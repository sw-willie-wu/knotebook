import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { OauthRequestDto, TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import { hashToken } from "../auth/api-token.js";
import { countBillableGrants, TOKEN_LIMIT_PER_USER } from "../auth/grant-quota.js";
import { matchesLoopbackRedirect } from "../oauth/redirect.js";
import { runOauthCleanup } from "../oauth/cleanup.js";

const CODE_TTL_MS = 10 * 60_000;

/**
 * 不變量 S：`req` 進 SQL 述詞前先過正規式。id 就是 `randomBytes(16).toString("base64url")`
 * ＝22 字元；不匹配的一律當「已使用或已過期」同形回，不成 oracle。
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const decisionBodySchema = z.object({
  req: z.string(),
  decision: z.enum(["allow", "deny"]),
});

/** 同意頁把 scope 字串拆成單值，逐條列人話。 */
function splitScopes(scope: TokenScope): string[] {
  return scope.split(" ");
}

/** deny／allow 共用的導回組字——一律 URL API（`state` 由 client 控制）。 */
function buildRedirect(redirectUri: string, issuer: string, params: Record<string, string>, state: string | null): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export interface OauthApiRouteDeps {
  db: Db;
  config: AppConfig;
}

/**
 * 同意頁的站內端點（§5.3.1／§5.3.2）。**掛頂層 app、走站內錯誤形**——不得放進
 * `/oauth` 那個 RFC 形 plugin：這兩支的消費者是我們自己的 SPA，錯誤要能餵給 i18n。
 * 兩支都不吃限流桶（上游 `AUTHORIZE_LIMIT` 已支配）。
 */
export function oauthApiRoutes(deps: OauthApiRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const issuer = publicUrlIssuer(deps.config.publicUrl);

    app.get("/api/oauth/request", { preHandler: app.authenticate }, async (request, reply) => {
      const req = (request.query as { req?: unknown }).req;
      if (typeof req !== "string" || !REQUEST_ID_RE.test(req)) {
        return sendError(reply, 410, "oauth_request_invalid", "授權請求已使用或已過期");
      }
      const [row] = await deps.db
        .select({
          redirectUri: oauthRequests.redirectUri,
          scope: oauthRequests.scope,
          clientId: oauthRequests.clientId,
          clientName: oauthClients.clientName,
          redirectUris: oauthClients.redirectUris,
        })
        .from(oauthRequests)
        .innerJoin(oauthClients, eq(oauthRequests.clientId, oauthClients.clientId))
        .where(and(eq(oauthRequests.id, req), sql`${oauthRequests.expiresAt} > now()`));
      if (row === undefined) {
        return sendError(reply, 410, "oauth_request_invalid", "授權請求已使用或已過期");
      }
      // stored 值含 ephemeral port，**不可用字串成員判定**。
      if (!row.redirectUris.some(uri => matchesLoopbackRedirect(uri, row.redirectUri))) {
        return sendError(reply, 404, "not_found", "找不到此授權請求");
      }

      const [existing] = await deps.db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(
          and(eq(apiTokens.userId, request.user!.id), eq(apiTokens.kind, "oauth"), eq(apiTokens.clientId, row.clientId))
        );

      const scope = row.scope as TokenScope;
      const body: OauthRequestDto = {
        clientName: row.clientName,
        redirectHost: new URL(row.redirectUri).host,
        scope,
        scopes: splitScopes(scope),
        replacesExisting: existing !== undefined,
      };
      return body;
    });

    app.post("/api/oauth/decision", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = decisionBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      }
      // 擋在消費之前——被擋下的請求不該白吃掉一個 pending request。
      if (request.user!.mustChangePassword) {
        return sendError(reply, 403, "forbidden", "請先修改密碼");
      }
      if (!REQUEST_ID_RE.test(parsed.data.req)) {
        return sendError(reply, 410, "oauth_request_invalid", "這個授權請求已使用或已過期");
      }

      // ⚠ I5 要早於下面的消費與 client 查表（誤序只在跨 24h 邊界時可觀察，無自動化守衛）。
      await runOauthCleanup(deps.db);

      // I6：allow 與 deny 都消費，連點兩下只會建一個 code。`expires_at > now()` 那半段
      // 在這裡被上面 I5 ③ 遮蔽（過期列已先被清），是縱深防禦、沒有自動化守衛。
      const [pending] = await deps.db
        .delete(oauthRequests)
        .where(and(eq(oauthRequests.id, parsed.data.req), sql`${oauthRequests.expiresAt} > now()`))
        .returning();
      if (pending === undefined) {
        return sendError(reply, 410, "oauth_request_invalid", "這個授權請求已使用或已過期");
      }

      const [client] = await deps.db.select().from(oauthClients).where(eq(oauthClients.clientId, pending.clientId));
      if (client === undefined || !client.redirectUris.some(uri => matchesLoopbackRedirect(uri, pending.redirectUri))) {
        return sendError(reply, 404, "not_found", "找不到此授權請求");
      }

      if (parsed.data.decision === "deny") {
        return { redirectTo: buildRedirect(pending.redirectUri, issuer, { error: "access_denied" }, pending.state) };
      }

      const userId = request.user!.id;
      if ((await countBillableGrants(deps.db, userId, pending.clientId)) >= TOKEN_LIMIT_PER_USER) {
        return sendError(reply, 409, "token_limit", `有效 token 已達 ${TOKEN_LIMIT_PER_USER} 個上限，請先撤銷一個`);
      }

      const code = randomBytes(32).toString("base64url");
      await deps.db.insert(oauthCodes).values({
        codeHash: hashToken(code),
        clientId: pending.clientId,
        userId,
        scope: pending.scope,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      // 建 code 是 I5 ① 的「使用」之一。
      await deps.db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.clientId, pending.clientId));

      return { redirectTo: buildRedirect(pending.redirectUri, issuer, { code }, pending.state) };
    });
  };
}
