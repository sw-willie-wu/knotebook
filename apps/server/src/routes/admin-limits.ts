/** #397：站台限制（`requireAdmin`）。範圍／刻度／env 鎖的驗證在 `SiteLimits.update`，這裡只做形狀驗證與錯誤對應。 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { SITE_LIMIT_KEYS, type SiteLimitChangeDto, type SiteLimitsDto, type SiteLimitsPatchBody } from "@knotebook/shared";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import type { Db } from "../db/index.js";
import { siteLimitChanges, users } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import { LimitLockedError, LimitRangeError, LimitStepError } from "../site-limits/errors.js";
import type { SiteLimits } from "../site-limits/store.js";

const CHANGES_LIMIT = 50;

// refine 一定要給訊息：zod 預設的 "Invalid input" 會漏進 400 的 message（回應訊息要是 "Invalid request body."）。
const patchSchema = z
  .object({
    set: z
      .object(Object.fromEntries(SITE_LIMIT_KEYS.map(k => [k, z.number().int().nullable()])))
      .partial()
      .strict()
      .refine(o => Object.keys(o).length > 0, "Invalid request body."),
  })
  .strict();

export function adminLimitsRoutes(deps: { db: Db; siteLimits: SiteLimits }) {
  async function body(): Promise<SiteLimitsDto> {
    const rows = await deps.db
      .select({
        id: siteLimitChanges.id,
        key: siteLimitChanges.key,
        oldValue: siteLimitChanges.oldValue,
        newValue: siteLimitChanges.newValue,
        oldEffective: siteLimitChanges.oldEffective,
        newEffective: siteLimitChanges.newEffective,
        changedAt: siteLimitChanges.changedAt,
        actorId: users.id,
        actorEmail: users.email,
        actorDisplayName: users.displayName,
      })
      .from(siteLimitChanges)
      .leftJoin(users, eq(users.id, siteLimitChanges.actorUserId))
      .orderBy(desc(siteLimitChanges.changedAt), desc(siteLimitChanges.id))
      .limit(CHANGES_LIMIT);
    const changes: SiteLimitChangeDto[] = rows.map(r => ({
      id: r.id,
      key: r.key,
      oldValue: r.oldValue,
      newValue: r.newValue,
      oldEffective: r.oldEffective,
      newEffective: r.newEffective,
      actor: r.actorId === null ? null : { id: r.actorId, email: r.actorEmail!, displayName: r.actorDisplayName },
      changedAt: r.changedAt.toISOString(),
    }));
    return { ...deps.siteLimits.view(), changes };
  }

  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/limits", { preHandler: app.requireAdmin }, async (_request, reply) => reply.send(await body()));

    app.patch("/api/admin/limits", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      try {
        await deps.siteLimits.update(request.user!.id, parsed.data.set as SiteLimitsPatchBody["set"]);
      } catch (err) {
        if (err instanceof LimitLockedError) return sendError(reply, 409, "limit_locked_by_env", err.message);
        if (err instanceof LimitRangeError || err instanceof LimitStepError) return sendError(reply, 400, "invalid_body", err.message);
        throw err;
      }
      return reply.send(await body());
    });
  };
}
