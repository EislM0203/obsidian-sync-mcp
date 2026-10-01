import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SearchIndex, queryTerms, stemOf, MAX_QUERY_TERMS } from "./search.js";

let tmpDir: string;

before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "search-test-"));
});

after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

describe("SearchIndex", () => {
    it("tracks size correctly", () => {
        const idx = new SearchIndex();
        assert.equal(idx.size, 0);
        idx.update("a.md", "content");
        assert.equal(idx.size, 1);
        idx.update("b.md", "content");
        assert.equal(idx.size, 2);
        idx.remove("a.md");
        assert.equal(idx.size, 1);
    });

    it("stores and retrieves mtimes", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "content", 1234567890);
        const notes = idx.listWithMtime();
        assert.equal(notes.length, 1);
        assert.equal(notes[0].mtime, 1234567890);
    });

    it("extracts and retrieves tags from content", () => {
        const idx = new SearchIndex();
        idx.update("tagged.md", "---\ntags: [project, urgent]\n---\n\nSome #inline content", 100);
        const tags = idx.getTags("tagged.md");
        assert.ok(tags.includes("project"));
        assert.ok(tags.includes("urgent"));
        assert.ok(tags.includes("inline"));
    });

    it("lists all tags with counts", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "---\ntags: [project, urgent]\n---\n", 100);
        idx.update("b.md", "---\ntags: [project]\n---\n", 200);
        idx.update("c.md", "No tags here", 300);
        const allTags = idx.listAllTags();
        assert.equal(allTags[0].tag, "project");
        assert.equal(allTags[0].count, 2);
        assert.equal(allTags[1].tag, "urgent");
        assert.equal(allTags[1].count, 1);
    });

    it("clears tags on remove", () => {
        const idx = new SearchIndex();
        idx.update("tagged.md", "---\ntags: [foo]\n---\n", 100);
        assert.deepEqual(idx.getTags("tagged.md"), ["foo"]);
        idx.remove("tagged.md");
        assert.deepEqual(idx.getTags("tagged.md"), []);
    });

    it("updates tags when content changes", () => {
        const idx = new SearchIndex();
        idx.update("note.md", "---\ntags: [old]\n---\n", 100);
        assert.deepEqual(idx.getTags("note.md"), ["old"]);
        idx.update("note.md", "---\ntags: [new]\n---\n", 200);
        assert.deepEqual(idx.getTags("note.md"), ["new"]);
    });

    it("extracts outgoing links", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "See [[b]] and [[folder/c]]", 100);
        assert.deepEqual(idx.getLinks("a.md"), ["b", "folder/c"]);
    });

    it("builds backlinks from wikilinks", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[b]]", 100);
        idx.update("c.md", "Also links to [[b]]", 200);
        const backlinks = idx.getBacklinks("b.md");
        assert.ok(backlinks.includes("a.md"));
        assert.ok(backlinks.includes("c.md"));
    });

    it("matches backlinks by filename without extension", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[Project X]]", 100);
        const backlinks = idx.getBacklinks("Project X.md");
        assert.deepEqual(backlinks, ["a.md"]);
    });

    it("matches backlinks by full path", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[projects/todo]]", 100);
        const backlinks = idx.getBacklinks("projects/todo.md");
        assert.deepEqual(backlinks, ["a.md"]);
    });

    it("clears backlinks when source is removed", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[b]]", 100);
        assert.deepEqual(idx.getBacklinks("b.md"), ["a.md"]);
        idx.remove("a.md");
        assert.deepEqual(idx.getBacklinks("b.md"), []);
    });

    it("matches backlinks case-insensitively", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[welcome]]", 100);
        const backlinks = idx.getBacklinks("Welcome.md");
        assert.deepEqual(backlinks, ["a.md"]);
    });

    it("updates backlinks when source content changes", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "Links to [[b]]", 100);
        assert.deepEqual(idx.getBacklinks("b.md"), ["a.md"]);
        idx.update("a.md", "Now links to [[c]]", 200);
        assert.deepEqual(idx.getBacklinks("b.md"), []);
        assert.deepEqual(idx.getBacklinks("c.md"), ["a.md"]);
    });
});

