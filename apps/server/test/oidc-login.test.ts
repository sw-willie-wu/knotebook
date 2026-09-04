import { describe, expect, it } from "vitest";
import { MAX_NEXT_PATH_LENGTH, OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { CustomFetch } from "openid-client";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createOidcRuntime } from "../src/auth/oidc-client.js";
import { unsealOidcState } from "../src/auth/oidc-state.js";

const ISSUER_URL = "https://idp.example.com";

function oidcConfig(): AppConfig {
  return loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/test",
    APP_SECRET: "a".repeat(64),
    PUBLIC_URL: "http://localhost:3000",
    OIDC_ISSUER_URL: ISSUER_URL,
    OIDC_CLIENT_ID: "test-client",
    OIDC_CLIENT_SECRET: "test-secret",
  });
}

/** 一層可換底的 fetch：讓同一個 runtime 在測試中期改變底層行為（例如「discovery 先失敗，
 * 修好後重打」），不需要重新建立 runtime——重建 runtime 會失去要驗證的快取狀態本身。 */
function switchableFetch(initial: CustomFetch): { fetch: CustomFetch; set(next: CustomFetch): void } {
  let current = initial;
  const fetch: CustomFetch = (...args) => current(...args);
  return { fetch, set: next => (current = next) };
}

const throwingFetch: CustomFetch = async () => {
  throw new Error("network unreachable");
};

describe("GET /api/auth/oidc/login", () => {
  it("OIDC 未設定 → 302 /login?error=oidc_unavailable", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("已設定 + mock IdP → 302 至 authorize endpoint，query/cookie 皆正確", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);

    const location = new URL(res.headers.location as string);
    expect(location.origin).toBe(ISSUER_URL);
    expect(location.pathname).toBe("/authorize");
    // URL-decoded 精確斷言（searchParams.get 已自動 decode）——逐字 "openid email profile"。
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/oidc/callback");

    const cookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe("/api/auth/oidc");
    // MINOR-3（審查 fix round 1）：sameSite/maxAge 先前未被斷言——把其中一個改成
    // "none"／改掉秒數（例如 5），既有測試矩陣仍全綠，等於這兩個屬性沒被任何測試守住。
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.maxAge).toBe(600);

    // MINOR-4（審查 fix round 1）：cookie 密封值 ↔ authorize URL 一致——回讀密封的
    // state/nonce，須與 302 location 的 query 相等，證明兩者確實來自同一次產生、沒有
    // 各自獨立亂數導致「cookie 存的 state」與「送去 IdP 的 state」對不上（callback 端
    // 靠這個相等性做 CSRF 防護，見 Task 9）。
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const sealedPayload = unsealOidcState(config.appSecret, cookie!.value, nowEpochSeconds);
    expect(sealedPayload).not.toBeNull();
    expect(sealedPayload?.state).toBe(location.searchParams.get("state"));
    expect(sealedPayload?.nonce).toBe(location.searchParams.get("nonce"));

    // 不可預測性：第二次請求必須產生不同的 state（不是固定值/可預測序列）。
    const res2 = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const location2 = new URL(res2.headers.location as string);
    expect(location2.searchParams.get("state")).not.toBe(location.searchParams.get("state"));
  });

  it("discovery 網路失敗（IdP 5xx，harness failNext 一次性）→ 302 oidc_unavailable；不快取——同一 app 再打一次（failNext 已消費即還原）→ 302 至 IdP", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.failNext("discovery");
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/login?error=oidc_unavailable");

    // failNext 為一次性，這裡不需要任何手動「修好」——上面那次呼叫已經把它消費並還原。
    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("discovery 成功但 metadata 無 jwks_uri → 302 oidc_unavailable；修好後重打成功——不可用不快取", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.omitFromMetadata(["jwks_uri"]);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/login?error=oidc_unavailable");

    fakeIdp.omitFromMetadata([]);

    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("discovery 成功後把 fetch 換成 throw → 仍 302 至 IdP（成功快取至重啟）", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const swap = switchableFetch(fakeIdp.fetch);
    const runtime = createOidcRuntime(config.oidc!, { fetch: swap.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(new URL(first.headers.location as string).origin).toBe(ISSUER_URL);

    swap.set(throwingFetch);

    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("in-flight 去重：首波併發共用同一次 discovery → discovery fetch 恰一次", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/api/auth/oidc/login" }),
      app.inject({ method: "GET", url: "/api/auth/oidc/login" }),
    ]);
    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(fakeIdp.counts.discovery).toBe(1);
  });

  it("limiter：同一 IP 第 30 次仍放行、第 31 次請求 → 302 too_many_requests", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    let res: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 31; i += 1) {
      res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
      // MINOR-5（審查 fix round 1）：只釘住第 31 發只證明「額度真的有上限」，沒證明
      // 「上限剛好是 30」——把 limit 改成 1 也會讓第 31 發同樣落在 too_many_requests，
      // 舊測試矩陣分不出兩者。這裡額外釘住第 30 發仍成功 302 至 IdP（location 含
      // issuer），才真的鎖住「限額恰為 OIDC_LIMIT=30」。
      if (i === 29) {
        expect(res.statusCode).toBe(302);
        expect(new URL(res.headers.location as string).origin).toBe(ISSUER_URL);
      }
    }
    expect(res!.statusCode).toBe(302);
    expect(res!.headers.location).toBe("/login?error=too_many_requests");
  });

  it("limiter：callback 吃自己的額度，不會扣到 login 頭上（issue #16）", async () => {
    // 一次完整的 SSO 登入必定先 login 再 callback。兩者共用一個 bucket 的話，每次登入
    // 吃掉兩份額度，實際可用次數只有標稱的一半（共用出口 IP 的辦公室網路更早撞到）。
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    // 先把 callback 那份額度打爆（沒有 state cookie，一律 302 回 oidc_state_mismatch，
    // 但**照樣計數**——這條路由不需要先走過 login 就能被外部敲）。
    for (let i = 0; i < 31; i += 1) {
      await app.inject({ method: "GET", url: "/api/auth/oidc/callback?code=x&state=y" });
    }
    const exhausted = await app.inject({ method: "GET", url: "/api/auth/oidc/callback?code=x&state=y" });
    expect(exhausted.headers.location).toBe("/login?error=too_many_requests");

    // login 的額度必須完全沒被動到。
    const login = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(login.statusCode).toBe(302);
    expect(new URL(login.headers.location as string).origin).toBe(ISSUER_URL);
  });
});

