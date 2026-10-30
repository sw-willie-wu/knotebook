// #293 在線頭像列：viewer 的 awareness 轉發與離線移除（spec §4.1、§15、P6）。
// 本檔守的多是 Hocuspocus／y-protocols 的函式庫事實（產品碼沒有對應的一行），各條由哪一步守：
// - 唯讀連線的 awareness 照樣轉發 → CA1
// - 連線關閉即移除該連線登記的 clientID → CA3 第 1 步（5 s 窗）、CA2
// - 重連的重送沿用舊 clock、被忽略 → CA3 第 2 步、CA4 對照組
// - clock＋1 被接受 → CA3 第 3 步；觀察者清掉舊 meta 後重連即看到別人 → CA4
// - 重連後的人不正常斷線，靠 30 s outdatedTimeout 移除 → CA3 第 4 步，只守「不超過 35 s」（改慢會紅，改快不會）
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { buildCollabTestApp, type TestClient } from "./helpers.js";
import { waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const socketOf = (c: TestClient) => c.provider.configuration.websocketProvider;

type PeerState = { knotebook?: { role?: string }; user?: { id?: string } } | undefined;
const sawViewer = (st: PeerState, viewerUserId: string) => st?.knotebook?.role === "viewer" && st.user?.id === viewerUserId;

async function scene(tag: string) {
  const ctx = await buildCollabTestApp();
  const owner = await ctx.createUser({ email: `owner-${tag}@example.com`, password: PASSWORD });
  const viewer = await ctx.createUser({ email: `viewer-${tag}@example.com`, password: PASSWORD });
  const note = await ctx.createNote(owner.id);
  await ctx.share(note.id, viewer.id, "viewer");
  const ownerClient = await (await ctx.loginAs(`owner-${tag}@example.com`, PASSWORD)).connect(note.id);
  const viewerClient = await (await ctx.loginAs(`viewer-${tag}@example.com`, PASSWORD)).connect(note.id);
  const viewerId = viewerClient.provider.awareness!.clientID;
  const ownerStates = () => ownerClient.provider.awareness!.getStates();
  const ownerSeesViewer = () => ownerStates().has(viewerId);
  viewerClient.provider.setAwarenessField("knotebook", { v: 1, kind: "user", role: "viewer", avatar: null, since: 1 });
  viewerClient.provider.setAwarenessField("user", { id: viewer.id, name: "V", color: "#000000" });
  // 兩個欄位是兩則 awareness 訊息：兩者都到了才算收到，不在中間讀
  await waitFor("owner 收到 viewer 的狀態", 5_000, () => sawViewer(ownerStates().get(viewerId) as PeerState, viewer.id));
  return { ctx, viewer, ownerClient, viewerClient, viewerId, ownerStates, ownerSeesViewer };
}

/** 照 web `useLocalPresenceField` 的 onClose 清理複製（server 測試不 import web）：刪掉已沒有 state 的遠端 meta。 */
function clearStaleRemoteMeta(c: TestClient): void {
  c.provider.on("close", () => {
    const a = c.provider.awareness!;
    for (const id of [...a.meta.keys()]) if (id !== a.clientID && !a.states.has(id)) a.meta.delete(id);
  });
}

describe("collab awareness（#293）", () => {
  it("CA1 viewer 的 awareness 會轉發給同篇的人；這條連線確實是唯讀", async () => {
    const s = await scene("ca1");
    const st = s.ownerStates().get(s.viewerId) as PeerState;
    expect(st?.knotebook?.role).toBe("viewer");
    expect(st?.user?.id).toBe(s.viewer.id);
    // 唯讀的反證：viewer 寫 Y.Doc 不會到 owner（collab-auth 的同一手法）——CA1 不是因為它其實是 editor 才成立
    const el = new Y.XmlElement("paragraph");
    el.insert(0, [new Y.XmlText("from viewer")]);
    s.viewerClient.doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [el]);
    await sleep(500);
    expect(s.ownerClient.doc.getXmlFragment(YDOC_FRAGMENT).toString()).not.toContain("from viewer");
  });

  it("CA2 不正常斷線（不送移除訊息）也會被移除，且在 35 s 內（A2、P6）", async () => {
    const s = await scene("ca2");
    const t0 = Date.now();
    socketOf(s.viewerClient).destroy(); // 不呼叫 provider.destroy()：模擬分頁直接被關
    await waitFor("owner 端移除 viewer", 40_000, () => !s.ownerSeesViewer());
    const ms = Date.now() - t0;
    console.log("[P6] abrupt close removal ms", ms);
    expect(ms).toBeLessThan(35_000);
    s.viewerClient.disconnect();
  }); // CA2／CA3 不另設 per-test 逾時、沿用全域 120 s：要等滿 awareness 的 30 s 逾時，加上建場景與各段 waitFor，60 s 太貼

  it("CA3 重連的重送被忽略、clock＋1 重寫才回來；之後不正常斷線仍在 35 s 內移除（P6、N-4）", async () => {
    const s = await scene("ca3");
    const sock = socketOf(s.viewerClient);
    sock.disconnect();
    await waitFor("owner 端失去 viewer", 5_000, () => !s.ownerSeesViewer());
    void sock.connect();
    await waitFor("viewer 重新認證並同步", 5_000, () => s.viewerClient.provider.isAuthenticated && s.viewerClient.provider.synced);
    await sleep(2_000);
    // 函式庫行為：onOpen 的重送沿用舊 clock，server 整筆忽略——web 端 LF9「重連強制重寫」存在的理由
    expect(s.ownerSeesViewer()).toBe(false);
    const a = s.viewerClient.provider.awareness!;
    a.setLocalState({ ...a.getLocalState()! }); // 模擬 useLocalPresenceField 的重寫（clock＋1）
    await waitFor("owner 端 viewer 回來", 5_000, s.ownerSeesViewer);
    const t0 = Date.now();
    sock.destroy();
    await waitFor("移除", 40_000, () => !s.ownerSeesViewer());
    const ms = Date.now() - t0;
    console.log("[P6] reconnected abrupt close removal ms", ms);
    expect(ms).toBeLessThan(35_000);
    s.viewerClient.disconnect();
  });

  it("CA4 觀察者自己重連：onClose 清掉遠端舊 meta → 重連後立即看到原本在場的人", async () => {
    const s = await scene("ca4");
    clearStaleRemoteMeta(s.ownerClient);
    const sock = socketOf(s.ownerClient);
    sock.disconnect();
    await waitFor("owner 端失去 viewer", 5_000, () => !s.ownerSeesViewer());
    void sock.connect();
    await waitFor("owner 重新認證並同步", 5_000, () => s.ownerClient.provider.isAuthenticated && s.ownerClient.provider.synced);
    const t0 = Date.now();
    await waitFor("owner 重連後看到 viewer", 5_000, s.ownerSeesViewer);
    console.log("[CA4] observer reconnect, viewer back after ms", Date.now() - t0);
  });

  it("CA4 對照：不清遠端舊 meta → 重連後 2 s 仍看不到原本在場的人", async () => {
    const s = await scene("ca4b");
    const sock = socketOf(s.ownerClient);
    sock.disconnect();
    await waitFor("owner 端失去 viewer", 5_000, () => !s.ownerSeesViewer());
    void sock.connect();
    await waitFor("owner 重新認證並同步", 5_000, () => s.ownerClient.provider.isAuthenticated && s.ownerClient.provider.synced);
    await sleep(2_000);
    expect(s.ownerSeesViewer()).toBe(false);
  });
});
