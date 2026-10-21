import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SpaceStorageDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { Db } from "../db/index.js";
import { oneTimeLinks, storagePlans, users } from "../db/schema.js";
import { activeOneTimeLink } from "../auth/one-time-link.js";
import { disableUserInTx } from "../auth/tx/disable-user.js";
import type { UserGate } from "../auth/session.js";
import type { CollabHooks } from "../collab/hooks.js";
import { UUID_RE } from "../notes/service.js";
import { foreignKeyViolationConstraint } from "../db/pg-errors.js";
import { listSpaceUsage, readSpaceUsage } from "../storage/usage.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { TxAbort } from "../http/tx-abort.js";
import type { AdminTestHook } from "../auth/admin-test-hook.js";
import { demoteSiteAdminInTx } from "../auth/tx/admin-demote.js";

/** 儲存配額 §7.2：指派方案的 body（strict——多餘欄 400）。 */
const assignPlanSchema = z.object({ planId: z.string() }).strict();

export interface AdminUsersRouteDeps {
  db: Db;
  gate: UserGate;
  collabHooks: CollabHooks;
  /** #247 §9.4 降級的測試注入縫（`auth/admin-test-hook.ts`）；`undefined`＝no-op。 */
  adminTestHook?: AdminTestHook;
}

interface AdminUserDto {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  /** #247 §9.5：最後一次新簽登入 session 的時間；null＝升級後尚未登入過（不回填）。 */
  lastLoginAt: string | null;
  /** #267：最後一次帶 session cookie 的請求、共編連線或編輯、或登入的時間（`users.last_active_at`，同一使用者至多每分鐘更新一次）；null＝從無紀錄。 */
  lastActiveAt: string | null;
  storage: SpaceStorageDto;
  /** #286：`password_hash IS NOT NULL`（只回布林）。 */
  hasPassword: boolean;
  /** #286：有效（未用、未撤銷、未過期）的重設連結的到期時間；I3 保證至多一支。不受帳密開關影響（D2）。 */
  passwordResetExpiresAt: string | null;
}

interface AdminUserRow {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  lastActiveAt: Date | null;
  hasPassword: boolean;
  passwordResetExpiresAt: Date | null;
}

// 只選這九欄＋兩個 SQL 表達式＋方案（storage 另組）（形狀鎖，#122 起含 handle、#247 起含 lastLoginAt、#267 起含 lastActiveAt、#286 起含
// hasPassword／passwordResetExpiresAt）：不可帶 passwordHash/tokenVersion——`hasPassword` 只回布林，仍不 select `password_hash` 本體。即使只是
// 內部查詢，也不要 select 出這兩欄再靠序列化階段刻意漏掉，直接在 SQL 端就不撈，斷絕任何洩漏路徑。
function toAdminUserDto(row: AdminUserRow, storage: SpaceStorageDto): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    storage,
    hasPassword: row.hasPassword,
    passwordResetExpiresAt: row.passwordResetExpiresAt ? row.passwordResetExpiresAt.toISOString() : null,
  };
}

const adminUserColumns = {
  id: users.id,
  email: users.email,
  handle: users.handle,
  displayName: users.displayName,
  isAdmin: users.isAdmin,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
  lastActiveAt: users.lastActiveAt,
  hasPassword: sql<boolean>`${users.passwordHash} is not null`,
  // ⚠ 外層參照 `users.id` 必須留在巢狀的 `and(…)` 裡：drizzle 0.44 在單表 RETURNING（PATCH storage-plan）會把
  // SQL 表達式**頂層**的欄位參照去掉表名，頂層的 `${users.id}` 變成 `"id"`、在子查詢內被解析成 one_time_links.id，靜默變 null（spec §4.2）。
  // `.mapWith` 不可省：不加會拿到 pg 原始字串。
  passwordResetExpiresAt: sql`(select ${oneTimeLinks.expiresAt} from ${oneTimeLinks} where ${and(eq(oneTimeLinks.targetUserId, users.id), activeOneTimeLink("password_reset"))})`.mapWith(oneTimeLinks.expiresAt),
};

/** 單一使用者的 storage 欄（PATCH 回應用；GET 列表走 GROUP BY 一次）。 */
async function storageOfUser(db: Db, userId: string): Promise<SpaceStorageDto> {
  const usage = await readSpaceUsage(db, { kind: "user", id: userId });
  if (!usage) throw new Error(`storageOfUser: 找不到使用者 ${userId}`);
  return { planId: usage.planId, planName: usage.planName, usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes };
}

/**
 * Admin 使用者管理路由：全部端點皆需 `requireAdmin`。
 *
 * disable/enable/promote/demote 四支操作性端點對 `:id` 皆先以 `UUID_RE` 擋掉格式不合法的
 * 路徑參數（見 notes/service.ts 的 `resolveRole` 同一套理由：pg uuid 欄位對非法格式
 * 字串會直接 throw，讓它冒到全域錯誤 handler 會被誤判成 500），非法格式與「查無此
 * 使用者」統一回同一個 404 `user_not_found`，不特別區分。
 */