// ── #131：login 端點收 ?next=，封進 state cookie ─────────────────────────────
//
// 判準只有一道：safeNextPath（與 web 端同一支，含 2048 上限）。**刻意沒有第二道長度
// 關**——spec §5.3.3 原本要求再壓到 512、理由是 sealed cookie 的 4 KB 限制，實測不成立
// （見下方「封章後的 cookie 位元組」那案），Willie 2026-09-03 裁決拿掉。
describe("#131 login 端點的 next", () => {
  /** 走一次 login，回傳封進 cookie 的 next（沒有就是 undefined）與兩種 cookie 位元組數。 */
  async function loginWithNext(
    url: string,
  ): Promise<{ next: string | undefined; cookieBytes: number; setCookieBytes: number }> {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    // 真的去了 IdP——否則下面解出 undefined 是「其實被導回 /login」的假綠。（早退不
    // setCookie，所以 cookie 的存在本身也擋得住；這條的價值是失敗訊息直接指出病因。）
    expect(location.origin).toBe(ISSUER_URL);
    // next 只走密封 cookie，**不得**出現在送去 IdP 的 authorize query。放在 helper 裡
    // ＝七案免費覆蓋，含負向案（「被判定不該封的 next 有沒有反而被轉手出去」）。
    // ⚠ 用 searchParams.has，不要對整條 location 做子字串比對：state 是 43 字元隨機
    // base64url，偶爾會湊出 "next" 這四個字元 → 間歇假紅。
    expect(location.searchParams.has("next")).toBe(false);

    const cookie = res.cookies.find(c => c.name === OIDC_STATE_COOKIE);
    expect(cookie).toBeDefined();
    const payload = unsealOidcState(config.appSecret, cookie!.value, Math.floor(Date.now() / 1000));
    expect(payload).not.toBeNull();
    const setCookieHeader = res.headers["set-cookie"];
    const setCookieLine = Array.isArray(setCookieHeader)
      ? setCookieHeader.find(line => line.startsWith(`${OIDC_STATE_COOKIE}=`))!
      : setCookieHeader!;
    return {
      next: payload!.next,
      // Chrome 實際設限的對象是 name=value；RFC 6265 §6.1 的 4096 預算則含屬性——
      // 兩個都量，免得像 spec §5.3.3 那樣「把部分量當全量」。
      cookieBytes: Buffer.byteLength(`${cookie!.name}=${cookie!.value}`, "utf8"),
      setCookieBytes: Buffer.byteLength(setCookieLine, "utf8"),
    };
  }

  const sealedNextOf = async (url: string) => (await loginWithNext(url)).next;

  it("合法 next → 封進 state cookie（逐字）", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1")).toBe(
      "/n/alice/my-note?x=1",
    );
  });

  it("跨站 next → 不封（safeNextPath 擋下，登入照常去 IdP）", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2F%2Fevil.example")).toBeUndefined();
  });

  it("非 SPA 路徑的 next（/api/notes）→ 不封", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fapi%2Fnotes")).toBeUndefined();
  });

  it("唯一的長度關是 safeNextPath 的 2048：2048 封、2049 不封", async () => {
    const atLimit = "/" + "a".repeat(2047);
    const overLimit = "/" + "a".repeat(2048);
    expect(atLimit).toHaveLength(MAX_NEXT_PATH_LENGTH);
    expect(await sealedNextOf(`/api/auth/oidc/login?next=${encodeURIComponent(atLimit)}`)).toBe(atLimit);
    expect(await sealedNextOf(`/api/auth/oidc/login?next=${encodeURIComponent(overLimit)}`)).toBeUndefined();
  });

  it("封章後的 cookie 位元組：最壞情況（2048 字元 next）仍遠低於瀏覽器的 4 KB", async () => {
    // 這一案是「server 端不需要第二道長度關」這個決策的**量測**守衛（spec §5.3.3 的 512
    // 就是被它推翻的：那句宣稱 2048 會撐爆 cookie，實際只有約 3049 bytes）。「不得再加
    // 一道關」則由上面的 2048/2049 那案守——分工要講清楚，因為本案的斷言是**單向上界**。
    const worstCaseNext = "/" + "a".repeat(MAX_NEXT_PATH_LENGTH - 1);
    const { next, cookieBytes, setCookieBytes } = await loginWithNext(
      `/api/auth/oidc/login?next=${encodeURIComponent(worstCaseNext)}`,
    );
    // ⚠ 沒有這一行，本案在「有人重新加一道 1000 字元的關」之下會**更綠**：next 被丟掉
    // → cookie 只剩約 305 bytes → 兩條上界當然都過。先釘住最壞情況真的進了 cookie。
    expect(next).toHaveLength(MAX_NEXT_PATH_LENGTH);
    expect(cookieBytes).toBeLessThan(4096);
    expect(setCookieBytes).toBeLessThan(4096);
    // 同時釘住餘裕：低於 3500 才算「遠低於」，突然逼近（例如 payload 加欄位）就該
    // 重新評估要不要加關。
    expect(cookieBytes).toBeLessThan(3500);
  });

  it("next 出現多次（?next=/a&next=/b）→ 不封（query 解出來是陣列，route 先收斂成 null）", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fa&next=%2Fb")).toBeUndefined();
  });

  it("沒有 next → 不封（既有行為不變）", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login")).toBeUndefined();
  });

  // 四個導回 /login?error=… 的出口一律不帶 next（spec round 10 定案：設定錯誤路徑，
  // 使用者從 client 重新發起即可）。下面**四案一案對一條**——把任何一條改成帶 next，
  // 就恰有一案會紅。
  it("早退不帶 next：OIDC 未設定", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("早退不帶 next：discovery 不可用", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.failNext("discovery");
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("早退不帶 next：組 authorization URL 失敗（外層 catch）", async () => {
    // metadata 缺 authorization_endpoint 時 getConfiguration **會成功**（它只檢查
    // jwks_uri 與簽章演算法），要到 buildAuthorizationUrl 才拋錯——這是本 harness 造得出
    // 來、到得了外層 catch 的路徑。⚠ 本案只斷言「導回且不帶 next」，**沒有**斷言走的是
    // 哪個分支（counts.discovery 對成功與失敗都是 1，分辨不了）；「確實是外層 catch」是
    // 用突變驗的：把該 catch 改成帶 next，四案中恰有本案紅。
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.omitFromMetadata(["authorization_endpoint"]);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({ config, oidc: runtime });

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    expect(res.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
  });

  it("早退不帶 next：限流（第 2 發撞上 limit=1 的桶）", async () => {
    const config = oidcConfig();
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const runtime = createOidcRuntime(config.oidc!, { fetch: fakeIdp.fetch });
    const { app } = await buildTestApp({
      config,
      oidc: runtime,
      limiters: freshLimiters({ oidcLogin: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) }),
    });
    const url = "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note";

    const first = await app.inject({ method: "GET", url });
    expect(new URL(first.headers.location as string).origin).toBe(ISSUER_URL);

    const second = await app.inject({ method: "GET", url });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe("/login?error=too_many_requests");
    expect(second.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
  });
});
