/**
 * 儲存配額的站台管理端點（spec 2026-10-08 §7.1、§7.2 群組那兩支）。全部 `app.requireAdmin`、全部單句（不開交易——
 * s14 ⑥：本檔 `.transaction(` 恆 0；要改用交易必須先抽 `*InTx` 並列進 ROUTE_FILES）。錯誤訊息中文；body 一律 strict zod，
 * 形狀錯回固定的「請求格式錯誤」（不吐 zod 英文）。id 一律 UUID_RE＋toLowerCase，非 UUID 走該端點的 404 碼。
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES, type AdminGroupDto, type StoragePlanDto, type StoragePlansResponse } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groups, siteSettings, storagePlans } from "../db/schema.js";
import { foreignKeyViolationConstraint, uniqueViolationConstraint } from "../db/pg-errors.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";
import { sendError } from "../http/errors.js";
import { UUID_RE } from "../notes/service.js";
import { listSpaceUsage } from "../storage/usage.js";

export interface AdminStorageRouteDeps {
  db: Db;
}

const quotaSchema = z.number().int().min(0).max(STORAGE_QUOTA_MAX_BYTES).nullable();
const createSchema = z.object({ name: z.string(), quotaBytes: quotaSchema }).strict();
const patchSchema = z
  .object({ name: z.string().optional(), quotaBytes: quotaSchema.optional() })
  .strict()
  .refine(b => b.name !== undefined || b.quotaBytes !== undefined);
const defaultsSchema = z
  .object({ userPlanId: z.string().optional(), groupPlanId: z.string().optional() })
  .strict()
  .refine(b => b.userPlanId !== undefined || b.groupPlanId !== undefined);
const assignSchema = z.object({ planId: z.string() }).strict();

const UNSTORABLE = /[\0]|\p{Surrogate}/u;

/**
 * 方案名稱：trim（含全形空白）後 1..40 個 **code point**（與 DB `char_length` 同單位——不得用 `.length`，astral 字元算兩個）；
 * 含 NUL 或落單代理一律拒（PG 存不下 → 22021，[[g:pg-unstorable-strings-drizzle-tx]]）。不合法回 null。
 */
export function validatePlanName(raw: string): string | null {
  const name = raw.trim();
  if (UNSTORABLE.test(name)) return null;
  const n = [...name].length;
  return n >= 1 && n <= STORAGE_PLAN_NAME_MAX ? name : null;
}

/**
 * 方案 DTO 的 select（只組不執行；每次現造）。overQuotaCount＝指派到此方案且 used > quota 的使用者數＋群組數。
 * 相關子查詢裡的外層欄一律寫死 `storage_plans.id`／`storage_plans.quota_bytes`：單表 select 時 drizzle 把 `${storagePlans.id}`
 * 渲染成不帶表名的 `"id"`（`toSQL()` 實測），在 `from users u` 子查詢裡會被解析成 `u.id`——計數恆 0。
 */
function planRowsQuery(db: Db) {
  return db
    .select({
      id: storagePlans.id,
      name: storagePlans.name,
      quotaBytes: storagePlans.quotaBytes,
      createdAt: storagePlans.createdAt,
      updatedAt: storagePlans.updatedAt,
      userCount: sql<number>`(select count(*)::int from users u where u.storage_plan_id = storage_plans.id)`,
      groupCount: sql<number>`(select count(*)::int from groups g where g.storage_plan_id = storage_plans.id)`,
      overQuotaCount: sql<number>`(
        case when storage_plans.quota_bytes is null then 0 else
          (select count(*)::int from users u where u.storage_plan_id = storage_plans.id
             and (select coalesce(sum(up.size), 0) from uploads up join notes n on n.id = up.note_id where n.owner_id = u.id) > storage_plans.quota_bytes)
        + (select count(*)::int from groups g where g.storage_plan_id = storage_plans.id
             and (select coalesce(sum(up.size), 0) from uploads up join notes n on n.id = up.note_id where n.group_id = g.id) > storage_plans.quota_bytes)
        end)`,
    })
    .from(storagePlans);
}

type PlanRow = Awaited<ReturnType<ReturnType<typeof planRowsQuery>["execute"]>>[number];

