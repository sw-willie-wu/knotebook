import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { hasScope, normalizeScope, type RequiredScope, type TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens, oauthClients } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { BoundedMap, DEFAULT_MAX_KEYS } from "../lib/bounded-map.js";
import { buildBearerChallenge } from "./challenge.js";
import { hashToken, isAccessTokenShape, parseAuthorizationHeader } from "./api-token.js";
import type { GateUser, UserGate } from "./session.js";

export interface BearerDeps {
  db: Db;
  gate: UserGate;
  /** `publicUrlIssuer(config.publicUrl)`＝origin，無尾斜線（D12）。 */
  issuer: string;
  /** cookie session 的解析（`app.ts` 的區域函式）——無 `Authorization` header 時的回退。 */
  resolveSessionUser: (request: FastifyRequest) => Promise<{ user: GateUser; tv: number } | null>;
  limiters: {
    bearerMiss: FixedWindowLimiter;
    tokenRead: FixedWindowLimiter;
    tokenWrite: FixedWindowLimiter;
  };
}

/** `last_used_at` 的寫入節流：同一支 token 60 秒內只寫一次。 */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * #107：**opt-in** 的 Bearer／session 雙路徑認證（D2）。只有明確掛上這個 preHandler
 * 的路由收 API token，其餘路由維持 `app.authenticate`（cookie-only）——token 外洩的
 * 最壞情況因此是「筆記被讀寫」，不會變成「帳號被接管」。
 *
 * 兩個 scope 參數刻意分開：
 * - `required` 是**授權判定**用的單值（`hasScope(stored, required)`）。
 * - `challenge` 是 401／403 的 `WWW-Authenticate` 上宣告的 scope 集合，預設等於
 *   `required`。MCP client 會把 challenge 的 scope 當作本次操作的權威值、只要這麼多，
 *   所以 `/api/mcp` 必須宣告 `notes:read notes:write`，否則 client 走完 OAuth 只會
 *   拿到唯讀 token。
 *
 * 有 `Authorization` header 就**只走 token 路徑、不回退 cookie**（同時帶兩者時無歧義；
 * 已確認 web 端從不送這個 header）。
 *
 * ⚠ 這裡**不能呼叫 `app.authenticate`** 來做 cookie 回退：`sendError` 內含
 * `reply.send()`，之後補的 `WWW-Authenticate` 會靜默消失（見 `app.ts` 的
 * `resolveSessionUser` 註解）。所以回退走的是不送回應的 `resolveSessionUser`。
 */