export function adminUsersRoutes(deps: AdminUsersRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/users", { preHandler: app.requireAdmin }, async () => {
      // 次要排序鍵 id asc（同 notes.ts GET /api/notes 清單慣例）：createdAt 精度不足以
      // 保證唯一序，兩筆使用者在同一毫秒建立時排序會不穩定。
      // 用量一次 GROUP BY（沒有附件的使用者不在 Map 裡 → 0）；方案以 inner join 帶出（storage_plan_id NOT NULL＋FK）。
      const usage = await listSpaceUsage(deps.db, "user");
      const rows = await deps.db
        .select({ ...adminUserColumns, planId: storagePlans.id, planName: storagePlans.name, quotaBytes: storagePlans.quotaBytes })
        .from(users)
        .innerJoin(storagePlans, eq(storagePlans.id, users.storagePlanId))
        .orderBy(asc(users.createdAt), asc(users.id));
      return rows.map(r => toAdminUserDto(r, { planId: r.planId, planName: r.planName, usedBytes: usage.get(r.id) ?? 0, quotaBytes: r.quotaBytes }));
    });

    app.post("/api/admin/users/:id/disable", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      // 正規化成小寫：pg 的 uuid 型別比對本身不分大小寫，但 `id === request.user!.id`
      // 這個自我鎖死檢查是純 JS 字串比對——request.user!.id 來自 DB（一律小寫），若
      // 路徑參數帶大寫版本的自己 UUID（格式仍合法，UUID_RE 帶 /i），字串比對會誤判
      // 成「不是自己」而放行，讓 admin 能繞過 cannot_disable_self 把自己鎖死。統一在
      // 這裡正規化，後續比對／查詢都用同一個小寫 id。
      const id = rawId.toLowerCase();
      if (id === request.user!.id) {
        return sendError(reply, 400, "cannot_disable_self", "無法停用自己的帳號");
      }

      // 條件式停用＋ #286 同交易撤銷重設連結（auth/tx/disable-user.ts）。
      const input = { id };
      let result: Awaited<ReturnType<typeof disableUserInTx>>;
      try {
        result = await deps.db.transaction(tx => disableUserInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // 交易動到含雜湊欄的連結列：非預期的 DB 錯誤一律遮蔽後再丟（同 admin-auth.ts 刪除登入服務）。
        throw redactDbError(request.log, err, "停用帳號");
      }

      if (!result.disabled) {
        const [existing] = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
        if (!existing) {
          return sendError(reply, 404, "user_not_found", "找不到此使用者");
        }
        // 已存在但這次 UPDATE 沒命中列：代表已經是停用狀態——冪等 204，不再重複
        // invalidate/onUserRevoked（上一次真正停用時已經處理過，狀態沒有變化）。
        return reply.code(204).send();
      }

      deps.gate.invalidate(id);
      deps.collabHooks.onUserRevoked(id);
      if (result.revokedResetLinks > 0) {
        request.log.info({ userId: request.user!.id, targetUserId: id, revoked: result.revokedResetLinks }, "停用帳號時撤銷重設密碼連結");
      }

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/enable", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      // 正規化成小寫（見 disable 端點同一段註解）：三個 :id 端點統一套用，即使 enable/
      // promote 本身沒有「跟自己比對」的檢查，仍保持一致行為與可預期性。
      const id = rawId.toLowerCase();

      // 刻意不動 tokenVersion：disable 當下已 bump 過的 tv 維持不變，讓 disable 前簽發
      // 的舊 session 即使在 enable 之後仍然失效（binding：只有重新登入才能拿到新 session）。
      const [updated] = await deps.db.update(users).set({ disabledAt: null }).where(eq(users.id, id)).returning({ id: users.id });
      if (!updated) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }

      deps.gate.invalidate(id);

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/promote", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      const id = rawId.toLowerCase();

      const [updated] = await deps.db.update(users).set({ isAdmin: true }).where(eq(users.id, id)).returning({ id: users.id });
      if (!updated) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }

      // gate 快取內的 isAdmin 若不即時失效，該使用者要等到快取 TTL（60s）過期才會被
      // requireAdmin 認可——invalidate 讓下一次 authenticate 立刻反映新 isAdmin。
      deps.gate.invalidate(id);

      return reply.code(204).send();
    });

    // #247 §9.4：與 promote 對稱。自降 400（比照 disable 的小寫正規化理由，見上）；交易內鎖全部 admin 列後計數（auth/tx/admin-demote.ts）。
    app.post("/api/admin/users/:id/demote", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      const id = rawId.toLowerCase();
      if (id === request.user!.id) {
        return sendError(reply, 400, "cannot_demote_self", "無法移除自己的管理員身分");
      }
      const input = { targetId: id };
      try {
        await deps.db.transaction(tx => demoteSiteAdminInTx(tx, input, deps.adminTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      // 同 promote：gate 快取的 isAdmin 不即時失效的話，被降級者 60 秒內仍過得了 requireAdmin。
      deps.gate.invalidate(id);
      return reply.code(204).send();
    });

    // 儲存配額 §7.2：指派使用者方案。單句非鍵 UPDATE（不取空間鎖、不擋進行中的上傳——R10）；不檢查新方案是否小於現用量。
    // 停權者照樣可改（S13）。非 UUID 的 :id／planId 各走自己的 404 碼（不落到 22P02 → 500）；大寫 UUID 正規化成小寫。
    app.patch("/api/admin/users/:id/storage-plan", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "user_not_found", "找不到此使用者");
      const id = rawId.toLowerCase();
      const parsed = assignPlanSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
      if (!UUID_RE.test(parsed.data.planId)) return sendError(reply, 404, "storage_plan_not_found", "找不到這個方案");
      let updated: AdminUserRow[];
      try {
        updated = await deps.db.update(users).set({ storagePlanId: parsed.data.planId.toLowerCase() }).where(eq(users.id, id)).returning(adminUserColumns);
      } catch (err) {
        if (foreignKeyViolationConstraint(err) === "users_storage_plan_fk") return sendError(reply, 404, "storage_plan_not_found", "找不到這個方案");
        throw err;
      }
      const [row] = updated;
      if (!row) return sendError(reply, 404, "user_not_found", "找不到此使用者");
      return toAdminUserDto(row, await storageOfUser(deps.db, id));
    });
  };
}
