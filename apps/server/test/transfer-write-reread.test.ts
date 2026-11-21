// Repeated exports of a note that was not touched are byte-identical (cold note, live document already loaded in memory): the `note_changed` decision presupposes this.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { noteAiEdits, notes, noteVersions, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { exportNoteBody, exportNoteForTransfer } from "../src/transfer/export-note.js";
import { BASE_UNAVAILABLE_MESSAGES } from "../src/routes/transfer.js";
import { BASE_WITHOUT_ID_MESSAGE } from "../src/transfer/frontmatter.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { buildCollabTestApp, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedShare, seedUser } from "./group-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { bulkPut, callTool, downloadNote, editBody, humanEdit, issueBulkDirect, liveBlocks, liveMarkdown, renameIn, seedBlocks, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

const PASSWORD = "correct-horse-battery";
const FENCE = "```";
const RICH = [
  "# 標題一",
  "段落含 **粗體**、*斜體*、`code` 與[連結](https://example.com)。",
  "## 小節",
  "* 項目一\n  * 子項目\n* 項目二",
  "1. 第一\n2. 第二",
  "- [ ] 待辦",
  "> 引用",
  "| 欄一 | 欄二 |\n| --- | --- |\n| a | b |",
  `${FENCE}js\nconst x = 1;\n${FENCE}`,
  "![圖](https://example.com/a.png)",
  "段落 P sentinel-e0-end",
].join("\n\n");

describe("repeated exports are byte-identical", () => {
  it("cold note: two downloads in a row have the same body", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
    await seedMd(ctx.db, note.id, RICH);
    const a = await downloadNote(ctx.app, bulk.token, note.id);
    const b = await downloadNote(ctx.app, bulk.token, note.id);
    expect(b.body).toBe(a.body);
    expect(a.body).toContain("sentinel-e0-end");
  });

  it("live document loaded in memory (with a connection): two downloads in a row have the same body; a cold read after disconnect and unload is the same too", async () => {
    const ctx = await buildCollabTestApp();
    const email = `o-${randomUUID()}@example.com`;
    const owner = await ctx.createUser({ email, password: PASSWORD });
    const n = await ctx.createNote(owner.id);
    const client = await seedContent(ctx, await ctx.loginAs(email, PASSWORD), n.id, RICH);
    const pat = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const b = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    expect(ctx.collab.hocuspocus.documents.get(n.id)).toBeDefined();
    const live1 = await downloadNote(ctx.app, b.token, n.id);
    const live2 = await downloadNote(ctx.app, b.token, n.id);
    expect(live2.body).toBe(live1.body);
    client.disconnect();
    const deadline = Date.now() + 10_000;
    while (ctx.collab.hocuspocus.documents.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(ctx.collab.hocuspocus.documents.get(n.id)).toBeUndefined();
    const cold = await downloadNote(ctx.app, b.token, n.id);
    expect(cold.body).toBe(live1.body);
  });
});

describe("a note with knowledge info reads the same on every path", () => {
  it("exportNoteBody and exportNoteForTransfer give the same body for a note with knowledge info, and the download carries the comment", async () => {
    const blocks = [
      { type: "heading", props: { level: 2, knowledgeId: "k_8f3a2c1d", knowledgeWhen: "alice reads this", knowledgeEvidence: "tested" }, content: "D1" },
      { type: "paragraph", content: "body" },
    ];
    const doc = new Y.Doc();
    const session = await EditorSession.open(testEditingRuntime, doc);
    try {
      session.editor.replaceBlocks(session.editor.document, blocks as never);
    } finally {
      session.close();
    }
    const body = await exportNoteBody(testEditingRuntime, doc, new Map());
    const transfer = await exportNoteForTransfer(testEditingRuntime, doc, new Map());
    expect(transfer.body).toBe(body);
    expect(body).toBe("## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nevidence: tested\n-->\n\nbody\n");

    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
    await seedBlocks(ctx.db, note.id, blocks);
    const downloaded = await downloadNote(ctx.app, bulk.token, note.id);
    expect(downloaded.body).toBe(body);
  });
});

type Opts = Parameters<typeof buildCollabTestApp>[0];
const CH = "# 第一章\n\n段落 A1\n\n## 1.1 小節\n\n段落 B1\n\n# 第二章\n\n段落 C1\n\n* 清單一\n* 清單二\n\n# 第三章\n\n段落 D1";
async function scene(opts: Opts = {}, md = CH) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "Title" });
  if (md !== "") await seedMd(ctx.db, note.id, md);
  return { ctx, u, pat, bulk, note };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string; reason?: string } }).error;
