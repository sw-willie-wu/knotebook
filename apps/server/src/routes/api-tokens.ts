import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { normalizeScope, type ApiTokenDto, type CreatedApiTokenDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { apiTokens } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { generateAccessToken, hashToken } from "../auth/api-token.js";
import { UUID_RE } from "../notes/service.js";
import { runOauthCleanup } from "../oauth/cleanup.js";
import { countBillableGrants, TOKEN_LIMIT_PER_USER } from "../auth/grant-quota.js";

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  /** UI 的兩檔；落庫前一律過 `normalizeScope` 轉成集合形。 */
  scope: z.enum(["notes:read", "notes:write"]),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
});

function toDto(row: typeof apiTokens.$inferSelect): ApiTokenDto {
  return {
    id: row.id,
    // kind 只 cast（CHECK 只有兩值，沒有正規化的需求）；scope 走 normalizeScope 讓
    // CHECK 漂移時退化成唯讀（fail-closed）——代價是未來若加第三個 scope，這裡會
    // 靜默少報落庫值，屆時要一起改。
    kind: row.kind as ApiTokenDto["kind"],
    name: row.name,
    scope: normalizeScope(row.scope),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.accessExpiresAt?.toISOString() ?? null,
    clientId: row.clientId,
  };
}

export interface ApiTokensRouteDeps {
  db: Db;
  limiters: { patCreate: FixedWindowLimiter };
}

/**
 * PAT 管理端點。**一律 cookie session 專用**（`app.authenticate`，不是
 * `authenticateAny`）——token 不能拿來簽發或撤銷 token，否則一支外洩的 token 就能
 * 自我延續，D2「最壞情況只是筆記被讀寫」的邊界就破了。
 *
 * 列表**同時列出 OAuth grant**（#132 之後才會有）：使用者只有這一個地方能看到與
 * 撤銷所有憑證，兩種來源共用同一份 UI。
 */
export function apiTokensRoutes(deps: ApiTokensRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/auth/tokens", { preHandler: app.authenticate }, async request => {
      const rows = await deps.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.userId, request.user!.id))
        .orderBy(desc(apiTokens.createdAt));
      return { tokens: rows.map(toDto) };
    });

    app.post("/api/auth/tokens", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      // 強制改密碼的使用者不得簽發憑證。**擋在限流之前**——被擋下的請求不該吃掉
      // 使用者自己的額度（比照 #132 decision 端點「mustChangePassword 在消費之前」）。
      if (request.user!.mustChangePassword) {
        return sendError(reply, 403, "forbidden", "請先修改密碼");
      }
      const userId = request.user!.id;
      if (!deps.limiters.patCreate.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "建立次數過多，請稍後再試");
      }

      // I5：建 PAT 是五個清理時機之一（五條 DELETE 的說明見 oauth/cleanup.ts）。
      await runOauthCleanup(deps.db);
      if ((await countBillableGrants(deps.db, userId)) >= TOKEN_LIMIT_PER_USER) {
        return sendError(reply, 409, "token_limit", `有效 token 已達 ${TOKEN_LIMIT_PER_USER} 個上限，請先撤銷一個`);
      }

      const plaintext = generateAccessToken();
      const expiresAt =
        parsed.data.expiresInDays === null ? null : new Date(Date.now() + parsed.data.expiresInDays * 86_400_000);
      const [row] = await deps.db
        .insert(apiTokens)
        .values({
          userId,
          kind: "pat",
          name: parsed.data.name,
          scope: normalizeScope(parsed.data.scope),
          accessTokenHash: hashToken(plaintext),
          accessExpiresAt: expiresAt,
        })
        .returning();

      // I2：明文只在這個回應出現一次，之後任何地方都拿不回來。
      const body: CreatedApiTokenDto = { ...toDto(row), token: plaintext };
      return reply.code(201).send(body);
    });

    app.delete("/api/auth/tokens/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      // 非 uuid 直接 404——丟給 pg 會是 22P02，經全域 error handler 冒成 500。
      if (!UUID_RE.test(id)) return sendError(reply, 404, "token_not_found", "找不到此 token");
      // D9：撤銷＝硬刪列。`AND user_id=$me` 讓「別人的 token」與「不存在」同形 404。
      const deleted = await deps.db
        .delete(apiTokens)
        .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, request.user!.id)))
        .returning({ id: apiTokens.id });
      if (deleted.length === 0) return sendError(reply, 404, "token_not_found", "找不到此 token");
      return reply.code(204).send();
    });
  };
}