export function createAuthenticateAny(deps: BearerDeps) {
  // per-app 實例（比照 UserGate 的 BoundedMap）：模組層 singleton 會讓不同測試檔共用
  // 同一份節流狀態，`last_used_at` 的守衛測試會隨執行順序紅綠。
  // 被擠掉的後果只是該 token 下一發多跑一次 UPDATE，沒有錯誤路徑。
  const lastUsedTouchedAt = new BoundedMap<number>(DEFAULT_MAX_KEYS);

  function touchLastUsed(request: FastifyRequest, row: { id: string; clientId: string | null }): void {
    const now = Date.now();
    const previous = lastUsedTouchedAt.get(row.id);
    if (previous !== undefined && now - previous < LAST_USED_THROTTLE_MS) return;
    lastUsedTouchedAt.set(row.id, now);
    const stamp = new Date(now);
    // fire-and-forget：`last_used_at` 只是設定頁顯示與 #132 的 I5 清理依據，寫失敗
    // 不該讓請求本身失敗。
    void (async () => {
      await deps.db.update(apiTokens).set({ lastUsedAt: stamp }).where(eq(apiTokens.id, row.id));
      if (row.clientId !== null) {
        // oauth grant 連帶更新 client 的 last_used_at——#132 的 I5 ① 用它判斷
        // 「30 天未使用」，兩個時間戳的語意必須一致，否則天天在用的 client 會被清掉。
        await deps.db.update(oauthClients).set({ lastUsedAt: stamp }).where(eq(oauthClients.clientId, row.clientId));
      }
    })().catch((err: unknown) => {
      request.log.warn({ err, tokenId: row.id }, "failed to update api token last_used_at");
    });
  }

  /**
   * 送出 401／429。**header 必須在 `sendError` 之前設**——`sendError` 內含
   * `reply.send()`，之後補 header 會靜默消失（fastify 5 實測）。
   *
   * ⚠ 這條順序**目前用突變測試測不出來**：`app.ts` 的全域 onSend hook（nosniff 那
   * 支）是 async，它的 microtask 邊界讓「send 之後才設的 header」碰巧趕上。把那支
   * hook 改成同步的 `(req, reply, payload, done)` 形，順序寫反就會真的掉 header
   * （實測 4 案紅）。所以別因為「試過交換也沒事」就把順序改掉。
   */
  function rejectBearer(request: FastifyRequest, reply: FastifyReply, challenge: string, invalidToken: boolean): void {
    if (!deps.limiters.bearerMiss.consume(request.ip)) {
      // 429 不帶 challenge：RFC 6750 的 challenge 只定義在 400／401／403，掛在 429 上
      // 可能讓 client 在被限流時去重跑一輪授權，反而再吃 #132 的 DCR／authorize 桶。
      sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      return;
    }
    reply.header(
      "www-authenticate",
      buildBearerChallenge({ issuer: deps.issuer, scope: challenge, error: invalidToken ? "invalid_token" : undefined })
    );
    sendError(reply, 401, "unauthorized", invalidToken ? "token 無效或已過期" : "未登入");
  }

  return function authenticateAny(required: RequiredScope, challenge: string = required) {
    return async function preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const rawHeader = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
      const parsed = parseAuthorizationHeader(rawHeader);

      if (parsed.kind === "none") {
        const resolved = await deps.resolveSessionUser(request);
        if (resolved === null) {
          // 沒帶任何憑證也要帶 challenge——這條路由收 Bearer，而 MCP client 的第一發
          // 請求依定義沒有 Authorization header，challenge 是它發現授權伺服器的入口。
          // RFC 6750 §3：沒帶憑證時 SHOULD NOT 含 error code。
          reply.header("www-authenticate", buildBearerChallenge({ issuer: deps.issuer, scope: challenge }));
          sendError(reply, 401, "unauthorized", "未登入");
          return;
        }
        request.user = resolved.user;
        request.sessionTv = resolved.tv;
        request.authKind = "session";
        return; // session 是完整身分：不檢查 scope、不吃 token 桶
      }

      // RFC 6750 §3：unsupported authentication method（例如 Basic）→ 不帶 error。
      if (parsed.kind === "other-scheme") return rejectBearer(request, reply, challenge, false);

      // 前綴不合就不查 DB（refresh token 當 Bearer 送也落在這裡）。
      if (!isAccessTokenShape(parsed.token)) return rejectBearer(request, reply, challenge, true);

      const [row] = await deps.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.accessTokenHash, hashToken(parsed.token)))
        .limit(1);
      if (row === undefined) return rejectBearer(request, reply, challenge, true);

      // ⚠ 認證述詞**不含 kind**，且是「非 NULL 且已過期才拒」：D4 的預設 PAT 是 NULL
      // ＝不到期，寫成 `access_expires_at > now()` 會讓每支預設 PAT 全滅；而 I1 額度
      // 那條述詞的 `kind='oauth' OR` 是配額用的（refresh 不到期），帶進這裡會讓過期的
      // oauth access token 永遠有效。
      if (row.accessExpiresAt !== null && row.accessExpiresAt.getTime() <= Date.now()) {
        return rejectBearer(request, reply, challenge, true);
      }

      const gateResult = await deps.gate.checkUser(row.userId);
      if (gateResult.status !== "ok") return rejectBearer(request, reply, challenge, true);
      // 強制改密碼的使用者不得經 token 繞過（`UserGate.evaluate` 不看這個旗標）。
      if (gateResult.user.mustChangePassword) return rejectBearer(request, reply, challenge, true);

      if (!hasScope(row.scope as TokenScope, required)) {
        // 403 **不** consume BEARER_MISS：那是合法 token，反覆重試不得連累同 IP。
        reply.header(
          "www-authenticate",
          buildBearerChallenge({ issuer: deps.issuer, scope: challenge, error: "insufficient_scope" })
        );
        sendError(reply, 403, "insufficient_scope", "此 token 沒有執行這個操作的權限");
        return;
      }

      // 限流扣點在 scope 檢查**通過之後**——403 不啃桶。
      const bucket = required === "notes:write" ? deps.limiters.tokenWrite : deps.limiters.tokenRead;
      if (!bucket.consume(`token:${row.userId}`)) {
        sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
        return;
      }

      request.user = gateResult.user;
      request.authKind = "token";
      // 這裡用 normalizeScope 而非 cast：CHECK 漂移時退化成唯讀（fail-closed）。上面
      // `hasScope` 那處的 cast 則是刻意的——它以成員判定承接 text 欄位的斷言。
      request.tokenScope = normalizeScope(row.scope);
      request.tokenId = row.id;
      touchLastUsed(request, { id: row.id, clientId: row.clientId });
    };
  };
}
