import { randomBytes } from "node:crypto";
import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { normalizeScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests, users } from "../db/schema.js";
import { isForeignKeyViolation, uniqueViolationConstraint } from "../db/pg-errors.js";
import type { UserGate } from "../auth/session.js";
import { generateAccessToken, generateRefreshToken, hashToken, REFRESH_TOKEN_PREFIX } from "../auth/api-token.js";
import { countBillableGrants, TOKEN_LIMIT_PER_USER } from "../auth/grant-quota.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { sendOauthError } from "../http/oauth-errors.js";
import { isLoopbackRedirectUri, matchesLoopbackRedirect } from "../oauth/redirect.js";
import { canonicalResource, isCanonicalResource } from "../oauth/resource.js";
import { hasUnstorableChar } from "../oauth/storable.js";
import { runOauthCleanup } from "../oauth/cleanup.js";
import { verifyPkce } from "../oauth/pkce.js";
import { DEFAULT_CLIENT_NAME, hasUnsafeClientNameChar } from "../oauth/client-name.js";

export interface OauthRouteDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  limiters: { dcr: FixedWindowLimiter; authorize: FixedWindowLimiter; tokenEndpoint: FixedWindowLimiter };
}

/**
 * 兩個 RFC 形 plugin 共用的 error／notFound handler（§5.0）。
 *
 * ⚠ **只能在帶 prefix 的封裝 plugin 內呼叫**：root 的 `setNotFoundHandler` 由
 * `http/spa.ts` 獨佔，無 prefix 的 plugin 再呼叫一次會開機即崩。
 */
export function registerRfcErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    // statusCode 要保留：formbody 的 415 就是 415，不可退化成 500。
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error, authKind: request.authKind }, "oauth endpoint error");
      return sendOauthError(reply, 500, "server_error", "伺服器內部錯誤");
    }
    // §5.0 的映射表只列 415／400／404／405，都歸 invalid_request；今天沒有路由會丟
    // 401／403／429（那些是 handler 直送），有的話這裡要先補碼再改。
    return sendOauthError(reply, status, "invalid_request", error.message || "請求錯誤");
  });

  // RFC 沒有 not_found 碼，用 invalid_request 加說明。
  app.setNotFoundHandler(async (_request, reply) => sendOauthError(reply, 404, "invalid_request", "unknown endpoint"));
}

/**
 * 只挑我們認得的欄位（zod 預設 strip 其餘）——RFC 7591 允許 AS 忽略不支援的 metadata，
 * 回應也不回聲，client 依回應為準。
 */
const registerBodySchema = z.object({
  // trim 比照 `routes/api-tokens.ts` 的 name：全空白的名稱同樣是同意頁的視覺洞
  client_name: z.string().trim().min(1).max(64).optional(),
  redirect_uris: z.array(z.string().max(512)).min(1).max(8),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  application_type: z.string().optional(),
});

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_STATE = 2048;
const MAX_SCOPE = 512;
const MAX_RESOURCE = 512;
const MAX_REDIRECT_URI = 512;
const MAX_CLIENT_ID = 64;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * client 或 redirect_uri 不可信時的說明頁（§5.3 步驟 1）。**全靜態、不回聲任何請求
 * 參數**——這裡的輸入全是無認證方控制的字串。這是 I5 清掉 client 之後、client 拿舊
 * client_id 回頭的必經路徑，訊息必須可操作。
 */
const UNKNOWN_CLIENT_MESSAGE = [
  "這個應用程式在 Knotebook 的註冊已失效或不存在。請在你的用戶端移除後重新加入（例如 `claude mcp remove knotebook` 再 `claude mcp add …`），它會重新註冊。",
  "This application's registration with Knotebook has expired or does not exist. Remove it from your client and add it again (for example `claude mcp remove knotebook` then `claude mcp add …`) so that it re-registers.",
].join("\n\n");

const T1_MESSAGE =
  "授權請求缺少必要參數或參數過長。\n\nThe authorization request is missing required parameters or they are too long.";
const RATE_LIMITED_MESSAGE =
  "授權請求太頻繁，請稍後再試。\n\nToo many authorization requests. Try again later.";

function sendPlainText(reply: FastifyReply, statusCode: number, message: string): FastifyReply {
  return reply
    .code(statusCode)
    .header("content-type", "text/plain; charset=utf-8")
    .header("cache-control", "no-store")
    .send(message);
}