describe("SearchIndex persistence", () => {
    it("saves and loads mtimes and tags from disk", async () => {
        const path = join(tmpDir, "index.json");

        const idx1 = new SearchIndex(path);
        idx1.update("note1.md", "---\ntags: [foo]\n---\nHello world", 100);
        idx1.update("note2.md", "Goodbye world, see [[note1]]", 200);
        await idx1.saveToDisk();

        const idx2 = new SearchIndex(path);
        const loaded = await idx2.loadFromDisk();
        assert.ok(loaded);
        assert.equal(idx2.size, 2);

        const notes = idx2.listWithMtime();
        assert.equal(notes.length, 2);
        assert.ok(notes.some((n) => n.path === "note1.md" && n.mtime === 100));
        assert.ok(notes.some((n) => n.path === "note2.md" && n.mtime === 200));

        assert.deepEqual(idx2.getTags("note1.md"), ["foo"]);
        assert.deepEqual(idx2.getTags("note2.md"), []);

        // Backlinks survive persistence
        assert.deepEqual(idx2.getBacklinks("note1.md"), ["note2.md"]);

        // Metadata survives persistence (no FlexSearch)
    });

    it("saves and loads encrypted when passphrase set", async () => {
        const path = join(tmpDir, "encrypted-index.json");

        const idx1 = new SearchIndex(path, "mypassphrase");
        idx1.update("secret.md", "classified content", 999);
        await idx1.saveToDisk();

        // Verify file is not plaintext
        const { readFile } = await import("fs/promises");
        const raw = await readFile(path, "utf-8");
        assert.ok(!raw.includes("secret.md"));
        assert.ok(!raw.includes("classified"));

        const idx2 = new SearchIndex(path, "mypassphrase");
        const loaded = await idx2.loadFromDisk();
        assert.ok(loaded);
        assert.equal(idx2.size, 1);
    });

    it("returns false when no persisted index exists", async () => {
        const idx = new SearchIndex(join(tmpDir, "nonexistent.json"));
        assert.equal(await idx.loadFromDisk(), false);
    });

    it("returns false when no persist path configured", async () => {
        const idx = new SearchIndex();
        assert.equal(await idx.loadFromDisk(), false);
    });
});

describe("SearchIndex full-text", () => {
    const search = (idx: SearchIndex, q: string) => idx.search(queryTerms(q)).map((h) => h.path);

    it("finds a word that occurs in only one note", () => {
        // The branch this grew from pruned terms seen in fewer than two notes,
        // which deleted exactly the most useful searches.
        const idx = new SearchIndex();
        idx.update("secret.md", "the quetzalcoatl migration plan", 1);
        idx.update("a.md", "gardening notes", 2);
        idx.update("b.md", "more gardening notes", 3);
        assert.deepEqual(search(idx, "quetzalcoatl"), ["secret.md"]);
    });

    it("requires every query word (strict AND, no fallback to OR)", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "quarterly budget review", 1);
        idx.update("b.md", "quarterly gardening", 2);
        assert.deepEqual(search(idx, "quarterly budget"), ["a.md"]);
        assert.deepEqual(search(idx, "quarterly nonexistent"), []);
    });

    it("ignores case, including Greek final sigma and other variant letters", () => {
        const idx = new SearchIndex();
        idx.update("greek.md", "Η ΟΔΟΣ είναι κλειστή", 1);
        idx.update("micro.md", "a 5 µm gap", 2);
        assert.deepEqual(search(idx, "οδοσ"), ["greek.md"]);
        assert.deepEqual(search(idx, "ΟΔΟΣ"), ["greek.md"]);
        assert.deepEqual(search(idx, "μm"), ["micro.md"]);
    });

    it("treats NFD and NFC text as the same word", () => {
        const idx = new SearchIndex();
        idx.update("z.md", "Reise nach Zürich", 1);
        assert.deepEqual(search(idx, "Zürich"), ["z.md"]);
    });

    it("indexes the filename and ranks a filename hit first", () => {
        const idx = new SearchIndex();
        idx.update("notes/mentions.md", "we discussed the budget", 1);
        idx.update("budget.md", "numbers for next year", 2);
        assert.deepEqual(search(idx, "budget"), ["budget.md", "notes/mentions.md"]);
    });

    it("ranks rarer words and repeated words higher", () => {
        const idx = new SearchIndex();
        idx.update("once.md", "deadline mentioned", 1);
        idx.update("often.md", "deadline deadline deadline", 2);
        assert.deepEqual(search(idx, "deadline"), ["often.md", "once.md"]);
    });

    it("keeps link text searchable but not link URLs", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "see [the roadmap](https://example.com/zzqq) and [[Project Atlas|atlas notes]]", 1);
        assert.deepEqual(search(idx, "roadmap"), ["a.md"]);
        assert.deepEqual(search(idx, "atlas"), ["a.md"]);
        assert.deepEqual(search(idx, "zzqq"), []);
    });

    it("does not index code", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "prose here\n```\nfunctionname()\n```\nand `inlinecode`", 1);
        assert.deepEqual(search(idx, "functionname"), []);
        assert.deepEqual(search(idx, "inlinecode"), []);
        assert.deepEqual(search(idx, "prose"), ["a.md"]);
    });

    it("forgets old content on update and everything on remove", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "zebrafish", 1);
        idx.update("a.md", "axolotl", 2);
        assert.deepEqual(search(idx, "zebrafish"), []);
        assert.deepEqual(search(idx, "axolotl"), ["a.md"]);
        idx.remove("a.md");
        assert.deepEqual(search(idx, "axolotl"), []);
        assert.equal(idx.termCount, 0);
    });

    it("drops stop words from queries and caps the term count", () => {
        assert.deepEqual(queryTerms("the budget and the plan"), ["budget", "plan"]);
        assert.deepEqual(queryTerms("the and of"), []);
        assert.equal(queryTerms(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ")).length, MAX_QUERY_TERMS);
    });

    it("survives a save/load round trip", async () => {
        const path = join(tmpDir, "fulltext.json");
        const idx1 = new SearchIndex(path, "pw");
        idx1.update("a.md", "quarterly budget", 1);
        await idx1.saveToDisk();
        const idx2 = new SearchIndex(path, "pw");
        assert.ok(await idx2.loadFromDisk());
        assert.deepEqual(search(idx2, "budget"), ["a.md"]);
    });

    it("rebuilds when loading an index written before full-text search existed", async () => {
        // 0.7.0 wrote notes without terms. Loading that as-is would make every
        // search return nothing, and CouchDB catch-up would never fill it in.
        const path = join(tmpDir, "legacy.json");
        const { writeFile } = await import("fs/promises");
        await writeFile(path, JSON.stringify({ mtimes: { "a.md": 1 }, tags: {}, links: {}, since: "42-abc" }));
        const idx = new SearchIndex(path);
        assert.equal(await idx.loadFromDisk(), false);
        assert.equal(idx.size, 0);
        assert.equal(idx.since, "", "since must reset so CouchDB replays from the start");
    });
});

