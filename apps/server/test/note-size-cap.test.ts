/**
 * 筆記大小上限（`NOTE_MAX_BYTES`，`notes/note-size.ts`）：API／MCP／批次寫回／撤回／套用版本／複製只擋成長——修改後超過上限、而且比修改前大
 * 才拒絕（HTTP 413 `note_too_large` 帶 `limitBytes`；MCP 工具錯誤 `note_too_large`）。瀏覽器的協作更新不在 server 檢查（同 310006f）。
 * 已超過的筆記照常讀出與下載，刪減一律接受。上限在這裡壓到 20 000 位元組。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";
import { noteAiEdits, noteStates, notes } from "../src/db/schema.js";
import { logNotesOverCap } from "../src/notes/note-size-startup.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testConfig, testEditingRuntime } from "./helpers.js";
import { bearer, docText, getContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkGet, bulkPut, callTool, downloadNote, editBody, issueBulkDirect, seedMd } from "./bulk-transfer-helpers.js";

const CAP = 20_000;
const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: testConfig.appSecret, PUBLIC_URL: "http://localhost:3000", NOTE_MAX_BYTES: String(CAP) });
const PASSWORD = "correct-horse-battery";
/** n 個不同的段落（每段約 60 位元組的文字；存下的狀態每段約 270 位元組）。 */
const paras = (n: number, tag = "p") => Array.from({ length: n }, (_, k) => `${tag} ${k} lorem ipsum dolor sit amet consectetur adipiscing elit`).join("\n\n");
const BIG = paras(450); // 狀態約 120 KB：超過 CAP
const SMALL = paras(20); // 約 5 KB

async function scene() {
  const ctx = await buildCollabTestApp({ config });
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "N" });
  const stored = async (id = note.id) => {
    const [r] = await ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, id));
    return r ? r.ydoc.byteLength : 0;
  };
  const edit = (payload: Record<string, unknown>, id = note.id) => ctx.app.inject({ method: "POST", url: `/api/notes/${id}/edits`, headers: bearer(pat.token), payload });
  return { ctx, u, pat, note, stored, edit };
}
const expect413 = (res: { statusCode: number; json(): unknown }) => {
  expect(res.statusCode).toBe(413);
  expect((res.json() as { error: { code: string; limitBytes: number } }).error).toMatchObject({ code: "note_too_large", limitBytes: CAP });
};