const NOTE_CHANGED = { code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.note_changed, reason: "note_changed" };
const edits = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId));
const versions = (ctx: CollabTestCtx, noteId: string) => ctx.db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId));
const titleOf = async (ctx: CollabTestCtx, id: string) => (await ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, id)))[0]!.title;
const norm = (s: string) => s.replace(/\n+$/, "");
const bodyOf = (text: string) => text.split("\n").slice(8).join("\n");

async function mcpSectionEdit(s: Scene, heading: string, op: "replace_section" | "delete_section", markdown?: string) {
  const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json() as { outline: Array<{ sectionId: string; heading: string; fingerprint: string }> };
  const sec = c.outline.find(o => o.heading === heading)!;
  const args = { note_id: s.note.id, op, section_id: sec.sectionId, if_match: sec.fingerprint, ...(markdown !== undefined ? { markdown } : {}) };
  const r = await callTool(s.ctx.app, s.pat.token, "edit_note", args);
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
}
/** MCP rename (since #381 it needs `if_match` = `titleFingerprint` from `read_note_outline`; read first, as a model really would). */
async function mcpRename(s: Scene, title: string) {
  const o = await callTool(s.ctx.app, s.pat.token, "read_note_outline", { note_id: s.note.id });
  expect(o.isError, JSON.stringify(o.structuredContent)).toBeUndefined();
  const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "rename", title, if_match: o.structuredContent.titleFingerprint });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
}
async function expectNoteChanged(s: Scene, token: string, text: string, base: string) {
  const md0 = await liveMarkdown(s.ctx, s.note.id);
  const t0 = await titleOf(s.ctx, s.note.id);
  const e0 = (await edits(s.ctx, s.note.id)).length;
  const v0 = (await versions(s.ctx, s.note.id)).length;
  const r = await bulkPut(s.ctx.app, token, text);
  expect(r.statusCode).toBe(409);
  expect(errOf(r)).toEqual(NOTE_CHANGED);
  expect(await liveMarkdown(s.ctx, s.note.id)).toBe(md0);
  expect(await titleOf(s.ctx, s.note.id)).toBe(t0);
  expect((await edits(s.ctx, s.note.id)).length).toBe(e0);
  expect((await versions(s.ctx, s.note.id)).length).toBe(v0);
  const [row] = await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, base));
  expect(row!.appliedBodySha).toBeNull();
  expect(row!.appliedTitleSha).toBeNull();
  return md0;
}

