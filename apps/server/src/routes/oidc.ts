import type { FastifyInstance } from "fastify";
import * as client from "openid-client";
import { and, eq, sql } from "drizzle-orm";
import { normalizeEmail, OIDC_STATE_COOKIE } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { users } from "../db/schema.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { OIDC_STATE_COOKIE_PATH, OIDC_STATE_TTL_SECONDS, sealOidcState, unsealOidcState } from "../auth/oidc-state.js";
import { OidcUnavailableError, oidcRedirectUri, type OidcRuntime } from "../auth/oidc-client.js";
import { decideOidcLogin, type OidcClaims, type OidcUserRow } from "../auth/oidc-decision.js";
import { signSession, type UserGate } from "../auth/session.js";
import { setSessionCookie } from "../auth/cookies.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

export interface OidcRouteDeps {
  config: AppConfig;
  db: Db;
  gate: UserGate;
  /** `buildApp` 的 fallback 已把「`config.oidc` 有值但無 runtime」這個矛盾狀態排除
   * （見 `app.ts` 的 `oidcRuntime` 接線註解）——這裡仍收 `undefined`，是為了讓這條路由
   * 自己也能安全地應對「萬一」，不把兩端點 302 語彙不變量的維持全部押在呼叫端。 */
  runtime: OidcRuntime | undefined;
  limiters: { oidc: FixedWindowLimiter };
}

/**
 * ID token／userinfo 的 `email` claim 若為空字串，視為缺欄位（null），不是「有效但
 * 空白」的 email（審查 fix round 1 MINOR-4）：`typeof v === "string"` 對空字串仍為
 * true，若不額外擋，`normalizeEmail("")` 回傳 `""`（非 null），會讓
 * `decideOidcLogin` 誤判「email 存在」而走建帳路徑，產生 `email=""`／`displayName=""`
 * 的帳號，且日後任何同樣缺 email 的 IdP 回應都會落在同一個 `lower(email) = ''`
 * 命中上，被誤判為 `oidc_conflict`（多列命中）——本應是各自獨立的
 * `oidc_email_missing`。
 */
function nonEmptyClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** `users` 一列 → `decideOidcLogin` 要的最小欄位集。 */
function toOidcUserRow(row: typeof users.$inferSelect): OidcUserRow {
  return {
    id: row.id,
    email: row.email,
    disabledAt: row.disabledAt,
    mustChangePassword: row.mustChangePassword,
    oidcIssuer: row.oidcIssuer,
    oidcSub: row.oidcSub,
  };
}

type OidcResolutionOutcome =
  | { kind: "reject"; code: "account_disabled" | "oidc_conflict" | "oidc_email_unverified" | "oidc_email_missing"; conflictReason?: "multi_email_match" | "bound_to_other_identity" }
  | { kind: "success"; userId: string; tv: number; wroteUsers: boolean };

/**
 * 單一交易：查候選列 → `decideOidcLogin` 純決策 → 依 kind 寫入（§14.3 執行層）。
 *
 * 可能因併發撞 `users_email_unique`／`users_oidc_idx` 而 throw（`isUniqueViolation`
 * 可辨識）——呼叫端（callback route）負責 catch 並重查一次，這裡不自行重試，保持每次
 * 呼叫＝一次乾淨的交易嘗試，職責單純。
 */
