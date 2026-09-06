// #106 D6（spec §9）最後編輯落款的整合守衛：`collab/server.ts` 的 `onStoreDocument` 兩分支
// （人＝WS 的 `CollabContext`、AI＝直連的 `DirectCtx`）＋`applied` 閘，以及 `NoteDto.lastEdited`
// 的每一個產出點（list／`:ref`／by-path／POST／PATCH）。
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE, YDOC_FRAGMENT } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { notes } from "../src/db/schema.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testConfig, testEditingRuntime } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
type Ctx = Awaited<ReturnType<typeof buildCollabTestApp>>;
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId, tv: 0 })}`;
const row = (ctx: Ctx, id: string) => ctx.db.select().from(notes).where(eq(notes.id, id)).then(r => r[0]!);
/** disconnect 之後的唯一等法：size 歸零＝onStoreDocument（含 last_edited UPDATE）已 await 完。 */
const settled = (ctx: Ctx) => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);

describe("最後編輯", () => {
  it("人在編輯器寫 → at 有值、by=人、token/label NULL；AI 寫 → token/label 有值；拒絕路徑（live 409）不變", async () => {
    // hook 要用到 `buildCollabTestApp` 的結果，而 hook 又必須在建 app 之前就交出去——先傳一個
    // 空物件（同一個參照一路到 `applyDeps.testHooks`），再把 `beforeMerge` 掛上去。
    // `deps.testHooks?.beforeMerge` 是**呼叫時**才讀，所以晚掛仍生效（同 note-edits.test.ts）。
    const hooks: EditingTestHooks = {};
    const ctx = await buildCollabTestApp({ editingTestHooks: hooks });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    let client = await seedContent(ctx, session, note.id, "# A\n\n一");
    // ⚠ 這個 hook 只在本案最後那一次（拒絕路徑）該動作——中間那次 AI append 發生在 client 已斷線之後，
    // 若照樣注入，編輯永遠到不了 server，內建的 waitFor 會逾時。用旗標明確控制，不要靠時序。
    let injectConcurrent = false;
    // ⚠ try/finally（模組層單例 runtime 的 lease）＋等到 **server** 收到（改動要經 WS 才到 server）。
    hooks.beforeMerge = async () => {
      if (!injectConcurrent) return;
      const s = await EditorSession.open(testEditingRuntime, client.doc);
      try {
        s.editor.updateBlock(s.editor.document[1]!.id, { content: "併發" });
      } finally {
        s.close();
      }
      await waitFor("server 收到併發編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("併發"));
    };
    // store debounce 2s：用 disconnect 觸發立即 store，再等文件卸載（＝store 已 await 完）。
    client.disconnect(); await settled(ctx);
    let r = await row(ctx, note.id);
    expect(r.lastEditedAt).not.toBeNull(); expect(r.lastEditedBy).toBe(u.id); expect(r.lastEditedTokenId).toBeNull(); expect(r.lastEditedAgentLabel).toBeNull();
    const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code");
    const c = (await getContent(ctx.app, note.id, token)).json();
    const humanAt = r.lastEditedAt!.getTime();
    expect((await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "AI" } })).statusCode).toBe(201);
    r = await row(ctx, note.id);
    expect(r.lastEditedTokenId).toBe(tokenId); expect(r.lastEditedAgentLabel).toBe("claude"); expect(r.lastEditedAt!.getTime()).toBeGreaterThan(humanAt);
    const aiAt = r.lastEditedAt!.getTime();
    client = await session.connect(note.id);
    injectConcurrent = true; // 從這裡開始，beforeMerge 才注入併發編輯
    const a = (await getContent(ctx.app, note.id, token)).json().outline[1];
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nx", if_match: a.fingerprint } });
    expect(res.statusCode).toBe(409);
    expect((await row(ctx, note.id)).lastEditedAt!.getTime()).toBe(aiAt); // applied=false → 不寫
    expect(c.lastEdited).not.toBeNull();
  });

  it("GET /api/notes 每筆 lastEdited；:ref 與 by-path 在 AI 寫入後回非 null；PATCH 不清掉；POST 無 content → null、帶 content → 與 DB 一致", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Bot");
    const cookie = await cookieFor(u.id);
    const plain = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "P" } });
    expect(plain.json().lastEdited).toBeNull();
    const withContent = await ctx.app.inject({ method: "POST", url: "/api/notes", headers: bearer(token), payload: { title: "C", content: "hi" } });
    const dto = withContent.json();
    // ⚠ handle **不能硬寫成 `"a"`**：`ctx.createUser` 不帶 handle，該欄吃 DB default
    // （`'user-' || substr(gen_random_uuid()::text, 1, 8)`，每次都不一樣）。這篇的擁有者就是那位
    // 編輯者，所以直接拿**同一個回應**裡的 `ownerHandle` 當期望值（底下 by-path 那行本來就這麼用）。
    // 不要退化成 `expect.any(String)`——那會把「落款指向的是正確那位編輯者」這條守衛拿掉
    // （`toNoteDto` 的 `editorHandle` 關聯漏接時會回空字串，正是這一格要抓的）。
    expect(dto.lastEdited).toMatchObject({ byHandle: dto.ownerHandle, agentLabel: "bot" });
    const id = dto.id;
    const list = (await ctx.app.inject({ method: "GET", url: "/api/notes", headers: { cookie } })).json();
    expect(list.find((n: { id: string }) => n.id === id).lastEdited.agentLabel).toBe("bot");
    expect((await ctx.app.inject({ method: "GET", url: `/api/notes/${id}`, headers: { cookie } })).json().lastEdited.agentLabel).toBe("bot");
    expect((await ctx.app.inject({ method: "GET", url: `/api/notes/by-path/${dto.ownerHandle}/${dto.slug}`, headers: { cookie } })).json().lastEdited.agentLabel).toBe("bot");
    const patched = await ctx.app.inject({ method: "PATCH", url: `/api/notes/${id}`, headers: { cookie }, payload: { title: "C2" } });
    // ⚠ 這一行**不能只驗 agentLabel**：PATCH 的落款 handle 是 `.returning()` 之後另外補查來的
    // （`editorHandleOf`），只驗 agentLabel 的話「補查漏接 → byHandle 變空字串」完全抓不到
    // （突變 M5c 實測存活）。與 POST 那格同一形：拿同一個回應裡的 ownerHandle 當期望值。
    expect(patched.json().lastEdited).toMatchObject({ byHandle: dto.ownerHandle, agentLabel: "bot" });
  });

  it("讀取假綠守衛補：連讀 20 次 last_edited_* 不變", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    expect((await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "x" } })).statusCode).toBe(201);
    const before = await row(ctx, note.id);
    for (let i = 0; i < 20; i += 1) await getContent(ctx.app, note.id, token);
    const after = await row(ctx, note.id);
    expect(after.lastEditedAt!.getTime()).toBe(before.lastEditedAt!.getTime());
  });

  it("onStoreDocument 的 UPDATE 拋錯只 warn、note_states 照樣落盤；lastContext.userId 非字串不 UPDATE", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    // 讓 notes 的 UPDATE 炸：先把 last_edited_by 的 FK 目標砍掉不可行（cascade），改以 pg 觸發器
    // 讓 UPDATE 失敗，落盤後再移除。⚠ 一律用 `sql` 樣板（本 repo 慣例，見 collab-auth.test.ts），
    // 不要把 id 串進裸字串。
    await ctx.db.execute(sql`create or replace function knb_boom() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await ctx.db.execute(sql`create trigger knb_boom_trg before update of last_edited_at on notes for each row execute function knb_boom()`);
    // 種子不用 `"x"`：`seedContent` 的哨兵是最後一行的可見文字，而 `docText()` 是整段 XML
    // 字串——`textColor` 這類屬性名本身就含 `x`，單字元 ASCII 哨兵會立刻命中，等於沒等。
    const client = await seedContent(ctx, session, note.id, "觸發器種子");
    client.disconnect(); await settled(ctx);
    expect((await ctx.db.execute(sql`select 1 from note_states where note_id = ${note.id}`)).rowCount).toBe(1);
    expect((await row(ctx, note.id)).lastEditedAt).toBeNull();
    expect(ctx.collabLogs.some(l => l.level === "warn" && /last_edited/.test(l.msg))).toBe(true);
    await ctx.db.execute(sql`drop trigger knb_boom_trg on notes`);
    // userId 非字串：用一個 context 沒 userId 的直連（onStoreDocument 的第一道守衛）
    const direct = await ctx.collab.hocuspocus.openDirectConnection(note.id, {} as never);
    await direct.transact(doc => { doc.getXmlFragment(YDOC_FRAGMENT); }); await direct.disconnect();
    expect((await row(ctx, note.id)).lastEditedAt).toBeNull();
  });
});
