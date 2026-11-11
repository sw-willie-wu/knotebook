/**
 * #334 最愛 REST：`GET /api/favorites`（清單）、`PUT /api/favorites/:id`（加入）、`DELETE /api/favorites/:id`（移出）。
 *
 * - 三支都是 cookie-only（`app.authenticate`），不收 Bearer token；外部程式沒有最愛的入口。
 * - 清單的可見性只經 `visibleNoteBranches`（見 `favorites/queries.ts`）：只回呼叫者此刻看得見、不在垃圾桶的筆記，
 *   回應與「沒有這筆紀錄」相同。GET 不扣節流桶（同 `GET /api/notes`）。
 * - PUT 依序：`:id` 不是 UUID → 404；帶了 body 但不是空物件 `{}` → 400；`resolveNoteAccess` 得 none（不存在、沒權限、
 *   在垃圾桶）→ 404；扣 `favorite` 桶 → 429；寫入（加入時間一律是現在）。404 的幾種來源回應逐位元組相同，不洩漏筆記存在與否。
 *   授權前的 400 與 404 不扣桶；扣桶之後筆記才被永久刪除的那種 404 已經扣過。
 * - DELETE 依序：`:id` 不是 UUID → 404；扣 `favorite` 桶 → 429；刪呼叫者自己那列 → 一律 204。不做存取檢查：只動自己的列、
 *   回應與有沒有這列無關，使用者也移得掉剛失去權限、畫面上還沒消失的那篇。
 * - 紀錄只在使用者移出、或筆記被永久刪除（FK cascade）時刪除；進垃圾桶、撤分享、被移出群組、角色改成不能讀都不刪，
 *   還原或重新拿到讀取權就以原本的加入時間回來。
 * - 每支都是單句 SQL、不開交易，所以本檔不在 `test/unit/s14-structure.test.ts` 的 `ROUTE_FILES` 裡。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { FavoriteDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { addFavorite, listFavorites, removeFavorite } from "../favorites/queries.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";

export interface FavoritesRouteDeps {
  db: Db;
  /** `PUT`／`DELETE` 共用（key=userId，見 `FAVORITE_LIMIT`）。 */
  limiters: { favorite: FixedWindowLimiter };
  /** 交錯點測試注入縫（`favorite-authorized`），透傳自 `AppDeps.groupTestHook`；生產不注入。 */
  groupTestHook?: GroupTestHook;
}

/**
 * PUT 沒有參數：body 可省（網頁的 `api()` 沒有 body 時不送 Content-Type），帶了就必須是 `{}`。
 * 帶任何欄位（或 JSON `null`、陣列）回 400，而不是默默忽略：送了欄位的 client 會知道這版 server 不認得它。
 */
const putBodySchema = z.object({}).strict();

export function favoritesRoutes(deps: FavoritesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", "No note with that id.");
    const tooManyRequests = (reply: FastifyReply): FastifyReply =>
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

    app.get("/api/favorites", { preHandler: app.authenticate }, async (request, reply) => {
      return reply.send((await listFavorites(deps.db, request.user!.id)) satisfies FavoriteDto[]);
    });

    app.put("/api/favorites/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      // 只有「沒有 body」才當成 `{}`：JSON `null` 是帶了 body，要 400。
      if (!putBodySchema.safeParse(request.body === undefined ? {} : request.body).success) {
        return sendError(reply, 400, "invalid_body", "Invalid request body.");
      }
      if ((await resolveNoteAccess(deps.db, userId, id)).role === "none") return noteNotFound(reply);
      if (!deps.limiters.favorite.consume(userId)) return tooManyRequests(reply);
      await deps.groupTestHook?.("favorite-authorized", { noteId: id });
      const out = await addFavorite(deps.db, { userId, noteId: id });
      if (out === "gone") return noteNotFound(reply);
      return reply.send(out satisfies FavoriteDto);
    });

    app.delete("/api/favorites/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      if (!deps.limiters.favorite.consume(userId)) return tooManyRequests(reply);
      await removeFavorite(deps.db, { userId, noteId: id });
      return reply.code(204).send();
    });
  };
}
