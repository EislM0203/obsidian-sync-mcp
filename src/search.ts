/**
 * Metadata index for vault notes, with a full-text inverted index.
 *
 * Tracks paths, mtimes, tags, links, backlinks, and term -> notes postings.
 * Persists to disk (encrypted if passphrase is set).
 *
 * The inverted index keeps every term, including ones that occur in a single
 * note. A word unique to one note is the most useful thing a user can search
 * for, so pruning rare terms to save memory would delete exactly the entries
 * that make search worth having. Memory therefore grows with the vault's
 * vocabulary — fine for personal vaults, and the reason 0.5.0 removed the
 * FlexSearch index for very large ones.
 */

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { parseFrontmatterAndLinks, maskCode } from "./parse.js";

/** Common English words that carry little search value. Dropped from notes and queries alike. */
const STOP_WORDS = new Set([
    "the","and","is","at","which","on","a","an","of","to","in","for","it","this","that",
    "with","as","by","from","or","be","are","was","were","been","being","have","has","had",
    "do","does","did","will","would","could","should","may","might","can","shall","not",
    "no","nor","but","if","then","than","so","yet","both","either","neither","each",
    "every","all","any","few","more","most","other","some","such","only","own","same",
    "too","very","just","about","above","after","again","against","am","around","because",
    "before","below","between","beyond","during","further","here","how",
    "i","into","many","me","my","myself","once","out","over","per","please",
    "re","rather","said","say","says","she","since","still","take","tell","them",
    "there","these","they","through","under","until","up","upon","us","we",
    "what","when","where","while","who","whom","why","you","your",
]);

/** Most terms one query may contribute; each one is a postings lookup and a scoring pass. */
export const MAX_QUERY_TERMS = 32;

/**
 * Case-fold one term, one code point at a time.
 *
 * `String#toLowerCase` is context-sensitive: `"ΟΔΟΣ".toLowerCase()` ends in a
 * final sigma, `"οδοσ"` typed by a user ends in a medial one, and the two
 * would never meet in the index. Folding each code point on its own (upper
 * then lower) maps every case variant of a letter — σ/ς/Σ, µ/μ, ſ/s — to one
 * form, on the note side and the query side identically.
 */
export function foldTerm(term: string): string {
    let out = "";
    for (const ch of term) out += ch.toUpperCase().toLowerCase();
    return out;
}

const WORD_RE = /[\p{L}\p{M}\p{N}_]+/gu;

/**
 * Term frequencies for a piece of text.
 *
 * NFC-normalized first, so a note saved decomposed (macOS) and a query typed
 * composed produce the same terms. Code blocks and inline code are masked, and
 * the URL half of a markdown link is dropped — but link TEXT is kept, both for
 * `[text](url)` and `[[target|alias]]`, because it is part of what the note says.
 */
export function tokenize(text: string): Map<string, number> {
    const freq = new Map<string, number>();
    const cleaned = maskCode(text.normalize("NFC")).replace(/\]\([^)]*\)/g, "] ");
    for (const m of cleaned.matchAll(WORD_RE)) {
        const term = foldTerm(m[0]);
        if (STOP_WORDS.has(term)) continue;
        freq.set(term, (freq.get(term) ?? 0) + 1);
    }
    return freq;
}

/** Distinct searchable terms of a query, in order, capped at MAX_QUERY_TERMS. */
export function queryTerms(query: string): string[] {
    return [...tokenize(query).keys()].slice(0, MAX_QUERY_TERMS);
}

/** Filename without folders or extension — indexed alongside the body. */
function basenameText(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.endsWith(".md") ? name.slice(0, -3) : name;
}

export interface SearchHit {
    path: string;
    score: number;
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
    /** term -> (note -> occurrences of the term in that note). */
    private postings = new Map<string, Map<string, number>>();
    /**
     * note -> its distinct terms. The reverse of `postings`, so re-indexing or
     * removing a note touches only that note's own terms instead of walking the
     * whole vocabulary. A plain array rather than a Map: counts already live in
     * the postings, and a per-note Map doubled the index's heap.
     */
    private noteTerms = new Map<string, string[]>();
    private saving = false;
    private _since: string = "";
    private persistPath: string | null;
    private passphrase: string | null;

