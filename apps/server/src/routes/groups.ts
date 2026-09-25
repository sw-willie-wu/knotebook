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
import { and, asc, eq, sql } from "drizzle-orm";
import { normalizeEmail, type GroupDto, type GroupMemberDto, type GroupMemberRole } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groups, users } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { UUID_RE } from "../notes/service.js";
import {
  GROUP_NOT_FOUND_MESSAGE, countAdmins, groupAccess, groupNoteIdsQuery, listMyGroupsQuery, lockGroup,
  materializeAndDeleteGroup, validateGroupName,
} from "../groups/queries.js";

const nameBodySchema = z.object({ name: z.string() }).strict();
const addMemberBodySchema = z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).optional() }).strict();
const memberRoleBodySchema = z.object({ role: z.enum(["admin", "member"]) }).strict();

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

    // §6.3：物化成逐人分享再刪（D8）；公開連結保留；不踢線。
    app.delete("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.canAdmin) return sendError(reply, 403, "forbidden", "只有群組管理者可以進行此操作");
      try {
        await materializeAndDeleteGroup(deps.db, id, deps.groupTestHook);
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      return reply.code(204).send();
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

    const lastAdmin = (): TxAbort => new TxAbort(409, "last_admin", "群組至少要有一位管理者");
    const txNotFound = (): TxAbort => new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
    const replyTxAbort = (reply: FastifyReply, err: unknown): FastifyReply | null =>
      err instanceof TxAbort ? sendError(reply, err.status, err.errCode, err.message) : null;

    // 只新增（spec §6.1）：已是成員 → 409，**不動**既有的 role。停用帳號一樣可加。§7：加人不踢線。
    app.put("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.canAdmin) return sendError(reply, 403, "forbidden", "只有群組管理者可以進行此操作");
      const parsed = addMemberBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      // lower() 讀取端比對＋多列命中防護（同 shares 的 PUT）。
      const [target] = await deps.db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(parsed.data.email)}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);
      if (!target) return sendError(reply, 404, "user_not_found", "找不到此使用者");
      const role = parsed.data.role ?? "member";
      try {
        await deps.db.transaction(async tx => {
          if (!(await lockGroup(tx, id))) throw txNotFound();
          await deps.groupTestHook?.("group-members-checked", { groupId: id });
          const inserted = await tx
            .insert(groupMembers)
            .values({ groupId: id, userId: target.id, role })
            .onConflictDoNothing()
            .returning({ userId: groupMembers.userId });
          if (inserted.length === 0) throw new TxAbort(409, "already_member", "此人已經是群組成員");
        });
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      return toMemberDto({ userId: target.id, email: target.email, displayName: target.displayName, role });
    });

    // 升降級（S1）。§7：成員升降級不踢線（`group_members.role` 不參與筆記權限）。
    app.patch("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (!access.canAdmin) return sendError(reply, 403, "forbidden", "只有群組管理者可以進行此操作");
      const parsed = memberRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const nextRole = parsed.data.role;
      let member: GroupMemberDto;
      try {
        member = await deps.db.transaction(async tx => {
          if (!(await lockGroup(tx, id))) throw txNotFound();
          const [row] = await tx
            .select({ role: groupMembers.role, email: users.email, displayName: users.displayName })
            .from(groupMembers)
            .innerJoin(users, eq(users.id, groupMembers.userId))
            .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, targetId)));
          if (!row) throw txNotFound();
          if (row.role === "admin" && nextRole === "member" && (await countAdmins(tx, id)) <= 1) throw lastAdmin();
          await deps.groupTestHook?.("group-members-checked", { groupId: id });
          await tx.update(groupMembers).set({ role: nextRole }).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, targetId)));
          return toMemberDto({ userId: targetId, email: row.email, displayName: row.displayName, role: nextRole });
        });
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      return member;
    });

    // 移人／退出（S1）。admin（含站台 admin）可移任何人；一般成員只能移自己。commit 後 §7 踢線：
    // （群組所有筆記 × 那一人）——重驗由 `resolveRole` 決定，owner（A1）或另有來源的人續留。
    app.delete("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (targetId !== request.user!.id && !access.canAdmin) return sendError(reply, 403, "forbidden", "只有群組管理者可以移除其他成員");
      let noteIds: string[];
      try {
        noteIds = await deps.db.transaction(async tx => {
          if (!(await lockGroup(tx, id))) throw txNotFound();
          const [row] = await tx
            .select({ role: groupMembers.role })
            .from(groupMembers)
            .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, targetId)));
          if (!row) throw txNotFound();
          if (row.role === "admin" && (await countAdmins(tx, id)) <= 1) throw lastAdmin();
          await deps.groupTestHook?.("group-members-checked", { groupId: id });
          await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, targetId)));
          return (await groupNoteIdsQuery(tx, id)).map(r => r.id);
        });
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      deps.collabHooks.onGroupAccessChanged(noteIds, [targetId]);
      return reply.code(204).send();
    });
  };
}
