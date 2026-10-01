/**
 * #103／#175：群組管理路由。全部 `app.authenticate`（session-only，不收 Bearer；沒有節流——與 shares 現狀相同）。
 *
 * 授權碼（§6.7）：`:id`／`:userId` 先過 `UUID_RE`；不合法、群組不存在、呼叫者不是成員（且不是站台 admin）→
 * 同一條 404 `not_found`（`GROUP_NOT_FOUND_MESSAGE`，逐位元組相同，S4）；是成員但缺那一支要的管理旗標 → 403 `forbidden`。
 * 兩個管理旗標＝角色旗標 **OR 站台 admin（不論是否成員）**（§5.5）。**授權判定先於 body 驗證**。
 * body 的 `roleId`（`PUT`／`PATCH …/members`）非 UUID 或不屬於此群組 → 404 `role_not_found`（「找不到此角色」，不是上面
 * 那條 `not_found`）；它的 UUID 檢查在 403 與 body 形狀驗證**之後**，「不屬於此群組」在交易內判定。
 * 每個交易的本體都在 `groups/tx/*`（S14）：路由只做 `db.transaction(tx => xxxInTx(tx, …))` 與 commit 後的踢線。
 * 角色端點（PR3）：`POST …/roles` 是單句 INSERT；`PATCH`／`DELETE …/roles/:roleId` 的本體是 `groups/tx/roles.ts`（T12、T13）；
 * 三支都要 `manageGroup`，`:roleId` 非 UUID 或不屬於此群組 → 404 `role_not_found`，內建角色受限 → 409 `builtin_role`。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import {
  GROUP_ROLE_FLAGS, isReservedRoleName, normalizeEmail, type BuiltinGroupRole, type GroupMemberDto, type GroupRoleDto, type GroupRoleFlag,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups, users } from "../db/schema.js";
import { isForeignKeyViolation, uniqueViolationConstraint } from "../db/pg-errors.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { UUID_RE } from "../notes/service.js";
import {
  GROUP_NOT_FOUND_MESSAGE, groupAccess, groupWithMyRoleQuery, listMyGroupsQuery, listRolesQuery, roleFlagValues, toGroupDto, toGroupRoleDto,
  validateGroupName, validateRoleName,
} from "../groups/queries.js";
import { createGroupInTx } from "../groups/tx/create-group.js";
import { deleteEmptyGroupInTx } from "../groups/tx/delete-group.js";
import { addMemberInTx, removeMemberInTx, setMemberRoleInTx } from "../groups/tx/members.js";
import { deleteRoleInTx, updateRoleInTx } from "../groups/tx/roles.js";

const nameBodySchema = z.object({ name: z.string() }).strict();
const addMemberBodySchema = z.object({ email: z.string().email(), roleId: z.string().optional() }).strict();
const memberRoleBodySchema = z.object({ roleId: z.string() }).strict();
// 六個可設旗標（鍵取自 shared 的 `GROUP_ROLE_FLAGS`，與 web 角色頁同一份），全必填；沒有 `read`（閱讀恆真）——
// `.strict()` 讓帶 `read` 的 body 回 400，而不是收下後默默忽略。
const roleFlagsSchema = z
  .object(Object.fromEntries(GROUP_ROLE_FLAGS.map(flag => [flag, z.boolean()])) as Record<GroupRoleFlag, z.ZodBoolean>)
  .strict();
const createRoleBodySchema = z.object({ name: z.string(), permissions: roleFlagsSchema }).strict();
// `permissions` 給就是六鍵全給（不收部分更新、不收 `read`）；兩鍵都不給 → 400。
const patchRoleBodySchema = z
  .object({ name: z.string().optional(), permissions: roleFlagsSchema.optional() })
  .strict()
  .refine(b => b.name !== undefined || b.permissions !== undefined, { message: "至少要改名稱或權限其中一項" });

export interface GroupsRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  /** 交錯點測試注入縫（`groups/test-hook.ts`），透傳自 `AppDeps.groupTestHook`。 */
  groupTestHook?: GroupTestHook;
}

function toMemberDto(row: { userId: string; email: string; displayName: string; roleId: string; builtin: string | null }): GroupMemberDto {
  return { userId: row.userId, email: row.email, displayName: row.displayName, roleId: row.roleId, builtin: (row.builtin ?? null) as BuiltinGroupRole | null };
}

