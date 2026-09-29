/**
 * Metadata index for vault notes with full-text search.
 *
 * Tracks paths, mtimes, tags, links, backlinks, and a term inverted index.
 * Persists to disk (encrypted if passphrase is set).
 */

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { parseFrontmatterAndLinks, maskCode } from "./parse.js";


// ---------------------------------------------------------------------------
// Stop words — common English words that carry little search value.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
    "the","and","is","at","which","on","a","an","of","to","in","for","it","this","that",
    "with","as","by","from","or","be","are","was","were","been","being","have","has","had",
    "do","does","did","will","would","could","should","may","might","can","shall","not",
    "no","nor","but","if","then","than","so","yet","both","either","neither","each",
    "every","all","any","few","more","most","other","some","such","only","own","same",
    "too","very","just","about","above","after","again","against","am","around","because",
    "before","being","below","between","beyond","during","further","had","here","how",
    "i","into","many","me","most","my","myself","once","out","over","per","please",
    "re","rather","said","say","says","she","since","still","take","tell","them",
    "then","there","these","they","through","under","until","up","upon","us","we",
    "what","when","where","while","who","whom","why","you","your",
]);

/**
 * Tokenize note content into a term-frequency map.
 *
 * 1. Lowercase
 * 2. Strip fenced code blocks and inline code (maskCode)
 * 3. Strip wikilinks [[...]] and markdown links [...](...)
 * 4. Split on word boundaries
 * 5. Drop empty, pure numbers, and stop words
 */
function tokenize(content: string): Map<string, number> {
    const freq = new Map<string, number>();
    let text = maskCode(content).toLowerCase();
    // Strip wikilinks: [[...]]  (keep nothing — the link text is already a path)
    text = text.replace(/\[\[[^\]]*\]\]/g, " ");
    // Strip markdown links: [text](url)
    text = text.replace(/\[[^\]]*\]\([^)]*\)/g, " ");
    // Split on word boundaries
    const words = text.split(/[^\p{L}\p{N}_]+/u);
    for (const w of words) {
        if (w === "") continue;
        if (/^\d+$/.test(w)) continue;          // pure numbers
        if (STOP_WORDS.has(w)) continue;         // stop words
        freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    return freq;
}

/**
 * Remove a single path from every term set it belongs to.
 * Returns the number of sets that were emptied (and should be deleted).
 */
function removePathFromTerms(terms: Map<string, Set<string>>, path: string): number {
    let emptyCount = 0;
    for (const [term, paths] of terms) {
        if (paths.has(path)) {
            paths.delete(path);
            if (paths.size === 0) {
                terms.delete(term);
                emptyCount++;
            }
        }
    }
    return emptyCount;
}

/**
 * Post-index pass: remove terms that appear in fewer than `minFreq` notes.
 */
function cleanupMinTermFreq(terms: Map<string, Set<string>>, minFreq: number): number {
    let removed = 0;
    for (const [term, paths] of terms) {
        if (paths.size < minFreq) {
            terms.delete(term);
            removed++;
        }
    }
    return removed;
}


function encrypt(text: string, passphrase: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    const tag = (cipher as any).getAuthTag() as Buffer;
    return salt.toString("hex") + ":" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string, passphrase: string): string {
    const [saltHex, ivHex, tagHex, encryptedHex] = data.split(":");
    const key = scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    (decipher as any).setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf-8");
}

/**
 * Lifecycle of the in-memory index. "building" from construction until the
 * startup rebuild finishes, "ready" afterwards, "failed" if the rebuild threw.
 * Read by list_notes so a client can tell a partial index from a complete one.
 */
export type IndexState = "building" | "ready" | "failed";

export class SearchIndex {
    private _state: IndexState = "building";
    private mtimes = new Map<string, number>();
    private tags = new Map<string, string[]>();
    private links = new Map<string, string[]>();
    private backlinks = new Map<string, Set<string>>();
    private knownPaths = new Set<string>();

    // -- Full-text term inverted index ----------------------------------------
    /** term → set of paths containing that term */
    private terms = new Map<string, Set<string>>();

    /** Count of incremental updates since last cleanup. */
    private _incrementalUpdates = 0;
    private _lastCleanupIndex = 0;

    private saving = false;
    private _since: string = "";
    private persistPath: string | null;
    private passphrase: string | null;

    constructor(persistPath?: string, passphrase?: string) {
        this.persistPath = persistPath ?? null;
        this.passphrase = passphrase ?? null;
    }

    // -- Serialization -------------------------------------------------------

