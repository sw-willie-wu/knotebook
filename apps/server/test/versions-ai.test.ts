// 版本歷史 × AI／MCP／REST 寫入（#272 spec 2026-10-13 §4.2、§12.1 案 19、28、29、D10：AI／直寫前後不再立刻切版，只記成待切，
// 停手 X 後由掃描器切——人與 AI 在同一段安靜期內就在同一版。本檔的 harness 把 X 壓成 0，掃描一律手動呼叫 `scanDue()`）。
// 前 spec 2026-10-09 D9 的 create_note、§7-3 落款閘門、拆分後的守衛照舊。
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { noteAiEdits, notes, users } from "../src/db/schema.js";
import { withDirectConnection, type DirectCtx } from "../src/notes/editing/session.js";
import { VACUUM_VERSION_FINGERPRINT } from "../src/notes/version-fingerprint.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, type CollabTestCtx, type TestClient } from "./helpers.js";
import { NO_PENDING, pendingOf, seedOldNote, versionsOf, waitForPending } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const LABEL_TOKEN = "Claude Code (knotebook)";

async function setup() {
  const ctx = await buildCollabTestApp({ versionAutoWaitMs: 0 });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", LABEL_TOKEN);
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const edit = (body: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: body });
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  const scan = () => ctx.collab.versions.scanDue();
  return { ctx, u, note, session, token, content, edit, unloaded, scan };
}
const human = (userId: string) => ({ user_id: userId, agent_label: null });
const hasAgent = (userId: string) => (e: { user_id: string; agent_label: string | null }) => e.user_id === userId && e.agent_label !== null;

/** 在 client.doc 第一顆段落的文字上做一次編輯（模擬瀏覽器打字），等 server 收到。 */
async function typeFirst(ctx: CollabTestCtx, noteId: string, client: TestClient, fn: (t: Y.XmlText) => void, until: (s: string) => boolean): Promise<void> {
  const p = topLevelContainers(client.doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  client.doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到", 5_000, () => until(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

describe("#272：AI 寫入不再立刻切版（D2）", () => {
  it("人工未存＋AI 寫入 → 當下 0 版；離開後掃描 → 1 版，人與 AI 同一版、內容含兩邊（M10：寫前切版回來會多一版）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    expect((await s.edit({ op: "append", markdown: "AI 加的一段" })).statusCode).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    const p = await waitForPending(s.ctx.db, s.note.id, x => x.editors.some(hasAgent(s.u.id)));
    expect(p.editors).toContainEqual(human(s.u.id));
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]); // 離開也不切
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    expect(rows[0]!.editors).toContainEqual(human(s.u.id));
    expect(rows[0]!.editors.some(hasAgent(s.u.id))).toBe(true);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(docText(v1)).toContain("人打的未存內容");
    expect(docText(v1)).toContain("AI 加的一段");
  });

  it("已手動存過、AI 寫入 → 當下不增版；掃描後 +1，editors 只有 AI（存檔之後沒改的人不在名單）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "先存起來的內容");
    await waitForPending(s.ctx.db, s.note.id); // 種子那批人的落盤先寫進待切，再手動存（存檔清待切）
    const live = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    await s.ctx.collab.versions.cutIfDirty(s.note.id, live, { kind: "manual" });
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    expect((await s.edit({ op: "append", markdown: "AI 第二段" })).statusCode).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    await waitForPending(s.ctx.db, s.note.id);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.editors).toHaveLength(1);
    expect(rows[1]!.editors.every(hasAgent(s.u.id))).toBe(true);
    client.disconnect();
  });

  it("沒有基底、直接寫 note_states 的舊筆記被 AI 直連寫入（沒人開著）→ 當下 0 版；掃描後 1 版、editors 只有 AI", async () => {
    const s = await setup();
    await seedOldNote(s.ctx.db, s.note.id, "功能上線前就有的筆記");
    expect((await s.edit({ op: "append", markdown: "AI 補一段" })).statusCode).toBe(201);
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(1);
    expect(rows[0]!.editors[0]!.agent_label).not.toBeNull();
  });

  it("被拒的寫入（if_match 不符）不切版、AI 不進待切名單", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    const res = await s.edit({ op: "replace_all", markdown: "x", if_match: "0000000000000000" });
    expect(res.statusCode).toBe(409);
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
    const p = await waitForPending(s.ctx.db, s.note.id);
    expect(p.editors).toEqual([human(s.u.id)]);
    client.disconnect();
  });

  it("自動儲存關閉（個人空間）→ AI 寫入後不待切、掃描 0 版", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的未存內容");
    expect((await s.edit({ op: "append", markdown: "AI" })).statusCode).toBe(201);
    client.disconnect();
    await s.unloaded();
    expect(await pendingOf(s.ctx.db, s.note.id)).toEqual(NO_PENDING);
    await s.scan();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });
});

