import { defineConfig } from "@playwright/test";
import { E2E_ORIGIN, IDP_PORT } from "./ports.js";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts", // 建名為「SSO」的登入服務（指向 fake-idp）；以前由 OIDC_* env 匯入
  workers: 1, // 單 worker 序列、共用一座疊
  timeout: 60_000,
  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
    locale: "en-US", // 斷言釘死英文文案（i18n 預設語言，避免跑者作業系統語系飄移影響 getByText 斷言）
    launchOptions: { args: [`--host-resolver-rules=MAP fake-idp:9400 127.0.0.1:${IDP_PORT}`] }, // issuer 一致性（容器內固定 fake-idp:9400；本機發布埠可變）
  },
});
