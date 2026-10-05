import { describe, expect, it } from "vitest";
import { MAX_NEXT_PATH_LENGTH, OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { CustomFetch } from "openid-client";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { createOidcRuntimeRegistry } from "../src/auth/oidc-client.js";
import { authProviders } from "../src/db/schema.js";
import { buildTestApp, freshDb, freshLimiters } from "./helpers.js";
import { createFakeIdp } from "./helpers/fake-idp.js";
import { legacyOidcApp, seedAuthProvider } from "./helpers/oidc-provider.js";
import { unsealOidcState, type OidcStatePayload } from "../src/auth/oidc-state.js";

const ISSUER_URL = "https://idp.example.com";

/** 一層可換底的 fetch：讓同一個 registry 在測試中期改變底層行為（例如「discovery 先失敗，
 * 修好後重打」），不需要重新建立 registry——重建會失去要驗證的快取狀態本身。 */
function switchableFetch(initial: CustomFetch): { fetch: CustomFetch; set(next: CustomFetch): void } {
  let current = initial;
  const fetch: CustomFetch = (...args) => current(...args);
  return { fetch, set: next => (current = next) };
}

const throwingFetch: CustomFetch = async () => {
  throw new Error("network unreachable");
};

/**
 * state payload 的 next。Task 11 起 `OidcStatePayload` 是聯集（prove 形沒有 next），直接讀 `p.next` 在
 * `tsconfig.test.json` 下是 TS2339——一律經這個收窄 helper（gate r2 t8-14 I1）。
 */
function nextOf(p: OidcStatePayload | null): string | undefined {
  return p !== null && p.intent === "login" ? p.next : undefined;
}

describe("GET /api/auth/oidc/login（legacy 入口，#187 B13）", () => {
  it("沒有 legacy provider（未匯入 OIDC_*）→ 302 /login?error=oidc_unavailable；legacy provider 停用 → 同", async () => {
    const { app, db } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");

    await seedAuthProvider(db, { issuerUrl: ISSUER_URL, legacyCallback: true, enabled: false });
    const disabled = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(disabled.statusCode).toBe(302);
    expect(disabled.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("已設定 + mock IdP → 302 至 authorize endpoint，query/cookie 皆正確；redirect_uri 是舊回呼網址；state cookie 綁 providerId／configVersion／intent", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app, config, provider } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

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
    // #187 §7.1／§14.1-13：legacy provider 沿用舊回呼網址（IdP 端已註冊的那條不必改）。
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
    // state/nonce，須與 302 location 的 query 相等，證明兩者確實來自同一次產生。
    const nowEpochSeconds = Math.floor(Date.now() / 1000);
    const sealedPayload = unsealOidcState(config.appSecret, cookie!.value, nowEpochSeconds);
    expect(sealedPayload).not.toBeNull();
    expect(sealedPayload?.state).toBe(location.searchParams.get("state"));
    expect(sealedPayload?.nonce).toBe(location.searchParams.get("nonce"));
    // #187 §7.3：cookie 綁發出它的 provider 與當下的設定版本；PR1 的 login 一律 intent "login"。
    expect(sealedPayload).toMatchObject({ providerId: provider.id, configVersion: 1, intent: "login" });

    // 不可預測性：第二次請求必須產生不同的 state（不是固定值/可預測序列）。
    const res2 = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const location2 = new URL(res2.headers.location as string);
    expect(location2.searchParams.get("state")).not.toBe(location.searchParams.get("state"));
  });

  it("discovery 網路失敗（IdP 5xx，harness failNext 一次性）→ 302 oidc_unavailable；不快取——同一 app 再打一次（failNext 已消費即還原）→ 302 至 IdP", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.failNext("discovery");
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/login?error=oidc_unavailable");

    // failNext 為一次性，這裡不需要任何手動「修好」——上面那次呼叫已經把它消費並還原。
    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("discovery 成功但 metadata 無 jwks_uri → 302 oidc_unavailable；修好後重打成功——不可用不快取", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.omitFromMetadata(["jwks_uri"]);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/login?error=oidc_unavailable");

    fakeIdp.omitFromMetadata([]);

    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("discovery 成功後把 fetch 換成 throw → 仍 302 至 IdP（成功快取到設定版本變更或重啟）", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const swap = switchableFetch(fakeIdp.fetch);
    const { app } = await legacyOidcApp(swap.fetch, ISSUER_URL);

    const first = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(first.statusCode).toBe(302);
    expect(new URL(first.headers.location as string).origin).toBe(ISSUER_URL);

    swap.set(throwingFetch);

    const second = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(second.statusCode).toBe(302);
    expect(new URL(second.headers.location as string).origin).toBe(ISSUER_URL);
  });

  it("in-flight 去重：首波併發共用同一次 discovery → discovery fetch 恰一次", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/api/auth/oidc/login" }),
      app.inject({ method: "GET", url: "/api/auth/oidc/login" }),
    ]);
    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(fakeIdp.counts.discovery).toBe(1);
  });

  it("resolved_issuer 寫回失敗（DB 錯誤）→ 盡力而為：登入照常 302 至 IdP、記一筆 warn（只帶 provider id 與錯誤訊息），不是 oidc_unavailable", async () => {
    // #187 Task 8（Task 3 審查遺留）：providerConfiguration 的寫回失敗不得變成登入失敗。login 路徑上唯一的 UPDATE 就是
    // recordResolvedIssuer——讓 app 用的 db 的 update 一律 throw，其餘照常。
    const { db } = await freshDb();
    const failingUpdates = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "update") return () => { throw new Error("simulated DB failure"); };
        return Reflect.get(target, key, receiver);
      },
    });
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await buildTestApp(
      { db: failingUpdates, oidcRegistry: createOidcRuntimeRegistry({ fetch: fakeIdp.fetch }) },
      { logger: { level: "warn", stream } },
    );
    const provider = await seedAuthProvider(db, { issuerUrl: ISSUER_URL, legacyCallback: true });

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).origin).toBe(ISSUER_URL);

    const warned = lines.flatMap(l => l.split("\n")).filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(l => l.msg === "resolved_issuer 寫回失敗（盡力而為，登入照常）");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 40, providerId: provider.id, error: "simulated DB failure" });
    // 真的沒寫進去（寫回確實失敗了，不是根本沒走到那一步）。
    const [row] = await db.select({ r: authProviders.resolvedIssuer }).from(authProviders).where(eq(authProviders.id, provider.id));
    expect(row!.r).toBeNull();
  });

  it("limiter：同一 IP 第 30 次仍放行、第 31 次請求 → 302 too_many_requests", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    let res: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 31; i += 1) {
      res = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
      // MINOR-5（審查 fix round 1）：只釘住第 31 發只證明「額度真的有上限」，沒證明
      // 「上限剛好是 30」——這裡額外釘住第 30 發仍成功 302 至 IdP，才真的鎖住「限額恰為 OIDC_LIMIT=30」。
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
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

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
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app, config } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    // 真的去了 IdP——否則下面解出 undefined 是「其實被導回 /login」的假綠。
    expect(location.origin).toBe(ISSUER_URL);
    // next 只走密封 cookie，**不得**出現在送去 IdP 的 authorize query。⚠ 用 searchParams.has，
    // 不要對整條 location 做子字串比對：state 是 43 字元隨機 base64url，偶爾會湊出 "next"。
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
      next: nextOf(payload),
      // Chrome 實際設限的對象是 name=value；RFC 6265 §6.1 的 4096 預算則含屬性——兩個都量。
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
    // 「server 端不需要第二道長度關」這個決策的**量測**守衛。#187 加了 providerId／configVersion／intent 三欄後
    // 最壞約 3177 bytes（plan 主檔複驗第 21 條；Plan 5 時是 3049）——仍低於 3500。
    const worstCaseNext = "/" + "a".repeat(MAX_NEXT_PATH_LENGTH - 1);
    const { next, cookieBytes, setCookieBytes } = await loginWithNext(
      `/api/auth/oidc/login?next=${encodeURIComponent(worstCaseNext)}`,
    );
    // ⚠ 沒有這一行，本案在「有人重新加一道 1000 字元的關」之下會**更綠**：先釘住最壞情況真的進了 cookie。
    expect(next).toHaveLength(MAX_NEXT_PATH_LENGTH);
    expect(cookieBytes).toBeLessThan(4096);
    expect(setCookieBytes).toBeLessThan(4096);
    // 同時釘住餘裕：低於 3500 才算「遠低於」，突然逼近（例如 payload 再加欄位）就該重新評估要不要加關。
    expect(cookieBytes).toBeLessThan(3500);
  });

  it("next 出現多次（?next=/a&next=/b）→ 不封（query 解出來是陣列，route 先收斂成 null）", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login?next=%2Fa&next=%2Fb")).toBeUndefined();
  });

  it("沒有 next → 不封（既有行為不變）", async () => {
    expect(await sealedNextOf("/api/auth/oidc/login")).toBeUndefined();
  });

  // 五個導回 /login?error=… 的早退出口一律不帶 next（spec round 10 定案：設定錯誤路徑，使用者從 client 重新發起即可；
  // #187 §7.2 多了「provider id 不是 UUID」那一個）。下面五案一案對一條【推：把任何一條改成帶 next，恰有對應那一案紅——
  // implementer 以突變確認，見 Step 10 M6】。
  it("早退不帶 next：沒有 legacy provider", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("早退不帶 next：provider id 不是 UUID（/api/auth/oidc/login/not-a-uuid）", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);
    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login/not-a-uuid?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    expect(fakeIdp.counts.discovery).toBe(0);
  });

  it("早退不帶 next：discovery 不可用", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.failNext("discovery");
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
  });

  it("早退不帶 next：組 authorization URL 失敗（外層 catch）", async () => {
    // metadata 缺 authorization_endpoint 時 getConfiguration **會成功**（它只檢查 jwks_uri 與簽章演算法），要到
    // buildAuthorizationUrl 才拋錯——這是本 harness 造得出來、到得了外層 catch 的路徑。⚠ 本案只斷言「導回且不帶 next」，
    // **沒有**斷言走的是哪個分支；「確實是外層 catch」是用突變驗的（Step 10 M6）。
    const fakeIdp = createFakeIdp(ISSUER_URL);
    fakeIdp.omitFromMetadata(["authorization_endpoint"]);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL);

    const res = await app.inject({ method: "GET", url: "/api/auth/oidc/login?next=%2Fn%2Falice%2Fmy-note" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=oidc_unavailable");
    expect(res.cookies.find(c => c.name === OIDC_STATE_COOKIE)).toBeUndefined();
  });

  it("早退不帶 next：限流（第 2 發撞上 limit=1 的桶）", async () => {
    const fakeIdp = createFakeIdp(ISSUER_URL);
    const { app } = await legacyOidcApp(fakeIdp.fetch, ISSUER_URL, {
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
