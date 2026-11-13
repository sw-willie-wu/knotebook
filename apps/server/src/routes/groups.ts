/**
 * #103／#175：群組管理路由。全部 `app.authenticate`（session-only，不收 Bearer；沒有節流——與 shares 現狀相同）。
 *
 * 授權碼：`:id`／`:userId` 先過 `UUID_RE`；不合法、群組不存在、呼叫者不是成員（且不是站台 admin）→
 * 同一條 404 `not_found`（`GROUP_NOT_FOUND_MESSAGE`，逐位元組相同）；是成員但缺那一支要的管理旗標 → 403 `forbidden`。
 * 兩個管理旗標＝角色旗標 **OR 站台 admin（不論是否成員）**。**授權判定先於 body 驗證**。
 * body 的 `roleId`（`PUT`／`PATCH …/members`）非 UUID 或不屬於此群組 → 404 `role_not_found`（"No role with that id."，不是上面
 * 那條 `not_found`）；它的 UUID 檢查在 403 與 body 形狀驗證**之後**，「不屬於此群組」在交易內判定。
 * 每個交易的本體都在 `groups/tx/*`（S14）：路由只做 `db.transaction(tx => xxxInTx(tx, …))` 與 commit 後的踢線。
 * 角色端點：`POST …/roles` 是單句 INSERT；`PATCH`／`DELETE …/roles/:roleId` 的本體是 `groups/tx/roles.ts`（`updateRoleInTx`、`deleteRoleInTx`）；
 * 三支都要 `manageGroup`，`:roleId` 非 UUID 或不屬於此群組 → 404 `role_not_found`，內建角色受限 → 409 `builtin_role`。
 * 刪群組：body 必填 `{mode}`；全刪的 gate 在交易外、commit 後才刪附件檔與踢線。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import {
  GROUP_ROLE_FLAGS, isReservedRoleName, normalizeEmail, type AvatarRef, type BuiltinGroupRole, type GroupMemberDto, type GroupRoleDto, type GroupRoleFlag,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { readAvatarRefs } from "../avatars/read.js";
import { groupMembers, groupRoles, groups, users } from "../db/schema.js";
import { foreignKeyViolationConstraint, isForeignKeyViolation, isRetryableTxError, notNullViolationColumn, uniqueViolationConstraint } from "../db/pg-errors.js";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { VersionService } from "../collab/versions.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError, sendStorageQuotaExceeded } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { UUID_RE } from "../notes/service.js";
import {
  GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, groupAccess, groupNoteIdsQuery, groupWithMyRoleQuery, listMyGroupsQuery, listRolesQuery, roleFlagValues,
  toGroupDto, toGroupRoleDto, validateGroupName, validateRoleName,
} from "../groups/queries.js";
import { fallbackGroupFolderName } from "../folders/names.js";
import { createGroupInTx } from "../groups/tx/create-group.js";
import { deleteGroupWithNotesInTx, transferGroupInTx } from "../groups/tx/delete-group.js";
import { addMemberInTx, removeMemberInTx, setMemberRoleInTx } from "../groups/tx/members.js";
import { deleteRoleInTx, updateRoleInTx } from "../groups/tx/roles.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { quotaErrorDetail } from "../storage/usage.js";
import { deleteUploadFiles } from "../uploads/service.js";

const nameBodySchema = z.object({ name: z.string() }).strict();
// 版本歷史：PATCH 另開 schema——`name` 可選、加 `autoVersions`、至少一欄；`nameBodySchema` 與 POST 共用、不得動。
const groupPatchBodySchema = z
  .object({ name: z.string().optional(), autoVersions: z.boolean().optional() })
  .strict()
  .refine(b => b.name !== undefined || b.autoVersions !== undefined, { message: "Invalid request body: send at least one field." });
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
  .refine(b => b.name !== undefined || b.permissions !== undefined, { message: "Invalid request body: send at least one of name and permissions." });
// #175：刪群組必填模式（shared `DeleteGroupBody` 的兩支）。`.strict()`：多餘鍵 400，不默默忽略（例如 delete 帶 transferTo）。
const deleteGroupBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("transfer"), transferTo: z.string() }).strict(),
  z.object({ mode: z.literal("delete") }).strict(),
]);

export interface GroupsRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  /** 交錯點測試注入縫（`groups/test-hook.ts`），透傳自 `AppDeps.groupTestHook`。 */
  groupTestHook?: GroupTestHook;
  /** 全刪模式 commit 後刪附件檔（`deleteUploadFiles`）。 */
  uploadsDir: string;
  /** 空間鎖等待上限（ms），透傳自 `AppDeps.storageLockTimeoutMs`（轉移交易用；也是轉移與全刪的結構鎖上限）。 */
  storageLockTimeoutMs: number;
  /** 版本歷史：刪群組・轉移 commit 後重建載入中筆記的版本狀態（`relocated`）。 */
  versions: VersionService;
}

