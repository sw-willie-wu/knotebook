import { describe, expect, it } from "vitest";
import { IDLE_TIMEOUT_MS } from "../../src/routes/ai.js";

// CI flake round 2（見 test/ai-sse.test.ts「idle timeout」整合測試、app.ts
// `BuildAppOptions.aiIdleTimeoutMs`）：idle timeout 的生產預設值改由 `AiRouteDeps.idleTimeoutMs`
// 可注入覆寫，`IDLE_TIMEOUT_MS` 從 module-private 常數改為具名導出。純形狀斷言，釘住這個
// 預設值——防止未來改動時（例如調整逾時秒數、或誤刪 `?? IDLE_TIMEOUT_MS` 這段 fallback）
// 悄悄把「未傳 idleTimeoutMs 時採用 60s」這個生產行為改壞，卻沒有任何測試示警。不需要真的
// 等 60s：只斷言常數值本身。
describe("routes/ai：idle timeout 預設值（spec §13.2）", () => {
  it("未傳 AiRouteDeps.idleTimeoutMs 時，生產預設為 60_000ms（60s）", () => {
    expect(IDLE_TIMEOUT_MS).toBe(60_000);
  });
});
