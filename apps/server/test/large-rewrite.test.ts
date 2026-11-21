import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import { noteAiEdits } from "../src/db/schema.js";
import { NoteWriteService } from "../src/notes/editing/write-service.js";
import { seedDoc } from "./copy-helpers.js";
import { bearer, getContent, seedTokenForUser } from "./editing-helpers.js";
import { buildCollabTestApp, testEditingRuntime } from "./helpers.js";
import { loopStall } from "./perf-helpers.js";
import { bulkPut, callTool, downloadNote, editBody, issueBulkDirect, liveBlocks, topIdsOf } from "./bulk-transfer-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { yjsNote, type YjsBlockSpec } from "./unit/fixtures/yjs-note.js";

const BIG = 10_000;
const paragraphs = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
const log = (name: string, ms: number, extra = "") => console.log(`[scale] ${name}: ${Math.round(ms)} ms${extra}`);
const idsOf = (doc: Y.Doc) => topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id") as string);

async function scene(n: number, specOf?: (i: number) => YjsBlockSpec) {
  const ctx = await buildCollabTestApp();
  const u = await seedUser(ctx.db);
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Big" });
  const doc = yjsNote(n, specOf);
  await seedDoc(ctx.db, note.id, doc);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const content = async () => (await getContent(ctx.app, note.id, pat.token)).json();
  const post = (body: Record<string, unknown>) =>
    ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token), payload: body });
  const rows = () => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
  return { ctx, u, note, doc, pat, content, post, rows };
}