async function attemptOidcAccountResolution(db: Db, claims: OidcClaims): Promise<OidcResolutionOutcome> {
  return db.transaction(async tx => {
    const [byOidcRow] = await tx
      .select()
      .from(users)
      .where(and(eq(users.oidcIssuer, claims.issuer), eq(users.oidcSub, claims.sub)))
      .limit(1);
    const byOidcUser = byOidcRow ? toOidcUserRow(byOidcRow) : null;

    // 不 limit：多列命中的判定歸純函式（decideOidcLogin 的 oidc_conflict 分支）。
    const byEmailRows = claims.email !== null ? await tx.select().from(users).where(sql`lower(${users.email}) = ${claims.email}`) : [];
    const byEmailUsers = byEmailRows.map(toOidcUserRow);

    // login（不清 mustChangePassword）分支需要的 tokenVersion 就在上面兩個查詢已撈出的
    // 全欄位列裡（byOidcRow／byEmailRows 皆 `select()` 全欄，非窄選）——用這個 map
    // 直接查表即可，不必為了單一欄位再補一次 SELECT（審查 fix round 1 MINOR-6）。
    const knownRows = new Map<string, typeof users.$inferSelect>();
    if (byOidcRow) knownRows.set(byOidcRow.id, byOidcRow);
    for (const row of byEmailRows) knownRows.set(row.id, row);

    const decision = decideOidcLogin(claims, byOidcUser, byEmailUsers);

    if (decision.kind === "reject") {
      return { kind: "reject", code: decision.code, conflictReason: decision.conflictReason };
    }

    if (decision.kind === "login") {
      if (!decision.clearMustChange) {
        const row = knownRows.get(decision.userId);
        return { kind: "success", userId: decision.userId, tv: row!.tokenVersion, wroteUsers: false };
      }
      const [updated] = await tx
        .update(users)
        .set({ mustChangePassword: false })
        .where(eq(users.id, decision.userId))
        .returning({ tokenVersion: users.tokenVersion });
      return { kind: "success", userId: decision.userId, tv: updated!.tokenVersion, wroteUsers: true };
    }

    if (decision.kind === "link") {
      const setValues: Partial<typeof users.$inferInsert> = { oidcIssuer: claims.issuer, oidcSub: claims.sub };
      if (decision.clearMustChange) setValues.mustChangePassword = false;
      const [updated] = await tx.update(users).set(setValues).where(eq(users.id, decision.userId)).returning({ tokenVersion: users.tokenVersion });
      return { kind: "success", userId: decision.userId, tv: updated!.tokenVersion, wroteUsers: true };
    }

    // decision.kind === "create"：email 已正規化（decideOidcLogin 收到的 claims.email
    // 已在 callback 進門過 normalizeEmail）、password_hash 明確 null、
    // must_change_password 沿用 schema 預設 false（OIDC 自動建帳不強制改密）。
    const [inserted] = await tx
      .insert(users)
      .values({
        email: decision.email,
        displayName: decision.displayName,
        oidcIssuer: claims.issuer,
        oidcSub: claims.sub,
        passwordHash: null,
        mustChangePassword: false,
      })
      .returning({ id: users.id, tokenVersion: users.tokenVersion });
    return { kind: "success", userId: inserted!.id, tv: inserted!.tokenVersion, wroteUsers: true };
  });
}

/**
 * `GET /api/auth/oidc/login`＋`GET /api/auth/oidc/callback`——OIDC authorization code
 * flow 的兩端（Task 8 login／Task 9 callback：code 交換、claims 合併、帳號解析、
 * session 簽發）。
 *
 * 全程回 302（不回 JSON 錯誤）：這兩條路由的呼叫者是瀏覽器頂層導航（使用者點「用 SSO
 * 登入」按鈕的 `<a href>`／IdP 導回），不是 fetch/XHR，回 JSON 4xx/5xx 只會讓瀏覽器顯示
 * 裸 JSON，使用者拿不到任何有意義的回饋——一律導回 `/login?error=<code>`（含程式錯誤：
 * callback 整段核心邏輯包在最外層 try/catch，任何未預期例外一律映射
 * `oidc_exchange_failed`，不落到全域錯誤 handler 變成 JSON 500），交給登入頁的 toast
 * 顯示對應 i18n 文案。
 */
