/**
 * #103 §6.1：群組管理路由。全部 `app.authenticate`（session-only，不收 Bearer；沒有節流——與 shares
 * 現狀相同，spec §12 第 7 條）。
 *
 * 授權碼：`:id`／`:userId` 先過 `UUID_RE`；不合法、群組不存在、呼叫者不是成員（且不是站台 admin）→
 * 同一條 404 `not_found`（`GROUP_NOT_FOUND_MESSAGE`，逐位元組相同，S4）；是成員但端點要 admin →
 * 403 `forbidden`；站台 admin 視同每個群組的 admin（只在 API 層，UI 不支援——spec §12 第 5 條）。
 * **授權判定先於 body 驗證**：非成員不論送什麼 body 都拿到同一條 404。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import type { GroupDto, GroupMemberDto, GroupMemberRole } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groups, users } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import { GROUP_NOT_FOUND_MESSAGE, groupAccess, listMyGroupsQuery, validateGroupName } from "../groups/queries.js";

const nameBodySchema = z.object({ name: z.string() }).strict();

export interface GroupsRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  /** 交錯點測試注入縫（`groups/test-hook.ts`），透傳自 `AppDeps.groupTestHook`。 */
  groupTestHook?: GroupTestHook;
}

function toGroupDto(row: { id: string; name: string; myRole: string; createdAt: Date }): GroupDto {
  return { id: row.id, name: row.name, myRole: row.myRole as GroupMemberRole, createdAt: row.createdAt.toISOString() };
}

function toMemberDto(row: { userId: string; email: string; displayName: string; role: string }): GroupMemberDto {
  return { userId: row.userId, email: row.email, displayName: row.displayName, role: row.role as GroupMemberRole };
}

export function groupsRoutes(deps: GroupsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const notFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
    const invalidName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "群組名稱須為 1–80 個字元");

    app.get("/api/groups", { preHandler: app.authenticate }, async request => {
      const rows = await listMyGroupsQuery(deps.db, request.user!.id);
      return rows.map(toGroupDto);
    });

    // S2：建立者在同一個交易裡成為第一位 admin。
    app.post("/api/groups", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = nameBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const name = validateGroupName(parsed.data.name);
      if (name === null) return invalidName(reply);
      const userId = request.user!.id;
      const created = await deps.db.transaction(async tx => {
        const [g] = await tx.insert(groups).values({ name, createdBy: userId }).returning();
        await tx.insert(groupMembers).values({ groupId: g!.id, userId, role: "admin" });
        return g!;
      });
      return reply.code(201).send(toGroupDto({ ...created, myRole: "admin" }));
    });

    app.patch("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.canAdmin) return sendError(reply, 403, "forbidden", "只有群組管理者可以進行此操作");
      const parsed = nameBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const name = validateGroupName(parsed.data.name);
      if (name === null) return invalidName(reply);
      const [row] = await deps.db.update(groups).set({ name }).where(eq(groups.id, id)).returning();
      if (!row) return notFound(reply);
      // 非成員的站台 admin 在 API 層的身分就是 admin（規格落差第 9 條）。
      return toGroupDto({ ...row, myRole: access.memberRole ?? "admin" });
    });

    app.get("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      // 排序：admin 在前、再 displayName、再 userId（displayName 可重複，要有決定性的次要鍵）。
      const rows = await deps.db
        .select({ userId: users.id, email: users.email, displayName: users.displayName, role: groupMembers.role })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .where(eq(groupMembers.groupId, id))
        .orderBy(sql`case when ${groupMembers.role} = 'admin' then 0 else 1 end`, asc(users.displayName), asc(users.id));
      return rows.map(toMemberDto);
    });
  };
}
