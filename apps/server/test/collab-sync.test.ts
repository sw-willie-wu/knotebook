import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { COLLAB_REJECT_NOTE_DELETING } from "../src/collab/server.js";
import { buildCollabTestApp } from "./helpers.js";

const PASSWORD = "correct-horse-battery";

// 本 task 的 onAuthenticate 是過渡實作（接受任意非空 token、`context.userId = token`），
// 所以測試一律用 `tokenOverride` 直接指定「使用者身分」——`POST /api/notes/:id/collab-token`
// 要到 Task 4 才存在。Task 5 把 onAuthenticate 換成真驗證後，這裡改走不帶 override 的
// `connect()`（走真 endpoint 取 token）。
const TOKEN_A = "spike-userA";
const TOKEN_B = "spike-userB";

// 只在本檔用來辨識「這則 CLOSE 是我們主動送的」。真正的撤權 reason 常數（
// COLLAB_CLOSE_REVOKED 等）由 Task 2 定義、Task 6 消費。
const TEST_CLOSE_REASON = "knotebook:test-closed";

/**
 * 輪詢等待條件成立。共編是非同步收斂的，斷言不可用固定 sleep（會依機器速度隨機
 * 紅綠），也不可只檢查一次——一律「在期限內輪詢到成立」，逾時才失敗並帶上標籤。
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

describe("Hocuspocus v4 × Fastify 共編同步", () => {
  it("兩個 client 連同一份 note，A 的編輯 ≤3s 內收斂到 B", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    const a = await session.connect(note.id, { tokenOverride: TOKEN_A });
    const b = await session.connect(note.id, { tokenOverride: TOKEN_B });

    insertParagraph(a.doc, "hello from A");

    await waitFor("B 的 state vector 收斂到與 A 相同", 3_000, () => stateVector(b.doc) === stateVector(a.doc));
    expect(b.doc.getXmlFragment(YDOC_FRAGMENT).toString()).toBe("<paragraph>hello from A</paragraph>");
  });

  it("連線索引隨連線建立/中斷增減（Task 5/6 撤權的地基）", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    const a = await session.connect(note.id, { tokenOverride: TOKEN_A });
    await session.connect(note.id, { tokenOverride: TOKEN_B });

    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(2);
    expect(ctx.collab.connectionsOf(TOKEN_A).size).toBe(1);
    expect(ctx.collab.connectionsOf(TOKEN_B).size).toBe(1);

    const handle = [...ctx.collab.connectionsOf(TOKEN_A)][0];
    expect(handle.noteId).toBe(note.id);
    expect(handle.userId).toBe(TOKEN_A);

    a.disconnect();

    await waitFor("A 斷線後索引移除該連線", 3_000, () => ctx.collab.connectionsOf(TOKEN_A).size === 0);
    expect(ctx.collab.connectionsOfNote(note.id).size).toBe(1);
  });

  it("同一條 socket 退訂再重訂同一篇筆記：索引指向活著的那條連線，舊登記不殘留", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    const a = await session.connect(note.id, { tokenOverride: TOKEN_A });

    // detach → attach 是 SPA 在筆記間導覽的形狀：**同一條 socket**（socketId 不變）先送
    // CLOSE 退訂，再重新訂閱同一篇筆記，於是前後兩次登記共用同一個
    // (socketId, documentName) 複合鍵。
    a.provider.detach();
    a.provider.attach();

    await waitFor("重訂後索引恰有一條連線", 5_000, () => ctx.collab.connectionsOfNote(note.id).size === 1);
    expect(ctx.collab.connectionsOf(TOKEN_A).size).toBe(1);

    // 索引裡剩下的必須是**活著**的那條：拿它關線，client 要真的收得到。若索引誤留舊的
    // （已從 document 移除的）handle，`Connection.close` 的 hasConnection 守衛會讓它靜靜
    // 什麼都不做——撤權就會漏掉一個還在編輯的使用者（Task 6 的失效模式）。
    const handle = [...ctx.collab.connectionsOfNote(note.id)][0];
    handle.close(TEST_CLOSE_REASON);

    await waitFor("client 收到指定 reason 的應用層 CLOSE", 3_000, () =>
      a.closes.some(one => one.reason === TEST_CLOSE_REASON)
    );
  });

  it("onNextTokenSync 在 requestToken 觸發的 token 抵達時被呼叫，且只觸發一次", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    await session.connect(note.id, { tokenOverride: TOKEN_A });
    const handle = [...ctx.collab.connectionsOf(TOKEN_A)][0];

    // 同一連線登記兩個回呼：兩個都必須被觸發（Task 6 的 deadline 在 5s 內可能重覆
    // 登記，若實作用「單一 cb 覆寫」會讓第一個 timer 永不解除、誤殺已重驗成功者）。
    let first = 0;
    let second = 0;
    ctx.collab.onNextTokenSync(handle, () => { first += 1; });
    ctx.collab.onNextTokenSync(handle, () => { second += 1; });

    handle.requestToken();

    await waitFor("onNextTokenSync 的兩個回呼都被觸發", 3_000, () => first === 1 && second === 1);

    // 一次性：登記過的回呼觸發後即清空，第二次 token 抵達不會重複呼叫。
    handle.requestToken();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it("markDeleting 期間拒絕新連線，unmarkDeleting 後恢復", async () => {
    const ctx = await buildCollabTestApp();
    const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
    const note = await ctx.createNote(alice.id);
    const session = await ctx.loginAs("alice@example.com", PASSWORD);

    ctx.collab.markDeleting(note.id);
    await expect(session.connect(note.id, { tokenOverride: TOKEN_A })).rejects.toThrow(COLLAB_REJECT_NOTE_DELETING);

    ctx.collab.unmarkDeleting(note.id);
    const a = await session.connect(note.id, { tokenOverride: TOKEN_A });
    expect(a.provider.isAuthenticated).toBe(true);
  });
});
