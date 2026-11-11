import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { YDOC_FRAGMENT, createHeadlessNoteSchema, topLevelContainers } from "@knotebook/shared";
import type { CollabContext } from "../../src/collab/server.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, NoteGoneError, forkFrom, withDirectConnection, type DirectCtx, type DirectTarget } from "../../src/notes/editing/session.js";

// rebuildEvery／heapGrowthLimit 刻意調到不可能觸發——本檔最後一案會另建一個 rebuildEvery:1 的
// runtime 並用它自己 installGlobals() 換掉 globalThis 的 window/document；若這顆模組層 rt 中途也
// 觸發了自己的重建，會在測試中途把全域 window 換走，讓那個小 runtime 的 session 意外 mount 到別顆
// window 上（潛在 flake）。
const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1_000_000, heapGrowthLimit: Number.MAX_SAFE_INTEGER });
rt.installGlobals();

async function seeded(): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  s.editor.replaceBlocks(s.editor.document, [
    { type: "paragraph", content: "第一段" },
    { type: "paragraph", content: "第二段" },
    { type: "heading", props: { level: 2 }, content: "標題" },
  ]);
  s.close();
  return doc;
}
const ids = (doc: Y.Doc): Array<string | null> => topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id") ?? null);

describe("EditorSession", () => {
  it("fork 上 replaceBlocks → diff 套回原 doc：段外 id 不變、被換的段換新 id、併發編輯兩邊都活", async () => {
    const source = await seeded();
    const [p1, p2, h1] = ids(source);
    // 先釘住「id 真的是三個相異字串」：否則下面的 toBe/not.toBe 在 id 全是 null 時會空轉成假綠。
    for (const v of [p1, p2, h1]) expect(typeof v).toBe("string");
    expect(new Set([p1, p2, h1]).size).toBe(3);
    const { fork, sv } = forkFrom(source);
    const s = await EditorSession.open(rt, fork);
    s.editor.replaceBlocks([p2!], [{ type: "paragraph", content: "AI 改寫" }]);
    const diff = s.diffSince(sv);
    s.close();
    const s2 = await EditorSession.open(rt, source); // 併發：合併前有人在 source 追加
    s2.editor.insertBlocks([{ type: "paragraph", content: "同時打的" }], h1!, "after");
    s2.close();
    Y.applyUpdate(source, diff);
    const after = ids(source);
    expect(after[0]).toBe(p1);
    expect(after[2]).toBe(h1);
    expect(after[1]).not.toBe(p2);
    expect(source.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("AI 改寫");
    expect(source.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("同時打的");
  });

  it("未 mount 的 collaborative editor 對既有 id 操作 throw", async () => {
    const source = await seeded();
    const { fork } = forkFrom(source);
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: createHeadlessNoteSchema(rt.baseUrl),
        collaboration: { fragment: fork.getXmlFragment(YDOC_FRAGMENT), user: { name: "x", color: "#000" } },
      })
    );
    expect(() => editor.replaceBlocks([ids(source)[0]!], [{ type: "paragraph" }])).toThrow(/could not be found|not found/);
  });

  it("非空文件 mount 不編輯 → 對 pre-fork sv 的 diff 為空（2 bytes）", async () => {
    const source = await seeded();
    const { fork, sv } = forkFrom(source);
    const s = await EditorSession.open(rt, fork);
    const diff = s.diffSince(sv);
    s.close();
    expect(diff.length).toBe(2);
  });

  it("重建 window 後再 mount 並產出正確 diff", async () => {
    const small = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    small.installGlobals();
    const source = await seeded();
    const a = await EditorSession.open(small, forkFrom(source).fork);
    a.close();
    expect(small.rebuilds).toBe(1);
    const { fork, sv } = forkFrom(source);
    const b = await EditorSession.open(small, fork);
    b.editor.insertBlocks([{ type: "paragraph", content: "after rebuild" }], ids(fork)[2]!, "after");
    const diff = b.diffSince(sv);
    b.close();
    Y.applyUpdate(source, diff);
    expect(source.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("after rebuild");
  });
});

// `withDirectConnection` 的錯誤優先分支（fn 的錯優先於 disconnect 的錯，見
// session.ts 的註解）在真實 hocuspocus 上很難逼出「disconnect 也失敗」，這裡用假 Hocuspocus
// 直接控制 disconnect 的成敗，純單元、不需要 docker/pg。
function fakeHocuspocus(disconnect: () => Promise<void>): Hocuspocus<CollabContext> {
  return {
    openDirectConnection: async () => ({
      transact: async (cb: (doc: never) => void) => cb({} as never),
      disconnect,
    }),
  } as unknown as Hocuspocus<CollabContext>;
}

/** 閘門關著、筆記活著：重確認一律放行（本 describe 只驗錯誤優先順序）。 */
const live = (hocuspocus: Hocuspocus<CollabContext>): DirectTarget => ({ hocuspocus, isDeleting: () => false, noteIsLive: async () => true });

const directCtx = (): DirectCtx => ({ source: "ai-edit", userId: "u1", tokenId: null, agentLabel: null, applied: false });

