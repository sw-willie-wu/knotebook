/**
 * #181 `GET /api/trash` 的查詢（spec 2026-10-21 §6.3.1、§6.7）：呼叫者有垃圾桶權（D-W9）的項目＝個人（owner）∪ 群組
 * （角色 `can_edit AND can_delete`）。兩支結構性互斥（個人支 `owner_id = $u`、群組支 INNER JOIN 群組；`owner_id` 與 `group_id`
 * 恰一個非 NULL，`notes_owner_xor_group_chk`），`unionAll`。
 * 垃圾桶權的推導與單篇的 `trashRightFromRow` 同規則（`trash-routes.test.ts` TR-L3／TR-M1 逐角色比對）。
 * #181 PR-2d：MCP `list_trash` 共用 `readTrashRetentionDays`；`delete_note` 移入後以 `loadTrashedMeta` 重讀。
 * 資料夾 PR-3d：MCP `list_trash` 改走 `listTrashPage`（keyset 游標）；REST 的 `listTrash` 是它第一頁的包裝。兩者同用毫秒排序鍵（Q3）。
 * 資料夾 PR-3d T8：MCP `delete_folder` 移入後以 `loadTrashedPurgeAt` 重讀到期時間。
 */
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias, unionAll, type AnyPgColumn } from "drizzle-orm/pg-core";
import { TRASH_LIST_LIMIT, type TrashItemDto, type TrashListDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups, notes, siteSettings, users } from "../db/schema.js";
import { folderPathJsonSql, NOTES_FOLDER_ID } from "../folders/sql.js";

/** 刪除者（`notes.deleted_by`）。一律 LEFT JOIN：帳號已刪時欄位是 NULL，那一列仍要列出（`deletedBy: null`）。 */
const deleter = alias(users, "deleter");

/**
 * 到期時間（清單與 `loadTrashedMeta` 共用）。與清理的到期式（`notes/tx/trash.ts` 的 `purgeExpiredBatchInTx`）同一類，要改一起改。
 * 兩式都受 session TimeZone 影響（跨 DST 時「天」不是 24 h），但同一個 pool 下兩邊算出來一致。
 * ⚠ 真正的陷阱是對無型別 bind 參數寫 `CASE WHEN ${x} IS NULL`／`${x} IS NULL`：pg 推不出參數型別，parse 階段 42P18。所以不寫 CASE——
 * `make_interval` 是 STRICT，天數 NULL 時整式就是 NULL。參數側的 `::int` 目前不影響行為（`make_interval` 的簽名已把參數定成 int），
 * 是防禦性的：日後有人包上 `CASE`／`IS NULL` 時參數已有型別（同 `password-reset.ts` 的 `make_interval(hours => …::int)`）。
 * raw `sql` 一定要 `.mapWith(notes.deletedAt)`——不然拿到 pg 的原始字串，`toISOString()` 直接 throw（`mcp/queries.ts` 檔頭）。
 */
function purgeAtExpr(days: SQL | AnyPgColumn) {
  return sql<Date | null>`${notes.deletedAt} + make_interval(days => ${days})`.mapWith(notes.deletedAt);
}

/** 兩支共用的前段欄位（每次現造：builder 單次使用）。 */
function baseColumns(retentionDays: number | null) {
  return {
    id: notes.id,
    title: notes.title,
    deletedAt: notes.deletedAt,
    purgeAt: purgeAtExpr(sql`${retentionDays}::int`).as("purge_at"),
    deleterHandle: deleter.handle,
    deleterName: deleter.displayName,
    // 資料夾（spec 2026-10-22 §5.8）：`folder_id` 非 NULL → 即時路徑（資料夾期間改名、搬動也跟著），否則快照；NULL → []。
    // 外層欄一律帶表名字面（單表 SELECT 直接插欄位會渲染成裸名，`NOTES_FOLDER_ID` 檔頭）。node-postgres 把 jsonb 解成陣列。
    folderPath: sql<string[]>`coalesce(case when "notes"."folder_id" is not null then ${folderPathJsonSql(NOTES_FOLDER_ID())} else "notes"."trash_folder_path" end, '[]'::jsonb)`.as("folder_path"),
  };
}

/** keyset 游標：`deletedAtMs` 是毫秒排序鍵本身（命名避開 `trash-structure.test.ts` 守衛二的比對式）。 */
export interface TrashCursor { deletedAtMs: Date; id: string }

/** 毫秒排序鍵（資料夾 PR-3d Q3：REST 與 MCP 同用）。raw `sql` 時間戳要 `.mapWith`（`mcp/queries.ts` 檔頭）。 */
const deletedAtMsExpr = sql`date_trunc('milliseconds', ${notes.deletedAt})`.mapWith(notes.deletedAt);

/**
 * 呼叫者有垃圾桶權的項目，依（毫秒 `deleted_at` DESC, id DESC），至多 `opts.limit` 筆（多取一筆判 hasMore）。
 * keyset：兩支各在 `and(…)` 裡帶 `(date_trunc('milliseconds', deleted_at), id) < (游標)`，左側與排序鍵同精度（memory g:drizzle-query-builder-gotchas）。
 * `items` 與 `keys` 等長、同序。retentionDays 由呼叫端讀好傳入（`readTrashRetentionDays`）。
 */
