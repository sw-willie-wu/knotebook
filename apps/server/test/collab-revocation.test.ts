import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, YDOC_FRAGMENT, type Role } from "@knotebook/shared";
import { COLLAB_REJECT_FORBIDDEN, COLLAB_REJECT_NOTE_DELETING } from "../src/collab/server.js";
import { createCollabHooks, REVERIFY_DEADLINE_MS } from "../src/collab/hooks-impl.js";
import { buildCollabTestApp, type CollabTestCtx, type HttpSession } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

/**
 * 本檔一律以**真** CollabHooks 建 app。預設的 `noopCollabHooks` 會讓 shares PUT/DELETE、
 * admin disable、改密碼、notes DELETE 這些呼叫點全部空轉——撤權路徑永遠不會被觸發，
 * 每個斷言都會綠得毫無意義（測到的只是「沒人動這條連線」）。
 */
function buildApp(): Promise<CollabTestCtx> {
  return buildCollabTestApp({ collabHooks: (server, log) => createCollabHooks(server, log) });
}

/**
 * 輪詢等待條件成立（比照 collab-sync/collab-auth）：共編是非同步收斂的，斷言不可用固定
 * sleep，也不可只檢查一次——一律「在期限內輪詢到成立」，逾時才失敗並帶上標籤。
 */
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

function stateVector(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("hex");
}

/** 在 doc 的共編 fragment 插入一個含文字的 XML 元素——模擬 BlockNote 的一次編輯。 */
function insertParagraph(doc: Y.Doc, text: string): void {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [element]);
}

/** 走真的 `POST /api/notes/:id/collab-token`（會計入 per-user limiter）取一份 token。 */
async function fetchToken(session: HttpSession, noteId: string): Promise<string> {
  const res = await session.fetch(`/api/notes/${noteId}/collab-token`, { method: "POST" });
  if (!res.ok) throw new Error(`取得 collab token 失敗（${res.status}）：${await res.text()}`);
  const body = (await res.json()) as { token: string; role: Role };
  return body.token;
}

/**
 * 撤權 SLA（spec §10：撤銷分享 ≤10 秒）的端對端驗證。所有「撤權後多久生效」的斷言一律
 * ≤10s——這是對外承諾的上限；實際機制（§7 的機制列）是「requestToken + 5s deadline」，
 * 正常路徑遠快於此。
 */
