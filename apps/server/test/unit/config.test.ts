import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";
const valid = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "https://notes.example.com" };
describe("loadConfig", () => {
  it("合法設定；cookieSecure 依 PUBLIC_URL scheme", () => {
    expect(loadConfig(valid).cookieSecure).toBe(true);
    expect(loadConfig({ ...valid, PUBLIC_URL: "http://localhost:3000" }).cookieSecure).toBe(false);
  });
  it("完整物件回傳 - https", () => {
    const config = loadConfig(valid);
    expect(config).toEqual({
      databaseUrl: "postgres://u:p@localhost:5432/db",
      appSecret: "a".repeat(64),
      publicUrl: new URL("https://notes.example.com"),
      cookieSecure: true,
    });
  });
  it("完整物件回傳 - 含 bootstrapAdminEmail", () => {
    const config = loadConfig({ ...valid, BOOTSTRAP_ADMIN_EMAIL: "admin@example.com" });
    expect(config).toEqual({
      databaseUrl: "postgres://u:p@localhost:5432/db",
      appSecret: "a".repeat(64),
      publicUrl: new URL("https://notes.example.com"),
      cookieSecure: true,
      bootstrapAdminEmail: "admin@example.com",
    });
  });
  it("APP_SECRET 太短 → throw 含 openssl 指引", () => {
    expect(() => loadConfig({ ...valid, APP_SECRET: "short" })).toThrow(/openssl rand -hex 32/);
  });
  it("缺 PUBLIC_URL → throw", () => {
    const { PUBLIC_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/PUBLIC_URL/);
  });
  it("http 非 localhost → throw", () => {
    expect(() => loadConfig({ ...valid, PUBLIC_URL: "http://notes.example.com" })).toThrow(/https/);
  });
  it("無 scheme → throw", () => {
    expect(() => loadConfig({ ...valid, PUBLIC_URL: "localhost:3000" })).toThrow(/http\/https/);
  });
  it("空字串 BOOTSTRAP_ADMIN_EMAIL → 視同未設", () => {
    const config = loadConfig({ ...valid, BOOTSTRAP_ADMIN_EMAIL: "" });
    expect(config.bootstrapAdminEmail).toBeUndefined();
  });
});
