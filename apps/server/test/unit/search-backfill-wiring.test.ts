/**
 * #93 S13（spec §6.3）：回填呼叫點在 `app.listen` **之後**（與 handle.test.ts 的補登守衛方向相反——偏離 C），
 * 關機 handler 第一步 abort。錨定**呼叫點字面**（`backfillSearchIndex(db`），不是函式名——後者先命中 import。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");

describe("#93 S13：index.ts 的回填接線", () => {
  it("回填呼叫點在 app.listen 之後", () => {
    const callAt = src.indexOf("backfillSearchIndex(db");
    const listenAt = src.indexOf(".listen(");
    expect(callAt, "index.ts 必須呼叫 backfillSearchIndex(db…)").toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt, "回填必須在 listen 之後（spec §6.1 偏離 C）").toBeGreaterThan(listenAt);
  });
  it("關機 handler 先 abort 回填，再 destroy collab", () => {
    const onceAt = src.indexOf("process.once(");
    const abortAt = src.indexOf("backfillAbort.abort()", onceAt);
    const destroyAt = src.indexOf(".destroy()", onceAt);
    expect(onceAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(onceAt);
    expect(destroyAt).toBeGreaterThan(-1);
    expect(abortAt).toBeLessThan(destroyAt);
  });
  it("#269：轉換工作在 listen 之後 start；SIGTERM 鏈先以 2 s 共用寬限等 app.linkConversion.stop()，再 collab.destroy()（#272 先或後 merge 都成立）", () => {
    const listenAt = src.indexOf(".listen(");
    const startAt = src.indexOf("app.linkConversion.start()");
    expect(startAt).toBeGreaterThan(listenAt);
    const onceAt = src.indexOf("process.once(");
    expect(onceAt, "index.ts 要有 process.once( 關機 handler").toBeGreaterThan(-1);
    // 剔掉註解行再找（#272 plan gate 抓到的雷：handler 上方／裡面的註解字面會先命中）。
    const handler = src.slice(onceAt).replace(/^\s*\/\/.*$/gm, "");
    // 單獨形（#272 未 merge）或併入 Promise.all 的形（#272 已 merge）都接受；stop 必須在「collab.destroy() 之前的那個 race」裡。
    const race = /Promise\.race\(\[(?:Promise\.all\(\[[^\]]*\bapp\.linkConversion\.stop\(\)[^\]]*\]\)|app\.linkConversion\.stop\(\)), stopGrace\(\)\]\)/.exec(handler);
    expect(race, "關機要以 Promise.race([… app.linkConversion.stop() …, stopGrace()]) 有上限地等轉換工作").not.toBeNull();
    const destroyAt = handler.indexOf("collab.destroy()");
    expect(destroyAt, "關機要呼叫 collab.destroy()").toBeGreaterThan(-1);
    expect(destroyAt, "race 要在 collab.destroy() 之前").toBeGreaterThan(race!.index + race![0].length - 1);
    expect(src).toMatch(/_STOP_GRACE_MS = 2_000;/);
    expect(src).toMatch(/const stopGrace = \(\): Promise<void> => new Promise\(resolve => setTimeout\(resolve, [A-Z_]+_STOP_GRACE_MS\)\.unref\(\)\);/);
  });
});
