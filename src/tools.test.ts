import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools, READ_NOTE_MAX_RESULT_SIZE_CHARS } from "./tools.js";

function captureTools(): { name: string; _meta?: Record<string, unknown> }[] {
    const tools: { name: string; _meta?: Record<string, unknown> }[] = [];
    const server = { addTool: (tool: { name: string; _meta?: Record<string, unknown> }) => tools.push(tool) };
    registerTools(server as any, {} as any, {} as any, "vault");
    return tools;
}

test("read_note declares anthropic/maxResultSizeChars so Claude Code returns whole notes inline", () => {
    const readNote = captureTools().find((t) => t.name === "read_note");
    assert.ok(readNote, "read_note registered");
    assert.equal(readNote._meta?.["anthropic/maxResultSizeChars"], READ_NOTE_MAX_RESULT_SIZE_CHARS);
    assert.ok(READ_NOTE_MAX_RESULT_SIZE_CHARS > 50_000 && READ_NOTE_MAX_RESULT_SIZE_CHARS <= 500_000);
});

test("no other tool carries the annotation", () => {
    for (const tool of captureTools().filter((t) => t.name !== "read_note")) {
        assert.equal(tool._meta, undefined, `${tool.name} should not declare _meta`);
    }
});

// --- search_vault ---

import { SearchIndex } from "./search.js";
import { MAX_SEARCH_RESULTS } from "./tools.js";

type Tool = { name: string; execute: (args: any) => Promise<string> };

function harness(notes: Record<string, { body: string; mtime?: number }>) {
    const reads: string[] = [];
    const vault = {
        readNote: async (p: string) => {
            reads.push(p);
            if (p.includes("broken")) throw new Error("decrypt failed");
            return notes[p]?.body ?? null;
        },
    } as any;
    const index = new SearchIndex();
    for (const [p, n] of Object.entries(notes)) index.update(p, n.body, n.mtime ?? 1000);
    index.state = "ready";
    const tools: Tool[] = [];
    registerTools({ addTool: (t: Tool) => tools.push(t) } as any, vault, index, "V");
    return { search: tools.find((t) => t.name === "search_vault")!, reads, index };
}

test("search_vault returns matches with snippets and deep links", async () => {
    const { search } = harness({ "a.md": { body: "The quarterly budget is due Friday." }, "b.md": { body: "gardening" } });
    const out = await search.execute({ query: "budget" });
    assert.match(out, /^1 note matching "budget", best first\./);
    assert.match(out, /\[a\.md\]\(obsidian:\/\//);
    assert.match(out, /quarterly budget is due/);
    assert.ok(!out.includes("b.md"));
});

test("search_vault reads only the notes it shows", async () => {
    const notes: Record<string, { body: string }> = {};
    for (let i = 0; i < 200; i++) notes[`n${i}.md`] = { body: "budget line item" };
    const { search, reads } = harness(notes);
    const out = await search.execute({ query: "budget", limit: 5 });
    assert.match(out, /Showing 5 of 200 notes/);
    assert.equal(reads.length, 5);
});

test("search_vault applies filters before the limit", async () => {
    // Ten untagged notes outrank the one tagged note. Filtering after a
    // top-10 cut would find nothing.
    const notes: Record<string, { body: string }> = {};
    for (let i = 0; i < 10; i++) notes[`loud${i}.md`] = { body: "budget budget budget budget" };
    notes["quiet.md"] = { body: "---\ntags: [finance]\n---\nbudget" };
    const { search } = harness(notes);
    const out = await search.execute({ query: "budget", tag: "finance", limit: 10 });
    assert.match(out, /quiet\.md/, out);
    assert.match(out, /tag="finance"/);
});

test("search_vault filters by folder and modified_after", async () => {
    const { search } = harness({
        "work/a.md": { body: "budget", mtime: Date.parse("2026-06-01") },
        "work/old.md": { body: "budget", mtime: Date.parse("2020-01-01") },
        "home/c.md": { body: "budget", mtime: Date.parse("2026-06-01") },
    });
    const out = await search.execute({ query: "budget", folder: "work", modified_after: "2026-01-01" });
    assert.match(out, /work\/a\.md/);
    assert.ok(!out.includes("old.md") && !out.includes("home/c.md"), out);
    assert.match(await search.execute({ query: "budget", modified_after: "last tuesday" }), /Invalid date format/);
});

test("search_vault explains a query made only of common words", async () => {
    const { search } = harness({ "a.md": { body: "the and of" } });
    assert.match(await search.execute({ query: "the and" }), /common words/);
    assert.match(await search.execute({ query: "   " }), /Empty query/);
});

test("search_vault says so when nothing matches", async () => {
    const { search } = harness({ "a.md": { body: "gardening" } });
    assert.match(await search.execute({ query: "budget" }), /^No notes match "budget"\./);
});

test("search_vault caps results at MAX_SEARCH_RESULTS", async () => {
    const notes: Record<string, { body: string }> = {};
    for (let i = 0; i < 80; i++) notes[`n${i}.md`] = { body: "budget" };
    const { search } = harness(notes);
    const out = await search.execute({ query: "budget", limit: 999 });
    assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, MAX_SEARCH_RESULTS);
});

test("search_vault still lists a match whose note fails to read", async () => {
    const { search } = harness({ "broken.md": { body: "budget" }, "ok.md": { body: "budget" } });
    const out = await search.execute({ query: "budget" });
    assert.match(out, /broken\.md/);
    assert.match(out, /ok\.md/);
});

test("search_vault searches during startup but says results may be incomplete", async () => {
    const { search, index } = harness({ "a.md": { body: "budget" } });
    index.state = "building";
    const out = await search.execute({ query: "budget" });
    assert.match(out, /a\.md/);
    assert.match(out, /catching up/);
});

test("search_vault truncates a long query where it echoes it", async () => {
    const { search } = harness({ "a.md": { body: "budget" } });
    const out = await search.execute({ query: "zz".repeat(200) });
    assert.ok(out.length < 300, `got ${out.length} chars`);
});
