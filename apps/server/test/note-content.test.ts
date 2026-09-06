import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE, YDOC_FRAGMENT } from "@knotebook/shared";
import { signSession } from "../src/auth/session.js";
import { noteStateBackups, noteStates } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { loadNoteDoc } from "../src/notes/editing/read.js";
import { buildCollabTestApp, buildTestApp, testConfig } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signSession(testConfig.appSecret, { userId, tv: 0 })}`;

// m-2：`read.ts` 檔頭與 `loadNoteDoc` 內的註解都宣稱「`documents.get` 到 `forkFrom(live)`
// 之間不得插入 `await`」，但那只是**註解在守**——沒有任何行為測試釘著這條不變量。
//
// 為什麼做不出誠實的行為測試：這條規則要防的是「讓出一次 microtask 就可能拿到已 unload
// 的文件」（@hocuspocus/server 的 `unloadDocument` 會先 `documents.delete` 再
// `document.destroy()`）。但真的呼叫 `Y.Doc.destroy()` 並**不會**清空它的內部 store——
// `Y.encodeStateAsUpdate` 對一份已 destroy 的文件仍會安靜地回出它 destroy 之前的內容，不會
// throw、也不會回空。要讓「插入一個 await、在中間把 live doc 換成已 destroy 的文件」這種
// 行為測試變紅，得先讓一個假的「已 destroy 的文件」表現出真正的 `Y.Doc` 沒有的行為（例如
// destroy 後真的變回空文件）——那樣測試在斷言的是我們捏造出來的假設，不是 `read.ts` 真正
// 依賴的性質。這條不變量因此只能靠原始碼文字守衛：真正壞掉時的後果是安靜地回出一份**陳舊**
// 快照與陳舊指紋（不會 500、不會 4xx），而 #137 的條件更新（if-match）正是把這個指紋當
// 基準——一旦這裡混進 await 而沒人發現，#137 會把一份過期快照的指紋當成「這就是目前的內容」。
//
// 定位字串選 `"documents.get(noteId)"`／`"forkFrom(live)"`（皆為 read.ts 裡的唯一出現處，
// import 那行只有裸的 `forkFrom`，檔頭註解只有裸的 `documents.get`，都不會誤命中）而非行號，
// 理由與本檔其餘測試一致（symbol 名比行號抗漂移）。indexOf 若定位失敗會是 -1，讓 slice
// 靜默拿到一段無意義甚至倒過來的字串而通過——所以先斷言兩個 marker 都真的找到。
//
// 守衛邊界：這只擋兩個 marker 之間出現 `await` 這個字面。把 await 挪到 `documents.get`
// 之前（例如 `const live = await Promise.resolve(...documents.get(noteId));`），或改用
// `.then()`／`queueMicrotask` 讓出而不寫 `await` 這個字，這裡都抓不到。
describe("read.ts 原始碼守衛：documents.get 到 forkFrom(live) 之間不得有 await", () => {
  it("字面文字不含 await", () => {
    const src = readFileSync(new URL("../src/notes/editing/read.ts", import.meta.url), "utf8");
    const start = src.indexOf("documents.get(noteId)");
    const end = src.indexOf("forkFrom(live)");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // 檔頭與行內註解本身就會提到「await」這個字（在講這條不變量），先濾掉整行都是 `//`
    // 註解的行，才不會被註解自己的文字誤判成「含 await」；真的插進來的 `await` 程式碼
    // 不是註解行，濾不掉。
    const between = src
      .slice(start, end)
      .split("\n")
      .filter(line => !line.trim().startsWith("//"))
      .join("\n");
    expect(between).not.toContain("await");
  });
});

