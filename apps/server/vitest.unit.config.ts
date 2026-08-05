import { defineConfig } from "vitest/config";

// 單獨給 test:unit 用的設定：不帶 globalSetup，確保 unit 測試絕不啟動 testcontainers。
// 主 vitest.config.ts（含 globalSetup）留給整合測試／全套 `test` 用。
export default defineConfig({
  test: { include: ["test/unit/**/*.test.ts"] },
});