    /** Load metadata from disk. */
    async loadFromDisk(): Promise<boolean> {
        if (!this.persistPath) return false;
        try {
            let raw = await readFile(this.persistPath, "utf-8");
            if (this.passphrase) {
                raw = decrypt(raw, this.passphrase);
            }
            const data = JSON.parse(raw);
            for (const [path, mtime] of Object.entries(data.mtimes ?? {})) {
                this.mtimes.set(path, mtime as number);
                this.knownPaths.add(path);
            }
            for (const [path, t] of Object.entries(data.tags ?? {})) {
                this.tags.set(path, t as string[]);
            }
            for (const [path, l] of Object.entries(data.links ?? {})) {
                const targets = l as string[];
                this.links.set(path, targets);
                for (const target of targets) {
                    const key = target.toLowerCase();
                    if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                    this.backlinks.get(key)!.add(path);
                }
            }
            // Load term inverted index.
            const rawTerms = data.terms as Record<string, string[]> | undefined;
            if (rawTerms) {
                for (const [term, paths] of Object.entries(rawTerms)) {
                    this.terms.set(term, new Set(paths));
                }
            }
            if (data.since) this._since = data.since;
            console.log(`Search metadata loaded from disk (${this.knownPaths.size} notes, ${this.terms.size} terms, since: ${this._since ? "yes" : "none"}).`);
            return this.knownPaths.size > 0;
        } catch {
            return false;
        }
    }