describe("withDirectConnection 的錯誤優先順序", () => {
  it("fn 成功、disconnect 失敗 → reject 且丟出的是 disconnect 的錯（落盤失敗不能被吞）", async () => {
    const disconnectErr = new Error("disconnect boom");
    const disconnect = vi.fn().mockRejectedValue(disconnectErr);
    const hocuspocus = fakeHocuspocus(disconnect);

    await expect(withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => "ok")).rejects.toBe(disconnectErr);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("fn throw、disconnect 也失敗 → reject 丟出 fn 的錯（不是 disconnect 的錯），disconnect 的錯只 log 一次", async () => {
    // 用身分比對（toBe）而非字串子字串比對（toThrow(string)）——後者只要
    // disconnect 的錯誤訊息裡含有 fn 錯誤訊息的子字串就會誤放行。disconnect 的錯誤訊息也刻意跟
    // fn 的錯誤訊息完全不重疊，即使將來有人改回字串比對也不會誤判。
    const fnErr = new Error("fn boom");
    const disconnect = vi.fn().mockRejectedValue(new Error("disconnect failed"));
    const hocuspocus = fakeHocuspocus(disconnect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => {
          throw fnErr;
        })
      ).rejects.toBe(fnErr);
      expect(disconnect).toHaveBeenCalledTimes(1); // disconnect 只呼叫一次，不會因為 fn 錯而重試
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fn 成功、disconnect 也成功 → 回傳 result，disconnect 恰呼叫一次（主線路徑＋防重複落盤）", async () => {
    // 既有兩案都用 mockRejectedValue，disconnect 第一次呼叫就 reject，
    // 蓋不到「disconnect 成功之後」才會發生的重複呼叫；也沒有任何單元案覆蓋主線（fn 成功＋
    // disconnect 成功 → 回傳 result）。這一案同時補上兩個缺口。
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const hocuspocus = fakeHocuspocus(disconnect);

    await expect(withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => "ok")).resolves.toBe("ok");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("fn throw、disconnect 成功 → reject 且丟出的是 fn 的錯（不能被吞成 undefined 的成功），disconnect 恰呼叫一次、不 log", async () => {
    // 補第四格（fn throw × disconnect 成功），單元層原本只覆蓋了另外三格。
    // 殺的退化 D：把 `if (fnFailed) throw fnError;` 搬進 disconnect 的 catch 裡（只有 disconnect
    // 也失敗才重丟）——這格 disconnect 沒失敗，退化後整個函式會直接 resolve 成 undefined。
    const fnErr = new Error("fn boom");
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const hocuspocus = fakeHocuspocus(disconnect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => {
          throw fnErr;
        })
      ).rejects.toBe(fnErr);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fn throw falsy 值（undefined）、disconnect 成功 → 仍然 reject（不是靠 `if (fnError)` 這種錯誤值真假判斷）", async () => {
    // 殺的退化 C：把獨立布林旗標 fnFailed 換成 `if (fnError)` 之類用錯誤值真假判斷——fn 丟出 falsy
    // 值時判斷失效，會被誤判成「fn 沒失敗」而吞掉，整個函式改成直接 resolve 成 undefined。
    // 用 `throw undefined` 這種最極端的 falsy 值，並用 rejects（而非單純 await 後比對回傳值）
    // 斷言，因為「reject 成 undefined」跟「resolve 成 undefined」的回傳值長得一樣，只有
    // rejects/resolves 分得出兩者。
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const hocuspocus = fakeHocuspocus(disconnect);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        withDirectConnection(live(hocuspocus), "note-1", directCtx(), () => {
          throw undefined;
        })
      ).rejects.toBeUndefined();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

// #181：直連寫入的重確認——開之前、開之後各查一次閘門與存活。
function spiedTarget(isDeleting: () => boolean, noteIsLive: () => Promise<boolean>) {
  const transact = vi.fn(async (cb: (doc: never) => void) => cb({} as never));
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn(async () => ({ transact, disconnect }));
  const target: DirectTarget = {
    hocuspocus: { openDirectConnection: open } as unknown as Hocuspocus<CollabContext>,
    isDeleting: vi.fn(isDeleting),
    noteIsLive: vi.fn(noteIsLive),
  };
  return { target, open, transact, disconnect };
}

describe("withDirectConnection 的重確認（DirectTarget）", () => {
  it("ES1：閘門開著 → reject NoteGoneError，不開直連", async () => {
    const s = spiedTarget(() => true, async () => true);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).not.toHaveBeenCalled();
  });

  it("ES0：筆記不在或已在垃圾桶（第一次查就 false）→ reject NoteGoneError，不開直連", async () => {
    const s = spiedTarget(() => false, async () => false);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).not.toHaveBeenCalled();
  });

  it("ES2：開之後閘門才開 → reject NoteGoneError，disconnect 一次、不 transact", async () => {
    let n = 0;
    const s = spiedTarget(() => ++n > 1, async () => true);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.transact).not.toHaveBeenCalled();
  });

  it("ES2b：開之後判 gone、disconnect 也失敗 → 仍丟 NoteGoneError，disconnect 的錯只 log 一次", async () => {
    let n = 0;
    const s = spiedTarget(() => ++n > 1, async () => true);
    s.disconnect.mockRejectedValue(new Error("dc boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
      expect(s.disconnect).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ES3：開之後才移入垃圾桶（第二次 noteIsLive 回 false）→ 同 ES2", async () => {
    let n = 0;
    const s = spiedTarget(() => false, async () => ++n === 1);
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBeInstanceOf(NoteGoneError);
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.transact).not.toHaveBeenCalled();
  });

  it("ES4：開之後的存活查詢本身失敗 → 原錯冒出，仍 disconnect 一次、不 transact", async () => {
    const dbErr = new Error("db down");
    let n = 0;
    const s = spiedTarget(() => false, async () => {
      if (++n > 1) throw dbErr;
      return true;
    });
    await expect(withDirectConnection(s.target, "note-1", directCtx(), () => "ok")).rejects.toBe(dbErr);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.transact).not.toHaveBeenCalled();
  });
});
