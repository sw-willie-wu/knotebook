/**
 * #181 垃圾桶 REST（spec 2026-10-21 §6.3.3–§6.3.5、§6.7）：`GET /api/trash`、`POST /api/trash/restore`、`POST /api/trash/purge`。
 * 全部 cookie-only（`app.authenticate`，與 `DELETE /api/notes/:id` 一致；外部程式走 MCP）。
 *
 * - AG2：沒有垃圾桶權與不存在逐欄相同（`skipped: [{ id, reason: "not_found" }]`）——預判在 `trash/service.ts`，這裡不直呼交易本體。
 * - 清空＝client 把目前清單上的全部 id 送 purge（§6.3.4-5），沒有「清空」端點：清單載入後才進垃圾桶的筆記不會被一起清掉。
 * - 本檔沒有交易（S14 不登記）；交易都在 `trash/service.ts`。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TRASH_BATCH_MAX, type NoteDto, type TrashPurgeResultDto, type TrashRestoreResultDto } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";
import { isRetryableTxError } from "../db/pg-errors.js";
import { sendError } from "../http/errors.js";
import { loadNoteFields, toNoteDto } from "../notes/note-dto.js";
import { UUID_RE, resolveNoteAccess } from "../notes/service.js";
import { listTrash, readTrashRetentionDays } from "../trash/list.js";
import { purgeTrashed, restoreTrashed, type TrashBatchResult, type TrashServiceDeps } from "../trash/service.js";

/** 上限算**原始個數**（去重之前；gate r1 M6）。 */
const idsBodySchema = z.object({ ids: z.array(z.string()).min(1).max(TRASH_BATCH_MAX) }).strict();
const IDS_INVALID_MESSAGE = `Invalid request body: ids must be 1 to ${TRASH_BATCH_MAX} note ids.`;
/** 還原／永久刪除的交易被併發犧牲（40001／40P01／55P03，整個交易回滾、什麼都沒做）→ 409 server_busy，比照刪群組等路由。 */
const SERVER_BUSY_MESSAGE = "The server is busy. Try again in a moment.";

/** 驗證後轉小寫、去重（保留首見順序）；任一不合（含 zod 失敗、非 UUID）→ null。 */
function parseIds(body: unknown): string[] | null {
  const parsed = idsBodySchema.safeParse(body);
  if (!parsed.success || !parsed.data.ids.every(id => UUID_RE.test(id))) return null;
  return [...new Set(parsed.data.ids.map(id => id.toLowerCase()))];
}

export function trashRoutes(deps: TrashServiceDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/trash", { preHandler: app.authenticate }, async (request, reply) => {
      const row = await readTrashRetentionDays(deps.db);
      if (!row) {
        request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
        return sendError(reply, 500, "internal", "Internal server error.");
      }
      return reply.send(await listTrash(deps.db, request.user!.id, row.retentionDays));
    });

    app.post("/api/trash/restore", { preHandler: app.authenticate }, async (request, reply) => {
      const ids = parseIds(request.body);
      if (ids === null) return sendError(reply, 400, "invalid_body", IDS_INVALID_MESSAGE);
      const userId = request.user!.id;
      let result: TrashBatchResult;
      try {
        result = await restoreTrashed(deps, { ids, by: userId });
      } catch (err) {
        if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", SERVER_BUSY_MESSAGE);
        throw err;
      }
      const restored: NoteDto[] = [];
      for (const id of result.done) {
        // 極窄競態：還原 commit 之後、這裡重讀之前又被移入／降權／永久刪除 → 取不到或 none。它確實被還原過，所以不列 skipped；
        // 也不列 restored（呼叫者此刻看不到它）。
        const fields = await loadNoteFields(deps.db, id, userId);
        const access = await resolveNoteAccess(deps.db, userId, id);
        if (fields === undefined || access.role === "none") continue;
        restored.push(toNoteDto(fields, access));
      }
      return reply.send({ restored, skipped: result.skipped } satisfies TrashRestoreResultDto);
    });

    app.post("/api/trash/purge", { preHandler: app.authenticate }, async (request, reply) => {
      const ids = parseIds(request.body);
      if (ids === null) return sendError(reply, 400, "invalid_body", IDS_INVALID_MESSAGE);
      let result: TrashBatchResult;
      try {
        result = await purgeTrashed(deps, { ids, by: request.user!.id }, request.log);
      } catch (err) {
        if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", SERVER_BUSY_MESSAGE);
        throw err;
      }
      return reply.send({ purged: result.done, skipped: result.skipped } satisfies TrashPurgeResultDto);
    });
  };
}
