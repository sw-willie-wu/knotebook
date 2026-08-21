import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT } from "@knotebook/shared";
import { signCollabToken } from "../src/collab/token.js";
import {
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
} from "../src/collab/server.js";
import { notes } from "../src/db/schema.js";
import { buildCollabTestApp, testConfig } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

/**
 * 輪詢等待條件成立（比照 collab-sync.test.ts）：共編是非同步收斂的，斷言不可用固定
 * sleep，也不可只檢查一次——一律「在期限內輪詢到成立」，逾時才失敗並帶上標籤。
 */
async function waitFor(label: string, timeoutMs: number, check: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`等待逾時（${timeoutMs}ms）：${label}`);
}

function stateVector(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("hex");
}

/** 在 doc 的共編 fragment 插入一個含文字的 XML 元素——模擬 BlockNote 的一次編輯。 */
function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

describe("共編認證：onAuthenticate / onTokenSync 真驗證（Task 5）", () => {
  it("owner 可連可寫；viewer 連上但寫入被 protocol 層丟棄（另一 client 看不到）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth1@example.com", password: PASSWORD });
    const viewerUser = await ctx.createUser({ email: "viewer-auth1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, viewerUser.id, "viewer");

    const ownerSession = await ctx.loginAs("owner-auth1@example.com", PASSWORD);
    const viewerSession = await ctx.loginAs("viewer-auth1@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    const viewerClient = await viewerSession.connect(note.id);

    insertParagraph(ownerClient.doc, "from owner");
    await waitFor(
      "viewer 收斂到 owner 的寫入",
      3_000,
      () => stateVector(viewerClient.doc) === stateVector(ownerClient.doc)
    );
    expect(viewerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>from owner</paragraph>");

    // viewer 端寫入：protocol 層應直接丟棄（見 Hocuspocus `connection.readOnly` 的
    // messageYjsUpdate/messageYjsSyncStep2 分支），不落地也不廣播給 owner。
    insertParagraph(viewerClient.doc, "from viewer");
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from viewer");
  });

  it("偽 token（簽章錯誤）拒連", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth2@example.com", PASSWORD);

    const forged = await signCollabToken("f".repeat(64), { noteId: note.id, userId: owner.id, role: "owner", tv: 0 });

    await expect(session.connect(note.id, { tokenOverride: forged })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
  });

  it("陌生人以合法簽章但聲稱 role:'owner' 的 token 連線——重跑 resolveRole 得 'none'，仍拒連（N2：token 內 role 不作授權依據）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth3@example.com", password: PASSWORD });
    const stranger = await ctx.createUser({ email: "stranger-auth3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("stranger-auth3@example.com", PASSWORD);

    // 簽章有效（用真的 appSecret 簽），但 stranger 對這篇筆記毫無權限——role:'owner' 只是
    // 簽發時的（謊稱）快照，server 端不得信任，必須重跑 resolveRole 才拒絕。
    const forgedRole = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: stranger.id,
      role: "owner",
      tv: 0,
    });

    // issue #35：這是唯一真正的「授權被拒」——筆記在、token 有效，只是這個人沒有角色。
    await expect(session.connect(note.id, { tokenOverride: forgedRole })).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("撤分享後拿撤前舊 token（TTL 內）重連被拒（N2）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth4@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth4@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-auth4@example.com", PASSWORD);

    // 撤權前先拿一份合法 token（TTL 120s 內都有效）。
    const tokenRes = await editorSession.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
    expect(tokenRes.status).toBe(200);
    const { token: staleToken } = (await tokenRes.json()) as { token: string };

    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${editorUser.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await expect(editorSession.connect(note.id, { tokenOverride: staleToken })).rejects.toThrow(
      COLLAB_REJECT_FORBIDDEN
    );
  });

  it("token.noteId ≠ document name → 拒連", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth5@example.com", password: PASSWORD });
    const noteA = await ctx.createNote(owner.id);
    const noteB = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth5@example.com", PASSWORD);

    const tokenForB = await signCollabToken(testConfig.appSecret, {
      noteId: noteB.id,
      userId: owner.id,
      role: "owner",
      tv: 0,
    });

    await expect(session.connect(noteA.id, { tokenOverride: tokenForB })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
  });

  it("刪除閘門過期後，已刪除的筆記與「存在但無權限」的筆記拒連理由相同——不當存在性 oracle（issue #35）", async () => {
    // 「筆記已刪完、閘門也清了、client 才連回來」這個窗口本來會被說成「你已失去存取權」。
    // 修法是把閘門的 TTL 拉長到蓋過 client 最長的重啟退避（見 DELETING_GATE_TTL_MS），
    // **而不是**新增一個「筆記不存在」的拒連理由：後者會讓任何登入使用者都能對任意 UUID
    // 問「這篇筆記存在嗎」，而 REST 端刻意不區分這兩者（一律 404／一律 200+role:'none'）。
    // 這條測試釘的就是「兩者不可分辨」。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth15@example.com", password: PASSWORD });
    await ctx.createUser({ email: "stranger-auth15@example.com", password: PASSWORD });
    const deletedNote = await ctx.createNote(owner.id);
    const othersNote = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("stranger-auth15@example.com", PASSWORD);

    // 直接刪 row 且不碰閘門＝「刪除流程早就跑完、TTL 也過了」的終局狀態。
    await ctx.db.delete(notes).where(eq(notes.id, deletedNote.id));

    const deletedReason = await session.connect(deletedNote.id).then(
      () => "connected",
      (err: Error) => err.message
    );
    const existingReason = await session.connect(othersNote.id).then(
      () => "connected",
      (err: Error) => err.message
    );
    expect(deletedReason).toContain(COLLAB_REJECT_FORBIDDEN);
    // 逐字相同（除了 noteId）：兩者可觀察行為一致，問不出「這個 id 到底存不存在」。
    expect(deletedReason.replace(deletedNote.id, "")).toBe(existingReason.replace(othersNote.id, ""));
  });

  it("刪除閘門要先驗 token 才回答——沒有合法 token 問不出「這篇筆記正在被刪」", async () => {
    // 閘門是這個 server 唯一會透露「某個 noteId 存在且剛被刪掉」的地方，所以它排在驗完
    // token 之後：要問就得先持有一份對這篇筆記合法簽章的 token。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth18@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth18@example.com", PASSWORD);

    await ctx.collab.markDeleting(note.id);

    const forged = await signCollabToken("f".repeat(64), { noteId: note.id, userId: owner.id, role: "owner", tv: 0 });
    await expect(session.connect(note.id, { tokenOverride: forged })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    // 合法 token 才拿得到真正的理由。
    await expect(session.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
  });

  it("刪除閘門只對「本來就看得到這篇筆記的人」說 note-deleting（否則就是存在性 oracle）", async () => {
    // 閘門必須能對協作者說出「筆記被刪了」，又不能讓任何人拿一個 UUID 就問出「這篇存在嗎」。
    // 名單在刪除交易之前抓下來（markDeleting → loadNoteAudience），只有名單上的人聽得到。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth20@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth20@example.com", password: PASSWORD });
    await ctx.createUser({ email: "stranger-auth20@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    await ctx.collab.markDeleting(note.id);

    const editorSession = await ctx.loginAs("editor-auth20@example.com", PASSWORD);
    const strangerSession = await ctx.loginAs("stranger-auth20@example.com", PASSWORD);

    // 分享對象：聽得到真正的理由。
    await expect(editorSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    // 陌生人：拿得到合法 token（endpoint 對誰都回 200），但只會聽到 forbidden——與「這篇
    // 筆記根本不存在」一模一樣，問不出任何東西。
    await expect(strangerSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("名單抓不到時，「有沒有角色」接手判斷——陌生人照樣只聽得到 forbidden（審查 round 3）", async () => {
    // `markDeleting` 的名單查詢失敗時（DB 抖動）閘門的 value 是 null。那個 fallback 若解成
    // 「誰都聽得到 note-deleting」，一次抖動就把「這個 id 剛被刪掉」告訴全世界整整兩分鐘。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth21@example.com", password: PASSWORD });
    await ctx.createUser({ email: "stranger-auth21@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);

    // 讓名單查詢真的爆掉（拔掉 note_shares 表），閘門因此只記得 key、value 是 null。
    await ctx.db.execute(sql`ALTER TABLE note_shares RENAME TO note_shares_hidden`);
    try {
      await ctx.collab.markDeleting(note.id);
    } finally {
      await ctx.db.execute(sql`ALTER TABLE note_shares_hidden RENAME TO note_shares`);
    }
    expect(ctx.collabLogs.some(one => one.level === "warn")).toBe(true);

    const ownerSession = await ctx.loginAs("owner-auth21@example.com", PASSWORD);
    const strangerSession = await ctx.loginAs("stranger-auth21@example.com", PASSWORD);

    // owner 現在還查得到角色 ⇒ 聽得到真正的理由。
    await expect(ownerSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);
    // 陌生人沒有角色 ⇒ 只聽得到 forbidden，問不出這篇筆記的任何事。
    await expect(strangerSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);
  });

  it("拒連留下一行結構化日誌：noteId/userId/cause/reason，不含 token（issue #37）", async () => {
    // issue #6 修好之後，一次拒連的後果從「使用者卡在連線中（會來回報，維護者可以現場看
    // 畫面）」變成「使用者被自動導走」，他只會說「我突然被踢出來了」。CollabAuthError 的
    // message 又刻意留空（避免 Hocuspocus 無條件 console.error），所以沒有這行 log 的話，
    // 兩端一個位元都不留。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth16@example.com", password: PASSWORD });
    const stranger = await ctx.createUser({ email: "stranger-auth16@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("stranger-auth16@example.com", PASSWORD);

    const forgedRole = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: stranger.id,
      role: "owner",
      tv: 0,
    });
    await expect(session.connect(note.id, { tokenOverride: forgedRole })).rejects.toThrow(COLLAB_REJECT_FORBIDDEN);

    const line = ctx.collabLogs.find(one => one.obj.cause === "no-role");
    expect(line).toBeDefined();
    expect(line!.level).toBe("info");
    expect(line!.obj).toMatchObject({
      phase: "handshake",
      noteId: note.id,
      userId: stranger.id,
      cause: "no-role",
      reason: COLLAB_REJECT_FORBIDDEN,
    });
    // 欄位是封閉集合：token 內容（憑證）不得進日誌。
    expect(Object.keys(line!.obj).sort()).toEqual(["cause", "noteId", "phase", "reason", "userId"]);

    // 而 `bad-token` **不得**進 info：/collab 的 upgrade 不需要 session，Hocuspocus 對認證
    // 失敗又不關 socket——一則空 token 訊息換一行 info 日誌等於把日誌量交給匿名對端決定。
    const forged = await signCollabToken("f".repeat(64), { noteId: note.id, userId: stranger.id, role: "owner", tv: 0 });
    await expect(session.connect(note.id, { tokenOverride: forged })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
    const badToken = ctx.collabLogs.find(one => one.obj.cause === "bad-token");
    expect(badToken?.level).toBe("debug");
  });

  it("onAuthenticate 撞到未預期例外 → server-error（不是撤權），並留下 error 級別的日誌", async () => {
    // 這是唯一會讓分頁真的一直停在「連線中」的拒連原因，也就是維護者最需要找到的那一種：
    // 它必須跟其他拒連走同一個出口（`cause` 欄位），否則 docs 教的 grep 剛好漏掉它。
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth19@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth19@example.com", PASSWORD);

    // 先拿到合法 token（此時 gate 還是好的——它同時守著 REST 的 authenticate）。
    const tokenRes = await session.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
    const { token } = (await tokenRes.json()) as { token: string };

    ctx.breakGate(new Error("db went away"));
    await expect(session.connect(note.id, { tokenOverride: token })).rejects.toThrow(COLLAB_REJECT_SERVER_ERROR);

    const line = ctx.collabLogs.find(one => one.obj.cause === "server-error");
    expect(line?.level).toBe("error");
    // ⚠ userId 必須在（docs 的排錯指引承諾每一行都認得出是誰，而這一行是它叫維護者
    // 「先 grep 這個」的那一種）——`claims` 在 try 內，身分要另外提到 catch 看得到的地方。
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: owner.id, reason: COLLAB_REJECT_SERVER_ERROR });
    expect(line?.obj.err).toBeInstanceOf(Error);
  });

  it("gate 不通過記成 session-revoked，但送給 client 的仍是 invalid-token（兩層刻意不同）", async () => {
    // 「帳號停用／tokenVersion 過期」對 client 而言只是「這份 token 不能用」——它重取一次
    // 就會拿到 401 並走登出流程；但維護者要能分辨這與「簽章壞掉」不是同一回事。
    const ctx = await buildCollabTestApp();
    await ctx.createUser({ email: "admin-auth17@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-auth17@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-auth17@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-auth17@example.com", PASSWORD);

    // 比照 auth12：手動簽 tv=0 的 token，避開 collab-token 路徑先把 gate 結果快取住。
    const preDisableToken = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: target.id,
      role: "owner",
      tv: 0,
    });
    expect((await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" })).status).toBe(204);

    await expect(targetSession.connect(note.id, { tokenOverride: preDisableToken })).rejects.toThrow(
      COLLAB_REJECT_INVALID_TOKEN
    );

    const line = ctx.collabLogs.find(one => one.obj.cause === "session-revoked");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: target.id, reason: COLLAB_REJECT_INVALID_TOKEN });
  });

  it("connectionsOf 於連線/斷線後正確增減（兩個真實使用者）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth6@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth6@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-auth6@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    await editorSession.connect(note.id);

    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(2);
    expect(ctx.collab.connectionsOf(owner.id).size).toBe(1);
    expect(ctx.collab.connectionsOf(editorUser.id).size).toBe(1);

    const handle = [...ctx.collab.connectionsOf(owner.id)][0];
    expect(handle.noteId).toBe(note.id);
    expect(handle.userId).toBe(owner.id);

    ownerClient.disconnect();

    await waitFor("owner 斷線後索引移除該連線", 3_000, () => ctx.collab.connectionsOf(owner.id).size === 0);
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
  });

  it("onTokenSync 重驗：requestToken 後送出撤權後的新 token（即使聲稱 role:'owner'）→ 連線被 close(COLLAB_CLOSE_REVOKED)", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth7@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth7@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth7@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-auth7@example.com", PASSWORD);

    let revoked = false;
    const editorClient = await editorSession.connect(note.id, {
      tokenFn: async () => {
        if (revoked) {
          // 撤權後仍簽一個聲稱 role:'owner' 的合法簽章 token——驗證 onTokenSync 重跑
          // resolveRole 而非信任 token 內的 role（N2 同樣適用於重驗路徑）。
          return signCollabToken(testConfig.appSecret, { noteId: note.id, userId: editorUser.id, role: "owner", tv: 0 });
        }
        const res = await editorSession.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
        if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
        const body = (await res.json()) as { token: string };
        return body.token;
      },
    });

    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${editorUser.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);
    revoked = true;

    const handle = [...ctx.collab.connectionsOf(editorUser.id)][0];
    handle.requestToken();

    await waitFor("撤權後的 onTokenSync 以 COLLAB_CLOSE_REVOKED 關閉該連線", 3_000, () =>
      editorClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
  });

  it("onNextTokenSync 的回呼在重驗被拒（close）路徑也會觸發，不因 reject 被跳過（fix round 1 / CRITICAL 1）", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth11@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("owner-auth11@example.com", PASSWORD);

    let swapped = false;
    const client = await session.connect(note.id, {
      tokenFn: async () => {
        if (swapped) {
          // noteId 不符——保證命中 onTokenSync 的 close 分支（不管是走 N6 的 userId
          // 比對還是 noteId 比對，這裡兩者都會觸發同一個 close，重點是這條路徑確實被拒）。
          return signCollabToken(testConfig.appSecret, {
            noteId: "00000000-0000-0000-0000-000000000000",
            userId: owner.id,
            role: "owner",
            tv: 0,
          });
        }
        const res = await session.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
        if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
        const body = (await res.json()) as { token: string };
        return body.token;
      },
    });

    swapped = true;
    const handle = [...ctx.collab.connectionsOf(owner.id)][0];

    let fired = false;
    ctx.collab.onNextTokenSync(handle, () => {
      fired = true;
    });

    handle.requestToken();

    // 沒有 hoist-take-and-clear-before-verify + finally 派送的話，`handle.close()` 會
    // 同步觸發 unregister() 先把 tokenSyncCallbacks 的這個 key 刪掉，導致這裡永遠等不到
    // fired 變 true（逾時失敗）——這正是本測試要抓的迴歸。
    await waitFor("重驗被拒的路徑仍觸發 onNextTokenSync 回呼", 3_000, () => fired);
    await waitFor("連線確實被 close(COLLAB_CLOSE_REVOKED)（不是誤判其他成功路徑）", 3_000, () =>
      client.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
  });

  it("N2（onAuthenticate）：帳號停用後（tv bump + gate.invalidate），拿停用前簽的 token 重新連線被拒", async () => {
    const ctx = await buildCollabTestApp();
    await ctx.createUser({ email: "admin-auth12@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-auth12@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-auth12@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-auth12@example.com", PASSWORD);

    // 停用前手動簽一份合法 token（tv=0，此時尚未被 bump）——刻意不走
    // `POST .../collab-token`：那條路徑會先經 `authenticate` 呼叫一次 `gate.check`，
    // 把「尚未停用」的結果快取住（TTL 60s），會讓下面的停用操作看起來像沒生效
    // （撞上 Task 4 report 記載過的同一個快取陷阱，而非驗證到我們真正想測的東西）。
    const preDisableToken = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: target.id,
      role: "owner",
      tv: 0,
    });

    const disableRes = await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(204);

    // resolveRole 仍會判定 target 是 owner（停用不影響 note 所有權）——這裡失敗只可能
    // 是因為 gate.check 判定 revoked（tv 不符），精準命中 server.ts 的 gate 分支。
    await expect(targetSession.connect(note.id, { tokenOverride: preDisableToken })).rejects.toThrow(
      COLLAB_REJECT_INVALID_TOKEN
    );
  });

  it("N2（onTokenSync）：連線中的使用者被停用後，重驗（同一份舊 tv 的 token）→ close(COLLAB_CLOSE_REVOKED)", async () => {
    const ctx = await buildCollabTestApp();
    await ctx.createUser({ email: "admin-auth13@example.com", password: PASSWORD, isAdmin: true });
    const target = await ctx.createUser({ email: "target-auth13@example.com", password: PASSWORD });
    const note = await ctx.createNote(target.id);

    const adminSession = await ctx.loginAs("admin-auth13@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-auth13@example.com", PASSWORD);

    // 固定用同一份（此時仍合法、tv=0）的 token 建立連線，且往後每次 requestToken 都
    // 重送同一份——這樣停用後唯一會變的變數就是 DB 裡的 tv/disabledAt，精準隔離出
    // onTokenSync 的 gate.check 分支（role 仍會是 'owner'，不受停用影響）。
    const fixedToken = await signCollabToken(testConfig.appSecret, {
      noteId: note.id,
      userId: target.id,
      role: "owner",
      tv: 0,
    });

    const targetClient = await targetSession.connect(note.id, { tokenFn: async () => fixedToken });

    const disableRes = await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(204);

    const handle = [...ctx.collab.connectionsOf(target.id)][0];
    handle.requestToken();

    await waitFor("停用後重驗被 close(COLLAB_CLOSE_REVOKED)", 3_000, () =>
      targetClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
  });

  it("N6（onTokenSync）：重驗時送來另一個『真的有權限』使用者的合法簽章 token 仍視為借殼並 close，不接受身分頂替", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "owner-auth14@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-auth14@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    // editorUser 對這篇筆記有**真實**的合法權限——若把 N6 的 userId 比對拿掉，
    // resolveRole/gate.check 對 editorUser 都會通過，owner 這條連線會被靜靜地接管成
    // editorUser 的身分／權限而不會被關閉，測試才真的會失敗（不是隨便一個「role:none」
    // 陌生人就能製造出同樣的 close 結果，那樣測不出 N6 這條比對本身有沒有作用）。
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-auth14@example.com", PASSWORD);

    let swapped = false;
    const ownerClient = await ownerSession.connect(note.id, {
      tokenFn: async () => {
        if (swapped) {
          return signCollabToken(testConfig.appSecret, {
            noteId: note.id,
            userId: editorUser.id,
            role: "editor",
            tv: 0,
          });
        }
        const res = await ownerSession.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
        if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
        const body = (await res.json()) as { token: string };
        return body.token;
      },
    });

    swapped = true;
    const handle = [...ctx.collab.connectionsOf(owner.id)][0];
    handle.requestToken();

    await waitFor("借殼身分的 token 被 close(COLLAB_CLOSE_REVOKED)，owner 的連線沒有被 editorUser 接管", 3_000, () =>
      ownerClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );

    // ⚠ 這一則必須看得見（審查 round 3）：握手階段的 bad-token 走 debug（匿名 socket 的
    // 日誌放大器），但**重驗階段**的 bad-token 是把一條已經認證過的連線踢掉，使用者會看到
    // 「你已失去存取權」並被導走——身分也早就知道了。
    const line = ctx.collabLogs.find(one => one.obj.phase === "reverify" && one.obj.cause === "bad-token");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: owner.id });
  });
});
