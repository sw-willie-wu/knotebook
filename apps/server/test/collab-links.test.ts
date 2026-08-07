import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type Role } from "@knotebook/shared";
import type { CollabServer } from "../src/collab/server.js";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import { docClock } from "../src/collab/store.js";
import { notes, noteLinks } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession, type TestClient } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

/**
 * 本檔一律以**真** CollabHooks 建 app（比照 collab-revocation.test.ts）：預設的
 * `noopCollabHooks.linkSyncGate` 恆回 `{ ok: false }`，會讓「在記憶體但無連線 → 409」
 * 「unload 後 → 409」這兩案例假綠（不管有沒有真的送出過 gate 查詢都是 409）——本檔要測
 * 的正是 `createCollabHooks` 委派 `CollabServer.linkSyncState` 之後、真實的記憶體狀態。
 */
function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server: CollabServer) => createCollabHooks(server) });
}

/** 輪詢等待條件成立（比照 collab-revocation/collab-store：共編收斂不可用固定 sleep 斷言）。 */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 手工在 Y.Doc 層造一個 wikilink 節點（nodeName "wikilink"、attr targetNoteId，fragment
 * 用 shared 的 YDOC_FRAGMENT）——不依賴 apps/web 的 BlockNote schema/spec，只用來讓文件
 * 內容真的變動（推進 docClock），以及供「雙 client 收斂」案驗證 Yjs 層的同步本身正確。
 */
function insertWikilink(doc: Y.Doc, targetNoteId: string): void {
  const element = new Y.XmlElement("wikilink");
  element.setAttribute("targetNoteId", targetNoteId);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

/** 走訪 fragment 樹，收集所有 wikilink 節點的 targetNoteId——供收斂斷言比對兩端內容。 */
function extractWikilinkTargets(doc: Y.Doc): string[] {
  const targets: string[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === "wikilink") {
          const targetNoteId = child.getAttribute("targetNoteId");
          if (typeof targetNoteId === "string") targets.push(targetNoteId);
        }
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment(YDOC_FRAGMENT));
  return targets;
}

/** 走真的 `POST /api/notes/:id/collab-token`（會計入 per-user limiter）取一份 token。 */
async function fetchToken(session: HttpSession, noteId: string): Promise<string> {
  const res = await session.fetch(`/api/notes/${noteId}/collab-token`, { method: "POST" });
  if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
  const body = (await res.json()) as { token: string; role: Role };
  return body.token;
}

/** 走真的 `POST /api/notes/:id/links`——以手動 POST 複刻 client 提交語意（Task 8 與 Task 7 無程式碼依賴）。 */
function postLinks(session: HttpSession, noteId: string, targetIds: string[]): Promise<Response> {
  return session.fetch(`/api/notes/${noteId}/links`, {
    method: "POST",
    body: JSON.stringify({ link_target_ids: targetIds }),
  });
}

async function linkedTargets(db: Db, sourceId: string): Promise<string[]> {
  const rows = await db.select({ targetNoteId: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, sourceId));
  return rows.map(r => r.targetNoteId).sort();
}

async function readLinksClock(db: Db, noteId: string): Promise<number> {
  const [row] = await db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, noteId));
  return row?.linksClock ?? 0;
}

/**
 * 等 server 端（`CollabServer.linkSyncState`——`linkSyncGate` 實際委派的同一個函式）真的
 * 看到 `expectedClock`：client 本地插入的編輯要經過真實的 WS 訊息往返才會反映到 server 端
 * 的 canonical Y.Doc，不能假設「client.doc 已經有這次編輯」等於「server 也已經收到」。
 * 用這個當同步點取代任意長度的 sleep——輪詢的正是 `POST /links` 實際會呼叫的同一段邏輯。
 */
async function waitForServerClock(ctx: CollabTestCtx, noteId: string, userId: string, expectedClock: number): Promise<void> {
  await waitFor(`server 端 linkSyncState 收斂到 clock=${expectedClock}`, 10_000, () => {
    const state = ctx.collab.linkSyncState(noteId, userId);
    return state.ok && state.clock === expectedClock;
  });
}

