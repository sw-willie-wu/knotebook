import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias, unionAll, type AnyPgColumn } from "drizzle-orm/pg-core";
import { EMPTY_YDOC_UPDATE_B64, TRASH_LIST_LIMIT, type TrashItemDto, type TrashListDto, type TrashPreviewDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups, noteStates, notes, siteSettings, users } from "../db/schema.js";
import { folderPathJsonSql, NOTES_FOLDER_ID } from "../folders/sql.js";
import { resolveTrashedNoteAccess } from "../notes/service.js";

/** Always LEFT JOINed: a deleted account leaves NULL and the row is still listed. */
const deleter = alias(users, "deleter");

/** Same family as the purge expression in `purgeExpiredBatchInTx`: change together. Both follow the session TimeZone (a DST day isn't 24 h) but agree under one pool. No `CASE WHEN ${x} IS NULL` on an untyped bind parameter (42P18); `make_interval` is STRICT, and the parameter-side `::int` is defensive for a later wrap in CASE/IS NULL. Raw `sql` needs `.mapWith(notes.deletedAt)`. */
function purgeAtExpr(days: SQL | AnyPgColumn) {
  return sql<Date | null>`${notes.deletedAt} + make_interval(days => ${days})`.mapWith(notes.deletedAt);
}

function baseColumns(retentionDays: number | null) {
  return {
    id: notes.id,
    title: notes.title,
    deletedAt: notes.deletedAt,
    purgeAt: purgeAtExpr(sql`${retentionDays}::int`).as("purge_at"),
    deleterHandle: deleter.handle,
    deleterName: deleter.displayName,
    // folder_id set: live path (follows renames while trashed), else the snapshot. Table-qualified because a single-table SELECT renders a bare name (`NOTES_FOLDER_ID`).
    folderPath: sql<string[]>`coalesce(case when "notes"."folder_id" is not null then ${folderPathJsonSql(NOTES_FOLDER_ID())} else "notes"."trash_folder_path" end, '[]'::jsonb)`.as("folder_path"),
  };
}

// `deletedAtMs` is the millisecond sort key itself; the name avoids the `deletedAt:` pattern of a guard in `trash-structure.test.ts`.
export interface TrashCursor { deletedAtMs: Date; id: string }

const deletedAtMsExpr = sql`date_trunc('milliseconds', ${notes.deletedAt})`.mapWith(notes.deletedAt);

type TrashItemRow = {
  id: string;
  title: string;
  deletedAt: Date | null;
  purgeAt: Date | null;
  deleterHandle: string | null;
  deleterName: string | null;
  groupId: string | null;
  groupName: string | null;
  folderPath: string[];
};

function toTrashItemDto(r: TrashItemRow): TrashItemDto {
  return {
    id: r.id,
    title: r.title,
    deletedAt: r.deletedAt!.toISOString(),
    purgeAt: r.purgeAt?.toISOString() ?? null,
    deletedBy: r.deleterHandle === null ? null : { handle: r.deleterHandle, displayName: r.deleterName ?? "" },
    group: r.groupId === null ? null : { id: r.groupId, name: r.groupName ?? "" },
    folderPath: r.folderPath,
  };
}

export async function listTrashPage(
  db: Db,
  userId: string,
  retentionDays: number | null,
  opts: { limit: number; after: TrashCursor | null },
): Promise<{ items: TrashItemDto[]; keys: TrashCursor[]; hasMore: boolean }> {
  // Compares the ms-truncated key, the same precision as the sort key and the cursor.
  const keyset: SQL | undefined =
    opts.after === null
      ? undefined
      : sql`(${deletedAtMsExpr}, ${notes.id}) < (${opts.after.deletedAtMs.toISOString()}::timestamptz, ${opts.after.id}::uuid)`;
  const deletedAtMs = deletedAtMsExpr.as("deleted_at_ms");
  // Typed `| null` so the later union branches are assignable to the first.
  // Same trash right as `trashRightFromRow` (change together; `trash-routes.test.ts` compares them role by role). The branches are disjoint (`notes_owner_xor_group_chk`), so `unionAll` can't duplicate.
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
  // A set operation's ORDER BY takes output column names only (drizzle renders `notes.id` in a union as bare `id`).
  const rows = await unionAll(personal, grouped)
    .orderBy(desc(deletedAtMs), desc(notes.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const items: TrashItemDto[] = page.map(toTrashItemDto);
  return { items, keys: page.map(r => ({ deletedAtMs: r.deletedAtMs, id: r.id })), hasMore: rows.length > opts.limit };
}

export async function listTrash(db: Db, userId: string, retentionDays: number | null): Promise<TrashListDto> {
  const page = await listTrashPage(db, userId, retentionDays, { limit: TRASH_LIST_LIMIT, after: null });
  return { retentionDays, items: page.items, truncated: page.hasMore };
}

/** Read-only preview of a single trashed note; returns null when missing, live, or the caller lacks trash rights. */
export async function loadTrashPreview(
  db: Db,
  userId: string,
  noteId: string,
  retentionDays: number | null,
): Promise<TrashPreviewDto | null> {
  if (!(await resolveTrashedNoteAccess(db, userId, noteId))) return null;
  const [row] = await db
    .select({
      ...baseColumns(retentionDays),
      groupId: notes.groupId,
      groupName: groups.name,
      ydoc: noteStates.ydoc,
    })
    .from(notes)
    .leftJoin(deleter, eq(deleter.id, notes.deletedBy))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(noteStates, eq(noteStates.noteId, notes.id))
    .where(and(eq(notes.id, noteId), isNotNull(notes.deletedAt)))
    .limit(1);
  if (!row) return null;
  return {
    ...toTrashItemDto(row),
    ydoc: row.ydoc ? Buffer.from(row.ydoc).toString("base64") : EMPTY_YDOC_UPDATE_B64,
  };
}

export async function readTrashRetentionDays(db: Db): Promise<{ retentionDays: number | null } | undefined> {
  const [row] = await db
    .select({ retentionDays: siteSettings.trashRetentionDays })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .limit(1);
  return row === undefined ? undefined : { retentionDays: row.retentionDays };
}

export async function loadTrashedMeta(db: Db, noteId: string): Promise<{ title: string; purgeAt: Date | null } | undefined> {
  const [row] = await db
    .select({ title: notes.title, purgeAt: purgeAtExpr(siteSettings.trashRetentionDays) })
    .from(notes)
    .innerJoin(siteSettings, eq(siteSettings.singleton, true))
    .where(and(eq(notes.id, noteId), isNotNull(notes.deletedAt)))
    .limit(1);
  return row;
}

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