describe("API／MCP 寫入：長過上限就拒絕，什麼都沒寫", () => {
  it("REST /edits append 讓筆記超過上限 → 413（limitBytes）；內容、紀錄都沒動；上限內的照常 201", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, SMALL);
    expect((await s.edit({ op: "append", markdown: paras(30, "ok") })).statusCode).toBe(201);
    const before = await s.stored();
    const res = await s.edit({ op: "append", markdown: paras(400, "big") });
    expect413(res);
    const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json();
    expect(c.markdown).not.toContain("big 0 ");
    expect(await s.stored()).toBe(before);
    expect(await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id))).toHaveLength(1);
    await s.ctx.destroy();
  });

  it("MCP edit_note → 工具錯誤 note_too_large（帶 limitBytes）", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, SMALL);
    const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "append", markdown: paras(400, "big") });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    await s.ctx.destroy();
  });

  it("帶 content 建立（REST POST /api/notes、MCP create_note）超過上限 → 413／note_too_large，一列都沒留下", async () => {
    const s = await scene();
    const count = async () => (await s.ctx.db.select({ id: notes.id }).from(notes)).length;
    const n0 = await count();
    const res = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.pat.token), payload: { title: "big", content: BIG } });
    expect413(res);
    const r = await callTool(s.ctx.app, s.pat.token, "create_note", { title: "big", content: BIG });
    expect(r.structuredContent).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    expect(await count()).toBe(n0);
    const ok = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.pat.token), payload: { title: "small", content: SMALL } });
    expect(ok.statusCode).toBe(201);
    await s.ctx.destroy();
  });

  it("批次寫回（改一段變很大）→ 413；批次新增大檔 → 413、沒建", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, SMALL);
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    const d = await downloadNote(s.ctx.app, bulk.token, s.note.id);
    const before = await s.stored();
    const r = await bulkPut(s.ctx.app, bulk.token, editBody(d.text, b => b + "\n\n" + paras(400, "big")));
    expect(r.statusCode, r.body).toBe(413);
    expect(r.json().error).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    expect(await s.stored()).toBe(before);
    const c = await bulkPut(s.ctx.app, bulk.token, `---\nknotebook: 1\ntitle: "new big"\n---\n${BIG}\n`);
    expect(c.statusCode, c.body).toBe(413);
    expect((await s.ctx.db.select().from(notes).where(eq(notes.title, "new big")))).toHaveLength(0);
    await s.ctx.destroy();
  });

  it("撤回一次刪段（把大段插回去）會超過上限 → 413；刪段本身（變小）照常", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, "# A\n\n" + paras(40, "a") + "\n\n# B\n\nb");
    const outline = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>;
    const a = outline.find(o => o.heading === "A")!;
    const del = await s.edit({ op: "delete_section", section_id: a.sectionId, if_match: a.fingerprint });
    expect(del.statusCode, del.body).toBe(201);
    // 別處長到快滿：再把 A 段插回去就超過
    const fill = await s.edit({ op: "append", markdown: paras(40, "fill") }); // 約 11 KB：仍在上限內
    expect(fill.statusCode, fill.body).toBe(201);
    const rev = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${del.json().editId}/revert`, headers: bearer(s.pat.token) });
    expect413(rev);
    await s.ctx.destroy();
  });

  it("複製一篇已經超過上限的筆記 → 413（副本是新筆記：比 0 大又超過）；上限內的照常複製", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, BIG);
    const cookie = `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId: s.u.id, tv: 0 })}`;
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/copy`, headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" }, payload: {} });
    expect413(res);
    const r = await callTool(s.ctx.app, s.pat.token, "copy_note", { note_id: s.note.id });
    expect(r.structuredContent).toMatchObject({ code: "note_too_large", limitBytes: CAP });
    const small = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "S" });
    await seedMd(s.ctx.db, small.id, SMALL);
    const ok = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${small.id}/copy`, headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" }, payload: {} });
    expect(ok.statusCode, ok.body).toBe(201);
    await s.ctx.destroy();
  });

  it("套用（還原）一個比現況大、而且超過上限的版本 → 413；現況不動", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, BIG); // 已超過上限（上限之前就存在的筆記）
    const cookie = `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId: s.u.id, tv: 0 })}`;
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" };
    const saved = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions`, headers, payload: {} });
    expect(saved.statusCode, saved.body).toBe(201);
    const c = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json();
    const shrink = await s.edit({ op: "replace_all", markdown: "small now", if_match: c.fingerprint }); // 變小：照常
    expect(shrink.statusCode, shrink.body).toBe(201);
    const after = await s.stored();
    const res = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/versions/${saved.json().seq}/apply`, headers, payload: { versionId: saved.json().id, discardUnsaved: true } });
    expect413(res);
    expect((await getContent(s.ctx.app, s.note.id, s.pat.token)).json().markdown).toContain("small now");
    expect(await s.stored()).toBe(after);
    await s.ctx.destroy();
  });
});

describe("已經超過上限的筆記：照常讀出、下載；刪除與改短照樣接受", () => {
  it("超過上限的筆記：/content、read_note_section、單篇下載都 200；刪一段、整篇換成短的 → 201", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, "# A\n\n" + paras(220, "a") + "\n\n# B\n\n" + paras(220, "b"));
    expect(await s.stored()).toBeGreaterThan(CAP);
    const c = await getContent(s.ctx.app, s.note.id, s.pat.token);
    expect(c.statusCode).toBe(200);
    const sec = await callTool(s.ctx.app, s.pat.token, "read_note_section", { note_id: s.note.id, section_id: "_top" });
    expect(sec.isError).toBeUndefined();
    const bulk = await issueBulkDirect(s.ctx.db, s.pat.tokenId, { access: "write" });
    expect((await bulkGet(s.ctx.app, `/api/transfer/notes/${s.note.id}`, bulk.token)).statusCode).toBe(200);
    // 還在上限之上、但變小：接受
    const b = (c.json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "B")!;
    const del = await s.edit({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint });
    expect(del.statusCode, del.body).toBe(201);
    // 超過上限的筆記不能再長大（即使只加一點）
    expect413(await s.edit({ op: "append", markdown: "one more line" }));
    const now = (await getContent(s.ctx.app, s.note.id, s.pat.token)).json();
    const short = await s.edit({ op: "replace_all", markdown: "short", if_match: now.fingerprint });
    expect(short.statusCode, short.body).toBe(201);
    await s.ctx.destroy();
  });
});

describe("瀏覽器的協作更新不在 server 檢查（網頁編輯器在貼上、拖放、站內 AI 套用之前自己擋）", () => {
  it("協作用戶端貼上一大段讓筆記超過上限 → server 照常套用、轉給另一個用戶端，連線不被關", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await ctx.createUser({ email: "c@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("c@example.com", PASSWORD);
    const a = await session.connect(note.id);
    const b = await session.connect(note.id);
    const s = await EditorSession.open(testEditingRuntime, a.doc);
    try {
      const top = s.editor.document;
      s.editor.insertBlocks(paras(400, "huge").split("\n\n").map(t => ({ type: "paragraph", content: t })), top[top.length - 1]!.id, "after");
    } finally {
      s.close();
    }
    expect(Y.encodeStateAsUpdate(a.doc).byteLength).toBeGreaterThan(CAP);
    await waitFor("server 與 b 收到", 10_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("huge 399 ") && docText(b.doc).includes("huge 399 "));
    expect(a.closes).toHaveLength(0);
    a.disconnect();
    b.disconnect();
    await ctx.destroy();
  }, 60_000);
});

describe("刪減與等量改寫一律接受（依結果判斷：還在的內容沒變多、狀態一次長不超過 SLACK，審查 r4 I3、r6）", () => {
  it("超過上限的筆記：把一段改成短一點的字（狀態可能因結構成本變大）→ REST 201、MCP 照樣成功", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, "# A\n\n" + paras(220, "a") + "\n\n# B\n\nhello wonderful world");
    expect(await s.stored()).toBeGreaterThan(CAP);
    const b = ((await getContent(s.ctx.app, s.note.id, s.pat.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "B")!;
    const res = await s.edit({ op: "replace_section", section_id: b.sectionId, markdown: "# B\n\nhello world", if_match: b.fingerprint });
    expect(res.statusCode, res.body).toBe(201);
    const b2 = ((await getContent(s.ctx.app, s.note.id, s.pat.token)).json().outline as Array<{ sectionId: string; heading: string; fingerprint: string }>).find(o => o.heading === "B")!;
    const r = await callTool(s.ctx.app, s.pat.token, "edit_note", { note_id: s.note.id, op: "replace_section", section_id: b2.sectionId, markdown: "# B\n\nhi", if_match: b2.fingerprint });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
    await s.ctx.destroy();
  });

  it("被 413 擋下的複製不吃 edit 額度（審查 r4 M7）：連續 35 次被擋之後，上限內的複製照樣 201", async () => {
    const s = await scene();
    await seedMd(s.ctx.db, s.note.id, BIG);
    const small = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "S" });
    await seedMd(s.ctx.db, small.id, SMALL);
    const cookie = `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId: s.u.id, tv: 0 })}`;
    const headers = { cookie, "content-type": "application/json", origin: "http://localhost:3000" };
    for (let i = 0; i < 35; i++) expect413(await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/copy`, headers, payload: {} }));
    const ok = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${small.id}/copy`, headers, payload: {} });
    expect(ok.statusCode, ok.body).toBe(201);
    await s.ctx.destroy();
  });
});

describe("開機日誌", () => {
  it("記下已經超過上限的筆記：篇數與 id（不記標題）；沒有就記 0", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const big = await seedNote(ctx.db, { ownerId: u.id }, { title: "秘密標題" });
    const small = await seedNote(ctx.db, { ownerId: u.id }, { title: "S" });
    await seedMd(ctx.db, big.id, BIG);
    await seedMd(ctx.db, small.id, SMALL);
    const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
    const log = { info: (obj: object, msg: string) => lines.push({ level: "info", obj: obj as Record<string, unknown>, msg }), warn: (obj: object, msg: string) => lines.push({ level: "warn", obj: obj as Record<string, unknown>, msg }) };
    const r = await logNotesOverCap(ctx.db, CAP, log);
    expect(r).toEqual({ count: 1, noteIds: [big.id] });
    expect(lines).toEqual([{ level: "warn", obj: { limitBytes: CAP, count: 1, noteIds: [big.id] }, msg: expect.stringContaining("over the note size limit") }]);
    expect(JSON.stringify(lines)).not.toContain("秘密標題");
    lines.length = 0;
    expect(await logNotesOverCap(ctx.db, 10 * CAP, log)).toEqual({ count: 0, noteIds: [] });
    expect(lines[0]).toMatchObject({ level: "info", obj: { limitBytes: 10 * CAP, count: 0 } });
    await ctx.destroy();
  });
});