export function oidcRoutes(deps: OidcRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/auth/oidc/login", async (request, reply) => {
      if (deps.config.oidc === undefined || deps.runtime === undefined) {
        return reply.redirect("/login?error=oidc_unavailable");
      }

      if (!deps.limiters.oidc.consume(request.ip)) {
        return reply.redirect("/login?error=too_many_requests");
      }

      let configuration: client.Configuration;
      try {
        configuration = await deps.runtime.getConfiguration();
      } catch (err) {
        if (err instanceof OidcUnavailableError) {
          request.log.warn({ err }, "OIDC discovery 不可用，導回登入頁");
          return reply.redirect("/login?error=oidc_unavailable");
        }
        throw err;
      }

      // MINOR-1（審查 fix round 1）：`buildAuthorizationUrl` 在 metadata 缺
      // `authorization_endpoint` 等情況下會 throw——不包 try/catch 會落到全域錯誤 handler
      // 變成 JSON 500，破壞這條路由「一律 302，不回 JSON」的不變量。整段（state/nonce/PKCE
      // 產生、cookie、組 URL）刻意一起包，因為這些步驟本身也不該在中途失敗後留下已
      // `setCookie` 但沒有實際 302 到 IdP 的半殘狀態。
      try {
        const state = client.randomState();
        const nonce = client.randomNonce();
        const codeVerifier = client.randomPKCECodeVerifier();
        const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

        const nowEpochSeconds = Math.floor(Date.now() / 1000);
        const sealed = sealOidcState(deps.config.appSecret, {
          state,
          nonce,
          codeVerifier,
          exp: nowEpochSeconds + OIDC_STATE_TTL_SECONDS,
        });

        // scope 逐字 "openid email profile"（§14.3 authorize 參數契約——漏了會讓真 IdP
        // 全員回 oidc_email_missing，四輪 gate MAJOR-1）。
        const authorizationUrl = client.buildAuthorizationUrl(configuration, {
          redirect_uri: oidcRedirectUri(deps.config),
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        reply.setCookie(OIDC_STATE_COOKIE, sealed, {
          httpOnly: true,
          sameSite: "lax",
          secure: deps.config.cookieSecure,
          path: OIDC_STATE_COOKIE_PATH,
          maxAge: OIDC_STATE_TTL_SECONDS,
        });

        return reply.redirect(authorizationUrl.href);
      } catch (err) {
        // 不含 secret：`err` 是 openid-client 的驗證錯誤（缺 endpoint／參數格式），不含
        // `codeVerifier`/`state`/`nonce` 這類我們自己產生的一次性值（它們只存在於這個
        // function scope，從未被塞進任何 throw 的 err 物件）。
        request.log.warn({ err }, "組裝 OIDC authorization URL 失敗，導回登入頁");
        return reply.redirect("/login?error=oidc_unavailable");
      }
    });

    app.get("/api/auth/oidc/callback", async (request, reply) => {
      if (deps.config.oidc === undefined || deps.runtime === undefined) {
        return reply.redirect("/login?error=oidc_unavailable");
      }

      if (!deps.limiters.oidc.consume(request.ip)) {
        return reply.redirect("/login?error=too_many_requests");
      }

      // 整段（state 讀取到簽 session）包在同一個 try/catch：任何未預期例外（含
      // openid-client 內部丟出的非 OidcUnavailableError 型別、DB 交易的非
      // unique-violation 錯誤）一律映射 oidc_exchange_failed，維持「這條路由一切失敗
      // 都是 302，不是 JSON 500」的不變量（見上方 doc comment）。
      try {
        // 進門先讀並即刻清除 state cookie（成敗皆清）——`clearCookie` 必須帶與 login
        // route `setCookie` 時相同的 path/sameSite/secure，否則瀏覽器不認得是同一顆
        // cookie 而不會真的清除。
        const sealedCookie = request.cookies[OIDC_STATE_COOKIE];
        reply.clearCookie(OIDC_STATE_COOKIE, {
          path: OIDC_STATE_COOKIE_PATH,
          sameSite: "lax",
          secure: deps.config.cookieSecure,
        });

        if (sealedCookie === undefined) {
          return reply.redirect("/login?error=oidc_state_mismatch");
        }

        const nowEpochSeconds = Math.floor(Date.now() / 1000);
        const payload = unsealOidcState(deps.config.appSecret, sealedCookie, nowEpochSeconds);
        if (payload === null) {
          return reply.redirect("/login?error=oidc_state_mismatch");
        }

        const query = request.query as Record<string, unknown>;
        const stateParam = typeof query.state === "string" ? query.state : undefined;
        if (stateParam === undefined || stateParam !== payload.state) {
          return reply.redirect("/login?error=oidc_state_mismatch");
        }

        let configuration: client.Configuration;
        try {
          configuration = await deps.runtime.getConfiguration();
        } catch (err) {
          if (err instanceof OidcUnavailableError) {
            request.log.warn({ err }, "OIDC discovery 不可用，導回登入頁");
            return reply.redirect("/login?error=oidc_unavailable");
          }
          throw err;
        }

        // `currentUrl` 以 `oidcRedirectUri(config)` 為底、只換上這次請求的 query
        // string——不用 request.host/protocol（反代終止 TLS 時會漂），openid-client
        // 從這個 URL 重新推導 redirect_uri 送 token endpoint，必須與 login 送出的
        // redirect_uri 逐字元相同（§14.3）。
        const currentUrl = new URL(oidcRedirectUri(deps.config));
        const rawUrl = request.raw.url ?? "";
        const queryIndex = rawUrl.indexOf("?");
        currentUrl.search = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);

        let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
        try {
          tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
            expectedState: payload.state,
            expectedNonce: payload.nonce,
            pkceCodeVerifier: payload.codeVerifier,
          });
        } catch (err) {
          // 上游細節（可能含 client secret 交換的錯誤訊息）僅 log，不出線。
          request.log.warn({ err }, "OIDC code 交換失敗");
          return reply.redirect("/login?error=oidc_exchange_failed");
        }

        // `expectedNonce` 已隱含要求回應必須含 ID token（openid-client 契約），這裡仍
        // 防禦性檢查 undefined——不對 openid-client 的內部保證照單全收。
        const idTokenClaims = tokens.claims();
        if (idTokenClaims === undefined) {
          request.log.warn("OIDC token 交換成功但缺 id_token claims");
          return reply.redirect("/login?error=oidc_exchange_failed");
        }

        const sub = idTokenClaims.sub;
        let email = nonEmptyClaim(idTokenClaims.email);
        let emailVerified = typeof idTokenClaims.email_verified === "boolean" ? idTokenClaims.email_verified : null;
        const name = typeof idTokenClaims.name === "string" ? idTokenClaims.name : null;

        // issuer 單一真相：存 DB／組 claims 都用 serverMetadata().issuer，不用
        // config.oidc.issuerUrl（兩者理論上相同，但前者是 IdP 實際回報的正規值）。
        const metadata = configuration.serverMetadata();

        // email 或 email_verified 任一缺失 → 補打 userinfo 一次；metadata 無
        // userinfo_endpoint 則不打，缺失欄位維持 null，交給 decideOidcLogin 的缺失
        // 判定分支處理。逐欄位合併：ID token 有值者為準，只補缺的欄位。
        if ((email === null || emailVerified === null) && metadata.userinfo_endpoint !== undefined) {
          let userinfo: Awaited<ReturnType<typeof client.fetchUserInfo>>;
          try {
            userinfo = await client.fetchUserInfo(configuration, tokens.access_token, sub);
          } catch (err) {
            request.log.warn({ err }, "OIDC userinfo 取得失敗");
            return reply.redirect("/login?error=oidc_exchange_failed");
          }
          if (email === null) email = nonEmptyClaim(userinfo.email);
          if (emailVerified === null && typeof userinfo.email_verified === "boolean") emailVerified = userinfo.email_verified;
        }

        const claims: OidcClaims = {
          issuer: metadata.issuer,
          sub,
          email: email !== null ? normalizeEmail(email) : null,
          emailVerified,
          name,
        };

        let result: OidcResolutionOutcome;
        try {
          result = await attemptOidcAccountResolution(deps.db, claims);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // race：另一個併發 callback 同時建帳/連結，撞 users_email_unique 或
          // users_oidc_idx——此時對方的寫入已提交（unique 違反在 commit 前的
          // 約束檢查會等鎖釋放後才報錯），重查一次即可按命中路徑走。
          try {
            result = await attemptOidcAccountResolution(deps.db, claims);
          } catch (err2) {
            request.log.warn({ err: err2 }, "OIDC 帳號解析 race 重查後仍失敗");
            return reply.redirect("/login?error=oidc_exchange_failed");
          }
        }

        if (result.kind === "reject") {
          if (result.code === "oidc_conflict") {
            // 兩義 log 區分：lower() 多列命中 vs 已綁其他 (issuer,sub)——同碼不同成因。
            request.log.warn({ conflictReason: result.conflictReason }, "OIDC 帳號衝突");
          }
          return reply.redirect(`/login?error=${result.code}`);
        }

        // 對 users 表有任何寫入（連結/建帳/清 mustChangePassword）→ 簽 session 前必須
        // invalidate gate 快取，否則 60 秒 TTL 快取把舊旗標吐回 /api/auth/me（§14.3）。
        if (result.wroteUsers) {
          deps.gate.invalidate(result.userId);
        }

        const token = await signSession(deps.config.appSecret, { userId: result.userId, tv: result.tv });
        setSessionCookie(reply, deps.config, token);
        return reply.redirect("/");
      } catch (err) {
        request.log.error({ err }, "OIDC callback 發生未預期錯誤");
        return reply.redirect("/login?error=oidc_exchange_failed");
      }
    });
  };
}
