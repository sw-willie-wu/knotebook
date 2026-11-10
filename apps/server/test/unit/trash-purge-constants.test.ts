/**
 * #181：保留期清理的排程常數。文件寫了具體時間（docs/self-hosting.md 的 Trash 節與升級段、docs/known-limitations.md、
 * docs/api.md、CHANGELOG 的 Upgrade notes），改常數要一起改文件。
 */
import { describe, expect, it } from "vitest";
import { TRASH_PURGE_BATCH, TRASH_PURGE_FIRST_DELAY_MS, TRASH_PURGE_INTERVAL_MS, TRASH_PURGE_MAX_BATCHES } from "../../src/trash/purge.js";

describe("垃圾桶清理排程常數", () => {
  it("docs/self-hosting.md 與 CHANGELOG 的「5 分鐘首輪／每小時一輪」靠這條釘：首輪 5 分鐘、之後每 60 分鐘", () => {
    expect(TRASH_PURGE_FIRST_DELAY_MS).toBe(5 * 60 * 1000);
    expect(TRASH_PURGE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("docs/known-limitations.md、self-hosting.md、api.md 與 CHANGELOG 的「每輪最多 2,000 篇（2,000 per pass）」靠這條釘：每批 100 篇 × 每輪 20 批", () => {
    expect(TRASH_PURGE_BATCH).toBe(100);
    expect(TRASH_PURGE_MAX_BATCHES).toBe(20);
    expect(TRASH_PURGE_BATCH * TRASH_PURGE_MAX_BATCHES).toBe(2000);
  });
});