function toPlanDto(r: PlanRow, defaults: { userPlanId: string; groupPlanId: string }): StoragePlanDto {
  return {
    id: r.id, name: r.name, quotaBytes: r.quotaBytes,
    userCount: r.userCount, groupCount: r.groupCount, overQuotaCount: r.overQuotaCount,
    isDefaultForUsers: r.id === defaults.userPlanId, isDefaultForGroups: r.id === defaults.groupPlanId,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

async function readDefaults(db: Db): Promise<{ userPlanId: string; groupPlanId: string } | null> {
  const [row] = await db
    .select({ userPlanId: siteSettings.defaultUserStoragePlanId, groupPlanId: siteSettings.defaultGroupStoragePlanId })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true));
  return row ?? null;
}

export function adminStorageRoutes(deps: AdminStorageRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const invalidBody = (reply: FastifyReply) => sendError(reply, 400, "invalid_body", "請求格式錯誤");
    const invalidName = (reply: FastifyReply) => sendError(reply, 400, "invalid_name", "方案名稱須為 1–40 個字元");
    const planNotFound = (reply: FastifyReply) => sendError(reply, 404, "storage_plan_not_found", "找不到這個方案");
    const nameTaken = (reply: FastifyReply) => sendError(reply, 409, "storage_plan_name_taken", "已有同名的方案");
    const groupNotFound = (reply: FastifyReply) => sendError(reply, 404, "group_not_found", "找不到此群組");
    const settingsMissing = (reply: FastifyReply, log: FastifyBaseLogger) => {
      log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE); // 物件開頭（captureLogs 只收這形；先例 routes/admin-auth.ts:114）
      return sendError(reply, 500, "internal", "伺服器內部錯誤");
    };
    const onePlan = async (id: string): Promise<StoragePlanDto | null> => {
      const defaults = await readDefaults(deps.db);
      const [row] = await planRowsQuery(deps.db).where(eq(storagePlans.id, id));
      return row ? toPlanDto(row, defaults ?? { userPlanId: "", groupPlanId: "" }) : null;
    };

    app.get("/api/admin/storage-plans", { preHandler: app.requireAdmin }, async (request, reply) => {
      const defaults = await readDefaults(deps.db);
      if (!defaults) return settingsMissing(reply, request.log);
      const rows = await planRowsQuery(deps.db).orderBy(sql`lower(${storagePlans.name})`, asc(storagePlans.id));
      const body: StoragePlansResponse = { plans: rows.map(r => toPlanDto(r, defaults)), defaults };
      return body;
    });

    app.post("/api/admin/storage-plans", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      const name = validatePlanName(parsed.data.name);
      if (name === null) return invalidName(reply);
      let id: string;
      try {
        const [row] = await deps.db.insert(storagePlans).values({ name, quotaBytes: parsed.data.quotaBytes }).returning({ id: storagePlans.id });
        id = row!.id;
      } catch (err) {
        if (uniqueViolationConstraint(err) === "storage_plans_name_lower_idx") return nameTaken(reply);
        throw err;
      }
      return reply.code(201).send(await onePlan(id));
    });

    // 靜態段 `/defaults` 先於 `/:id`（find-my-way 靜態優先；S10 測試釘住「不被 /:id 吃掉」）。
    app.patch("/api/admin/storage-plans/defaults", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = defaultsSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      const set: { defaultUserStoragePlanId?: string; defaultGroupStoragePlanId?: string; updatedAt: ReturnType<typeof sql> } = { updatedAt: sql`now()` };
      for (const [key, col] of [["userPlanId", "defaultUserStoragePlanId"], ["groupPlanId", "defaultGroupStoragePlanId"]] as const) {
        const v = parsed.data[key];
        if (v === undefined) continue;
        if (!UUID_RE.test(v)) return planNotFound(reply);
        set[col] = v.toLowerCase();
      }
      let rows: Array<{ userPlanId: string; groupPlanId: string }>;
      try {
        // 單句 UPDATE（含 updated_at，M9）：與 B27 持有者、註冊的 FOR SHARE 讀在同一列排隊（spec §6.2）。只影響之後建立的。
        rows = await deps.db.update(siteSettings).set(set).where(eq(siteSettings.singleton, true))
          .returning({ userPlanId: siteSettings.defaultUserStoragePlanId, groupPlanId: siteSettings.defaultGroupStoragePlanId });
      } catch (err) {
        const c = foreignKeyViolationConstraint(err);
        if (c === "site_settings_default_user_plan_fk" || c === "site_settings_default_group_plan_fk") return planNotFound(reply);
        throw err;
      }
      if (rows.length === 0) return settingsMissing(reply, request.log);
      return rows[0];
    });

    app.patch("/api/admin/storage-plans/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return planNotFound(reply);
      const id = rawId.toLowerCase();
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      const set: { name?: string; quotaBytes?: number | null; updatedAt: ReturnType<typeof sql> } = { updatedAt: sql`now()` };
      if (parsed.data.name !== undefined) {
        const name = validatePlanName(parsed.data.name);
        if (name === null) return invalidName(reply);
        set.name = name;
      }
      if (parsed.data.quotaBytes !== undefined) set.quotaBytes = parsed.data.quotaBytes;
      let updated: Array<{ id: string }>;
      try {
        // 調低低於現用量允許（D4a：不刪、只擋新增）；調高立即生效（下一次判定讀到新值）。
        updated = await deps.db.update(storagePlans).set(set).where(eq(storagePlans.id, id)).returning({ id: storagePlans.id });
      } catch (err) {
        if (uniqueViolationConstraint(err) === "storage_plans_name_lower_idx") return nameTaken(reply);
        throw err;
      }
      if (updated.length === 0) return planNotFound(reply);
      return onePlan(id);
    });

    app.delete("/api/admin/storage-plans/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return planNotFound(reply);
      const id = rawId.toLowerCase();
      const isDefault = () => sendError(reply, 409, "storage_plan_is_default", "這個方案是預設方案，請先改選其他預設");
      let deleted: number;
      try {
        // spec §7.1（I2）：條件式排除預設先於 FK 觸發——「既是預設又使用中」一律 is_default；使用中由 FK RESTRICT 在 DB 端裁決。
        const res = await deps.db.execute(sql`
          delete from storage_plans where id = ${id}
            and id not in (select default_user_storage_plan_id from site_settings
                           union all select default_group_storage_plan_id from site_settings)
          returning id`);
        deleted = res.rows.length;
      } catch (err) {
        const c = foreignKeyViolationConstraint(err);
        if (c === "users_storage_plan_fk" || c === "groups_storage_plan_fk") return sendError(reply, 409, "storage_plan_in_use", "這個方案仍有使用者或群組在用，請先改指派其他方案");
        // 與「改預設」並發：子查詢讀快照，改預設在其後 commit 使它成為預設 → site_settings 的 FK 擋下（§7.1、R11）。
        if (c === "site_settings_default_user_plan_fk" || c === "site_settings_default_group_plan_fk") return isDefault();
        throw err;
      }
      if (deleted === 1) return reply.code(204).send();
      const [exists] = await deps.db.select({ id: storagePlans.id }).from(storagePlans).where(eq(storagePlans.id, id));
      return exists ? isDefault() : planNotFound(reply);
    });

    const groupDto = async (id?: string): Promise<AdminGroupDto[]> => {
      const usage = await listSpaceUsage(deps.db, "group");
      const base = deps.db
        .select({
          id: groups.id, name: groups.name, createdAt: groups.createdAt,
          memberCount: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
          planId: storagePlans.id, planName: storagePlans.name, quotaBytes: storagePlans.quotaBytes,
        })
        .from(groups)
        .innerJoin(storagePlans, eq(storagePlans.id, groups.storagePlanId));
      const rows = id === undefined ? await base.orderBy(sql`lower(${groups.name})`, asc(groups.id)) : await base.where(eq(groups.id, id));
      return rows.map(r => ({
        id: r.id, name: r.name, createdAt: r.createdAt.toISOString(), memberCount: r.memberCount,
        storage: { planId: r.planId, planName: r.planName, usedBytes: usage.get(r.id) ?? 0, quotaBytes: r.quotaBytes },
      }));
    };

    app.get("/api/admin/groups", { preHandler: app.requireAdmin }, async () => groupDto());

    app.patch("/api/admin/groups/:id/storage-plan", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return groupNotFound(reply);
      const id = rawId.toLowerCase();
      const parsed = assignSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      if (!UUID_RE.test(parsed.data.planId)) return planNotFound(reply);
      let updated: Array<{ id: string }>;
      try {
        // 單句非鍵 UPDATE（NO KEY UPDATE）：不取空間鎖、不擋進行中的上傳（R10）；不檢查新方案是否小於現用量（§7.2）。
        updated = await deps.db.update(groups).set({ storagePlanId: parsed.data.planId.toLowerCase() }).where(eq(groups.id, id)).returning({ id: groups.id });
      } catch (err) {
        if (foreignKeyViolationConstraint(err) === "groups_storage_plan_fk") return planNotFound(reply);
        throw err;
      }
      if (updated.length === 0) return groupNotFound(reply);
      return (await groupDto(id))[0];
    });
  };
}