describe("案 19：create_note 帶 content（前 spec D9）", () => {
  it("POST /api/notes 帶 content（token）→ 當下 0 版、待切的參考指紋＝真空；掃描後 1 版、editors 只有 AI", async () => {
    const s = await setup();
    const res = await s.ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(s.token), payload: { title: "新", content: "AI 建的筆記內容" } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, id)).toEqual([]);
    expect((await pendingOf(s.ctx.db, id)).ref).toBe(VACUUM_VERSION_FINGERPRINT);
    await s.scan();
    const rows = await versionsOf(s.ctx.db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(1);
    expect(rows[0]!.editors[0]!.agent_label).not.toBeNull();
  });
});

describe("D13：編輯者歸屬（spec §1.4）", () => {
  it("案 28：人在 WS 編輯（框選 AI 框的結果也走這條）＋cookie POST /edits → 掃描後該版 editors 只有 {user_id, agent_label: null}", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人在瀏覽器打的");
    const res = await s.session.fetch(`/api/notes/${s.note.id}/edits`, { method: "POST", body: JSON.stringify({ op: "append", markdown: "cookie 直寫的一段" }) });
    expect(res.status).toBe(201);
    client.disconnect();
    await s.unloaded();
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toEqual([human(s.u.id)]);
  });

  it("案 29：PAT POST /edits（token 有 agent 名稱）→ 掃描後 editors 含 {user_id, agent_label}（與這次寫入記下的 agent 名稱相同）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "人打的");
    expect((await s.edit({ op: "append", markdown: "PAT 寫的" })).statusCode).toBe(201);
    const [rec] = await s.ctx.db.select({ label: noteAiEdits.agentLabel }).from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(rec!.label).not.toBeNull();
    client.disconnect();
    await s.unloaded();
    await s.scan();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.editors).toHaveLength(2);
    expect(rows[0]!.editors).toContainEqual(human(s.u.id));
    expect(rows[0]!.editors).toContainEqual({ user_id: s.u.id, agent_label: rec!.label });
  });
});

