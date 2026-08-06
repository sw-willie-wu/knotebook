import { describe, expect, it } from "vitest";
import { crossesBucketBoundary, selectPrunable } from "../../src/collab/backup-policy.js";

describe("crossesBucketBoundary（15 分桶邊界；半開區間 [start, end)、對齊 UTC 時鐘）", () => {
  it("同一個 [10:00,10:15) 桶內 → false", () => {
    const last = new Date("2026-08-06T10:07:00Z");
    const now = new Date("2026-08-06T10:11:00Z");
    expect(crossesBucketBoundary(last, now)).toBe(false);
  });

  it("跨到下一個桶 [10:15,10:30) → true", () => {
    const last = new Date("2026-08-06T10:14:00Z");
    const now = new Date("2026-08-06T10:16:00Z");
    expect(crossesBucketBoundary(last, now)).toBe(true);
  });

  it("lastBackupAt 為 null → true（從未備份過）", () => {
    const now = new Date("2026-08-06T10:16:00Z");
    expect(crossesBucketBoundary(null, now)).toBe(true);
  });
});

describe("selectPrunable（rev 3 具體向量；newest-per-bucket，三層聯集之外全刪）", () => {
  it("now=2026-08-06T12:00:00Z 的具體向量：保留集合恰為 brief 逐字寫死的那組，其餘全刪", () => {
    const now = new Date("2026-08-06T12:00:00Z");
    const existing: Date[] = [];

    // 每 5 分鐘一筆，09:00–11:55（共 36 筆）。
    for (let totalMin = 9 * 60; totalMin <= 11 * 60 + 55; totalMin += 5) {
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      existing.push(new Date(Date.UTC(2026, 7, 6, h, m, 0)));
    }
    // 每小時整點一筆，00:00–08:00（共 9 筆）。
    for (let h = 0; h <= 8; h += 1) {
      existing.push(new Date(Date.UTC(2026, 7, 6, h, 0, 0)));
    }
    // 每日 12:00:00Z 一筆，07-28–08-05（共 9 筆）。
    for (let day = 28; day <= 31; day += 1) {
      existing.push(new Date(Date.UTC(2026, 6, day, 12, 0, 0)));
    }
    for (let day = 1; day <= 5; day += 1) {
      existing.push(new Date(Date.UTC(2026, 7, day, 12, 0, 0)));
    }
    expect(existing.length).toBe(36 + 9 + 9);

    // brief 逐字寫死的保留集合（獨立算過）：
    const retainedIso = new Set(
      [
        // 15分層：{11:10, 11:25, 11:40, 11:55}
        "2026-08-06T11:10:00.000Z",
        "2026-08-06T11:25:00.000Z",
        "2026-08-06T11:40:00.000Z",
        "2026-08-06T11:55:00.000Z",
        // 小時層：{06:00, 07:00, 08:00, 09:55, 10:55, 11:55}
        // ⚠ [09:00,10:00) 桶最新是 09:55 非 09:00。
        "2026-08-06T06:00:00.000Z",
        "2026-08-06T07:00:00.000Z",
        "2026-08-06T08:00:00.000Z",
        "2026-08-06T09:55:00.000Z",
        "2026-08-06T10:55:00.000Z",
        "2026-08-06T11:55:00.000Z",
        // 日層：最近 7 個 UTC 日曆日含今日（07-31–08-06）；今日桶最新=11:55 已含在上面。
        "2026-07-31T12:00:00.000Z",
        "2026-08-01T12:00:00.000Z",
        "2026-08-02T12:00:00.000Z",
        "2026-08-03T12:00:00.000Z",
        "2026-08-04T12:00:00.000Z",
        "2026-08-05T12:00:00.000Z",
      ]
    );

    const prunable = selectPrunable(existing, now);
    const prunableIso = new Set(prunable.map(d => d.toISOString()));

    const expectedPrunable = existing.filter(d => !retainedIso.has(d.toISOString()));
    expect(prunableIso.size).toBe(expectedPrunable.length);
    for (const d of expectedPrunable) {
      expect(prunableIso.has(d.toISOString())).toBe(true);
    }
    // 反向：保留集合裡的一筆都不該出現在 prunable 中（07-30 及更早必須被刪）。
    for (const iso of retainedIso) {
      expect(prunableIso.has(iso)).toBe(false);
    }
    expect(prunable.length).toBe(54 - 15);
  });
});
