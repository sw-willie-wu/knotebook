/**
 * 儲存用量檢視（spec 2026-10-08 §7.3）：使用者看自己的個人空間；群組管理者（manageGroup，含站台 admin）看群組空間。
 * 單句讀、不開交易。群組授權碼與 routes/groups.ts 一致：null → 404 not_found（GROUP_NOT_FOUND_MESSAGE，S4 逐位元組同形）、
 * 無 manageGroup → 403 forbidden。
 */
import type { FastifyInstance } from "fastify";
import type { StorageUsageDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { GROUP_NOT_FOUND_MESSAGE, groupAccess } from "../groups/queries.js";
import { sendError } from "../http/errors.js";
import { readSpaceUsage } from "../storage/usage.js";

export function storageRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/storage", { preHandler: app.authenticate }, async (request, reply) => {
      const usage = await readSpaceUsage(deps.db, { kind: "user", id: request.user!.id });
      if (!usage) return sendError(reply, 404, "not_found", "找不到此使用者");
      const dto: StorageUsageDto = { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, planName: usage.planName };
      return dto;
    });

    app.get("/api/groups/:id/storage", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      if (!access.manageGroup) return sendError(reply, 403, "forbidden", "你在這個群組的角色不能進行此操作");
      const usage = await readSpaceUsage(deps.db, { kind: "group", id: id.toLowerCase() });
      if (!usage) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      const dto: StorageUsageDto = { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, planName: usage.planName };
      return dto;
    });
  };
}
