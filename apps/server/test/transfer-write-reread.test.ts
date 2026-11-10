/**
 * 批次寫回「下載後筆記被動過 → 409 note_changed」（不再三方合併）。
 * E0：同一篇沒動過的筆記重複匯出逐位元組相同（冷筆記、live 文件已載入記憶體）——`note_changed` 的判斷以此為前提。
 * NC1–NC9：九案；NC10–NC12：檢查與套用之間的插隊（TOCTOU）、寫回額度、front matter。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noteAiEdits, notes, noteVersions, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { EditorSession } from "../src/notes/editing/session.js";
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

describe("E0 重複匯出逐位元組相同", () => {
  it("冷筆記：連續兩次下載本文相同", async () => {
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

  it("live 文件已載入記憶體（有連線）：連續兩次下載本文相同；連線斷開、卸載後的冷讀也相同", async () => {
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

/** MCP `edit_note`（真的經 /api/mcp）：以 heading 找段，`replace_section`／`delete_section`。 */
async function mcpSectionEdit(s: Scene, heading: string, op: "replace_section" | "delete_section", markdown?: string) {
  const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json() as { outline: Array<{ sectionId: string; heading: string; fingerprint: string }> };
  const sec = c.outline.find(o => o.heading === heading)!;
  const args = { note_id: s.note.id, op, section_id: sec.sectionId, if_match: sec.fingerprint, ...(markdown !== undefined ? { markdown } : {}) };
  const r = await callTool(s.ctx.app, s.pat.token, "edit_note", args);
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
}
/** MCP rename（#381 起要帶 `if_match`＝`read_note_outline` 的 `titleFingerprint`，照模型的真實流程先讀）。 */
async function mcpRename(s: Scene, title: string) {
  const o = await callTool(s.ctx.app, s.pat.token, "read_note_outline", { note_id: s.note.id });
  expect(o.isError, JSON.stringify(o.structuredContent)).toBeUndefined();
  const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "rename", title, if_match: o.structuredContent.titleFingerprint });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
}
/** 送檔 → 409 note_changed；內容、標題、紀錄列、版本、基底都沒動。 */
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