/**
 * 全斷線並等待文件真正從記憶體卸載——範本抄自 `hooks-impl.ts` 的 `beforeNoteDeleted`：
 * `flushPendingStores` 立即執行 debounce 中的 store，`unloadDocument` 在有進行中 store 時
 * 會靜默 no-op（`shouldUnloadDocument` 為 false），所以要輪詢重試。
 *
 * 步驟：先讓本測試自建的每個 `TestClient` 自行 `disconnect()`（provider.destroy() +
 * socket.destroy()，無自動重連——這才是「全斷線」，不是「叫它們重連」）；再呼叫
 * `hocuspocus.closeConnections(noteId)` 補一刀（v4.5.0 public API，此時應已是 no-op，
 * 純粹證明這條 runbook 路徑不依賴本測試自己持有的 client handle，未來真的 runbook
 * 腳本可能只知道 noteId）。
 */
async function disconnectAllAndUnload(ctx: CollabTestCtx, noteId: string, clients: readonly TestClient[]): Promise<void> {
  for (const client of clients) client.disconnect();
  ctx.collab.hocuspocus.closeConnections(noteId);
  ctx.collab.hocuspocus.flushPendingStores();

  const tryUnload = (): void => {
    const doc = ctx.collab.hocuspocus.documents.get(noteId);
    if (doc) void ctx.collab.hocuspocus.unloadDocument(doc).catch(() => {});
  };
  tryUnload();

  await waitFor("文件從記憶體卸載", 10_000, () => {
    if (!ctx.collab.hocuspocus.documents.has(noteId)) return true;
    tryUnload();
    return false;
  });
}

