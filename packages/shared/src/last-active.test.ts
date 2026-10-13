import { describe, expect, it } from "vitest";
import { LAST_ACTIVE_WRITE_INTERVAL_MS, ONLINE_WINDOW_MS } from "./index.js";

describe("#267 最後活動常數", () => {
  it("寫入間隔 1 分鐘、上線視窗 5 分鐘；間隔遠短於視窗（持續有活動的人記錄最多落後一個間隔，不會掉出「上線中」）", () => {
    expect(LAST_ACTIVE_WRITE_INTERVAL_MS).toBe(60_000);
    expect(ONLINE_WINDOW_MS).toBe(5 * 60_000);
    expect(LAST_ACTIVE_WRITE_INTERVAL_MS * 2).toBeLessThan(ONLINE_WINDOW_MS);
  });
});
