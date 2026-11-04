/** #181 §6.9：垃圾桶保留天數（`requireAdmin`）。PATCH 走 `updateTrashSettingsInTx`（S14：callback 整段是 xInTx）。 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { TrashSettingsDto } from "@knotebook/shared";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import { SITE_SETTINGS_MISSING_MESSAGE, TRASH_RETENTION_RANGE_MESSAGE, updateTrashSettingsInTx } from "../auth/tx/admin-site-settings.js";
import type { Db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";

// 鍵必填（缺鍵、多餘鍵都 400）；null＝不自動永久刪除。
const settingsPatchSchema = z
  .object({
    retentionDays: z
      .number()
      .int()
      .refine(n => n >= 1 && n <= 3650, TRASH_RETENTION_RANGE_MESSAGE)
      .nullable(),
  })
  .strict();

export function adminTrashRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/trash/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
      const [row] = await deps.db
        .select({ retentionDays: siteSettings.trashRetentionDays })
        .from(siteSettings)
        .where(eq(siteSettings.singleton, true))
        .limit(1);
      if (!row) {
        request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
        return sendError(reply, 500, "internal", "Internal server error.");
      }
      return reply.send(row satisfies TrashSettingsDto);
    });

    app.patch("/api/admin/trash/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = settingsPatchSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const input = parsed.data;
      let result: TrashSettingsDto;
      try {
        result = await deps.db.transaction(tx => updateTrashSettingsInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) {
          if (err.status === 500) request.log.error({ table: "site_settings" }, err.message);
          return sendError(reply, err.status, err.errCode, err.message);
        }
        throw err;
      }
      return reply.send(result);
    });
  };
}