describe("Task 8：links 共編整合——真 Hocuspocus gate、真 provider", () => {
  it("雙 client 收斂：Y.Doc 層手工插入的 wikilink 元素在兩個 client 間同步收斂", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links1@example.com", password: PASSWORD });
    const other = await ctx.createUser({ email: "other-links1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    await ctx.share(note.id, other.id, "editor");

    const ownerSession = await ctx.loginAs("owner-links1@example.com", PASSWORD);
    const otherSession = await ctx.loginAs("other-links1@example.com", PASSWORD);
    const ownerClient = await ownerSession.connect(note.id);
    const otherClient = await otherSession.connect(note.id);

    insertWikilink(ownerClient.doc, target.id);

    await waitFor("wikilink 收斂到另一 client", 10_000, () => extractWikilinkTargets(otherClient.doc).includes(target.id));
    expect(extractWikilinkTargets(otherClient.doc)).toEqual(extractWikilinkTargets(ownerClient.doc));
  });

  it("synced 首筆提交收斂：連線 synced 後首次提交 204，note_links 落地", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links2@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const expectedClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, expectedClock);

    const res = await postLinks(session, note.id, [target.id]);
    expect(res.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);
    expect(await readLinksClock(ctx.db, note.id)).toBe(expectedClock);
  });

  it("提交者自己的連線尚未登記進索引 → 409（案4同一 gate 分支的暫時性版本）；登記完成後立即收斂，1s 後重試仍收斂", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links3@example.com", password: PASSWORD });
    const editor = await ctx.createUser({ email: "editor-links3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    await ctx.share(note.id, editor.id, "editor");
    // target 也要分享給 editor——否則 writeNoteLinks 的批次授權查詢會把它靜默過濾掉
    // （見 notes-links.test.ts「無權存取的 target → 靜默過濾」），跟本測試要驗證的
    // gate 收斂無關，會把最終斷言的 note_links 弄成假陰性。
    await ctx.share(target.id, editor.id, "viewer");

    const ownerSession = await ctx.loginAs("owner-links3@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-links3@example.com", PASSWORD);

    // owner 先連上，文件已在記憶體；並先編輯一次讓 docClock > 0——避免整個案子退化成
    // `0 <= 0` 的邊界（那樣即使 CAS 閘門被整條拿掉、案子仍會巧合地綠，見審查 Important 2）。
    const ownerClient = await ownerSession.connect(note.id);
    insertWikilink(ownerClient.doc, target.id);
    const editClock = docClock(ownerClient.doc);
    await waitForServerClock(ctx, note.id, owner.id, editClock);

    // ⚠ 據實描述本案在測什麼（審查 Important 1——原註解宣稱的「synced 撞 connected 時序
    // 交錯」與下面機制不符，予以更正）：
    //
    // 下面卡住 editor 的 tokenFn 造出的是「文件已在記憶體、但 editor 自己的連線尚未登記進
    // byNote 索引」這個**狀態**——與案 4（在記憶體但提交者無連線）是完全同一個 gate 分支，
    // 差別只在於這裡的「未登記」是暫時的、稍後會自己解除。這是狀態等價的 proxy，**不是**
    // brief 字面「synced 撞 connected 窗口」那種時序交錯的重現：`@hocuspocus/provider` 的
    // `onOpen` 實作是 `await this.sendToken(); this.startSync();`（見
    // `@hocuspocus/provider` 4.5.0 原始碼）——`sendToken()` 在我們釋放 `gate` 之前不會
    // resolve，`startSync()`（也就是整個 y-protocol 同步、最終導向 client 端 "synced"
    // 事件）在窗口內根本還沒開始，這個 client 此時**從未 synced 過**，談不上「synced 已經
    // 發生、只是 connected 還沒跑完」。
    //
    // 真正的「synced 撞 connected」窗口在 server 端（`@hocuspocus/server` 4.5.0
    // `setUpNewConnection`）內部：先把已收到、排入佇列的訊息 drain 套用掉，**之後**才
    // `await this.hooks("connected", ...)`——本專案的 `connected` hook 正是在這裡才把連線
    // 登記進 `byNote`（見 collab/server.ts）。drain 與 connected 之間確實有一個真實窗口，
    // 但它完全在 Hocuspocus 內部一次 async 函式呼叫之中，中間沒有任何 I/O 或公開 API 可以
    // 掛勾暫停——沒有辦法只靠測試這一側手上的公開介面確定性地卡在那個窗口中間（要做到只能
    // monkeypatch `Hocuspocus.prototype` 內部方法，超出本 task「真 provider + 公開 API
    // 複刻 client 語意」的邊界，也不是本 task 該做的事）。
    let releaseToken: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseToken = resolve;
    });
    const editorConnectPromise = editorSession.connect(note.id, {
      tokenFn: async () => {
        await gate;
        return fetchToken(editorSession, note.id);
      },
    });
    // 萬一下面的斷言先失敗、沒人再 await 這個 promise（gate 永遠不會被釋放），避免它變成
    // unhandled rejection 汙染測試輸出。
    void editorConnectPromise.catch(() => {});

    const raced = await postLinks(editorSession, note.id, [target.id]);
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ error: { code: "not_loaded" } });
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);

    releaseToken();
    const editorClient = await editorConnectPromise;

    // 釘住 Task 7 client 實際依賴的性質：synced 之後，下一個 HTTP 請求抵達時這條連線的
    // 登記已經完成——不需要額外等待就該收斂，不是「湊巧等了 1 秒所以來得及」。
    const immediate = await postLinks(editorSession, note.id, [target.id]);
    expect(immediate.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    // 再等 1s 後重試仍然收斂——同時覆蓋 brief 逐字要求的「1s 重試收斂」，證明上面的立即
    // 收斂不是曇花一現。
    await sleep(1_000);
    const retried = await postLinks(editorSession, note.id, [target.id]);
    expect(retried.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    editorClient.disconnect();
    ownerClient.disconnect();
  });

  it("在記憶體但提交者無連線 → 409 not_loaded", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links4@example.com", password: PASSWORD });
    const editor = await ctx.createUser({ email: "editor-links4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    await ctx.share(note.id, editor.id, "editor");

    const ownerSession = await ctx.loginAs("owner-links4@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-links4@example.com", PASSWORD);

    // owner 連上，文件確實在記憶體裡；editor 自始至終沒有連過——與上一案（會收斂的暫時性
    // 競態）不同，這裡驗證的是「即使文件已載入，沒有登記連線的使用者永遠拿不到 clock」。
    const ownerClient = await ownerSession.connect(note.id);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(true);

    const res = await postLinks(editorSession, note.id, [target.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "not_loaded" } });
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);

    ownerClient.disconnect();
  });

  it("unload 後 → 409 not_loaded", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links5@example.com", PASSWORD);
    const client = await session.connect(note.id);

    await disconnectAllAndUnload(ctx, note.id, [client]);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    const res = await postLinks(session, note.id, [target.id]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "not_loaded" } });
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);
  });

  it("後續提交冪等：CAS 命中真的重寫（兩發之間手動刪掉 note_links，第二發仍把它重建）", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links6@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const expectedClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, expectedClock);

    const res1 = await postLinks(session, note.id, [target.id]);
    expect(res1.status).toBe(204);
    const clockAfterFirst = await readLinksClock(ctx.db, note.id);
    expect(clockAfterFirst).toBe(expectedClock);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    // 沒有任何新編輯——docClock 不變，第二次提交拿到的 clock 與已提交的 links_clock 相同，
    // `<=` 閘門讓同 clock 重送仍受理（LWW）。但如果只斷言「兩次提交後最終狀態相同」，即使
    // CAS 被誤改成嚴格的 `<`（同 clock 重送被誤判成 no-op、根本沒有真的重寫），這裡也會
    // 巧合地綠——反正本來就沒有新編輯，狀態原地不動騙不出差異。手動在兩發之間刪掉
    // `note_links` 列（不動 `links_clock`），讓第二發「真的執行了寫入」與「被誤判成
    // no-op」在最終狀態上產生可觀測的差異：前者會把列重建回來，後者列會維持刪除。
    await ctx.db.delete(noteLinks).where(eq(noteLinks.sourceNoteId, note.id));
    expect(await linkedTargets(ctx.db, note.id)).toEqual([]);

    const res2 = await postLinks(session, note.id, [target.id]);
    expect(res2.status).toBe(204);
    expect(await readLinksClock(ctx.db, note.id)).toBe(clockAfterFirst);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    client.disconnect();
  });

  it("鉗制收斂（護欄，§12.5-3）：links_clock 被人為調高後，unload+重連的 onLoadDocument 用 LEAST 鉗回 docClock，之後提交仍收斂", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links7@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links7@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const editClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, editClock);

    const res1 = await postLinks(session, note.id, [target.id]);
    expect(res1.status).toBe(204);
    const committedClock = await readLinksClock(ctx.db, note.id);
    expect(committedClock).toBe(editClock);

    // 人為把 links_clock 調到遠高於任何 docClock 能到達的值——若 onLoadDocument 的鉗制
    // 誤用 GREATEST（而非 spec 要求的 LEAST），這個值會原封不動地留到重連之後。
    const inflated = committedClock + 1_000_000;
    await ctx.db.update(notes).set({ linksClock: inflated }).where(eq(notes.id, note.id));
    expect(await readLinksClock(ctx.db, note.id)).toBe(inflated);

    // 全斷線待 unload：文件真的從記憶體卸載，下一次連線才會真的重跑 onLoadDocument。
    await disconnectAllAndUnload(ctx, note.id, [client]);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    const reconnected = await session.connect(note.id);
    const reloadedClock = docClock(reconnected.doc);

    // 鉗制斷言：必須恰好等於 docClock（不只是「有變小」）——這是唯一能區分
    // LEAST（正確：夾回 docClock）與 GREATEST（錯誤：維持人為調高值）的斷言。
    const clampedClock = await readLinksClock(ctx.db, note.id);
    expect(clampedClock).toBeLessThanOrEqual(reloadedClock);
    expect(clampedClock).toBe(reloadedClock);
    expect(clampedClock).toBeLessThan(inflated);

    const res2 = await postLinks(session, note.id, [target.id]);
    expect(res2.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);

    reconnected.disconnect();
  });

  it("還原 runbook（含 links_clock=0 重置）後提交收斂", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-links8@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const target = await ctx.createNote(owner.id, "Target");
    const session = await ctx.loginAs("owner-links8@example.com", PASSWORD);
    const client = await session.connect(note.id);

    insertWikilink(client.doc, target.id);
    const editClock = docClock(client.doc);
    await waitForServerClock(ctx, note.id, owner.id, editClock);

    const res1 = await postLinks(session, note.id, [target.id]);
    expect(res1.status).toBe(204);
    expect(await readLinksClock(ctx.db, note.id)).toBe(editClock);

    // 還原 runbook：closeConnections（v4.5.0 public API，見 disconnectAllAndUnload）→
    // flushPendingStores → unloadDocument 輪詢至真的卸載 → 交易外直接把 links_clock 重置
    // 為 0（模擬還原/重建索引 runbook 的其中一步）。
    await disconnectAllAndUnload(ctx, note.id, [client]);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    await ctx.db.update(notes).set({ linksClock: 0 }).where(eq(notes.id, note.id));
    expect(await readLinksClock(ctx.db, note.id)).toBe(0);

    const reconnected = await session.connect(note.id);
    // reconnected 建立時 onLoadDocument 的 LEAST(0, docClock) 鉗制不會把 0 往上拉——
    // 0 已經是所有 docClock 的下界，重連後仍應維持 0（不是「被鉗回某個正值」）。
    expect(await readLinksClock(ctx.db, note.id)).toBe(0);

    const res2 = await postLinks(session, note.id, [target.id]);
    expect(res2.status).toBe(204);
    expect(await linkedTargets(ctx.db, note.id)).toEqual([target.id]);
    expect(await readLinksClock(ctx.db, note.id)).toBe(docClock(reconnected.doc));

    reconnected.disconnect();
  });
});
