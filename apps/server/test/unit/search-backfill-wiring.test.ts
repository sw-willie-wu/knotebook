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
});
