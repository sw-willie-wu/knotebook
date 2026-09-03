import Fastify from "fastify";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseTrustProxy, publicUrlIssuer, publicUrlPathWarning } from "../../src/config.js";
import { oidcRedirectUri } from "../../src/auth/oidc-client.js";
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

describe("D12：OAuth issuer 取 origin、PUBLIC_URL 帶其他成分只警告", () => {
  it("publicUrlIssuer：保留 port、丟掉 path／query／fragment／userinfo，scheme 與 host 小寫", () => {
    // port 是這個 repo 最常見的自架形（demo 就是 http://192.168.3.22:8006）——
    // 手工組 issuer 的實作（protocol + "//" + hostname）會在這裡紅。
    expect(publicUrlIssuer(new URL("http://192.168.3.22:8006/knb"))).toBe("http://192.168.3.22:8006");
    expect(publicUrlIssuer(new URL("https://example.com/knb?q=1#f"))).toBe("https://example.com");
    expect(publicUrlIssuer(new URL("https://u:p@example.com/knb"))).toBe("https://example.com");
    expect(publicUrlIssuer(new URL("HTTPS://Notes.Example.com"))).toBe("https://notes.example.com");
    // 不得回 href——那會多一個尾斜線，之後組出 `…//.well-known/…`
    expect(publicUrlIssuer(new URL("http://localhost:3000"))).toBe("http://localhost:3000");
  });

  it("publicUrlPathWarning：純 origin（含尾斜線、含 port）不警告", () => {
    expect(publicUrlPathWarning(new URL("https://notes.example.com"))).toBeNull();
    expect(publicUrlPathWarning(new URL("https://notes.example.com/"))).toBeNull();
    expect(publicUrlPathWarning(new URL("http://192.168.3.22:8006/"))).toBeNull();
  });

  it("publicUrlPathWarning：path／query／fragment／userinfo 都要警告（都是被 origin 丟掉的成分）", () => {
    for (const url of [
      "https://example.com/knb",
      "https://example.com/knb/",
      "https://example.com/?q=1",
      "https://example.com/#f",
      "https://u:p@example.com/",
    ]) {
      expect(publicUrlPathWarning(new URL(url)), url).not.toBeNull();
    }
  });

  it("警告訊息點名維運者要改什麼、以及現在就壞掉的是什麼", () => {
    const message = publicUrlPathWarning(new URL("https://example.com/knb"));
    // 不用 stringContaining("origin") —— 任何含這六個字母的字串都會過，等於沒守。
    expect(message).toContain("PUBLIC_URL");
    expect(message).toContain("sub-path");
    // OIDC 的 redirect_uri 是**現在就對不上**的那一個（OAuth 端點還不存在）
    expect(message).toContain("redirect_uri");
  });

  it("訊息是編譯期常數（插值進去會讓 pino 的 msg 每個部署都不同，日誌聚合與告警失效）", () => {
    const first = publicUrlPathWarning(new URL("https://a.example.com/knb"));
    // 先釘住「有訊息」——只比對相等的話，兩邊同時是 null 也會綠（判定壞掉時的假綠）
    expect(first).toBeTypeOf("string");
    expect(first).toBe(publicUrlPathWarning(new URL("https://b.example.com/other?q=1")));
  });

  it("警告的前提：sub-path 從 issuer 與 OIDC redirect_uri **兩邊**都被丟掉，userinfo 只從 issuer 丟", () => {
    // 這一案釘住訊息措辭所依據的事實。訊息說「server 丟掉 sub-path，所以與 docs 教你
    // 註冊的 <PUBLIC_URL>/api/auth/oidc/callback 對不上」——若哪天 oidcRedirectUri 改成
    // 保留 sub-path，這裡會紅，逼人回頭重讀那句話（訊息寫反過的前科：把 sub-path 說成
    // 「redirect_uri 會保留」，實際上只有 userinfo 如此）。
    const subpath = loadConfig({ ...valid, PUBLIC_URL: "https://example.com/knb" });
    expect(publicUrlIssuer(subpath.publicUrl)).toBe("https://example.com");
    expect(oidcRedirectUri(subpath)).toBe("https://example.com/api/auth/oidc/callback");

    const withCreds = loadConfig({ ...valid, PUBLIC_URL: "https://u:p@example.com/" });
    expect(publicUrlIssuer(withCreds.publicUrl)).toBe("https://example.com");
    expect(oidcRedirectUri(withCreds)).toBe("https://u:p@example.com/api/auth/oidc/callback");
  });

  it("結構守衛：index.ts 真的有呼叫 publicUrlPathWarning，且在 listen 之前", () => {
    // 純函式有測試不代表接線有——把 index.ts 的那個區塊整段刪掉，其餘測試全都照樣綠。
    // 錨定**呼叫點**字面而不是函式名：只找名字會先命中檔頭的 import，呼叫刪掉也不會紅
    // （比照 test/handle.test.ts 的 backfillHandleRegistry 結構守衛）。
    //
    // ⚠ 這條守的是「原始碼裡有這個呼叫字面、且位置早於 listen」，**不是**「警告真的
    // 印得出來」：死碼分支、算了不 log、甚至字面只出現在註解裡都照樣綠。要真的守住
    // 輸出得靠 e2e 抓 stdout，代價遠高於收益——與既有那條同一組限制，明示接受。
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.ts"), "utf8");
    const callAt = src.indexOf("publicUrlPathWarning(config.publicUrl");
    const listenAt = src.indexOf(".listen(");
    expect(callAt, "index.ts 必須呼叫 publicUrlPathWarning(config.publicUrl…)").toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt, "警告要在 listen 之前印出來").toBeLessThan(listenAt);
  });
});
