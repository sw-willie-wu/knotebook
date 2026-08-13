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
      insecureHttpWarning: false,
    });
  });
  it("APP_SECRET 太短 → throw 含 openssl 指引", () => {
    expect(() => loadConfig({ ...valid, APP_SECRET: "short" })).toThrow(/openssl rand -hex 32/);
  });
  it("缺 PUBLIC_URL → throw", () => {
    const { PUBLIC_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/PUBLIC_URL/);
  });
  it("http 非 localhost → 接受但 insecureHttpWarning=true，cookieSecure 仍為 false（trusted-LAN 拓撲，spec rev 5.6）", () => {
    const config = loadConfig({ ...valid, PUBLIC_URL: "http://notes.example.com" });
    expect(config.insecureHttpWarning).toBe(true);
    expect(config.cookieSecure).toBe(false);
  });
  it("http localhost → insecureHttpWarning=false", () => {
    expect(loadConfig({ ...valid, PUBLIC_URL: "http://localhost:3000" }).insecureHttpWarning).toBe(false);
  });
  it("https → insecureHttpWarning=false", () => {
    expect(loadConfig(valid).insecureHttpWarning).toBe(false);
  });
  it("無 scheme → throw", () => {
    expect(() => loadConfig({ ...valid, PUBLIC_URL: "localhost:3000" })).toThrow(/http\/https/);
  });
  describe("ADMIN_EMAIL / ADMIN_PASSWORD（env bootstrap admin，spec rev 5.7）", () => {
    it("皆未設 → 通過，adminEmail/adminPassword 皆 undefined", () => {
      const config = loadConfig(valid);
      expect(config.adminEmail).toBeUndefined();
      expect(config.adminPassword).toBeUndefined();
    });

    it("只設 ADMIN_EMAIL → fail-fast", () => {
      expect(() => loadConfig({ ...valid, ADMIN_EMAIL: "admin@example.com" })).toThrow(
        /ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定/
      );
    });

    it("只設 ADMIN_PASSWORD → fail-fast", () => {
      expect(() => loadConfig({ ...valid, ADMIN_PASSWORD: "correct-horse-battery" })).toThrow(
        /ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定/
      );
    });

    it("皆設但密碼 <12 字元 → fail-fast", () => {
      expect(() =>
        loadConfig({ ...valid, ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "short" })
      ).toThrow(/ADMIN_PASSWORD 至少需要 12 字元/);
    });

    it("皆設但 ADMIN_EMAIL 格式錯誤 → fail-fast", () => {
      expect(() =>
        loadConfig({ ...valid, ADMIN_EMAIL: "not-an-email", ADMIN_PASSWORD: "correct-horse-battery" })
      ).toThrow(/ADMIN_EMAIL 格式錯誤/);
    });

    it("皆設且合法 → 通過，config 帶出兩個欄位", () => {
      const config = loadConfig({ ...valid, ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "correct-horse-battery" });
      expect(config.adminEmail).toBe("admin@example.com");
      expect(config.adminPassword).toBe("correct-horse-battery");
    });

    it("ADMIN_EMAIL 空字串 + ADMIN_PASSWORD 有值 → 視同半套，fail-fast（空字串等同未設）", () => {
      expect(() =>
        loadConfig({ ...valid, ADMIN_EMAIL: "", ADMIN_PASSWORD: "correct-horse-battery" })
      ).toThrow(/ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定/);
    });
  });
});