describe("撤權 SLA：CollabHooks（Task 6）", () => {
  it("撤銷分享：被撤者收 CLOSE(revoked) 且其後編輯不落盤；同文件另一 editor 不受影響（N1：不得全 note 廣播）", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-rev1@example.com", password: PASSWORD });
    const victim = await ctx.createUser({ email: "victim-rev1@example.com", password: PASSWORD });
    const bystander = await ctx.createUser({ email: "bystander-rev1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, victim.id, "editor");
    await ctx.share(note.id, bystander.id, "editor");

    const ownerSession = await ctx.loginAs("owner-rev1@example.com", PASSWORD);
    const victimSession = await ctx.loginAs("victim-rev1@example.com", PASSWORD);
    const bystanderSession = await ctx.loginAs("bystander-rev1@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    const victimClient = await victimSession.connect(note.id);
    const bystanderClient = await bystanderSession.connect(note.id);

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${victim.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    // 斷言 1：被撤者在 SLA 內收到帶 reason 的應用層 CLOSE。
    await waitFor("被撤者收到 CLOSE(knotebook:revoked)", 10_000, () =>
      victimClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    // 斷言 2：其後的編輯不落盤——server 端該連線已從 document 移除，後續 update 訊息
    // 不會被套用，也就不會廣播給任何還在線上的人。
    insertParagraph(victimClient.doc, "from revoked user");
    await sleep(1_000);
    expect(ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from revoked user");
    expect(bystanderClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from revoked user");

    // 斷言 3：同文件的另一個 editor 完全不受影響（沒有被 close，且仍可繼續寫入並收斂）。
    expect(bystanderClient.closes).toEqual([]);
    insertParagraph(bystanderClient.doc, "from bystander");
    await waitFor(
      "未被撤權的 editor 仍可寫入並收斂到 owner",
      10_000,
      () => stateVector(ownerClient.doc) === stateVector(bystanderClient.doc)
    );
    expect(ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("from bystander");
  });

  it("不合作的 client（完成 auth 後對 token 請求毫無回應）：5s deadline 到期即被 close(revoked)", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-rev2@example.com", password: PASSWORD });
    const victim = await ctx.createUser({ email: "victim-rev2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, victim.id, "editor");

    const ownerSession = await ctx.loginAs("owner-rev2@example.com", PASSWORD);
    const victimSession = await ctx.loginAs("victim-rev2@example.com", PASSWORD);

    // 首次（連線用）token 正常取得；之後 server 端 requestToken 觸發的每一次呼叫都回一個
    // **永不 resolve** 的 promise——provider 因此永遠不會送出 AuthenticationMessage，等同
    // 「完成 auth 握手後對 token 請求訊息不回應」的不合作 client。此時唯一能剝離這條連線
    // 的就是 deadline timer。
    let uncooperative = false;
    const victimClient = await victimSession.connect(note.id, {
      tokenFn: async () => {
        if (uncooperative) return new Promise<string>(() => {});
        return fetchToken(victimSession, note.id);
      },
    });
    uncooperative = true;

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${victim.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await waitFor("不合作的 client 仍在 SLA 內被 close(knotebook:revoked)", 10_000, () =>
      victimClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );

    // 下界斷言：close 必須是「deadline 到期」造成的，而不是某條 token 往返路徑——若實作
    // 誤把 deadline 設得太短（或乾脆不等 client 直接關），這裡會失敗。timer 不可能早於
    // 設定值觸發，故下界安全；上界則由上面的 SLA 斷言涵蓋。
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(REVERIFY_DEADLINE_MS - 500);

    // deadline 到期是**合法使用者最可能被誤踢**的路徑（client 只是卡在 token 退避裡沒能
    // 在 5 秒內回話），使用者卻看到「你已失去存取權」——必須留下訊號（issue #37）。
    const line = ctx.collabLogs.find(one => one.obj.phase === "deadline");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ cause: "no-reverify", noteId: note.id, userId: victim.id });
  });

  it("連線期被撤權（onTokenSync 關掉連線）也要留下 phase:'reverify' 的日誌（issue #37）", async () => {
    // 「我好好的怎麼突然被踢出來」最常見的來源是這條路，不是握手——docs 的排錯指引叫維護者
    // grep `"cause"`，那就必須 grep 得到它。
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-rev9@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-rev9@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-rev9@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-rev9@example.com", PASSWORD);
    const editorClient = await editorSession.connect(note.id);

    const del = await ownerSession.fetch(`/api/notes/${note.id}/shares/${editorUser.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    await waitFor("被撤者收到 CLOSE(revoked)", 10_000, () =>
      editorClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    const line = ctx.collabLogs.find(one => one.obj.phase === "reverify");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: editorUser.id, cause: "no-role" });
  });

  it("停用使用者：該 user 在兩篇不同筆記上的連線皆被剝離（跨文件）", async () => {
    const ctx = await buildApp();
    await ctx.createUser({ email: "admin-rev3@example.com", password: PASSWORD, isAdmin: true });
    const owner = await ctx.createUser({ email: "owner-rev3@example.com", password: PASSWORD });
    const target = await ctx.createUser({ email: "target-rev3@example.com", password: PASSWORD });
    // 一篇自己的、一篇被分享的——跨文件才測得出 onUserRevoked 走的是 connectionsOf(userId)
    // 而非某一份文件的連線清單。
    const ownNote = await ctx.createNote(target.id);
    const sharedNote = await ctx.createNote(owner.id);
    await ctx.share(sharedNote.id, target.id, "editor");

    const adminSession = await ctx.loginAs("admin-rev3@example.com", PASSWORD);
    const targetSession = await ctx.loginAs("target-rev3@example.com", PASSWORD);

    const ownClient = await targetSession.connect(ownNote.id);
    const sharedClient = await targetSession.connect(sharedNote.id);
    expect(ctx.collab.connectionsOf(target.id).size).toBe(2);

    const started = Date.now();
    const disableRes = await adminSession.fetch(`/api/admin/users/${target.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(204);

    // 停用後該使用者連 token endpoint 都會 401（gate.invalidate + tv bump），provider 的
    // token function 取不到 token 就不會回送——這條連線因此走 deadline 分支被剝離。
    // 兩篇筆記的連線都必須在 SLA 內斷開。
    await waitFor("自有筆記的連線被 close(knotebook:revoked)", 10_000, () =>
      ownClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    await waitFor("被分享筆記的連線被 close(knotebook:revoked)", 10_000, () =>
      sharedClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );
    expect(Date.now() - started).toBeLessThan(10_000);

    await waitFor("兩條連線都已從索引移除", 10_000, () => ctx.collab.connectionsOf(target.id).size === 0);
  });

  it("token endpoint 暫時 5xx：client 重試期間 server 未收到重驗結果也不誤殺（deadline 內回來即撤銷 timer）", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-rev4@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-rev4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-rev4@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-rev4@example.com", PASSWORD);

    // 重驗時的第一次取 token 模擬撞上 5xx：client 的重試策略是等 1.5s 再打一次（真的再打
    // 一次 endpoint）。1.5s < 5s deadline，這條連線的權限其實完全沒變，不得被關掉。
    let armed = false;
    let attempts = 0;
    const ownerClient = await ownerSession.connect(note.id);
    const editorClient = await editorSession.connect(note.id, {
      tokenFn: async () => {
        if (armed) {
          attempts += 1;
          if (attempts === 1) await sleep(1_500);
        }
        return fetchToken(editorSession, note.id);
      },
    });
    armed = true;

    // 角色沒有變（editor → editor），但 PUT /shares 一律呼叫 onShareChanged——重驗會成功，
    // 純粹用來把這條連線推進「requestToken + deadline」的流程。
    const putRes = await ownerSession.fetch(`/api/notes/${note.id}/shares`, {
      method: "PUT",
      body: JSON.stringify({ email: "editor-rev4@example.com", role: "editor" }),
    });
    expect(putRes.status).toBe(200);

    // 等到超過 deadline 才斷言：若 timer 沒有被 onNextTokenSync 撤銷（或撤銷的是別條
    // 連線的 timer），這裡就會看到一筆 revoked。
    await sleep(REVERIFY_DEADLINE_MS + 1_500);
    expect(editorClient.closes).toEqual([]);
    expect(attempts).toBeGreaterThanOrEqual(1);

    // 連線不只「沒被關」，而且仍然真的可用。
    insertParagraph(editorClient.doc, "still editing");
    await waitFor("未被誤殺的連線仍可寫入並收斂到 owner", 10_000, () =>
      ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString().includes("still editing")
    );
  });

  it("limiter 邊界：該 user 已用掉 59/60 次 collab-token 配額，撤權重驗仍在 deadline 內完成（不被節流拖垮）", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-rev5@example.com", password: PASSWORD });
    const victim = await ctx.createUser({ email: "victim-rev5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, victim.id, "editor");

    const ownerSession = await ctx.loginAs("owner-rev5@example.com", PASSWORD);
    const victimSession = await ctx.loginAs("victim-rev5@example.com", PASSWORD);

    // 連線本身耗掉第 1 次配額。
    const victimClient = await victimSession.connect(note.id);

    // 再手動耗掉 58 次 → 累計 59/60，重驗那一次剛好是第 60 次（仍在限額內）。
    for (let i = 0; i < 58; i += 1) {
      const res = await victimSession.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
      expect(res.status).toBe(200);
    }

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}/shares/${victim.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    await waitFor("配額邊界上的重驗仍以 close(knotebook:revoked) 收場", 10_000, () =>
      victimClient.closes.some(one => one.reason === COLLAB_CLOSE_REVOKED)
    );

    // 上界斷言：這次 close 必須來自「token 真的回來了、重驗判定無權限」，而不是 deadline
    // 到期的保底路徑——後者代表 client 在配額邊界上取不到 token（SLA 雖然仍成立，但慢了
    // 5 秒，且性質是「猜測性剝離」而非「查證後剝離」）。
    expect(Date.now() - started).toBeLessThan(REVERIFY_DEADLINE_MS - 500);

    // 佐證配額真的被用到第 60 次（重驗那次也走了同一個 endpoint）：下一次即超限。
    const overRes = await victimSession.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
    expect(overRes.status).toBe(429);
  });

  it("刪除筆記：連線者收 CLOSE(note-deleted)、DELETE 於 SLA 內回 204、刪除中重連被拒、刪後 token 200+role:'none' 但無法連線、GET 404", async () => {
    const ctx = await buildApp();
    const owner = await ctx.createUser({ email: "owner-rev6@example.com", password: PASSWORD });
    const editorUser = await ctx.createUser({ email: "editor-rev6@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    await ctx.share(note.id, editorUser.id, "editor");

    const ownerSession = await ctx.loginAs("owner-rev6@example.com", PASSWORD);
    const editorSession = await ctx.loginAs("editor-rev6@example.com", PASSWORD);

    const ownerClient = await ownerSession.connect(note.id);
    const editorClient = await editorSession.connect(note.id);
    insertParagraph(ownerClient.doc, "doomed content");
    await waitFor("兩端先收斂（確保文件真的在記憶體中且有內容）", 10_000, () =>
      editorClient.doc.getXmlFragment(YDOC_FRAGMENT).toString().includes("doomed content")
    );

    const started = Date.now();
    const delRes = await ownerSession.fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    const elapsed = Date.now() - started;

    // DELETE 不得掛死（beforeNoteDeleted 的輪詢有上限，逾時就記錯放行）。
    expect(delRes.status).toBe(204);
    expect(elapsed).toBeLessThan(10_000);

    await waitFor("owner 端收到 CLOSE(knotebook:note-deleted)", 10_000, () =>
      ownerClient.closes.some(one => one.reason === COLLAB_CLOSE_NOTE_DELETED)
    );
    await waitFor("editor 端收到 CLOSE(knotebook:note-deleted)", 10_000, () =>
      editorClient.closes.some(one => one.reason === COLLAB_CLOSE_NOTE_DELETED)
    );
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(0);
    expect(ctx.collab.hocuspocus.documents.has(note.id)).toBe(false);

    // 刪除閘門仍在（TTL 內，見 DELETING_GATE_TTL_MS）：此時的重連一律以 note-deleting 拒絕。
    // 刻意在 DELETE 回應之後才測，而不是與 DELETE 併發送出——後者的相對時序取決於兩邊
    // 各自的 DB 往返，會是不確定性測試；閘門的 TTL 讓「刪除中」這個狀態在回應後仍持續，
    // 因此這裡測到的是同一個閘門、同一條拒絕路徑。
    await expect(editorSession.connect(note.id)).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);

    // §5 契約：token endpoint 對「有 session、但對該 note 無權限（含已刪除）」一律
    // 200 + role:'none'，絕不回錯誤狀態（不當權限探測 oracle）。
    const tokenRes = await editorSession.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { token: string; role: Role };
    expect(tokenBody.role).toBe("none");

    // 閘門過期之後（模擬 TTL 到期）這份 token 仍然連不上：擋下它的是 onAuthenticate
    // 重跑 resolveRole（筆記已不存在 → 'none'），不是刪除閘門。理由因此是 `forbidden`
    // ——與「這篇筆記存在、但你沒有權限」完全一樣，問不出存在性（issue #35 的取捨：
    // 「筆記被刪了」這句話由閘門在 TTL 內負責，見 DELETING_GATE_TTL_MS）。
    ctx.collab.unmarkDeleting(note.id);
    await expect(editorSession.connect(note.id, { tokenOverride: tokenBody.token })).rejects.toThrow(
      COLLAB_REJECT_FORBIDDEN
    );

    const getRes = await editorSession.fetch(`/api/notes/${note.id}`);
    expect(getRes.status).toBe(404);
  });
});