describe("#553 large rewrites through the real write path (default parse worker limits)", () => {
  it("the issue's shape in the worker: replace_all of a 10,000-paragraph note with 10,000 paragraphs answers ok, not too_complex", async () => {
    const base = yjsNote(BIG);
    const state = Y.encodeStateAsUpdate(base);
    // The worker takes the buffer over, so the copy to apply the diff to is made before the call.
    const copy = new Y.Doc();
    Y.applyUpdate(copy, state);
    const blocks = paragraphs(BIG, "new").map((text, i) => ({ id: `n${i}`, type: "paragraph" as const, content: text }));
    const t0 = performance.now();
    const r = await testEditingRuntime.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state, op: "replace_all", blocks });
    log("worker replace_all 10,000 -> 10,000", performance.now() - t0);
    expect(r).not.toBe("too_complex");
    if (r === "too_complex" || !r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
    Y.applyUpdate(copy, r.post.diff);
    const ids = idsOf(copy);
    expect(ids).toHaveLength(BIG);
    expect(ids.some(id => id.startsWith("q"))).toBe(false);
  }, 120_000);

  it("POST /edits replace_all of a 10,000-paragraph note with 2,000 paragraphs: 201, content as written, one record", async () => {
    const s = await scene(BIG);
    const c = await s.content();
    const t0 = performance.now();
    const res = await s.post({ op: "replace_all", markdown: paragraphs(2_000, "written").join("\n\n"), if_match: c.fingerprint });
    log("POST /edits replace_all 10,000 -> 2,000", performance.now() - t0);
    expect(res.statusCode).toBe(201);
    const ids = await topIdsOf(s.ctx, s.note.id);
    expect(ids).toHaveLength(2_000);
    expect(ids.some(id => id.startsWith("q"))).toBe(false);
    const blocks = await liveBlocks(s.ctx, s.note.id);
    expect(blocks[0]!.text).toBe("written 0");
    expect(blocks[1_999]!.text).toBe("written 1999");
    expect(await s.rows()).toHaveLength(1);
  }, 120_000);

  it("revert of that replace_all: 201, the 10,000 paragraphs back with their ids", async () => {
    const s = await scene(BIG);
    const original = idsOf(s.doc);
    const c = await s.content();
    const w = await s.post({ op: "replace_all", markdown: paragraphs(2_000, "written").join("\n\n"), if_match: c.fingerprint });
    expect(w.statusCode).toBe(201);
    const list = (await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(s.pat.token) })).json().edits as Array<{ id: string }>;
    const t0 = performance.now();
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${list[0]!.id}/revert`, headers: bearer(s.pat.token) });
    log("POST revert of 10,000 -> 2,000", performance.now() - t0);
    expect(rv.statusCode).toBe(201);
    expect(await topIdsOf(s.ctx, s.note.id)).toEqual(original);
    const blocks = await liveBlocks(s.ctx, s.note.id);
    expect(blocks[0]!.text).toBe("p0");
    expect(blocks[BIG - 1]!.text).toBe(`p${BIG - 1}`);
  }, 120_000);

  it("MCP edit_note delete_section of a 9,999-paragraph section: ok, the rest of the note intact", async () => {
    const s = await scene(BIG + 2, i =>
      i === 0 ? { id: "hs", type: "h", level: 1, text: "S" }
        : i <= BIG - 1 ? { id: `q${i}`, type: "p", text: `p${i}` }
          : i === BIG ? { id: "ht", type: "h", level: 1, text: "T" }
            : { id: "keep", type: "p", text: "keep" });
    const c = await s.content();
    const sec = c.outline.find((o: { heading: string }) => o.heading === "S");
    expect(sec).toBeDefined();
    const t0 = performance.now();
    const res = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "delete_section", section_id: sec.sectionId, if_match: sec.fingerprint });
    log("MCP delete_section of 9,999 paragraphs", performance.now() - t0);
    expect(res.isError).toBeUndefined();
    expect(await topIdsOf(s.ctx, s.note.id)).toEqual(["ht", "keep"]);
    expect(await s.rows()).toHaveLength(1);
  }, 120_000);

  it("bulk write-back that deletes 9,999 of 10,000 paragraphs: applied, one file_sync delete row", async () => {
    const s = await scene(BIG);
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    const d = await downloadNote(s.ctx.app, bulk.token, s.note.id);
    const t0 = performance.now();
    const r = await bulkPut(s.ctx.app, bulk.token, editBody(d.text, () => "p0\n"));
    log("bulk write-back deleting 9,999 of 10,000", performance.now() - t0);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied" });
    expect(await topIdsOf(s.ctx, s.note.id)).toEqual(["q0"]);
    const rows = await s.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "file_sync", afterBlockIds: [] });
  }, 180_000);

  it("applying a 10,000-paragraph version onto a 2,000-paragraph note: ok, content equals the version; logs the largest main-thread stall", async () => {
    const s = await scene(BIG);
    const writes = new NoteWriteService({ db: s.ctx.db, collab: s.ctx.collab, editing: testEditingRuntime, versions: s.ctx.collab.versions });
    const logger = s.ctx.app.log;
    const saved = await writes.saveVersion(logger, { noteId: s.note.id, userId: s.u.id, name: "big" });
    if (!saved.ok) throw new Error(`saveVersion: ${saved.kind}`);
    const c = await s.content();
    const w = await s.post({ op: "replace_all", markdown: paragraphs(2_000, "small").join("\n\n"), if_match: c.fingerprint });
    expect(w.statusCode).toBe(201);
    const stall = loopStall();
    const t0 = performance.now();
    const r = await writes.applyVersion(logger, { noteId: s.note.id, seq: saved.row.seq, versionId: saved.row.id, userId: s.u.id, discardUnsaved: true });
    const ms = performance.now() - t0;
    const worst = stall.stop();
    log("applyVersion 10,000 onto 2,000", ms, `, largest main-thread stall ${worst} ms`);
    expect(r.ok).toBe(true);
    const ids = await topIdsOf(s.ctx, s.note.id);
    expect(ids).toHaveLength(BIG);
    const blocks = await liveBlocks(s.ctx, s.note.id);
    expect(blocks[0]!.text).toBe("p0");
    expect(blocks[BIG - 1]!.text).toBe(`p${BIG - 1}`);
  }, 180_000);
});