export function groupsRoutes(deps: GroupsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const notFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
    const forbidden = (reply: FastifyReply): FastifyReply => sendError(reply, 403, "forbidden", "你在這個群組的角色不能進行此操作");
    const roleNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "role_not_found", "找不到此角色");
    const invalidName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "群組名稱須為 1–80 個字元");
    const replyTxAbort = (reply: FastifyReply, err: unknown): FastifyReply | null =>
      err instanceof TxAbort ? sendError(reply, err.status, err.errCode, err.message) : null;
    const invalidRoleName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "角色名稱須為 1–40 個字元");
    const roleNameTaken = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "role_name_taken", "這個群組已有同名的角色，或該名稱保留給內建角色");

    app.get("/api/groups", { preHandler: app.authenticate }, async request => {
      const rows = await listMyGroupsQuery(deps.db, request.user!.id);
      return rows.map(row => toGroupDto(row, request.user!.isAdmin));
    });

    // S2：建立者在同一個交易裡成為內建管理員；兩個內建角色同交易建（T8）。
    app.post("/api/groups", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = nameBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const name = validateGroupName(parsed.data.name);
      if (name === null) return invalidName(reply);
      const userId = request.user!.id;
      const { group } = await deps.db.transaction(tx => createGroupInTx(tx, { name, userId }));
      const [row] = await groupWithMyRoleQuery(deps.db, group.id, userId);
      return reply.code(201).send(toGroupDto(row!, request.user!.isAdmin));
    });

    app.patch("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = nameBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const name = validateGroupName(parsed.data.name);
      if (name === null) return invalidName(reply);
      const updated = await deps.db.update(groups).set({ name }).where(eq(groups.id, id)).returning({ id: groups.id });
      if (updated.length === 0) return notFound(reply);
      const [row] = await groupWithMyRoleQuery(deps.db, id, request.user!.id);
      if (!row) return notFound(reply);
      // 非成員的站台 admin：`myRole` 為 null、兩個 canManage＊ 為真（§6.1）。
      return toGroupDto(row, request.user!.isAdmin);
    });

    // §6.7／B9：PR1–PR3 只允許刪空群組（T5）。PR4 換成轉移／全刪（§6.8）。刪空群組不踢線（沒有筆記）。
    app.delete("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      try {
        await deps.db.transaction(tx => deleteEmptyGroupInTx(tx, { groupId: id }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        // 防禦縱深：lockGroup 之後的建立／移入會卡在 FK KEY SHARE，理論上撞不到這裡（RF4）——撞到也不回 500。
        if (isForeignKeyViolation(err)) return sendError(reply, 409, "group_not_empty", "群組內還有筆記，無法刪除");
        throw err;
      }
      return reply.code(204).send();
    });

    // §6.7（gate r2 M-7）：PR1 的唯讀版——web 要拿一般成員角色的 id 才能降級。成員即可讀（Q18）；站台 admin 也可以（§5.5）。
    app.get("/api/groups/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      const rows = await listRolesQuery(deps.db, id);
      return rows.map(row => toGroupRoleDto(row)!);
    });

    // #175 PR3（§6.7）：建自訂角色。單句 INSERT（spec §6 末段「非交易」）；不踢線（沒有人掛它，§7）。
    // 順序：groupAccess → 403 → body 形狀 → 名稱 → 保留名 → INSERT（六個旗標任意組合都合法，不驗蘊含——spec 疑點 11）。
    app.post("/api/groups/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = createRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const name = validateRoleName(parsed.data.name);
      if (name === null) return invalidRoleName(reply);
      if (isReservedRoleName(name)) return roleNameTaken(reply);
      let inserted: Array<{ id: string }>;
      try {
        inserted = await deps.db
          .insert(groupRoles)
          .values({ groupId: id, name, ...roleFlagValues(parsed.data.permissions) })
          .returning({ id: groupRoles.id });
      } catch (err) {
        if (uniqueViolationConstraint(err) === "group_roles_name_idx") return roleNameTaken(reply);
        // 授權之後群組被刪（FK KEY SHARE 等到刪除 commit）→ 與不存在同形
        // 注意：這條路目前沒有測試守（刪掉本行的突變存活，review r1 N5）；只有 groupAccess 與 INSERT 之間
        // 剛好有另一請求刪掉群組才會觸發，一般流程碰不到，要測得靠測試縫製造交錯。
        if (isForeignKeyViolation(err)) return notFound(reply);
        throw err;
      }
      return reply.code(201).send({
        id: inserted[0]!.id,
        builtin: null,
        name,
        permissions: { read: true, ...parsed.data.permissions },
        memberCount: 0,
      } satisfies GroupRoleDto);
    });

    // #175 PR3 T12（§6.7、§7）：改角色。`:roleId` 的 UUID 檢查在 403 之後（與成員路由 body 的 roleId 一樣排在 403 之後；但這裡是路徑參數，所以排在 body 驗證之前）。
    // 名稱在交易**之前**正規化好（S14：交易 callback 的引數不得有呼叫）。踢線只在 read／edit 有變、且有人掛時。
    app.patch("/api/groups/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      if (!UUID_RE.test(roleId)) return roleNotFound(reply);
      const parsed = patchRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const permissions = parsed.data.permissions;
      let name: string | undefined;
      if (parsed.data.name !== undefined) {
        const validated = validateRoleName(parsed.data.name);
        if (validated === null) return invalidRoleName(reply);
        if (isReservedRoleName(validated)) return roleNameTaken(reply);
        name = validated;
      }
      let out;
      try {
        out = await deps.db.transaction(tx => updateRoleInTx(tx, { groupId: id, roleId, name, permissions }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        if (uniqueViolationConstraint(err) === "group_roles_name_idx") return roleNameTaken(reply);
        throw err;
      }
      if (out.kick !== null && out.kick.userIds.length > 0) deps.collabHooks.onGroupAccessChanged(out.kick.noteIds, out.kick.userIds);
      return out.role;
    });

    // #175 PR3 T13（§6.7、Q8、§7）：刪自訂角色；持有者改掛內建一般成員，commit 後以（群組所有筆記, 原持有者）重驗。
    app.delete("/api/groups/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      if (!UUID_RE.test(roleId)) return roleNotFound(reply);
      let kick;
      try {
        kick = await deps.db.transaction(tx => deleteRoleInTx(tx, { groupId: id, roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      if (kick.userIds.length > 0) deps.collabHooks.onGroupAccessChanged(kick.noteIds, kick.userIds);
      return reply.code(204).send();
    });

    app.get("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      // 排序：內建管理員在前、再 displayName、再 userId（displayName 可重複，要有決定性的次要鍵）。
      const rows = await deps.db
        .select({ userId: users.id, email: users.email, displayName: users.displayName, roleId: groupMembers.roleId, builtin: groupRoles.builtin })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
        .where(eq(groupMembers.groupId, id))
        .orderBy(sql`case when ${groupRoles.builtin} = 'admin' then 0 else 1 end`, asc(users.displayName), asc(users.id));
      return rows.map(toMemberDto);
    });

    // 只新增（§6.7）：已是成員 → 409，**不動**既有角色。`roleId` 預設內建一般成員。停用帳號一樣可加。§7：加人不踢線。
    app.put("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageMembers) return forbidden(reply);
      const parsed = addMemberBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const roleId = parsed.data.roleId ?? null;
      if (roleId !== null && !UUID_RE.test(roleId)) return roleNotFound(reply);
      // lower() 讀取端比對＋多列命中防護（同 shares 的 PUT）。
      const [target] = await deps.db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(parsed.data.email)}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);
      if (!target) return sendError(reply, 404, "user_not_found", "找不到此使用者");
      let role;
      try {
        role = await deps.db.transaction(tx => addMemberInTx(tx, { groupId: id, targetUserId: target.id, roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      return toMemberDto({ userId: target.id, email: target.email, displayName: target.displayName, roleId: role.roleId, builtin: role.builtin });
    });

    // 換角色（Q9 不防升權；S1）。§7：換角色 → 群組所有筆記 × 那一人重驗（升降皆重驗）；角色沒變不踢。
    app.patch("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (!access.manageMembers) return forbidden(reply);
      const parsed = memberRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      if (!UUID_RE.test(parsed.data.roleId)) return roleNotFound(reply);
      let out;
      try {
        out = await deps.db.transaction(tx =>
          setMemberRoleInTx(tx, { groupId: id, targetUserId: targetId, roleId: parsed.data.roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      if (out.noteIds !== null) deps.collabHooks.onGroupAccessChanged(out.noteIds, [targetId]);
      return toMemberDto({ userId: targetId, ...out.member });
    });

    // 移人／退出（S1）。持管理成員旗標者（含站台 admin）可移任何人；其他人只能移自己。commit 後 §7 踢線。
    app.delete("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (targetId !== request.user!.id && !access.manageMembers) return forbidden(reply);
      let noteIds: string[];
      try {
        noteIds = await deps.db.transaction(tx => removeMemberInTx(tx, { groupId: id, targetUserId: targetId }, deps.groupTestHook));
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
