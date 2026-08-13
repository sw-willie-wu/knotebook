import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1, // §14.5：單 worker 序列、共用一座疊
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    launchOptions: { args: ["--host-resolver-rules=MAP fake-idp 127.0.0.1"] }, // issuer 一致性（§14.5）
  },
});
