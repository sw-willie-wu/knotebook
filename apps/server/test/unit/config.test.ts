import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { loadConfig, parseTrustProxy } from "../../src/config.js";
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
      trustProxy: false,
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

  describe("OIDC_ISSUER_URL / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET（Plan 5 §5）", () => {
    it("OIDC 三件組只設其中一個 → throw", () => {
      expect(() => loadConfig({ ...valid, OIDC_ISSUER_URL: "https://idp.example.com" })).toThrow(/OIDC/);
    });

    it("OIDC 三件組齊 → config.oidc 填入", () => {
      const c = loadConfig({ ...valid, OIDC_ISSUER_URL: "https://idp.example.com", OIDC_CLIENT_ID: "abc", OIDC_CLIENT_SECRET: "s" });
      expect(c.oidc).toEqual({ issuerUrl: "https://idp.example.com", clientId: "abc", clientSecret: "s" });
    });

    it("OIDC issuer 非 http/https → throw", () => {
      expect(() =>
        loadConfig({ ...valid, OIDC_ISSUER_URL: "ftp://idp.example.com", OIDC_CLIENT_ID: "abc", OIDC_CLIENT_SECRET: "s" })
      ).toThrow(/OIDC/);
    });

    it("全未設 → config.oidc undefined", () => {
      expect(loadConfig(valid).oidc).toBeUndefined();
    });
  });
});

describe("parseTrustProxy（issue #13）", () => {
  it("未設／空字串／false → false（client 可直連的拓撲唯一安全的預設）", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("  ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  it("true → true（等同修這條 issue 之前的行為，由部署者自己選）", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy(" True ")).toBe(true);
  });

  it("非負整數 → hop 數", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    // 0 正規化成 false，見下面那條專屬測試。
  });

  it("IP／CIDR／具名網段 → 逐項驗過的字串陣列", () => {
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(parseTrustProxy("loopback,uniquelocal")).toEqual(["loopback", "uniquelocal"]);
    expect(parseTrustProxy("::1")).toEqual(["::1"]);
    expect(parseTrustProxy("fd00::/8")).toEqual(["fd00::/8"]);
  });

  it("語法錯誤在啟動時就丟錯，不留到每個請求才炸", () => {
    expect(() => parseTrustProxy("not-an-ip")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/999")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/8/8")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/abc")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("999.1.1.1")).toThrow(/TRUST_PROXY/);
    // IPv6 的網段上限是 128，IPv4 是 32——不能混用。
    expect(() => parseTrustProxy("10.0.0.0/64")).toThrow(/TRUST_PROXY/);
    expect(parseTrustProxy("fd00::/64")).toEqual(["fd00::/64"]);
  });

  // ⚠ 這條是本組測試裡唯一擋得住「我們自己驗過、fastify 卻不收」的形狀。審查實測抓到
  // 兩個真例：具名網段沒轉小寫（proxy-addr 用精確比對，`Loopback` 直接丟
  // `invalid IP address`）、以及 `/0`（proxy-addr 的 `range <= 0` 一律拒）。兩者都會在
  // `buildApp` 的 Fastify 建構子炸掉，訊息還指不出是哪個環境變數——形同 fail-fast 破功。
  it.each([
    "true",
    "1",
    "2",
    "127.0.0.1",
    "10.0.0.0/8, 172.16.0.0/12",
    "loopback,uniquelocal",
    "Loopback",
    "LOOPBACK, 10.0.0.0/8",
    "::1",
    "fd00::/8",
    "fd00::/64",
  ])("我們接受的 %s，fastify 也接受（round-trip）", value => {
    const trustProxy = parseTrustProxy(value);
    expect(() => Fastify({ logger: false, trustProxy })).not.toThrow();
  });

  it("`/0` 在我們這裡就被擋掉（proxy-addr 也不收，訊息要指向 TRUST_PROXY=true）", () => {
    expect(() => parseTrustProxy("0.0.0.0/0")).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy("::/0")).toThrow(/TRUST_PROXY/);
  });

  it("具名網段一律正規化成小寫（proxy-addr 只認小寫）", () => {
    expect(parseTrustProxy("Loopback")).toEqual(["loopback"]);
    expect(parseTrustProxy("LOOPBACK, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });

  it("hop 數 0 正規化成 false（寫 0 的人表達的是關閉）", () => {
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("loadConfig 帶出這個欄位，未設時是 false", () => {
    const base = {
      DATABASE_URL: "postgres://u:p@localhost:5432/test",
      APP_SECRET: "a".repeat(64),
      PUBLIC_URL: "http://localhost:3000",
    };
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "loopback" }).trustProxy).toEqual(["loopback"]);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "nope" })).toThrow(/TRUST_PROXY/);
  });
});