describe("SearchIndex prefix and inflection matching", () => {
    const search = (idx: SearchIndex, q: string) => idx.search(queryTerms(q)).map((h) => h.path);

    it("finds longer forms of a word by prefix", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "weekly meetings with the team", 1);
        idx.update("b.md", "the deployment went fine", 2);
        assert.deepEqual(search(idx, "meet"), ["a.md"]);
        assert.deepEqual(search(idx, "deploy"), ["b.md"]);
    });

    it("finds the base form from a plural or past-tense query", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "one meeting today", 1);
        idx.update("b.md", "still deploying", 2);
        idx.update("c.md", "a box of watches", 3);
        assert.deepEqual(search(idx, "meetings"), ["a.md"]);
        assert.deepEqual(search(idx, "deployed"), ["b.md"]);
        assert.deepEqual(search(idx, "watch"), ["c.md"]);
    });

    it("weighs an exact match above a prefix match, other things equal", () => {
        // Not an absolute tier: a note that repeats "meetings" often can still
        // outrank one mentioning "meeting" once, which is the better answer.
        const idx = new SearchIndex();
        idx.update("prefix.md", "meetings", 1);
        idx.update("exact.md", "meeting", 2);
        assert.deepEqual(search(idx, "meeting"), ["exact.md", "prefix.md"]);
    });

    it("keeps AND across words while expanding each one", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "deployment meetings", 1);
        idx.update("b.md", "deployment only", 2);
        assert.deepEqual(search(idx, "deploy meet"), ["a.md"]);
    });

    it("matches short words exactly instead of expanding them", () => {
        const idx = new SearchIndex();
        idx.update("a.md", "about aboard", 1);
        idx.update("b.md", "ab testing", 2);
        assert.deepEqual(search(idx, "ab"), ["b.md"]);
    });

    it("does not stem words into unrelated shorter ones", () => {
        assert.equal(stemOf("meetings"), "meeting");
        assert.equal(stemOf("deployed"), "deploy");
        assert.equal(stemOf("watches"), "watch");
        assert.equal(stemOf("notes"), "note", "not 'not', which would match 'nothing'");
        assert.equal(stemOf("used"), "used", "not 'us'");
        assert.equal(stemOf("class"), "class", "a double s is not a plural");
        const idx = new SearchIndex();
        idx.update("a.md", "nothing to see", 1);
        assert.deepEqual(search(idx, "notes"), []);
    });
});