    constructor(persistPath?: string, passphrase?: string) {
        this.persistPath = persistPath ?? null;
        this.passphrase = passphrase ?? null;
    }

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
            if (data.since) this._since = data.since;
            // An index written before full-text search existed (0.7.0 and
            // earlier) knows the notes but not their terms. Loading it would
            // make every search come back empty, and in CouchDB mode catch-up
            // only replays changes since `since`, so it would never heal.
            // Report "nothing persisted" instead, which triggers a full rebuild.
            const persistedTerms = (data.noteTerms ?? null) as Record<string, Record<string, number>> | null;
            if (this.knownPaths.size > 0 && (!persistedTerms || [...this.knownPaths].some((p) => !(p in persistedTerms)))) {
                console.warn("Search index has no full-text terms for some notes (upgrading from an older version?); rebuilding.");
                this.clear();
                return false;
            }
            for (const [path, freq] of Object.entries(persistedTerms ?? {})) {
                if (this.knownPaths.has(path)) this.addTerms(path, new Map(Object.entries(freq)));
            }
            console.log(`Search metadata loaded from disk (${this.knownPaths.size} notes, ${this.postings.size} terms, since: ${this._since ? "yes" : "none"}).`);
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
            let data = JSON.stringify({
                mtimes: Object.fromEntries(this.mtimes),
                tags: Object.fromEntries(this.tags),
                links: Object.fromEntries(this.links),
                noteTerms: Object.fromEntries(
                    [...this.noteTerms].map(([p, terms]) => [p, Object.fromEntries(terms.map((t) => [t, this.postings.get(t)!.get(p)!]))]),
                ),
                since: this._since,
            });
            if (this.passphrase) {
                data = encrypt(data, this.passphrase);
            }
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            console.log(`Search index saved to disk (${this.knownPaths.size} notes${this.passphrase ? ", encrypted" : ""}).`);
        } catch (err) {
            console.error("Failed to save search index:", err);
        } finally {
            this.saving = false;
        }
    }

    /** Add or update a note in the index. */
    update(path: string, content: string, mtime?: number): void {
        if (this.knownPaths.has(path)) {
            this.clearBacklinks(path);
            this.removeTerms(path);
        }
        this.knownPaths.add(path);
        const freq = tokenize(content);
        for (const [term, count] of tokenize(basenameText(path))) {
            freq.set(term, (freq.get(term) ?? 0) + count);
        }
        this.addTerms(path, freq);
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
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.knownPaths.has(path)) {
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.clearBacklinks(path);
            this.removeTerms(path);
        }
    }

    private addTerms(path: string, freq: Map<string, number>): void {
        this.noteTerms.set(path, [...freq.keys()]);
        for (const [term, count] of freq) {
            let notes = this.postings.get(term);
            if (!notes) this.postings.set(term, (notes = new Map()));
            notes.set(path, count);
        }
    }

    private removeTerms(path: string): void {
        const terms = this.noteTerms.get(path);
        if (!terms) return;
        for (const term of terms) {
            const notes = this.postings.get(term);
            notes?.delete(path);
            if (notes?.size === 0) this.postings.delete(term);
        }
        this.noteTerms.delete(path);
    }

    /**
     * Every note containing ALL query terms, best first.
     *
     * Strict AND: a note missing any term is not a match, so a multi-word query
     * narrows instead of quietly widening to "any of these words".
     *
     * Score per term is (1 + log tf) * log(1 + N / df): rare terms weigh more,
     * repetition helps with diminishing returns. A term that also appears in
     * the filename counts double. Ties go to the path, so results are stable.
     *
     * Returns all matches, unsliced: callers filter by folder/tag/date first
     * and apply their limit afterwards, so a filter can never hide matches
     * that happened to rank below an unfiltered cutoff.
     */
    search(terms: string[]): SearchHit[] {
        if (terms.length === 0) return [];
        const lists = terms.map((t) => this.postings.get(t));
        if (lists.some((l) => !l)) return [];
        // Intersect starting from the rarest term: cheapest, and shrinks fastest.
        const ordered = (lists as Map<string, number>[]).slice().sort((a, b) => a.size - b.size);
        const n = this.knownPaths.size;
        const hits: SearchHit[] = [];
        for (const path of ordered[0].keys()) {
            if (!ordered.every((l) => l.has(path))) continue;
            const nameTerms = tokenize(basenameText(path));
            let score = 0;
            for (let i = 0; i < terms.length; i++) {
                const idf = Math.log(1 + n / lists[i]!.size);
                score += (1 + Math.log(lists[i]!.get(path)!)) * idf;
                if (nameTerms.has(terms[i])) score += idf;
            }
            hits.push({ path, score });
        }
        return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
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

    /** Clear all index data (for full rebuild after DB nuke). */
    clear(): void {
        const paths = Array.from(this.knownPaths);
        for (const p of paths) this.remove(p);
        this.postings.clear();
        this.noteTerms.clear();
        this._since = "";
        this._state = "building";
    }

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

    /** Distinct terms in the full-text index. */
    get termCount(): number {
        return this.postings.size;
    }
}