describe("NC 下載後筆記動過 → 409 note_changed", () => {
  it("NC1 下載後別人用 MCP edit_note 改了別章 → 送回（改第一章）409 note_changed、筆記不變；重新下載重做 → 200", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第三章", "replace_section", "# 第三章\n\n段落 D1 被 edit_note 改");
    const text = editBody(d.text, b => b.replace("段落 A1", "段落 A1 檔案改"));
    const md0 = await expectNoteChanged(s, s.bulk.token, text, d.fm.base!);
    expect(md0).toContain("段落 D1 被 edit_note 改");
    expect(md0).not.toContain("檔案改");
    // 內文被別人改過，檔案只改標題也一樣拒絕
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Title from file"), d.fm.base!);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d2.text, b => b.replace("段落 A1", "段落 A1 檔案改")));
    expect(r.json()).toMatchObject({ result: "applied", applied: 1 });
    const md = await liveMarkdown(s.ctx, s.note.id);
    expect(md).toContain("段落 A1 檔案改");
    expect(md).toContain("段落 D1 被 edit_note 改");
  });

  it("NC2 下載後別人只改了標題（edit_note rename）→ 送回改內文 409；送回只改標題也 409；標題、內文都不變", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpRename(s, "Renamed by edit_note");
    await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace("段落 A1", "段落 A1 檔案改")), d.fm.base!);
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Renamed by file"), d.fm.base!);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Renamed by edit_note");
  });

  it("NC3 相鄰 X、Y：副本 A 先寫回改 X → 副本 B 改 X 與 Y（同一區）→ 409、X 只有一份", async () => {
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

  it("NC4 插入：edit_note 換掉第二章 → 送舊副本在 C1 後插一段 → 409（不再插到別章）", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第二章", "replace_section", "# 第二章\n\n段落 C1 AI 改過\n\n* 清單一\n* 清單二");
    const md = await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace("段落 C1", "段落 C1\n\n檔案新插的段")), d.fm.base!);
    expect(md).not.toContain("檔案新插的段");
  });

  it("NC5 刪除：edit_note 改過那一段 → 送舊副本刪掉它 → 409（不再回 unchanged／same）、那段還在", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await mcpSectionEdit(s, "第三章", "replace_section", "# 第三章\n\n段落 D1 被改");
    const md = await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace(/\n\n段落 D1\s*$/, "")), d.fm.base!);
    expect(md).toContain("段落 D1 被改");
  });

  it("NC6 筆記沒動 → 改寫＋插入＋刪除＋改名一次套用、結果＝檔案；沒動的 block 留原 id、沒有存版", async () => {
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

  it("NC7 檔案沒改、筆記被動過（內文與標題都被改）→ 200 unchanged、什麼都不寫", async () => {
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

  it("NC8 同副本寫回後：別人再改、送同一份 → unchanged；送別的內容 → already_sent（不被 note_changed 搶先）；撤回後送同一份 → reverted", async () => {
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

  it("NC9 live 文件開著（瀏覽器連線）時有人打字 → 409 note_changed、打的字還在、檔案的修改沒寫", async () => {
    const PASS = "correct-horse-battery";
    const ctx = await buildCollabTestApp();
    const email = `o-${randomUUID()}@example.com`;
    const owner = await ctx.createUser({ email, password: PASS });
    const n = await ctx.createNote(owner.id);
    const client = await seedContent(ctx, await ctx.loginAs(email, PASS), n.id, "First para\n\nSecond para\n\nThird para live-nc9");
    const pat = await seedTokenForUser(ctx.db, owner.id, "notes:read notes:write");
    const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
    const d = await downloadNote(ctx.app, bulk.token, n.id);
    // 瀏覽器端（provider 的 doc）打字：改第三段
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

describe("NC13 匯出相同、結構不同", () => {
  it("別人把一段換成內容相同的新 block（id 換了，整篇匯出逐字相同）→ 改別段的檔 409 note_changed", async () => {
    const s = await scene({}, "Para 0\n\nPara 1\n\nPara 2");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks([ed.document[1]!.id], [{ type: "paragraph", content: "Para 1" }]));
    expect((await downloadNote(s.ctx.app, s.bulk.token, s.note.id)).body).toBe(d.body);
    await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace("Para 2", "Para 2 file")), d.fm.base!);
  });
});

describe("NC14／NC15 「動過」只看這篇自己的內容（結構比對，不照匯出比）", () => {
  for (const change of ["rename", "invisible"] as const) {
    it(`NC14 連到別篇的 wikilink（沒有自訂文字、顯示對方現行標題）：對方${change === "rename" ? "改名" : "變成看不到（進垃圾桶）"} → 不算動過、改別段的檔 200；wikilink 那顆 id 與屬性不變`, async () => {
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
      expect((await downloadNote(s.ctx.app, s.bulk.token, s.note.id)).body).not.toBe(d.body); // 前提：這篇的匯出確實變了
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

  it("NC15 下載後筆記被搬進資料夾、分享給別人 → 不算動過：改內文的檔照常 200 applied", async () => {
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

describe("NC16 寫回過本文的副本不再收標題修改", () => {
  it("副本寫回 Para 0 → 別人改 Para 2 → 同一份檔只改 title 再送 → 409 already_sent、標題不變、別人的修改在", async () => {
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

describe("NC17 基底 0 顆、現況恰一顆空段落（瀏覽器打開會正規化出來）", () => {
  const loneEmpty = (s: Scene, typed: boolean) =>
    humanEdit(s.ctx, s.note.id, ed => {
      ed.insertBlocks([{ type: "paragraph", content: typed ? "typed" : "" }], ed.document[0]!.id, "after");
      ed.removeBlocks([ed.document[0]!.id]);
      if (typed) ed.updateBlock(ed.document[0]!.id, { content: [] });
    });
  for (const typed of [false, true]) {
    it(`當沒動過：寫兩段 → 200、結果恰兩段（那顆空段落被換掉）${typed ? "；打過字又刪光的空段落也一樣" : ""}`, async () => {
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
  it("對照：那一顆段落有字 → 409；有兩顆空段落 → 409", async () => {
    const s = await scene({}, "");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks(ed.document.map(b => b.id), [{ type: "paragraph" }, { type: "paragraph" }]));
    await expectNoteChanged(s, s.bulk.token, `${d.text}Agent para`, d.fm.base!);
    await humanEdit(s.ctx, s.note.id, ed => ed.replaceBlocks(ed.document.map(b => b.id), [{ type: "paragraph", content: "Human" }]));
    await expectNoteChanged(s, s.bulk.token, `${d.text}Agent para`, d.fm.base!);
  });
});

describe("NC19 段表 null（mergeable: false）只改標題：退回整篇匯出比對", () => {
  it("下載後別人改了內文 → 只改 title 的檔 409、標題不變；沒人改 → renamed（對照）", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } }, "Para 0\n\nPara 1");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { content: "Para 1 human" }));
    await expectNoteChanged(s, s.bulk.token, renameIn(d.text, "Renamed unmergeable"), d.fm.base!);
    const d2 = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d2.text, "Renamed unmergeable"))).json()).toMatchObject({ result: "renamed" });
  });
  it("（docs 寫明的例外）含 wikilink 的 mergeable:false 筆記：連到的筆記改名 → 這篇的匯出變了 → 只改 title 的檔 409", async () => {
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

describe("NC18 空段落打字再刪光算動過（known-limitations 寫明）", () => {
  it("基底 A、空段落、B；別人在空段落打字再刪光 → 改 A 的檔 409", async () => {
    const s = await scene({}, "");
    await seedBlocks(s.ctx.db, s.note.id, [{ type: "paragraph", content: "A" }, { type: "paragraph" }, { type: "paragraph", content: "B" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    await humanEdit(s.ctx, s.note.id, ed => {
      ed.updateBlock(ed.document[1]!.id, { content: "x" });
      ed.updateBlock(ed.document[1]!.id, { content: [] });
    });
    expect((await downloadNote(s.ctx.app, s.bulk.token, s.note.id)).body).toBe(d.body); // 匯出一字不差
    await expectNoteChanged(s, s.bulk.token, editBody(d.text, b => b.replace(/^A$/m, "A file")), d.fm.base!);
  });
});

describe("NC10 檢查之後、合併之前插隊（TOCTOU）", () => {
  it("NC10a beforeMerge（規劃與套用都做完、合併前）別人改了另一段 → 不合併、重來時判成 note_changed；別人的修改在、檔案的沒寫", async () => {
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

  it("NC10b beforeMerge 時別人在文件結尾加一段（不動任何既有 block）→ 也擋下（整篇指紋）", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { beforeMerge: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } }, "Para 0\n\nPara 1\n\nPara 2");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = () => humanEdit(s.ctx, s.note.id, ed => ed.insertBlocks([{ type: "paragraph", content: "Human tail" }], ed.document[2]!.id, "after"));
    const r = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 0", "Para 0 file")));
    expect(r.statusCode).toBe(409);
    expect((await liveBlocks(s.ctx, s.note.id)).map(x => x.text)).toEqual(["Para 0", "Para 1", "Para 2", "Human tail"]);
  });

  it("NC10c 只改標題：改名那一刻（slug 候選縫，UPDATE 之前）別人改了標題 → 409 note_changed、別人的標題留著", async () => {
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

describe("NC11 寫回額度只看有改的檔", () => {
  it("transferWrite 用完：沒改的檔 → 200 unchanged（扣 tokenRead）；有改的檔 → 429；新增檔重送（去重命中）→ 200", async () => {
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

describe("NC20 零區（位元組有變、決策全是 same）＝unchanged", () => {
  it("只加空行 → 200 unchanged、applied_body_sha 不寫、寫回額度退回；額度用完時同一個檔 → 429（判零區要先解析，解析前就扣）", async () => {
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
  it("零區之後同一份副本只改標題 → renamed（不是 already_sent）", async () => {
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

describe("NC12 front matter", () => {
  it("`id :`／`base :`（冒號前有空白）→ 寫回原筆記、不建新筆記；有 base 沒 id → 400、什麼都沒建", async () => {
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

