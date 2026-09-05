import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";

describe("EditingRuntime", () => {
  it("installGlobals 後 window/document 與三個 rect polyfill 存在，document.URL 是 baseUrl，navigator 仍是 Node 內建的 getter", () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
    rt.installGlobals();
    expect(typeof globalThis.document.createElement).toBe("function");
    expect(globalThis.document.URL).toBe("http://localhost/");
    expect(typeof Element.prototype.getBoundingClientRect).toBe("function");
    expect(typeof Range.prototype.getBoundingClientRect).toBe("function");
    expect(typeof Range.prototype.getClientRects).toBe("function");
    const d = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
    expect(typeof d.get).toBe("function"); // Node ≥ 21 的 getter-only 內建，沒被覆寫成 jsdom 的值
    expect(d.value).toBeUndefined();
  });

  it("installGlobals 之後 new Anthropic() 不 throw（upstream.ts 的 dangerouslyAllowBrowser 守住瀏覽器嗅探）", () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
    rt.installGlobals();
    expect(() => new Anthropic({ apiKey: "x" })).toThrow(/browser-like environment/); // 沒有旗標會炸：釘住嗅探確實被觸發
    expect(() => new Anthropic({ apiKey: "x", dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it("假計數器：第 rebuildEvery 次 mount 標記重建；有 in-flight 時延後，歸零才重建", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 2 });
    rt.installGlobals();
    const a = await rt.acquire();
    rt.noteMount();
    rt.noteMount();
    expect(rt.rebuildPending).toBe(true);
    expect(rt.rebuilds).toBe(0);
    a.release();
    expect(rt.rebuilds).toBe(1);
    expect(rt.rebuildPending).toBe(false);
  });

  it("旗標設下後新 session 被擋 → 排空 → 重建 → 放行", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    rt.installGlobals();
    const a = await rt.acquire();
    rt.noteMount();
    let admitted = false;
    const pending = rt.acquire().then(l => {
      admitted = true;
      return l;
    });
    await new Promise(r => setImmediate(r));
    expect(admitted).toBe(false);
    a.release();
    const b = await pending;
    expect(admitted).toBe(true);
    expect(rt.rebuilds).toBe(1);
    b.release();
  });

  it("heap 增量超過上限也標記重建（注入 heapUsed 讀法）", async () => {
    let heap = 0;
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1_000, heapGrowthLimit: 10, readHeapUsed: () => heap });
    rt.installGlobals();
    heap = 11;
    const a = await rt.acquire();
    rt.noteMount();
    a.release();
    expect(rt.rebuilds).toBe(1);
  });

  // I-1：兩個 lease 同時持有時，先釋放的那個不能觸發重建——它一走就會把另一個還在用的 window 關掉。
  // 只有等 in-flight 真的歸零（兩個都 release）才可以重建。把 runtime.ts 的
  // `|| this.inFlightCount > 0` 拿掉會讓這個案子在 a.release() 那一步就提早重建，本案變紅（已手動驗證）。
  it("兩個 lease 同時持有時，其中一個 release 不會提前重建；全部釋放才重建", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    rt.installGlobals();
    const a = await rt.acquire();
    const b = await rt.acquire();
    rt.noteMount();
    expect(rt.rebuildPending).toBe(true);
    a.release();
    expect(rt.rebuilds).toBe(0);
    expect(rt.rebuildPending).toBe(true);
    b.release();
    expect(rt.rebuilds).toBe(1);
    expect(rt.rebuildPending).toBe(false);
  });

  // I-2：重建不能只是計數器跳——window 真的要換掉、舊的真的要關閉，否則 mount 造成的記憶體殘留
  // 完全不會回收（這個模組存在的唯一理由）。把 runtime.ts 的 installGlobals()／window.close() 拿掉
  // 會讓本案變紅（已手動驗證，見 task-2-report.md）。
  it("重建真的換了 window、真的關閉了舊的 window（不只是計數器跳）", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1 });
    rt.installGlobals();
    const beforeDoc = globalThis.document;
    const beforeWindow = beforeDoc.defaultView!;
    const a = await rt.acquire();
    rt.noteMount();
    a.release(); // 觸發重建
    expect(globalThis.document).not.toBe(beforeDoc);
    // jsdom 的 window.close() 不會設 `closed` 屬性，但會把 window.document 拆掉——用它釘住「真的關了」。
    expect(beforeWindow.document).toBeUndefined();
  });

  // I-2：mountsSinceRebuild 沒歸零的話，重建後立刻再 mount 一次就會因為殘留計數再度達標而誤判 pending。
  // 把 runtime.ts 的 `this.mountsSinceRebuild = 0` 拿掉會讓本案變紅（已手動驗證）。
  it("重建後 mountsSinceRebuild 歸零：緊接著再 mount 一次不會又觸發 pending", async () => {
    const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 2 });
    rt.installGlobals();
    const a = await rt.acquire();
    rt.noteMount();
    rt.noteMount();
    a.release(); // 觸發重建
    expect(rt.rebuildPending).toBe(false);
    rt.noteMount(); // 重建後的第一次 mount
    expect(rt.rebuildPending).toBe(false);
  });

  // m3：installGlobals() 在重建路徑 throw（這裡借用 readHeapUsed 的注入點模擬）時，pending 與
  // waiters 仍要放掉，否則後面所有 acquire() 永遠不會 settle（整台 server 的 AI 編輯靜默停擺）。
  it("installGlobals() 在重建時 throw 不會造成永久 hang：pending 清空、waiters 照樣放行、錯誤有留痕", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let throwOnRead = false;
      const rt = new EditingRuntime({
        baseUrl: "http://localhost/",
        rebuildEvery: 1,
        readHeapUsed: () => {
          if (throwOnRead) throw new Error("heap read boom");
          return 0;
        },
      });
      rt.installGlobals();
      const a = await rt.acquire();
      rt.noteMount();
      throwOnRead = true; // 下一次 installGlobals() 內部的 readHeapUsed() 會 throw
      a.release(); // 觸發 maybeRebuild()；不應該同步 throw 出來
      expect(rt.rebuildPending).toBe(false); // 沒有卡在 pending
      expect(rt.rebuilds).toBe(0); // 沒有假裝重建成功
      expect(consoleError).toHaveBeenCalledTimes(1); // 錯誤有留痕，不是被靜默吞掉
      const raced = await Promise.race([
        rt.acquire().then(() => "acquired" as const),
        new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 200)),
      ]);
      expect(raced).toBe("acquired"); // 沒有永久卡住之後的 acquire()
    } finally {
      consoleError.mockRestore(); // 任一斷言先炸也要還原 console.error，不然後續測試的錯誤輸出會被吃掉
    }
  });
});
