/** 版本歷史 §6.7：站台清除天數與自動儲存總開關（`requireAdmin`）。PATCH 走 `updateVersionSettingsInTx`（S14：callback 整段是 xInTx）。 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { VersionSettingsDto } from "@knotebook/shared";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import { SITE_SETTINGS_MISSING_MESSAGE, updateVersionSettingsInTx } from "../auth/tx/admin-site-settings.js";
import type { Db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";

const settingsPatchSchema = z
  .object({ keepAllDays: z.number().int().optional(), dailyUntilDays: z.number().int().optional(), autoVersionsEnabled: z.boolean().optional() })
  .strict()
  .refine(b => Object.keys(b).length > 0, "請求格式錯誤：至少需要一個欄位");

export function adminVersionsRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/versions/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
      const [row] = await deps.db
        .select({ keepAllDays: siteSettings.versionKeepAllDays, dailyUntilDays: siteSettings.versionDailyUntilDays, autoVersionsEnabled: siteSettings.autoVersionsEnabled })
        .from(siteSettings)
        .where(eq(siteSettings.singleton, true))
        .limit(1);
      if (!row) {
        request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
        return sendError(reply, 500, "internal", "伺服器內部錯誤");
      }
      return reply.send(row satisfies VersionSettingsDto);
    });

    app.patch("/api/admin/versions/settings", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = settingsPatchSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const input = parsed.data;
      let result: VersionSettingsDto;
      try {
        result = await deps.db.transaction(tx => updateVersionSettingsInTx(tx, input));
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
