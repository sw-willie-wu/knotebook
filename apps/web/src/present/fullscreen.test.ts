import { afterEach, describe, expect, it, vi } from "vitest";

// 每案一份假 document＋重新 import 模組：模組在載入時對 `document` 掛一次 fullscreenchange，
// 共用真 document 的話，前一案的模組實例會繼續收到事件（殘留狀態會多呼叫 exitFullscreen）。
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Deferred {
  resolve: () => void;
  reject: (err: unknown) => void;
}

function makeFakeDocument() {
  const listeners = new Set<() => void>();
  let request: Deferred | null = null;
  const exits: Deferred[] = [];
  const documentElement = {
    requestFullscreen: vi.fn(() => new Promise<void>((resolve, reject) => { request = { resolve, reject }; })),
  };
  const doc = {
    fullscreenEnabled: true,
    fullscreenElement: null as unknown,
    documentElement,
    addEventListener: (type: string, fn: () => void) => { if (type === "fullscreenchange") listeners.add(fn); },
    exitFullscreen: vi.fn(() => new Promise<void>((resolve, reject) => { exits.push({ resolve, reject }); })),
  };
  const fire = () => listeners.forEach((fn) => fn());
  return {
    doc,
    /** 規範順序：先送 fullscreenchange、後 resolve。 */
    async grantEventFirst() { doc.fullscreenElement = documentElement; fire(); request?.resolve(); request = null; await flush(); },
    /** 另一種順序：先 resolve、後送事件。 */
    async grantResolveFirst() { doc.fullscreenElement = documentElement; request?.resolve(); request = null; await flush(); fire(); await flush(); },
    async deny() { request?.reject(new TypeError("denied")); request = null; await flush(); },
    async completeExit() { doc.fullscreenElement = null; fire(); exits.shift()?.resolve(); await flush(); },
    async rejectExit() { exits.shift()?.reject(new TypeError("not in fullscreen")); await flush(); },
    async userExit() { doc.fullscreenElement = null; fire(); await flush(); },
    async otherEnters(el: unknown) { doc.fullscreenElement = el; fire(); await flush(); },
  };
}

async function load(fake: ReturnType<typeof makeFakeDocument>) {
  vi.stubGlobal("document", fake.doc);
  vi.resetModules();
  return import("./fullscreen");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("present/fullscreen（spec §6.5）", () => {
  it("在使用者事件內同步呼叫 requestFullscreen；成功後 isOwnedFullscreen 為真", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    expect(fake.doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    await fake.grantEventFirst();
    expect(fs.isOwnedFullscreen()).toBe(true);
  });

  it("fullscreenEnabled 為 false、或已在全螢幕、或已有請求 pending → 不請求", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fake.doc.fullscreenEnabled = false;
    fs.enterPresentationFullscreen();
    fake.doc.fullscreenEnabled = true;
    fake.doc.fullscreenElement = {};
    fs.enterPresentationFullscreen();
    fake.doc.fullscreenElement = null;
    fs.enterPresentationFullscreen();
    fs.enterPresentationFullscreen();
    expect(fake.doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("請求被拒：owned 與 exitWanted 都歸 false（之後別的元素進全螢幕不退）", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen(); // pending 中要退 → exitWanted
    await fake.deny();
    expect(fs.isOwnedFullscreen()).toBe(false);
    await fake.otherEnters(fake.doc.documentElement);
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("pending 中退出、請求被拒之前影片先進全螢幕 → 不退那支影片（只處理我們要的整份文件，gate r2-p2 補案）", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen(); // pending 中 → exitWanted
    await fake.otherEnters({ tagName: "VIDEO" });
    await fake.deny();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("不退非本模組要求的全螢幕（影片自己全螢幕）", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    await fake.otherEnters({ tagName: "VIDEO" });
    fs.exitOwnedFullscreen();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
    expect(fs.isOwnedFullscreen()).toBe(false);
  });

  it("別人把整份文件全螢幕（非本模組要求）→ owned 為 false、exitOwnedFullscreen 不退", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    await fake.otherEnters(fake.doc.documentElement);
    expect(fs.isOwnedFullscreen()).toBe(false);
    fs.exitOwnedFullscreen();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it.each(["grantEventFirst", "grantResolveFirst"] as const)("pending 中退出、%s → exitFullscreen 恰一次", async (order) => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen();
    expect(fake.doc.exitFullscreen).not.toHaveBeenCalled(); // pending 中不能退（會 reject、請求照樣生效）
    await fake[order]();
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("pending 中退出兩次 → 仍只退一次", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen();
    fs.exitOwnedFullscreen();
    await fake.grantResolveFirst();
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("exitFullscreen reject 不留 unhandled rejection", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      fs.enterPresentationFullscreen();
      await fake.grantEventFirst();
      fs.exitOwnedFullscreen();
      await fake.rejectExit();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("完成一次 pending 退出之後，再有別的元素進入全螢幕 → 不呼叫退出（殘留 exitWanted 的回歸，gate H 案）", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    fs.enterPresentationFullscreen();
    fs.exitOwnedFullscreen();
    await fake.grantResolveFirst();
    await fake.completeExit();
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
    await fake.otherEnters({ tagName: "VIDEO" });
    expect(fake.doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("msSinceFullscreenExit：從未離開過回 Infinity；離開事件之後是有限的小數字", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    expect(fs.msSinceFullscreenExit()).toBe(Infinity);
    fs.enterPresentationFullscreen();
    await fake.grantEventFirst();
    await fake.userExit();
    expect(fs.msSinceFullscreenExit()).toBeLessThan(1000);
  });

  it("subscribeFullscreen：狀態更新之後才通知；取消訂閱後不再通知", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    const seen: boolean[] = [];
    const unsubscribe = fs.subscribeFullscreen(() => seen.push(fs.isOwnedFullscreen()));
    fs.enterPresentationFullscreen();
    await fake.grantEventFirst();
    await fake.userExit();
    unsubscribe();
    await fake.otherEnters({});
    expect(seen).toEqual([true, false]);
  });

  it("subscribeFullscreen：離開事件的通知發出時，msSinceFullscreenExit 已是有限值（補案：M5 在上一案測不出，因為 fake 先改 fullscreenElement）", async () => {
    const fake = makeFakeDocument();
    const fs = await load(fake);
    const seen: number[] = [];
    fs.subscribeFullscreen(() => seen.push(fs.msSinceFullscreenExit()));
    fs.enterPresentationFullscreen();
    await fake.grantEventFirst();
    expect(seen).toEqual([Infinity]); // 進入事件：尚未離開過
    await fake.userExit();
    expect(seen).toHaveLength(2);
    expect(Number.isFinite(seen[1])).toBe(true);
  });
});
