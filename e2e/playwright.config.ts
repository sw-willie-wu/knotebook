import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts", // 建名為「SSO」的登入服務（指向 fake-idp）；以前由 OIDC_* env 匯入
  workers: 1, // 單 worker 序列、共用一座疊
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    locale: "en-US", // 斷言釘死英文文案（i18n 預設語言，避免跑者作業系統語系飄移影響 getByText 斷言）
    launchOptions: { args: ["--host-resolver-rules=MAP fake-idp 127.0.0.1"] }, // issuer 一致性
  },
});
