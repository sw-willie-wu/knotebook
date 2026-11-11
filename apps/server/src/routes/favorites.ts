/**
 * #334 最愛 REST：`GET /api/favorites`（清單）、`PUT /api/favorites/:id`（加入）、`DELETE /api/favorites/:id`（移出）。
 *
 * - 三支都是 cookie-only（`app.authenticate`），不收 Bearer token；外部程式沒有最愛的入口。
 * - 清單的可見性只經 `visibleNoteBranches`（見 `favorites/queries.ts`）：只回呼叫者此刻看得見、不在垃圾桶的筆記，
 *   回應與「沒有這筆紀錄」相同。GET 不扣節流桶（同 `GET /api/notes`）。
 * - 紀錄只在使用者移出、或筆記被永久刪除（FK cascade）時刪除；進垃圾桶、撤分享、被移出群組、角色改成不能讀都不刪，
 *   還原或重新拿到讀取權就以原本的加入時間回來。
 * - 每支都是單句 SQL、不開交易（S14 不登記）。
 */
import type { FastifyInstance } from "fastify";
import type { FavoriteDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { listFavorites } from "../favorites/queries.js";

export interface FavoritesRouteDeps {
  db: Db;
}

export function favoritesRoutes(deps: FavoritesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/favorites", { preHandler: app.authenticate }, async (request, reply) => {
      return reply.send((await listFavorites(deps.db, request.user!.id)) satisfies FavoriteDto[]);
    });
  };
}
