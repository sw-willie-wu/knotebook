import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkConversion, type LinkConversionDeps } from "../../src/notes/link-conversion.js";

// spec 2026-10-13 site-links §12.1：stop() 永不 reject——SIGTERM 鏈的 Promise.race 若被它的拒絕帶走，會跳過 collab.destroy()（丟掉人的待落盤編輯）。
// 這裡讓 `running` 本身拒絕（log.info 與 log.error 都丟錯），stop() 仍要 resolve。
describe("#269 createLinkConversion().stop()", () => {
  afterEach(() => vi.useRealTimers());

  it("在途那一輪以拒絕收場時 stop() 仍 resolve（永不 reject）", async () => {
    vi.useFakeTimers();
    const boom = () => {
      throw new Error("log boom");
    };
    const deps = { db: {}, writes: {}, versions: {}, siteOrigin: "http://kb.test", log: { info: boom, warn: boom, error: boom } } as unknown as LinkConversionDeps;
    const lc = createLinkConversion(deps, { startDelayMs: 0 });
    lc.start();
    vi.advanceTimersByTime(0); // 計時器觸發：running 已建立、尚未 settle
    const stopped = lc.stop(); // 同一個同步段落掛上處理者：running 的拒絕不會成為 unhandled
    await expect(stopped).resolves.toBeUndefined();
  });

  it("還沒開始就 stop：resolve、之後 start 的計時器不再跑", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const deps = { db: {}, writes: {}, versions: {}, siteOrigin: "http://kb.test", log: { info, warn: vi.fn(), error: vi.fn() } } as unknown as LinkConversionDeps;
    const lc = createLinkConversion(deps, { startDelayMs: 1_000 });
    lc.start();
    await expect(lc.stop()).resolves.toBeUndefined();
    vi.advanceTimersByTime(5_000);
    expect(info).not.toHaveBeenCalled();
  });
});