describe("GET /api/notes/:id/content", () => {
  it("owner／editor／viewer 200；none 404；無憑證 401 帶 challenge", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "o@example.com", password: PASSWORD });
    const editor = await ctx.createUser({ email: "e@example.com", password: PASSWORD });
    const viewer = await ctx.createUser({ email: "v@example.com", password: PASSWORD });
    const other = await ctx.createUser({ email: "x@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editor.id, "editor");
    await ctx.share(note.id, viewer.id, "viewer");
    for (const [u, status] of [
      [owner, 200],
      [editor, 200],
      [viewer, 200],
      [other, 404],
    ] as const) {
      const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read");
      expect((await getContent(ctx.app, note.id, token)).statusCode, u.id).toBe(status);
    }
    const anon = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content` });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("owner 的 cookie 也能讀 200，且不使文件多載入", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/notes/${note.id}/content`,
      headers: { cookie: await cookieFor(u.id) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastEdited).toBeNull();
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
  });

  it("WS client 剛打的字讀得到；?section= 只回該段（鍵是 id）；heading 開頭 outline[0] 是 _top 0 block；未知 section 404 section_not_found", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    // 兩個 heading 同階：更深的 heading 會被併進上一段（`sectionize` 的規則，note-sections.test.ts
    // 「h2→h3→h2」那案釘住），用 `## B` 就只會有兩段，不是這個案子要驗的形狀。
    const client = await seedContent(ctx, session, note.id, "# A\n\n第一段\n\n# B\n\n第二段");
    // 同步：provider 的編輯要先到 server 的 live doc（WS 往返），讀路徑才 fork 得到
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("第二段"));
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const res = await getContent(ctx.app, note.id, token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markdown).toContain("第一段");
    expect(body.outline[0]).toMatchObject({ sectionId: "_top", level: 0, heading: "", chars: 0 });
    expect(body.outline.map((o: { heading: string }) => o.heading)).toEqual(["", "A", "B"]);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // 大綱是對外 DTO（`NoteOutlineEntry`）：內部的 blockIds 不得外洩
    expect(body.outline.every((o: Record<string, unknown>) => o.blockIds === undefined)).toBe(true);
    // 每一列的 fingerprint 是**該段自己的**指紋，不是整篇 fingerprint 的複製（Task 3
    // `fingerprint.ts` 檔頭明令禁止的退化：不符時退回整篇指紋）——三段內容互異，指紋
    // 也必須互異；且沒有任何一列會恰好等於整篇 fingerprint（#137 的條件更新拿這個欄位
    // 當基準，這裡沒守到就是編出來的假指紋）。
    for (const o of body.outline) expect(o.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(body.outline.map((o: { fingerprint: string }) => o.fingerprint)).size).toBe(3);
    expect(body.outline.every((o: { fingerprint: string }) => o.fingerprint !== body.fingerprint)).toBe(true);
    const secId = body.outline[2].sectionId;
    const sec = (await getContent(ctx.app, note.id, token, secId)).json();
    expect(sec.section.id).toBe(secId);
    expect(sec.section.sectionId).toBeUndefined();
    expect(sec.section.markdown).toContain("第二段");
    expect(sec.section.markdown).not.toContain("第一段");
    // 段落端點回的指紋要與大綱那一列的指紋是同一個值（不是另外重算出來的巧合相等）。
    expect(sec.section.fingerprint).toBe(body.outline[2].fingerprint);
    expect(sec.outline).toBeUndefined();
    // 段落形不帶整篇 outline，同樣不該帶整篇 fingerprint／假的 lastEdited——spec §5 的鍵只有
    // `section`（見上）與 `lastEdited`。
    expect(sec.fingerprint).toBeUndefined();
    // #137：`lastEdited` 已是真值，不能再斷言恆 null（這篇剛被人編輯過，落盤一落地就變人形落款
    // ——「跑超過兩秒就紅」）。這裡守的仍是同一件事：段落形的頂層鍵**只有** section 與 lastEdited，
    // 不得混進整篇的 fingerprint／outline。值的正確性由本案結尾（落盤已是確定事件）那段驗。
    expect(Object.keys(sec).sort()).toEqual(["lastEdited", "section"]);
    // 零 block 的 `_top`（文件以 heading 開頭）：markdown 是空字串，不是 mount 正規化出來的 "\n"
    const top = (await getContent(ctx.app, note.id, token, "_top")).json();
    expect(top.section).toMatchObject({ id: "_top", markdown: "", chars: 0 });
    const missing = await getContent(ctx.app, note.id, token, "nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("section_not_found");
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    // 落盤之後 last_edited_* 已是人形落款＝確定事件。段落形與整篇形都要回真值：
    // byHandle 是那位編輯者、agentLabel 為 null（這篇沒有 AI 寫過）。
    // ⚠ handle **不能硬寫成 `"a"`**（那是 email 的 local part）：`ctx.createUser` 不帶 handle，
    // 該欄吃 DB default（`'user-' || substr(gen_random_uuid()::text, 1, 8)`）。取真值再比對，
    // **不要退化成 `expect.any(String)`**——這一格守的正是「落款指向的是這位編輯者」。
    const ownerHandle = (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}`, headers: bearer(token) })).json().ownerHandle;
    const settledSec = (await getContent(ctx.app, note.id, token, secId)).json();
    expect(settledSec.lastEdited).toMatchObject({ byHandle: ownerHandle, agentLabel: null });
    expect((await getContent(ctx.app, note.id, token)).json().lastEdited).toMatchObject({ byHandle: ownerHandle, agentLabel: null });
  });

  it("沒人在線讀 DB 快照；從未開過的筆記回空文件形，連讀兩次指紋相同", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const empty = (await getContent(ctx.app, note.id, token)).json();
    expect(empty).toMatchObject({ markdown: "", outline: [{ sectionId: "_top", chars: 0 }], lastEdited: null });
    expect((await getContent(ctx.app, note.id, token)).json().fingerprint).toBe(empty.fingerprint);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "hello");
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("hello"));
    client.disconnect();
    // 同步：斷線後 store（debounce 2000 ms）先跑、再 unload（hocuspocus 的 storeDocumentHooks →
    // unloadDocument；repo 前例：collab/server.ts 的 destroy() 也是等 documents 排空）
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    expect((await getContent(ctx.app, note.id, token)).json().markdown).toContain("hello");
  });

  it("讀取假綠守衛：連讀 20 次後 note_states 不變、無 backup 新列、documents.size 不變（last_edited_* 的斷言歸 #137——欄位由 migration 0010 建）", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "x");
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("x"));
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const before = (await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)))[0]!;
    const backups = (await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).length;
    const { token } = await seedTokenForUser(ctx.db, u.id);
    for (let i = 0; i < 20; i += 1) expect((await getContent(ctx.app, note.id, token)).statusCode).toBe(200);
    const after = (await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)))[0]!;
    expect(after.version).toBe(before.version);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).length).toBe(backups);
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
  });

  // 讀路徑「零副作用」的核心：live doc 只被 fork，絕不交出本尊。只看 HTTP 回應驗不到這條
  // ——實測（scratchpad 突變棚）把 `forkFrom(live).fork` 換成 `live` 本身，七個 HTTP 案例全綠：
  // 對「結構良好且非空」的文件，mount 目前剛好不改動任何東西。所以在這裡直接對 `loadNoteDoc`
  // 斷言身分與隔離，讓「交出本尊」這個突變一定會紅。
  it("loadNoteDoc：有人在線回 fork（非 live 本尊、改它不影響 live）；沒人在線回 DB 快照 loaded=false", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", PASSWORD);
    const client = await seedContent(ctx, session, note.id, "hello");
    await waitFor("server 收到編輯", 5_000, () => docText(ctx.collab.hocuspocus.documents.get(note.id)!).includes("hello"));
    const live = ctx.collab.hocuspocus.documents.get(note.id)!;
    const liveText = docText(live);
    const forked = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id);
    expect(forked.loaded).toBe(true);
    expect(forked.doc).not.toBe(live);
    expect(docText(forked.doc)).toBe(liveText); // fork 的內容與 live 一致
    forked.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [new Y.XmlElement("blockGroup")]);
    expect(docText(forked.doc)).not.toBe(liveText); // 確認上一行真的改到了 fork
    expect(docText(live)).toBe(liveText); // live 不受影響
    client.disconnect();
    await waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const fromDb = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, note.id);
    expect(fromDb.loaded).toBe(false);
    expect(docText(fromDb.doc)).toBe(liveText);
  });

  it("CONTENT_READ_LIMIT：limit 3 第 4 次 429；none 的 404 不消耗（陌生人 5×404 後讀自己的筆記仍 3×200 才 429）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { contentRead: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) } });
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const stranger = await ctx.createUser({ email: "s@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const own = await ctx.createNote(stranger.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const { token: st } = await seedTokenForUser(ctx.db, stranger.id);
    for (let i = 0; i < 5; i += 1) expect((await getContent(ctx.app, note.id, st)).statusCode).toBe(404);
    for (let i = 0; i < 3; i += 1) expect((await getContent(ctx.app, own.id, st)).statusCode).toBe(200); // 404 沒啃桶
    expect((await getContent(ctx.app, own.id, st)).statusCode).toBe(429);
    for (let i = 0; i < 3; i += 1) expect((await getContent(ctx.app, note.id, token)).statusCode).toBe(200);
    expect((await getContent(ctx.app, note.id, token)).statusCode).toBe(429);
  });

  it("section 含 NUL 或格式不合 → 400 invalid_body（不變量 S）；無 collab 的 app 不註冊此路由", async () => {
    const ctx = await buildCollabTestApp();
    const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const { token } = await seedTokenForUser(ctx.db, u.id);
    const NUL = String.fromCharCode(0);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/notes/${note.id}/content?section=${encodeURIComponent("a" + NUL)}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
    // SECTION_ID_RE 不收的字元（`.`）同樣 400——把「NUL 被擋」與「格式閘門本身存在」分開釘。
    const bad = await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/content?section=a.b`, headers: bearer(token) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_body");
    // 非 uuid 的 :id → 404（不是把它送進 resolveRole 的 SQL 而炸成 500）
    const notUuid = await ctx.app.inject({ method: "GET", url: "/api/notes/not-a-uuid/content", headers: bearer(token) });
    expect(notUuid.statusCode).toBe(404);
    expect(notUuid.json().error.code).toBe("not_found");
    // 無 collab 的 app：路由不存在。若它有被註冊，preHandler 會先回 401（無憑證），
    // 所以「404 而非 401」就是「沒註冊」的證據。
    const plain = await buildTestApp();
    const r2 = await plain.app.inject({ method: "GET", url: `/api/notes/${note.id}/content` });
    expect(r2.statusCode).toBe(404);
  });
});