describe("D10：AI 修改紀錄不變（spec §1.4）", () => {
  it("有人工待切時撤回一筆 AI 修改 → 當下不增版；有 op='revert' 列、原列 reverted_at 有值；待切 editors 多了撤回者", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "撤回測試原文");
    const ai = await s.edit({ op: "append", markdown: "AI 這段會被撤回" });
    expect(ai.statusCode).toBe(201);
    const editId = ai.json().editId as string;
    await waitForPending(s.ctx.db, s.note.id, x => x.editors.some(hasAgent(s.u.id)));
    await s.scan(); // 先把人＋AI 那段切成 v1，待切清空
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    await typeFirst(s.ctx, s.note.id, client, t => t.insert(0, "人又改"), x => x.includes("人又改"));
    await waitForPending(s.ctx.db, s.note.id, x => x.editors.length === 1);
    expect((await pendingOf(s.ctx.db, s.note.id)).editors).toEqual([human(s.u.id)]);
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${editId}/revert`, headers: bearer(s.token) });
    expect(rv.statusCode).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(1);
    const recs = await s.ctx.db.select({ id: noteAiEdits.id, op: noteAiEdits.op, revertedAt: noteAiEdits.revertedAt }).from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(recs.filter(r => r.op === "revert")).toHaveLength(1);
    expect(recs.find(r => r.id === editId)!.revertedAt).not.toBeNull();
    const p = await waitForPending(s.ctx.db, s.note.id, x => x.editors.some(hasAgent(s.u.id)));
    expect(p.editors).toHaveLength(2);
    expect(p.editors[0]).toEqual(human(s.u.id));
    expect(p.editors[1]).toMatchObject({ user_id: s.u.id });
    expect(p.editors[1]!.agent_label).not.toBeNull();
    client.disconnect();
  });
});

describe("§7-3 落款閘門：直連一律看 applied", () => {
  it("version-apply：applied=false 不落款；applied=true 落款寫人、token 與 agent label 為 null", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "落款測試內容");
    const lastAt = async () => (await s.ctx.db.select({ at: notes.lastEditedAt }).from(notes).where(eq(notes.id, s.note.id)))[0]!.at;
    // 先等種子那批人的 debounced store 落款（2 s）——否則它可能在下面兩次讀之間才落地，把「沒落款」測成「有落款」。
    await expect.poll(async () => (await lastAt()) !== null, { timeout: 10_000 }).toBe(true);
    const before = await lastAt();
    const ctx: DirectCtx = { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false };
    await withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ctx, () => undefined);
    expect(await lastAt()).toEqual(before);
    const ok: DirectCtx = { ...ctx, applied: true };
    await withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ok, () => undefined);
    const [row] = await s.ctx.db
      .select({ by: notes.lastEditedBy, tokenId: notes.lastEditedTokenId, label: notes.lastEditedAgentLabel })
      .from(notes)
      .where(eq(notes.id, s.note.id));
    expect(row).toEqual({ by: s.u.id, tokenId: null, label: null });
    client.disconnect();
  });

  it("beforeDisconnect 在 transact 成功之後、disconnect 之前跑，收到 fn 的回傳；fn 丟錯時不跑", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "鉤子順序內容");
    const order: string[] = [];
    const ctx: DirectCtx = { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false };
    // 鉤內的斷言會被 withDirectConnection 吞掉（只 log），所以只記錄、出來再斷言。
    await withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ctx, () => 42, {
      beforeDisconnect: async r => {
        order.push(`bd:${r}:loaded=${s.ctx.collab.hocuspocus.documents.has(s.note.id)}`);
      },
    });
    expect(order).toEqual(["bd:42:loaded=true"]);
    await expect(withDirectConnection(s.ctx.collab.hocuspocus, s.note.id, ctx, () => { throw new Error("boom"); }, {
      beforeDisconnect: async () => { order.push("不該跑"); },
    })).rejects.toThrow("boom");
    expect(order).toEqual(["bd:42:loaded=true"]);
    client.disconnect();
  });
});

describe("拆分後的守衛", () => {
  it("applyEdit 的 afterBlockIds／fingerprint 行為不變（寫入後讀到的 fingerprint 等於回覆）", async () => {
    const s = await setup();
    const client = await seedContent(s.ctx, s.session, s.note.id, "# A\n\n第一段");
    const c = await s.content();
    const res = await s.edit({ op: "replace_all", markdown: "# B\n\n新內容", if_match: c.fingerprint });
    expect(res.statusCode).toBe(201);
    await waitFor("provider 收到", 3_000, () => docText(client.doc).includes("新內容"));
    expect((await s.content()).fingerprint).toBe(res.json().fingerprint);
    expect(topLevelContainers(client.doc.getXmlFragment(YDOC_FRAGMENT)).length).toBeGreaterThan(0);
    client.disconnect();
  });
});
