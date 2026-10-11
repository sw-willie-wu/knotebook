/**
 * 儲存用量檢視（spec 2026-10-08 §7.3；#247 §9.1、§9.2）：使用者看自己的個人空間；**群組的任何成員**（不論旗標，含非成員的站台 admin）
 * 看群組空間——#247 起放寬（原本只限 manageGroup）。單句讀、不開交易。群組授權與 routes/groups.ts 一致：`groupAccess` 回 null →
 * 404 not_found（GROUP_NOT_FOUND_MESSAGE；非成員／不存在／id 不合法三者逐位元組同形，S4）；本檔沒有 403 分支。
 * 錯誤詳情裡要不要附用量數字另由 `storage/usage.ts` 的 `canViewSpaceUsage` 決定（manageGroup），與這支 GET 無關。
 */
import type { FastifyInstance } from "fastify";
import type { GroupStorageUsageDto, StorageUsageDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { GROUP_NOT_FOUND_MESSAGE, groupAccess } from "../groups/queries.js";
import { sendError } from "../http/errors.js";
import type { StorageSpace } from "../storage/space.js";
import { readGroupUsageByMember, readSpaceUsage, readSpaceUsageByKind } from "../storage/usage.js";

export function storageRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/storage", { preHandler: app.authenticate }, async (request, reply) => {
      const space: StorageSpace = { kind: "user", id: request.user!.id };
      const usage = await readSpaceUsage(deps.db, space);
      if (!usage) return sendError(reply, 404, "not_found", "找不到此使用者");
      const byKind = await readSpaceUsageByKind(deps.db, space);
      const dto: StorageUsageDto = { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, planName: usage.planName, byKind };
      return dto;
    });

    app.get("/api/groups/:id/storage", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      const space: StorageSpace = { kind: "group", id: id.toLowerCase() };
      const usage = await readSpaceUsage(deps.db, space);
      if (!usage) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      const [byKind, byMember] = await Promise.all([readSpaceUsageByKind(deps.db, space), readGroupUsageByMember(deps.db, space.id)]);
      const dto: GroupStorageUsageDto = { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, planName: usage.planName, byKind, byMember };
      return dto;
    });
  };
}