export async function listTrashPage(
  db: Db,
  userId: string,
  retentionDays: number | null,
  opts: { limit: number; after: TrashCursor | null },
): Promise<{ items: TrashItemDto[]; keys: TrashCursor[]; hasMore: boolean }> {
  const keyset: SQL | undefined =
    opts.after === null
      ? undefined
      : sql`(${deletedAtMsExpr}, ${notes.id}) < (${opts.after.deletedAtMs.toISOString()}::timestamptz, ${opts.after.id}::uuid)`;
  const deletedAtMs = deletedAtMsExpr.as("deleted_at_ms");
  // 群組兩欄寫成 `sql<… | null>`：union 後面各支的列型別要可指派給第一支（同 `list-query.ts` 的 `nullGroupColumns`）。
  const personal = db
    .select({
      ...baseColumns(retentionDays),
      deletedAtMs,
      groupId: sql<string | null>`null::uuid`.as("group_id"),
      groupName: sql<string | null>`null::text`.as("group_name"),
    })
    .from(notes)
    .leftJoin(deleter, eq(deleter.id, notes.deletedBy))
    .where(and(eq(notes.ownerId, userId), isNotNull(notes.deletedAt), keyset));
  const grouped = db
    .select({
      ...baseColumns(retentionDays),
      deletedAtMs,
      groupId: sql<string | null>`${notes.groupId}`.as("group_id"),
      groupName: sql<string | null>`${groups.name}`.as("group_name"),
    })
    .from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canEdit, true), eq(groupRoles.canDelete, true)))
    .innerJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(deleter, eq(deleter.id, notes.deletedBy))
    .where(and(isNotNull(notes.deletedAt), keyset));
  // 集合運算的 ORDER BY 只收輸出欄名（`deleted_at_ms` 是具名輸出欄；drizzle 對 union 的 `notes.id` 渲染成裸欄名 id）。
  const rows = await unionAll(personal, grouped)
    .orderBy(desc(deletedAtMs), desc(notes.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const items: TrashItemDto[] = page.map(r => ({
    id: r.id,
    title: r.title,
    deletedAt: r.deletedAt!.toISOString(),
    purgeAt: r.purgeAt?.toISOString() ?? null,
    deletedBy: r.deleterHandle === null ? null : { handle: r.deleterHandle, displayName: r.deleterName ?? "" },
    group: r.groupId === null ? null : { id: r.groupId, name: r.groupName ?? "" },
    folderPath: r.folderPath,
  }));
  return { items, keys: page.map(r => ({ deletedAtMs: r.deletedAtMs, id: r.id })), hasMore: rows.length > opts.limit };
}

/**
 * REST 與舊呼叫端：＝ `listTrashPage(after: null)` 的第一頁，回應形不變（Q3：同一毫秒內的相對順序改依 id）。
 * 至多 `opts.limit`（預設 `TRASH_LIST_LIMIT`）筆。
 */
export async function listTrash(db: Db, userId: string, retentionDays: number | null, opts: { limit?: number } = {}): Promise<TrashListDto> {
  const page = await listTrashPage(db, userId, retentionDays, { limit: opts.limit ?? TRASH_LIST_LIMIT, after: null });
  return { retentionDays, items: page.items, truncated: page.hasMore };
}

/**
 * site_settings 單列的保留天數；列不存在 → undefined（呼叫端：REST 記 `SITE_SETTINGS_MISSING_MESSAGE` 回 500；MCP 丟例外給
 * `runTool` → internal；`delete_note` 拿它當移入前的存在性守衛）。
 */
export async function readTrashRetentionDays(db: Db): Promise<{ retentionDays: number | null } | undefined> {
  const [row] = await db
    .select({ retentionDays: siteSettings.trashRetentionDays })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .limit(1);
  return row === undefined ? undefined : { retentionDays: row.retentionDays };
}

/**
 * `delete_note` 移入 commit 後的一讀（交易外單句 SELECT）：只看垃圾桶；`purgeAt` 與清單同一運算式，同一句裡 join
 * site_settings 取**這一刻**的保留天數。commit 之後被還原或永久刪除、或 site_settings 列不在 → 0 列 → undefined
 * （呼叫端照「重讀落空」處理）。
 */
export async function loadTrashedMeta(db: Db, noteId: string): Promise<{ title: string; purgeAt: Date | null } | undefined> {
  const [row] = await db
    .select({ title: notes.title, purgeAt: purgeAtExpr(siteSettings.trashRetentionDays) })
    .from(notes)
    .innerJoin(siteSettings, eq(siteSettings.singleton, true))
    .where(and(eq(notes.id, noteId), isNotNull(notes.deletedAt)))
    .limit(1);
  return row;
}

/**
 * `delete_folder` commit 後一讀（交易外單句 SELECT）：ids（≤ 100）中任一篇仍在垃圾桶者的 purgeAt——同一交易移入、`deleted_at` 相同；
 * 與清單同一個 `purgeAtExpr`，join site_settings 取這一刻的設定。ids 為空（不發查詢）、全部已不在垃圾桶、或保留天數 NULL → null。
 */
export async function loadTrashedPurgeAt(db: Db, noteIds: readonly string[]): Promise<Date | null> {
  if (noteIds.length === 0) return null;
  const [row] = await db
    .select({ purgeAt: purgeAtExpr(siteSettings.trashRetentionDays) })
    .from(notes)
    .innerJoin(siteSettings, eq(siteSettings.singleton, true))
    .where(and(inArray(notes.id, [...noteIds]), isNotNull(notes.deletedAt)))
    .limit(1);
  return row?.purgeAt ?? null;
}