    /** Save metadata to disk. Encrypted if passphrase is set. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath || this.saving) return;
        this.saving = true;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            // Convert Map<string, Set<string>> → Object<string, string[]> for JSON.
            const termsObj: Record<string, string[]> = {};
            for (const [term, paths] of this.terms) {
                termsObj[term] = [...paths];
            }
            let data = JSON.stringify({
                mtimes: Object.fromEntries(this.mtimes),
                tags: Object.fromEntries(this.tags),
                links: Object.fromEntries(this.links),
                terms: termsObj,
                since: this._since,
            });
            if (this.passphrase) {
                data = encrypt(data, this.passphrase);
            }
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            console.log(`Search index saved to disk (${this.knownPaths.size} notes, ${this.terms.size} terms${this.passphrase ? ", encrypted" : ""}).`);
        } catch (err) {
            console.error("Failed to save search index:", err);
        } finally {
            this.saving = false;
        }
    }

    // -- Core index operations -----------------------------------------------

    /** Add or update a note in the index. */
    update(path: string, content: string, mtime?: number): void {
        if (this.knownPaths.has(path)) {
            this.clearBacklinks(path);
            // Remove old terms for this path before re-indexing.
            removePathFromTerms(this.terms, path);
        }
        this.knownPaths.add(path);
        if (mtime !== undefined) this.mtimes.set(path, mtime);
        const parsed = parseFrontmatterAndLinks(content);
        if (parsed.tags.length > 0) {
            this.tags.set(path, parsed.tags);
        } else {
            this.tags.delete(path);
        }
        if (parsed.links.length > 0) {
            this.links.set(path, parsed.links);
            for (const target of parsed.links) {
                const key = target.toLowerCase();
                if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                this.backlinks.get(key)!.add(path);
            }
        } else {
            this.links.delete(path);
        }
        // Index full-text terms.
        const freq = tokenize(content);
        for (const [term, count] of freq) {
            let set = this.terms.get(term);
            if (!set) {
                set = new Set();
                this.terms.set(term, set);
            }
            set.add(path);
        }
        // Track incremental updates for periodic cleanup.
        this._incrementalUpdates++;
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.knownPaths.has(path)) {
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.clearBacklinks(path);
            // Clean up terms that referenced this path.
            removePathFromTerms(this.terms, path);
        }
    }

    /** Remove all backlink entries where path is the source. */
    private clearBacklinks(path: string): void {
        const oldLinks = this.links.get(path);
        if (oldLinks) {
            for (const target of oldLinks) {
                const key = target.toLowerCase();
                this.backlinks.get(key)?.delete(path);
                if (this.backlinks.get(key)?.size === 0) this.backlinks.delete(key);
            }
        }
        this.links.delete(path);
    }

    // -- Search --------------------------------------------------------------

    /**
     * Search note content across the vault.
     *
     * Uses AND semantics (all terms must match).  If the AND intersection is
     * empty the query falls back to OR (any term matches).
     *
     * Results are scored by inverse document frequency (IDF): rare terms that
     * appear in fewer notes contribute more to the score.
     */
    search(query: string, folder?: string, limit: number = 10): Array<{ path: string; score: number }> {
        const queryTerms = tokenize(query);
        if (queryTerms.size === 0) return [];

        // Snapshot terms at the start to avoid race conditions with concurrent
        // incremental updates during file-watcher events.
        const termsSnapshot = new Map(this.terms);

        const termsArr = [...queryTerms.keys()];

        // AND: intersect all term sets.
        let candidatePaths: Set<string> | null = null;
        for (const term of termsArr) {
            const set = termsSnapshot.get(term);
            if (!set || set.size === 0) {
                candidatePaths = null;
                break;
            }
            if (candidatePaths === null) {
                candidatePaths = new Set(set);
            } else {
                // In-place intersection.
                for (const p of candidatePaths) {
                    if (!set.has(p)) candidatePaths.delete(p);
                }
            }
        }

        // OR fallback: union of all term sets.
        if (!candidatePaths || candidatePaths.size === 0) {
            candidatePaths = new Set();
            for (const term of termsArr) {
                const set = termsSnapshot.get(term);
                if (set) {
                    for (const p of set) candidatePaths.add(p);
                }
            }
        }

        // Score each candidate by IDF-style weighting: 1 / set.size.
        // Rare terms that appear in fewer notes score higher.
        const scored = new Map<string, number>();
        for (const path of candidatePaths) {
            let score = 0;
            for (const term of termsArr) {
                const set = termsSnapshot.get(term);
                if (set && set.has(path)) {
                    score += 1 / set.size;
                }
            }
            scored.set(path, score);
        }

        // Filter by folder prefix if provided.
        const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
        const filtered = [...scored.entries()]
            .filter(([p]) => !prefix || p.startsWith(prefix))
            .sort((a, b) => b[1] - a[1]);

        return filtered.slice(0, limit).map(([path, score]) => ({ path, score }));
    }

    // -- List helpers --------------------------------------------------------

    /** List all indexed paths, optionally filtered by folder prefix. */
    listPaths(folder?: string): string[] {
        return this.listWithMtime(folder).map((n) => n.path);
    }

    /** List all indexed paths with mtimes, optionally filtered by folder prefix. */
    listWithMtime(folder?: string): Array<{ path: string; mtime: number }> {
        const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
        const entries = [...this.knownPaths]
            .filter((p) => p.endsWith(".md"))
            .filter((p) => !prefix || p.startsWith(prefix))
            .map((p) => ({ path: p, mtime: this.mtimes.get(p) ?? 0 }));
        return entries.sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Get mtime for a path. */
    getMtime(path: string): number {
        return this.mtimes.get(path) ?? 0;
    }

    /** Get tags for a path. */
    getTags(path: string): string[] {
        return this.tags.get(path) ?? [];
    }

    /** Get outgoing links for a path. */
    getLinks(path: string): string[] {
        return this.links.get(path) ?? [];
    }

    /** Get backlinks for a path (notes that link to it). Case-insensitive, matches by full path or filename. */
    getBacklinks(path: string): string[] {
        const results = new Set<string>();
        const withMd = (path.endsWith(".md") ? path : path + ".md").toLowerCase();
        const withoutMd = (path.endsWith(".md") ? path.slice(0, -3) : path).toLowerCase();
        const nameOnly = withoutMd.includes("/") ? withoutMd.slice(withoutMd.lastIndexOf("/") + 1) : withoutMd;

        for (const target of [withMd, withoutMd, nameOnly]) {
            const sources = this.backlinks.get(target);
            if (sources) {
                for (const s of sources) results.add(s);
            }
        }
        return [...results].sort();
    }

    /** List all tags across the vault with counts. */
    listAllTags(): Array<{ tag: string; count: number }> {
        const counts = new Map<string, number>();
        for (const tags of this.tags.values()) {
            for (const t of tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
    }

    /**
     * Post-index cleanup: remove terms that appear in fewer than minFreq notes.
     * Call this after the full rebuild to prune rare terms.
     *
     * Also called automatically after every `autoCleanupEvery` incremental
     * updates (default 500) to prevent rare-term accumulation.
     */
    cleanupMinTermFreq(minFreq: number): number {
        const removed = cleanupMinTermFreq(this.terms, minFreq);
        if (removed > 0) {
            console.log(`  pruned ${removed} rare terms from inverted index.`);
        }
        this._incrementalUpdates = 0;
        this._lastCleanupIndex++;
        return removed;
    }

    /**
     * Check if incremental updates warrant a cleanup pass.
     * Call this after each update() in the file-watcher callback.
     */
    maybeCleanup(minFreq: number, autoCleanupEvery: number = 500): void {
        if (this._incrementalUpdates >= autoCleanupEvery) {
            this.cleanupMinTermFreq(minFreq);
        }
    }

    /** Clear all index data (for full rebuild after DB nuke). */
    clear(): void {
        const paths = Array.from(this.knownPaths);
        for (const p of paths) this.remove(p);
        this.terms.clear();
        this._since = "";
        this._state = "building";
    }

    // -- Getters -------------------------------------------------------------

    get state(): IndexState {
        return this._state;
    }

    set state(value: IndexState) {
        this._state = value;
    }

    get since(): string {
        return this._since;
    }

    set since(value: string) {
        this._since = value;
    }

    get size(): number {
        return this.knownPaths.size;
    }

    /** Number of unique terms in the inverted index. */
    get termsSize(): number {
        return this.terms.size;
    }
}