function toMemberDto(row: { userId: string; email: string; displayName: string; roleId: string; builtin: string | null }, avatar: AvatarRef | null): GroupMemberDto {
  return { userId: row.userId, email: row.email, displayName: row.displayName, roleId: row.roleId, builtin: (row.builtin ?? null) as BuiltinGroupRole | null, avatar };
}

export function groupsRoutes(deps: GroupsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const notFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
    const forbidden = (reply: FastifyReply): FastifyReply => sendError(reply, 403, "forbidden", "Your role in this group can't do this.");
    const roleNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "role_not_found", "No role with that id.");
    const invalidName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "Group names must be 1 to 80 characters.");
    const replyTxAbort = (reply: FastifyReply, err: unknown): FastifyReply | null =>
      err instanceof TxAbort ? sendError(reply, err.status, err.errCode, err.message) : null;
    const invalidRoleName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "Role names must be 1 to 40 characters.");
    const roleNameTaken = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "role_name_taken", "This group already has a role with that name, or the name is reserved for a built-in role.");
    // 與 `transferGroupInTx` 的 TxAbort 共用同一個常數：非 UUID 與「不是內建管理員」逐位元組相同。
    const notAdmin = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "not_admin", NOT_ADMIN_MESSAGE);
    // 字面比照 `routes/notes.ts` 的 links busy 映射：40P01 是 PG 的死結偵測，重試即可。
    const serverBusy = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
    const groupNotEmpty = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "group_not_empty", "The group still has notes, so it can't be deleted.");

    app.get("/api/groups", { preHandler: app.authenticate }, async request => {
      const rows = await listMyGroupsQuery(deps.db, request.user!.id);
      return rows.map(row => toGroupDto(row, request.user!.isAdmin));
    });

    // 建立者在同一個交易裡成為內建管理員；兩個內建角色同交易建。
    app.post("/api/groups", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = nameBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const name = validateGroupName(parsed.data.name);
      if (name === null) return invalidName(reply);
      const userId = request.user!.id;
      let created;
      try {
        created = await deps.db.transaction(tx => createGroupInTx(tx, { name, userId }));
      } catch (err) {
        // 儲存配額：改預設 P→Q 後立刻刪 P 與本 INSERT 交錯 → 23503；重試會讀到 Q。
        if (foreignKeyViolationConstraint(err) === "groups_storage_plan_fk") return serverBusy(reply);
        // site_settings 沒有列 → 23502；同接受邀請先記錯（物件開頭）再 500。
        if (notNullViolationColumn(err) === "storage_plan_id") {
          request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
          return sendError(reply, 500, "internal", "Internal server error.");
        }
        throw err;
      }
      const { group } = created;
      const [row] = await groupWithMyRoleQuery(deps.db, group.id, userId);
      return reply.code(201).send(toGroupDto(row!, request.user!.isAdmin));
    });

    app.patch("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = groupPatchBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      let name: string | undefined;
      if (parsed.data.name !== undefined) {
        const validated = validateGroupName(parsed.data.name);
        if (validated === null) return invalidName(reply);
        name = validated;
      }
      const set = { ...(name !== undefined ? { name } : {}), ...(parsed.data.autoVersions !== undefined ? { autoVersions: parsed.data.autoVersions } : {}) };
      const updated = await deps.db.update(groups).set(set).where(eq(groups.id, id)).returning({ id: groups.id });
      if (updated.length === 0) return notFound(reply);
      const [row] = await groupWithMyRoleQuery(deps.db, id, request.user!.id);
      if (!row) return notFound(reply);
      // 非成員的站台 admin：`myRole` 為 null、兩個 canManage＊ 為真。
      return toGroupDto(row, request.user!.isAdmin);
    });

    // #175：刪群組必填模式。transfer＝筆記全數改成 transferTo（內建管理員）的個人筆記；delete＝連筆記一起刪。
    // 全刪的 gate（beforeNoteDeleted 會借連線）在交易**之前**開完（S14）；gate 之後才進群組的
    // 不經 gate 被刪，commit 後以 onGroupAccessChanged 讓在線者 5 秒內以 revoked 關閉（代價）。
    // 兩模式交易外的錯誤映射相同：FK 23503 → 409 group_not_empty（防禦縱深：lockGroup 之後的建立／移入卡在 FK KEY SHARE，
    // 理論上撞不到）；40P01／40001 → 409 server_busy（寫連結 × 刪群組仍會成環：`writeLinksInTx` 先鎖來源列再取目標 FK KEY SHARE，與群組筆記 FOR UPDATE 互等；
    // 同一位 transferTo 的兩筆轉移在接收者結構鎖上排隊〔取在筆記鎖之前〕，不再成環）。
    // 儲存配額起，transfer 另有 409 `storage_quota_exceeded`（接收者個人空間放不下；數字只給接收者本人與站台 admin）；
    // 55P03（空間鎖、資料夾結構鎖逾時）併入 server_busy。
    app.delete("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = deleteGroupBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      // `groupAccess` 已過 UUID_RE（不分大小寫）；轉小寫讓交易輸入與 hook ctx 跟 DB 回來的 id 同形。
      const groupId = id.toLowerCase();

      if (parsed.data.mode === "transfer") {
        // 非 UUID 與「不是這個群組的內建管理員」同形，也讓非 UUID 不進交易（否則 PG 22P02 → 500）。
        if (!UUID_RE.test(parsed.data.transferTo)) return notAdmin(reply);
        // 小寫化：下面以 `!==` 從 DB 回來的（小寫）memberIds 裡濾掉 transferTo。
        // 資料夾：群組名正規化後是空字串時的新頂層名依這個請求的 Accept-Language（server 沒有介面語言欄）。
        const input = {
          groupId,
          transferTo: parsed.data.transferTo.toLowerCase(),
          by: request.user!.id,
          fallbackFolderName: fallbackGroupFolderName(request.headers["accept-language"]),
          lockTimeoutMs: deps.storageLockTimeoutMs,
        };
        let out;
        try {
          out = await deps.db.transaction(tx => transferGroupInTx(tx, input, deps.groupTestHook));
        } catch (err) {
          // 先判子類（StorageQuotaExceeded extends TxAbort）：反序會失去數字。數字可見性在交易外判（接收者本人或站台 admin）。
          if (err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
          const sent = replyTxAbort(reply, err);
          if (sent) return sent;
          if (isForeignKeyViolation(err)) return groupNotEmpty(reply);
          if (isRetryableTxError(err)) return serverBusy(reply);
          throw err;
        }
        if (out.noteIds.length > 0) {
          deps.versions.relocated(out.noteIds);
          // 刪群組・轉移：其他成員失去存取（重驗 → none → 關閉）；transferTo 升 owner（重驗 → 解除唯讀）。
          deps.collabHooks.onGroupAccessChanged(out.noteIds, out.memberIds.filter(u => u !== input.transferTo));
          deps.collabHooks.onGroupAccessChanged(out.noteIds, [input.transferTo]);
        }
        return reply.code(204).send();
      }

      const p0 = (await groupNoteIdsQuery(deps.db, groupId)).map(r => r.id);
      // allSettled：gate 的契約是不 throw；萬一有一個 reject，其他已開的 gate 也要 release 再拋。
      const settled = await Promise.allSettled(p0.map(noteId => deps.collabHooks.beforeNoteDeleted(noteId)));
      const gates = settled.flatMap(s => (s.status === "fulfilled" ? [s.value] : []));
      const releaseAll = (): void => {
        for (const g of gates) g.release();
      };
      const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      if (rejected) {
        releaseAll();
        throw rejected.reason;
      }
      const input = { groupId, lockTimeoutMs: deps.storageLockTimeoutMs };
      let out;
      try {
        // 縫在 try 內：縫丟錯（測試）也走下面的 releaseAll。
        await deps.groupTestHook?.("group-delete-gated", { groupId });
        out = await deps.db.transaction(tx => deleteGroupWithNotesInTx(tx, input, deps.groupTestHook));
      } catch (err) {
        releaseAll();
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        if (isForeignKeyViolation(err)) return groupNotEmpty(reply);
        if (isRetryableTxError(err)) return serverBusy(reply);
        throw err;
      }
      await deleteUploadFiles(deps.uploadsDir, out.uploadIds, request.log);
      const gated = new Set(p0);
      const late = out.noteIds.filter(n => !gated.has(n));
      if (late.length > 0 && out.memberIds.length > 0) deps.collabHooks.onGroupAccessChanged(late, out.memberIds);
      return reply.code(204).send();
    });

    // 唯讀——web 要拿一般成員角色的 id 才能降級。成員即可讀；站台 admin 也可以。
    app.get("/api/groups/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      const rows = await listRolesQuery(deps.db, id);
      return rows.map(row => toGroupRoleDto(row)!);
    });

    // #175：建自訂角色。單句 INSERT（非交易）；不踢線（沒有人掛它）。
    // 順序：groupAccess → 403 → body 形狀 → 名稱 → 保留名 → INSERT（六個旗標任意組合都合法，不驗蘊含）。
    app.post("/api/groups/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = createRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
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
        // 注意：這條路目前沒有測試守（刪掉本行的突變存活）；只有 groupAccess 與 INSERT 之間
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

    // #175：改角色。`:roleId` 的 UUID 檢查在 403 之後（與成員路由 body 的 roleId 一樣排在 403 之後；但這裡是路徑參數，所以排在 body 驗證之前）。
    // 名稱在交易**之前**正規化好（S14：交易 callback 的引數不得有呼叫）。踢線只在 read／edit 有變、且有人掛時。
    app.patch("/api/groups/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      if (!UUID_RE.test(roleId)) return roleNotFound(reply);
      const parsed = patchRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
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

    // #175：刪自訂角色；持有者改掛內建一般成員，commit 後以（群組所有筆記, 原持有者）重驗。
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

    // 任何成員都看得到彼此的 email。routes/users.ts 建議的 ①（同群組成員）以此為前提——這裡收回 email，那支要一起拿掉。
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
      const avatars = await readAvatarRefs(deps.db, rows.map(r => r.userId));
      return rows.map(r => toMemberDto(r, avatars.get(r.userId) ?? null));
    });

    // 只新增：已是成員 → 409，**不動**既有角色。`roleId` 預設內建一般成員。停用帳號一樣可加。加人不踢線。
    app.put("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageMembers) return forbidden(reply);
      const parsed = addMemberBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const roleId = parsed.data.roleId ?? null;
      if (roleId !== null && !UUID_RE.test(roleId)) return roleNotFound(reply);
      // lower() 讀取端比對＋多列命中防護（同 shares 的 PUT）。
      const [target] = await deps.db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(parsed.data.email)}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);
      if (!target) return sendError(reply, 404, "user_not_found", "No user with that email.");
      let role;
      try {
        role = await deps.db.transaction(tx => addMemberInTx(tx, { groupId: id, targetUserId: target.id, roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      const avatars = await readAvatarRefs(deps.db, [target.id]);
      return toMemberDto({ userId: target.id, email: target.email, displayName: target.displayName, roleId: role.roleId, builtin: role.builtin }, avatars.get(target.id) ?? null);
    });

    // 換角色（不防升權）。換角色 → 群組所有筆記 × 那一人重驗（升降皆重驗）；角色沒變不踢。
    app.patch("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (!access.manageMembers) return forbidden(reply);
      const parsed = memberRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
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
      const avatars = await readAvatarRefs(deps.db, [targetId]);
      return toMemberDto({ userId: targetId, ...out.member }, avatars.get(targetId) ?? null);
    });

    // 移人／退出。持管理成員旗標者（含站台 admin）可移任何人；其他人只能移自己。commit 後踢線。
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
