import { randomBytes } from "node:crypto";
import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { normalizeScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import { oauthClients, oauthRequests } from "../db/schema.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { sendOauthError } from "../http/oauth-errors.js";
import { isLoopbackRedirectUri, matchesLoopbackRedirect } from "../oauth/redirect.js";
import { canonicalResource, isCanonicalResource } from "../oauth/resource.js";
import { hasUnstorableChar } from "../oauth/storable.js";
import { runOauthCleanup } from "../oauth/cleanup.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { DEFAULT_CLIENT_NAME, hasUnsafeClientNameChar } from "../oauth/client-name.js";

export interface OauthRouteDeps {
  db: Db;
  config: AppConfig;
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
  };
}