/** T2 的錯誤一律導回 client（RFC 6749 §4.1.2.1）——一律 URL API，禁止字串串接。 */
function redirectWithError(
  reply: FastifyReply,
  redirectUri: string,
  issuer: string,
  error: string,
  description: string,
  state: string | undefined
): FastifyReply {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return reply.code(302).header("location", url.toString()).header("cache-control", "no-store").send();
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const ACCESS_TTL_MS = 24 * 60 * 60_000;
const OAUTH_USER_CLIENT_UIDX = "api_tokens_oauth_user_client_uidx";

/**
 * §5.4 的參數長度表；超過上限一律 `invalid_request`（不進 DB）。只有 `code_verifier` 有
 * 下限（spec 明文 43..128）：太短若放到 PKCE 比對才失敗會回 invalid_grant，client 會誤判
 * code 壞掉重跑整輪。`code`／`refresh_token` 刻意**不設下限**——畸形憑證是 invalid_grant
 * 的事（RFC 6749 §5.2），由 hash 查無／前綴檢查判，不在這裡搶答。
 */
const TOKEN_FIELD_LIMITS: Record<string, { min: number; max: number }> = {
  code: { min: 1, max: 43 },
  code_verifier: { min: 43, max: 128 },
  refresh_token: { min: 1, max: 48 },
  client_id: { min: 1, max: 64 },
  redirect_uri: { min: 1, max: 512 },
  resource: { min: 1, max: 512 },
  grant_type: { min: 1, max: 32 },
};
/** RFC 7636 §4.1 的 unreserved 字元集。verifier 只進 sha256 與比較，不進 SQL。 */
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * tx 內的失敗一律**用 throw 表達**（spec §5.4）。drizzle 的 `db.transaction()` 只在
 * callback throw 時 ROLLBACK，正常 return 一律 COMMIT——用回傳值表達失敗，會把 I7 的
 * DELETE 與 code 的消費一起提交，換來「舊授權被刪掉、新 token 沒發出」的死狀態。
 */
class OauthGrantError extends Error {
  constructor(
    readonly code: string,
    readonly description: string
  ) {
    super(description);
  }
}

function formField(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * `/oauth` 前綴 plugin（§5.2–§5.4）。RFC 形錯誤 body 是全站唯一例外，理由與錯誤映射
 * 見 `http/oauth-errors.ts`（docs/api.md 的對應說明在文件那一棒補）。
 */
export function oauthRoutes(deps: OauthRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    registerRfcErrorHandlers(app);

    app.post("/register", async (request, reply) => {
      if (!deps.limiters.dcr.consume(request.ip)) {
        return sendOauthError(reply, 429, "invalid_request", "註冊次數過多，請稍後再試");
      }

      const parsed = registerBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const aboutRedirect = parsed.error.issues.some(issue => issue.path[0] === "redirect_uris");
        return sendOauthError(
          reply,
          400,
          aboutRedirect ? "invalid_redirect_uri" : "invalid_client_metadata",
          aboutRedirect ? "redirect_uris 格式不正確" : "client metadata 格式不正確"
        );
      }
      const body = parsed.data;

      // D10：無認證的 DCR 若收遠端 redirect，任何人都能註冊好聽的名字做一鍵釣魚。
      if (!body.redirect_uris.every(isLoopbackRedirectUri)) {
        return sendOauthError(
          reply,
          400,
          "invalid_redirect_uri",
          "redirect_uri 必須是 loopback 位址，且不含 query、fragment 或帳密"
        );
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
        return sendOauthError(reply, 400, "invalid_client_metadata", "只支援 token_endpoint_auth_method=none");
      }
      if (
        body.grant_types !== undefined &&
        !body.grant_types.every(grant => (SUPPORTED_GRANT_TYPES as readonly string[]).includes(grant))
      ) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "不支援的 grant_types");
      }
      if (body.response_types !== undefined && (body.response_types.length !== 1 || body.response_types[0] !== "code")) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "只支援 response_types=[code]");
      }
      const clientName = body.client_name ?? DEFAULT_CLIENT_NAME;
      if (hasUnsafeClientNameChar(clientName)) {
        return sendOauthError(reply, 400, "invalid_client_metadata", "client_name 含不允許的控制字元");
      }

      await runOauthCleanup(deps.db);

      const clientId = randomBytes(16).toString("base64url");
      const [row] = await deps.db
        .insert(oauthClients)
        .values({ clientId, clientName, redirectUris: body.redirect_uris })
        .returning();

      return reply.code(201).header("cache-control", "no-store").header("pragma", "no-cache").send({
        client_id: row!.clientId,
        client_name: row!.clientName,
        redirect_uris: row!.redirectUris,
        grant_types: [...SUPPORTED_GRANT_TYPES],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(row!.createdAt.getTime() / 1000),
      });
    });

    app.get("/authorize", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const clientId = queryString(query.client_id);
      const redirectUri = queryString(query.redirect_uri);

      // T1：只驗「建立 redirect 可信度」所需的兩個參數。失敗不吃限流額度。
      if (
        clientId === undefined ||
        clientId.length > MAX_CLIENT_ID ||
        redirectUri === undefined ||
        redirectUri.length > MAX_REDIRECT_URI
      ) {
        return sendPlainText(reply, 400, T1_MESSAGE);
      }

      // consume-always（與 PUBLIC_MISS_LIMIT 的預檢紀律刻意相反，見 AUTHORIZE_LIMIT）。
      if (!deps.limiters.authorize.consume(request.ip)) {
        return sendPlainText(reply, 429, RATE_LIMITED_MESSAGE);
      }

      // ⚠ I5 必須早於下面的 client 查表：否則被清掉的 client 會在建 request 時撞 FK 變 500。
      await runOauthCleanup(deps.db);

      // client_id 是這條路上唯一進 **SQL 述詞** 的請求字串：帶 NUL 的 bind 參數會讓 PG
      // 直接 22021（無認證端點的 500）。帶 NUL 的值不可能配到 base64url 的註冊值，
      // 所以回步驟 1 的說明頁語意正確。
      if (hasUnstorableChar(clientId)) {
        return sendPlainText(reply, 400, UNKNOWN_CLIENT_MESSAGE);
      }

      const [client] = await deps.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
      if (client === undefined || !client.redirectUris.some(uri => matchesLoopbackRedirect(uri, redirectUri))) {
        return sendPlainText(reply, 400, UNKNOWN_CLIENT_MESSAGE);
      }

      // T2：redirect_uri 此刻已可信，錯誤一律導回去（RFC 6749 §4.1.2.1）。
      const issuer = publicUrlIssuer(deps.config.publicUrl);
      const rawState = queryString(query.state);
      // 不合格的 state 一律不回聲（原樣回一個我們自己拒收的值沒有意義）。
      const stateOk = rawState !== undefined && rawState.length <= MAX_STATE && !hasUnstorableChar(rawState);
      const state = stateOk ? rawState : undefined;
      const fail = (error: string, description: string): FastifyReply =>
        redirectWithError(reply, redirectUri, issuer, error, description, state);

      if (queryString(query.response_type) !== "code") {
        return fail("unsupported_response_type", "only response_type=code is supported");
      }
      const codeChallenge = queryString(query.code_challenge);
      if (codeChallenge === undefined || !CODE_CHALLENGE_RE.test(codeChallenge)) {
        return fail("invalid_request", "code_challenge must be 43-128 base64url characters");
      }
      if (queryString(query.code_challenge_method) !== "S256") {
        return fail("invalid_request", "only code_challenge_method=S256 is supported");
      }
      if (rawState !== undefined && rawState.length > MAX_STATE) {
        return fail("invalid_request", "state is too long");
      }
      // 其餘落庫欄位各有守衛（code_challenge 有正規式、scope 過 normalizeScope、
      // redirect_uri 過 matchesLoopbackRedirect），state 是最後一個裸的。
      if (rawState !== undefined && hasUnstorableChar(rawState)) {
        return fail("invalid_request", "state contains characters that cannot be stored");
      }
      const rawScope = queryString(query.scope);
      if (rawScope !== undefined && rawScope.length > MAX_SCOPE) {
        return fail("invalid_request", "scope is too long");
      }
      const resource = queryString(query.resource);
      if (resource !== undefined && resource.length > MAX_RESOURCE) {
        return fail("invalid_request", "resource is too long");
      }
      // RFC 8707 §2.1：缺席與無效都是 invalid_target。
      if (!isCanonicalResource(resource, issuer)) {
        return fail("invalid_target", `resource must be ${canonicalResource(issuer)}`);
      }

      const id = randomBytes(16).toString("base64url");
      try {
        await deps.db.insert(oauthRequests).values({
          id,
          clientId,
          // 存**本次**送來的完整值（含 ephemeral port）——token 換發跟這個當次值比對。
          redirectUri,
          codeChallenge,
          scope: normalizeScope(rawScope),
          state: state ?? null,
          expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        });
      } catch (err) {
        // 併發 TOCTOU：另一發請求的 I5 在我們查到 client 之後把它清掉（只發生在跨
        // 24h／30d 邊界的毫秒視窗）。回說明頁而不是讓 FK 違反冒成 500——語意也對，
        // 那個 client 此刻確實不存在了。無法穩定重現，故無測試。
        if (isForeignKeyViolation(err)) return sendPlainText(reply, 400, UNKNOWN_CLIENT_MESSAGE);
        throw err;
      }

      return reply.code(302).header("location", `/authorize?req=${id}`).header("cache-control", "no-store").send();
    });

    app.post("/token", async (request, reply) => {
      // §5.4：**所有**回應都帶這兩個 header，429 與成功回應都不例外——所以設在限流
      // 之前（`sendOauthError` 自己也會設 cache-control，重複設同值無害）。
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      if (!deps.limiters.tokenEndpoint.consume(request.ip)) {
        return sendOauthError(reply, 429, "invalid_request", "換發請求太頻繁，請稍後再試");
      }

      for (const [name, { min, max }] of Object.entries(TOKEN_FIELD_LIMITS)) {
        const value = formField(request.body, name);
        if (value === undefined) continue;
        if (value.length > max || value.length < min) {
          return sendOauthError(reply, 400, "invalid_request", `${name} has an invalid length`);
        }
      }
      const issuer = publicUrlIssuer(deps.config.publicUrl);
      const grantType = formField(request.body, "grant_type");
      if (grantType === undefined) {
        return sendOauthError(reply, 400, "invalid_request", "missing grant_type");
      }

      if (grantType === "authorization_code") {
        const code = formField(request.body, "code");
        const verifier = formField(request.body, "code_verifier");
        const clientId = formField(request.body, "client_id");
        const redirectUri = formField(request.body, "redirect_uri");
        const resource = formField(request.body, "resource");
        if (code === undefined || verifier === undefined || clientId === undefined || redirectUri === undefined) {
          return sendOauthError(reply, 400, "invalid_request", "missing required parameter");
        }
        if (!CODE_VERIFIER_RE.test(verifier)) {
          return sendOauthError(reply, 400, "invalid_request", "code_verifier has invalid characters");
        }
        // 缺席與無效都是 invalid_target（RFC 8707 §2.1）——用 invalid_grant 會讓 client
        // 誤判 code 壞掉而重跑整輪授權。
        if (!isCanonicalResource(resource, issuer)) {
          return sendOauthError(reply, 400, "invalid_target", `resource must be ${canonicalResource(issuer)}`);
        }

        // 顯式註記型別（不是多餘的）：TS 只有在變數帶 `=> never` 註記時才把呼叫
        // 當成終止控制流，日後開 `noUncheckedIndexedAccess` 才不會整段紅。
        const invalidGrant: (description?: string) => never = (description = "authorization code is invalid") => {
          throw new OauthGrantError("invalid_grant", description);
        };

        try {
          const issued = await deps.db.transaction(async tx => {
            // I3：單次消費。0 列＝用過／過期／不存在（三者刻意同形）。
            const [consumed] = await tx
              .delete(oauthCodes)
              .where(and(eq(oauthCodes.codeHash, hashToken(code)), sql`${oauthCodes.expiresAt} > now()`))
              .returning();
            // ⚠ 這些 throw 讓整個 tx 回捲＝**失敗的兌換不消費 code**（spec §5.4 要的）。
            // 代價是同一支 code 可在 10 分鐘內重試，PKCE 是唯一防線；已記 known-limitations。
            if (consumed === undefined) invalidGrant();
            // client_id／redirect_uri 在 JS 端與 DB 列逐字比對，不進 SQL 述詞（不變量 S）。
            if (consumed.clientId !== clientId || consumed.redirectUri !== redirectUri) invalidGrant();
            if (!verifyPkce(verifier, consumed.codeChallenge)) invalidGrant();

            // ⚠ tx 內**不能**呼叫 `deps.gate.checkUser`：它走 pool，cache miss 時等於
            // 持有 tx 連線的同時再借第二條——並發兌換撞上 cache miss 會把 pool 耗盡而
            // 永久卡死。直接用 tx 讀列；判準與 checkUser 同（存在且未停權，不比 tokenVersion）。
            const [account] = await tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, consumed.userId));
            if (account === undefined || account.disabledAt !== null) invalidGrant();

            // I7：先刪同 (user, client) 的既有 grant，再算 I1 額度（等價於 decision 側的扣除）。
            await tx
              .delete(apiTokens)
              .where(
                and(eq(apiTokens.userId, consumed.userId), eq(apiTokens.kind, "oauth"), eq(apiTokens.clientId, consumed.clientId))
              );
            // ⚠ 這一條 throw 是承重的：它讓上面那筆 I7 的 DELETE 一起 ROLLBACK。改成
            // 回傳值就會提交刪除卻不發 token，把使用者既有的授權吞掉。
            if ((await countBillableGrants(tx, consumed.userId)) >= TOKEN_LIMIT_PER_USER) {
              throw new OauthGrantError("invalid_grant", "token limit reached");
            }

            const [client] = await tx.select().from(oauthClients).where(eq(oauthClients.clientId, consumed.clientId));
            if (client === undefined) invalidGrant();

            const accessToken = generateAccessToken();
            const refreshToken = generateRefreshToken();
            await tx.insert(apiTokens).values({
              userId: consumed.userId,
              kind: "oauth",
              name: client.clientName,
              scope: consumed.scope,
              accessTokenHash: hashToken(accessToken),
              refreshTokenHash: hashToken(refreshToken),
              clientId: consumed.clientId,
              accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
            });
            await tx.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.clientId, consumed.clientId));
            return { accessToken, refreshToken, scope: consumed.scope };
          });

          // ⚠ I5 只能 fire-and-forget：tx 已經提交，清理失敗若冒到 error handler 就會
          // 變成 500——client 拿不到 token，code 卻已被消費。
          void runOauthCleanup(deps.db).catch((err: unknown) => {
            request.log.warn({ err }, "oauth cleanup after token exchange failed");
          });
          return reply.send({
            access_token: issued.accessToken,
            token_type: "Bearer",
            expires_in: Math.floor(ACCESS_TTL_MS / 1000),
            refresh_token: issued.refreshToken,
            scope: issued.scope,
          });
        } catch (err) {
          // 先判自家例外：`OauthGrantError` 也有 `.code` 欄，而 `pg-errors` 正是靠
          // `.code` 嗅 SQLSTATE——順序反過來雖然今天仍對，但那是巧合。
          if (err instanceof OauthGrantError) {
            return sendOauthError(reply, 400, err.code, err.description);
          }
          // 並發兌換：兩張 code 各自「先刪後插」，由 partial unique index 裁決。
          if (uniqueViolationConstraint(err) === OAUTH_USER_CLIENT_UIDX) {
            return sendOauthError(reply, 400, "invalid_grant", "authorization code is invalid");
          }
          throw err; // 其餘 DB 錯誤照舊走 scoped error handler → 500 server_error
        }
      }

      if (grantType === "refresh_token") {
        const refreshToken = formField(request.body, "refresh_token");
        const clientId = formField(request.body, "client_id");
        const resource = formField(request.body, "resource");
        if (refreshToken === undefined || clientId === undefined) {
          return sendOauthError(reply, 400, "invalid_request", "missing required parameter");
        }
        if (resource !== undefined && !isCanonicalResource(resource, issuer)) {
          return sendOauthError(reply, 400, "invalid_target", `resource must be ${canonicalResource(issuer)}`);
        }
        // 前綴不合（含把 access token 當 refresh 送）：不進 DB。
        if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
          return sendOauthError(reply, 400, "invalid_grant", "refresh token is invalid");
        }

        const [existing] = await deps.db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.refreshTokenHash, hashToken(refreshToken)));
        // client_id 在 JS 端比對（不進 SQL 述詞）。
        if (existing === undefined || existing.clientId !== clientId) {
          return sendOauthError(reply, 400, "invalid_grant", "refresh token is invalid");
        }
        const gateResult = await deps.gate.checkUser(existing.userId);
        if (gateResult.status !== "ok") {
          return sendOauthError(reply, 400, "invalid_grant", "refresh token is invalid");
        }

        // I4：輪替。0 列＝這一支已被另一發輪替掉。
        const accessToken = generateAccessToken();
        const nextRefresh = generateRefreshToken();
        const rotated = await deps.db
          .update(apiTokens)
          .set({
            accessTokenHash: hashToken(accessToken),
            refreshTokenHash: hashToken(nextRefresh),
            accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS),
          })
          .where(eq(apiTokens.refreshTokenHash, hashToken(refreshToken)))
          .returning();
        if (rotated.length === 0) {
          return sendOauthError(reply, 400, "invalid_grant", "refresh token is invalid");
        }
        await deps.db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.clientId, existing.clientId));
        void runOauthCleanup(deps.db).catch((err: unknown) => {
          request.log.warn({ err }, "oauth cleanup after refresh failed");
        });

        return reply.send({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: Math.floor(ACCESS_TTL_MS / 1000),
          refresh_token: nextRefresh,
          scope: rotated[0]!.scope,
        });
      }

      return sendOauthError(reply, 400, "unsupported_grant_type", "unsupported grant_type");
    });
  };
}
