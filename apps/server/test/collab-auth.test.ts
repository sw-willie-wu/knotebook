import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT } from "@knotebook/shared";
import { signCollabToken } from "../src/collab/token.js";
import { COLLAB_REJECT_INVALID_TOKEN } from "../src/collab/server.js";
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

    await expect(session.connect(note.id, { tokenOverride: forgedRole })).rejects.toThrow(COLLAB_REJECT_INVALID_TOKEN);
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
      COLLAB_REJECT_INVALID_TOKEN
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
  });
});