describe("note changed after download -> 409 note_changed", () => {
  it("after download someone else changes another chapter with MCP edit_note -> sending back (changing chapter 1) is 409 note_changed, note unchanged; re-download and redo -> 200", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第三章", "replace_section", "# 第三章\n\n段落 D1 被 edit_note 改");
    const text = editBody(d.text, b => b.replace("段落 A1", "段落 A1 檔案改"));
    const md0 = await expectNoteChanged(s, s.bulk.token, text, d.fm.base!);
    expect(md0).toContain("段落 D1 被 edit_note 改");
    expect(md0).not.toContain("檔案改");
    // The body was changed by someone else, so a title-only file is also rejected.
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Title from file"), d.fm.base!);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("段落 A1", "段落 A1 檔案改")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("段落 A1 檔案改");
    expect(md).toContain("段落 D1 被 edit_note 改");
  });

  it("after download someone else changes only the title (edit_note rename) -> sending back a body change is 409; sending back only a title change is also 409; title and body both unchanged", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpRename(s, "Renamed by edit_note");
    await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace("段落 A1", "段落 A1 檔案改")), d.fm.base!);
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Renamed by file"), d.fm.base!);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Renamed by edit_note");
  });

  it("adjacent X, Y: copy A writes back a change to X first -> copy B changes X and Y (same region) -> 409, X exists only once", async () => {
    const s = await scene({}, "段落 X\n\n段落 Y\n\n段落 Z");
    const pat2 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const b2 = await issueBulkDirect(s.ctx.db, pat2.tokenId, { access: "write" });
    const da = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const db = await downloadNote(s.ctx.app, b2.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(da.text, b => b.replace("段落 X", "段落 X：A 改")))).json()).toMatchObject({ result: "applied" });
    const md = await expectNoteChanged(s, b2.token, editBody(db.text, b => b.replace("段落 X", "段落 X：B 改").replace("段落 Y", "段落 Y：B 改")), db.fm.base!);
    expect((await liveBlocks(s.ctx, s.note.id)).map(x => x.text)).toEqual(["段落 X：A 改", "段落 Y", "段落 Z"]);
    expect(md.split("段落 X").length - 1).toBe(1);
  });

  it("insert: edit_note replaces chapter 2 -> the old copy inserts a paragraph after C1 -> 409 (no longer inserted into another chapter)", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第二章", "replace_section", "# 第二章\n\n段落 C1 AI 改過\n\n* 清單一\n* 清單二");
    const md = await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace("段落 C1", "段落 C1\n\n檔案新插的段")), d.fm.base!);
    expect(md).not.toContain("檔案新插的段");
  });

  it("delete: edit_note changed that paragraph -> the old copy deletes it -> 409 (no longer unchanged/same), the paragraph is still there", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第三章", "replace_section", "# 第三章\n\n段落 D1 被改");
    const md = await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace(/\n\n段落 D1\s*$/, "")), d.fm.base!);
    expect(md).toContain("段落 D1 被改");
  });

  it("note untouched -> rewrite + insert + delete + rename applied at once, result = file; untouched blocks keep their ids, no version saved", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const before = await liveBlocks(s.ctx, s.note.id);
    const text = renameIn(editBody(d.text, b => b.replace("段落 A1", "段落 A1 改").replace("段落 C1", "段落 C1\n\n新段落").replace(/\n\n段落 D1\s*$/, "")), "New title");
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    const out = r.json() as Record<string, unknown>;
    expect(out).toMatchObject({ result: "applied", renamed: true, applied: 3, same: 0 });
    expect(out).not.toHaveProperty("conflicts");
    expect(out).not.toHaveProperty("version");
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe(norm(bodyOf(text)));
    expect(await titleOf(s.ctx, s.note.id)).toBe("New title");
    const after = new Set((await liveBlocks(s.ctx, s.note.id)).map(x => x.id));
    for (const keep of before.filter(x => ["第一章", "1.1 小節", "段落 B1", "第二章", "第三章"].includes(x.text))) expect(after.has(keep.id), keep.text).toBe(true);
    expect(await versions(s.ctx, s.note.id)).toHaveLength(0);
    expect(await edits(s.ctx, s.note.id)).toHaveLength(3);
  });

  it("file unchanged, note touched (body and title both changed) -> 200 unchanged, nothing written", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第三章", "replace_section", "# 第三章\n\n段落 D1 被改");
    await mcpRename(s, "Other title");
    const md0 = await liveMarkdown(s.ctx, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "unchanged", applied: 0, renamed: false });
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(md0);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Other title");
  });

  it("after the same copy is written back: someone else edits again, sending the same one -> unchanged; sending other content -> already_sent (not pre-empted by note_changed); after a revert sending the same one -> reverted", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("段落 A1", "段落 A1 改"));
    const w = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(w.json()).toMatchObject({ result: "applied" });
    const [editId] = (w.json() as { editIds: string[] }).editIds;
    await mcpSectionEdit(s, "第三章", "replace_section", "# 第三章\n\n段落 D1 被改");
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "unchanged" });
    const other = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("段落 A1", "段落 A1 再改")));
    expect(other.statusCode).toBe(409);
    expect(errOf(other).reason).toBe("already_sent");
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${editId}/revert`, headers: bearer(s.pat.token) });
    expect(rv.statusCode).toBe(201);
    const again = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(again.statusCode).toBe(409);
    expect(errOf(again).reason).toBe("reverted");
  });

  it("someone types while the live document is open (browser connection) -> 409 note_changed, the typed text is still there, the file's changes are not written", async () => {
    const PASS = "correct-horse-battery";
    const ctx = await buildCollabTestApp();
    const email = `o-${randomUUID()}@example.com`;
    const owner = await ctx.createUser({ email, password: PASS });
    const n = await ctx.createNote(owner.id);
    const client = await seedContent(ctx, await ctx.loginAs(email, PASS), n.id, "First para\n\nSecond para\n\nThird para live-nc9");
    const pat = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const d = await downloadNote(ctx.app, bulk.token, n.id);
    const s = await EditorSession.open(testEditingRuntime, client.doc);
    try {
      const third = s.editor.document[2]!;
      s.editor.updateBlock(third.id, { content: "Third para live-nc9 typed in browser" });
    } finally {
      s.close();
    }
    await waitFor("server 收到瀏覽器打的字", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(n.id)!).includes("typed in browser"));
    const r = await bulkPut(ctx.app, bulk.token, editBody(d.text, b => b.replace("First para", "First para from file")));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual(NOTE_CHANGED);
    const md = await liveMarkdown(ctx, n.id);
    expect(md).toContain("typed in browser");
    expect(md).not.toContain("from file");
    client.disconnect();
  });
});

describe("same export, different structure", () => {
  it("someone replaces a paragraph with a new block of the same content (id changed, whole export verbatim identical) -> a file that edits another paragraph is 409 note_changed", async () => {
    const s = await scene({}, "Para 0\n\nPara 1\n\nPara 2");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks([ed.document[1]!.id], [{ type: "paragraph", content: "Para 1" }]));
    expect((await downloadNote(s.ctx.app, s.bulk.token, s.note.id)).body).toBe(d.body);
    await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Para 2 file")), d.fm.base!);
  });
});

describe("'changed' looks only at this note's own content (structural comparison, not export comparison)", () => {
  for (const change of ["rename", "invisible"] as const) {
    it(`wikilink to another note (no custom text, shows the other note's current title): the other note ${change === "rename" ? "is renamed" : "becomes invisible (moved to trash)"} -> not counted as changed, a file editing another paragraph is 200; the wikilink's id and attributes are unchanged`, async () => {
      const s = await scene({}, "");
      const target = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Target before" });
      await seedBlocks(s.ctx.db, s.note.id, [
        { type: "paragraph", content: [{ type: "text", text: "See ", styles: {} }, { type: "wikilink", props: { targetNoteId: target.id, snapshotTitle: "Old snapshot" } }] },
        { type: "paragraph", content: "Para 1" },
      ]);
      const [linkBlock] = await topIdsOf(s.ctx, s.note.id);
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      expect(d.body).toContain("Target before");
      if (change === "rename") await s.ctx.db.update(notes).set({ title: "Target after" }).where(eq(notes.id, target.id));
      else await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, target.id));
      expect((await downloadNote(s.ctx.app, s.bulk.token, s.note.id)).body).not.toBe(d.body); // precondition: this note's export really changed
      const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1 file")));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
      const ids = await topIdsOf(s.ctx, s.note.id);
      expect(ids[0]).toBe(linkBlock);
      const { doc } = await loadNoteDoc({ db: s.ctx.db, collab: s.ctx.collab }, s.note.id);
      const xml = doc.getXmlFragment(YDOC_FRAGMENT).toString();
      expect(xml).toContain(`targetNoteId="${target.id}"`);
      expect(xml).toContain('snapshotTitle="Old snapshot"');
      expect(await liveMarkdown(s.ctx, s.note.id)).toContain("Para 1 file");
    });
  }

  it("after download the note is moved into a folder and shared with others -> not counted as changed: a file editing the body is still 200 applied", async () => {
    const s = await scene({}, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const f = await seedFolder(s.ctx.db, { personal: s.u.id }, { name: "Moved here" });
    await s.ctx.db.update(notes).set({ folderId: f.id }).where(eq(notes.id, s.note.id));
    const other = await seedUser(s.ctx.db);
    await seedShare(s.ctx.db, s.note.id, other.id, "editor");
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1 file")));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
  });
});

describe("a copy that already wrote the body no longer accepts title changes", () => {
  it("copy writes back Para 0 -> someone else edits Para 2 -> the same file with only the title changed is sent again -> 409 already_sent, title unchanged, the other's change is there", async () => {
    const s = await scene({}, "Para 0\n\nPara 1\n\nPara 2");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = editBody(d.text, b => b.replace("Para 0", "Para 0 file"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "applied" });
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: "Para 2 human" }));
    const md0 = await liveMarkdown(s.ctx, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(text, "Renamed after human edit"));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual({ code: "base_unavailable", message: BASE_UNAVAILABLE_MESSAGES.already_sent, reason: "already_sent" });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
    expect(await liveMarkdown(s.ctx, s.note.id)).toBe(md0);
    expect(md0).toContain("Para 2 human");
  });
});

describe("base has 0 blocks, current has exactly one empty paragraph (a browser normalizes that in when opening)", () => {
  const loneEmpty = (s: Scene, typed: boolean) =>
    humanEdit(s.ctx, s.note.id, ed => {
      ed.insertBlocks([{ type: "paragraph", content: typed ? "typed" : "" }], ed.document[0]!.id, "after");
      ed.removeBlocks([ed.document[0]!.id]);
      if (typed) ed.updateBlock(ed.document[0]!.id, { content: [] });
    });
  for (const typed of [false, true]) {
    it(`treated as untouched: write two paragraphs -> 200, result is exactly two paragraphs (the empty paragraph is replaced)${typed ? "; same for an empty paragraph that was typed into and then cleared" : ""}`, async () => {
      const s = await scene({}, "");
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      expect(d.body).toBe("");
      await loneEmpty(s, typed);
      expect(await topIdsOf(s.ctx, s.note.id)).toHaveLength(1);
      const r = await bulkPut(s.ctx.app, s.bulk.token, `${d.text}First para\n\nSecond para`);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
      expect((await liveBlocks(s.ctx, s.note.id)).map(b => b.text)).toEqual(["First para", "Second para"]);
    });
  }
  it("control: that one paragraph has text -> 409; two empty paragraphs -> 409", async () => {
    const s = await scene({}, "");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks(ed.document.map(b => b.id), [{ type: "paragraph" }, { type: "paragraph" }]));
    await expectNoteChanged(s, s.bulk.token, `${d.text}Agent para`, d.fm.base!);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks(ed.document.map(b => b.id), [{ type: "paragraph", content: "Human" }]));
    await expectNoteChanged(s, s.bulk.token, `${d.text}Agent para`, d.fm.base!);
  });
});

describe("null paragraph table (mergeable: false), title-only change: falls back to whole-export comparison", () => {
  it("after download someone changed the body -> a file with only the title changed is 409, title unchanged; nobody changed it -> renamed (control)", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } }, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { content: "Para 1 human" }));
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Renamed unmergeable"), d.fm.base!);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d2.text, "Renamed unmergeable"))).json()).toMatchObject({ result: "renamed" });
  });
  it("documented exception: a mergeable:false note with a wikilink: the linked note is renamed -> this note's export changed -> a file with only the title changed is 409", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } }, "");
    const target = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Target before" });
    await seedBlocks(s.ctx.db, s.note.id, [
      { type: "paragraph", content: [{ type: "text", text: "See ", styles: {} }, { type: "wikilink", props: { targetNoteId: target.id, snapshotTitle: "Old snapshot" } }] },
      { type: "paragraph", content: "Para 1" },
    ]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain("Target before");
    await s.ctx.db.update(notes).set({ title: "Target after" }).where(eq(notes.id, target.id));
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Renamed unmergeable"), d.fm.base!);
  });
});

describe("typing into an empty paragraph and deleting it all counts as changed (documented in known-limitations)", () => {
  it("base A, empty paragraph, B; someone types into the empty paragraph and deletes it all -> a file editing A is 409", async () => {
    const s = await scene({}, "");
    await seedBlocks(s.ctx.db, s.note.id, [{ type: "paragraph", content: "A" }, { type: "paragraph" }, { type: "paragraph", content: "B" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => {
      ed.updateBlock(ed.document[1]!.id, { content: "x" });
      ed.updateBlock(ed.document[1]!.id, { content: [] });
    });
    expect((await downloadNote(s.ctx.app, s.bulk.token, s.note.id)).body).toBe(d.body); // export is verbatim identical
    await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace(/^A$/m, "A file")), d.fm.base!);
  });
});

describe("someone interleaves after the check, before the merge (TOCTOU)", () => {
  it("beforeMerge (planning and applying done, before the merge): someone changes another paragraph -> no merge, on retry judged note_changed; their change is there, the file's is not written", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { beforeMerge: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } }, "Para 0\n\nPara 1\n\nPara 2");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = () => humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[2]!.id, { content: "Para 2 human" }));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 0", "Para 0 file")));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual(NOTE_CHANGED);
    expect((await liveBlocks(s.ctx, s.note.id)).map(x => x.text)).toEqual(["Para 0", "Para 1", "Para 2 human"]);
    expect(await edits(s.ctx, s.note.id)).toHaveLength(0);
  });

  it("at beforeMerge someone appends a paragraph at the end of the document (touching no existing block) -> also blocked (whole-note fingerprint)", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { beforeMerge: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } }, "Para 0\n\nPara 1\n\nPara 2");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = () => humanEdit(s.ctx, s.note.id, ed => ed.insertBlocks([{ type: "paragraph", content: "Human tail" }], ed.document[2]!.id, "after"));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 0", "Para 0 file")));
    expect(r.statusCode).toBe(409);
    expect((await liveBlocks(s.ctx, s.note.id)).map(x => x.text)).toEqual(["Para 0", "Para 1", "Para 2", "Human tail"]);
  });

  it("title only: at the moment of rename (slug candidate hook, before the UPDATE) someone changes the title -> 409 note_changed, their title stays", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ slugUpdateTestHook: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ title: "Human title" }).where(eq(notes.id, s.note.id)); };
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "File title"));
    expect(r.statusCode).toBe(409);
    expect(errOf(r)).toEqual(NOTE_CHANGED);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Human title");
    const [row] = await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d.fm.base!));
    expect(row!.appliedTitleSha).toBeNull();
  });
});

describe("write quota counts only files that changed", () => {
  it("transferWrite used up: unchanged file -> 200 unchanged (charges tokenRead); changed file -> 429; resending a new file (dedupe hit) -> 200", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } }, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const newFile = "---\nknotebook: 1\ntitle: \"Fresh\"\n---\nFresh body";
    const created = await bulkPut(s.ctx.app, s.bulk.token, newFile);
    expect(created.statusCode).toBe(201);
    expect(transferWrite.isBlocked(s.u.id)).toBe(true);
    const same = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ result: "unchanged" });
    const again = await bulkPut(s.ctx.app, s.bulk.token, newFile);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, result: "unchanged" });
    const changed = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Para 1 x")));
    expect(changed.statusCode).toBe(429);
    expect(Number(changed.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(norm(await liveMarkdown(s.ctx, s.note.id))).toBe("Para 0\n\nPara 1");
  });
});

describe("zero region (bytes changed, every decision is same) = unchanged", () => {
  it("only blank lines added -> 200 unchanged, applied_body_sha not written, write quota refunded; with the quota used up the same file -> 429 (detecting a zero region needs parsing first, and it is charged before parsing)", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } }, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const blank = editBody(d.text, b => b.replace("Para 0\n", "Para 0\n\n\n"));
    const r = await bulkPut(s.ctx.app, s.bulk.token, blank);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "unchanged", applied: 0 });
    const [row] = await s.ctx.db.select().from(transferBases).where(eq(transferBases.key, d.fm.base!));
    expect(row!.appliedBodySha).toBeNull();
    expect(transferWrite.isBlocked(s.u.id)).toBe(false);
    expect((await bulkPut(s.ctx.app, s.bulk.token, "---\nknotebook: 1\ntitle: \"Fresh\"\n---\nFresh body")).statusCode).toBe(201);
    expect(transferWrite.isBlocked(s.u.id)).toBe(true);
    const again = await bulkPut(s.ctx.app, s.bulk.token, blank);
    expect(again.statusCode).toBe(429);
  });
  it("after a zero region the same copy with only the title changed -> renamed (not already_sent)", async () => {
    const s = await scene({}, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const blank = editBody(d.text, b => b.replace("Para 0\n", "Para 0\n\n\n"));
    expect((await bulkPut(s.ctx.app, s.bulk.token, blank)).json()).toMatchObject({ result: "unchanged" });
    const rn = await bulkPut(s.ctx.app, s.bulk.token, renameIn(blank, "Renamed after blank"));
    expect(rn.statusCode).toBe(200);
    expect(rn.json()).toMatchObject({ result: "renamed", renamed: true });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Renamed after blank");
  });
});

describe("front matter", () => {
  it("`id :` / `base :` (space before the colon) -> written to the original note, no new note created; base without id -> 400, nothing created", async () => {
    const s = await scene({}, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const count = async () => (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const n0 = await count();
    const spaced = editBody(d.text.replace(/^id: /m, "id : ").replace(/^base: /m, "base : "), b => b.replace("Para 1", "Para 1 spaced"));
    const r = await bulkPut(s.ctx.app, s.bulk.token, spaced);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: s.note.id, created: false, result: "applied" });
    expect(await count()).toBe(n0);
    const noId = d.text.replace(/^id: .*\n/m, "");
    const bad = await bulkPut(s.ctx.app, s.bulk.token, noId);
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad)).toEqual({ code: "invalid_body", message: BASE_WITHOUT_ID_MESSAGE });
    expect(await count()).toBe(n0);
  });
});

