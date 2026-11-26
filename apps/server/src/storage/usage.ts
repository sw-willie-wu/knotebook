// Non-transactional reads that may borrow a pool connection: call them only outside a transaction.
import { eq, sql } from "drizzle-orm";
import { emptyStorageByKind, kindOfMime, type ContentUsageDto, type GroupStorageMemberUsageDto, type StorageByKind, type StorageQuotaErrorDetail } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import type { DbOrTx } from "../db/tx.js";
import { groups, notes, storagePlans, uploads, userAvatars, users } from "../db/schema.js";
import { groupAccess } from "../groups/queries.js";
import { spaceNotesWhere, sumAvatarBytesSql, sumUploadSizeSql, type StorageSpace } from "./space.js";
import type { StorageQuotaExceeded } from "./tx/quota.js";

export interface SpaceUsage {
  usedBytes: number;
  quotaBytes: number | null;
  planId: string;
  planName: string;
}

/** No lock: for prechecks and display; the authoritative check is `assertSpaceRoomInTx`. */
export async function readSpaceUsage(db: DbOrTx, space: StorageSpace): Promise<SpaceUsage | null> {
  const cols = { planId: storagePlans.id, planName: storagePlans.name, quotaBytes: storagePlans.quotaBytes };
  const [plan] = space.kind === "user"
    ? await db.select(cols).from(users).innerJoin(storagePlans, eq(storagePlans.id, users.storagePlanId)).where(eq(users.id, space.id))
    : await db.select(cols).from(groups).innerJoin(storagePlans, eq(storagePlans.id, groups.storagePlanId)).where(eq(groups.id, space.id));
  if (!plan) return null;
  const avatar = space.kind === "user" ? sumAvatarBytesSql(space.id) : sql<number>`0`.mapWith(Number);
  const [row] = await db.select({ used: sumUploadSizeSql(), avatar }).from(uploads).innerJoin(notes, eq(notes.id, uploads.noteId)).where(spaceNotesWhere(space));
  return { usedBytes: (row?.used ?? 0) + (row?.avatar ?? 0), quotaBytes: plan.quotaBytes, planId: plan.planId, planName: plan.planName };
}

/** Not folded into `readSpaceUsage`: that statement is the hot-path "full" precheck and must not GROUP BY. */
export async function readSpaceUsageByKind(db: DbOrTx, space: StorageSpace): Promise<StorageByKind> {
  const rows = await db
    .select({ mime: uploads.mime, bytes: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .where(spaceNotesWhere(space))
    .groupBy(uploads.mime);
  const out = emptyStorageByKind();
  for (const r of rows) out[kindOfMime(r.mime)] += r.bytes;
  if (space.kind === "user") {
    const [row] = await db.select({ bytes: sumAvatarBytesSql(space.id) }).from(users).where(eq(users.id, space.id));
    out.image += row?.bytes ?? 0;
  }
  return out;
}

/** Grouped by `charged_to_id`, not `COALESCE(charged_to_id, uploader_id)`: that would credit the uploader when the charged account is deleted (those and NULL rows aggregate into `userId: null`). Members who left are still listed; only bytes > 0, ordered by bytes desc, then `charged_to_id` asc with null last. */
export async function readGroupUsageByMember(db: DbOrTx, groupId: string): Promise<GroupStorageMemberUsageDto[]> {
  const rows = await db
    .select({ userId: uploads.chargedToId, handle: users.handle, displayName: users.displayName, bytes: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .leftJoin(users, eq(users.id, uploads.chargedToId))
    .where(spaceNotesWhere({ kind: "group", id: groupId }))
    .groupBy(uploads.chargedToId, users.handle, users.displayName)
    .having(sql`sum(${uploads.size}) > 0`)
    .orderBy(sql`sum(${uploads.size}) desc`, sql`${uploads.chargedToId} asc nulls last`);
  return rows.map(r => ({ userId: r.userId, handle: r.handle, displayName: r.displayName, bytes: r.bytes }));
}

/** `user.id` comes from the DB (always lowercase); `space.id` may be the route's raw value, hence only it is lowercased for the comparison. */
export async function canViewSpaceUsage(db: Db, user: { id: string; isAdmin: boolean }, space: StorageSpace): Promise<boolean> {
  if (space.kind === "user") return user.id === space.id.toLowerCase() || user.isAdmin;
  return (await groupAccess(db, space.id, user))?.manageGroup === true;
}

/** Called after rollback, outside the transaction; the visibility TOCTOU is acceptable. */
export async function quotaErrorDetail(db: Db, user: { id: string; isAdmin: boolean }, err: StorageQuotaExceeded): Promise<StorageQuotaErrorDetail> {
  return (await canViewSpaceUsage(db, user, err.space))
    ? { incomingBytes: err.incomingBytes, usedBytes: err.usedBytes, quotaBytes: err.quotaBytes }
    : { incomingBytes: err.incomingBytes };
}

export async function precheckDetail(db: Db, user: { id: string; isAdmin: boolean }, space: StorageSpace, usage: SpaceUsage): Promise<StorageQuotaErrorDetail> {
  return (await canViewSpaceUsage(db, user, space))
    ? { incomingBytes: null, usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes }
    : { incomingBytes: null };
}

export function isSpaceFull(usage: SpaceUsage | null): usage is SpaceUsage & { quotaBytes: number } {
  return usage !== null && usage.quotaBytes !== null && usage.usedBytes >= usage.quotaBytes;
}

/** `null` = no limit; <= 0 = full. */
export function remainingRoom(usage: SpaceUsage | null): number | null {
  if (usage === null || usage.quotaBytes === null) return null;
  return usage.quotaBytes - usage.usedBytes;
}

/** A missing key means 0 (the caller fills it in). Avatar bytes come from a second GROUP BY summed in JS, so avatar-only users must still get an entry. */
export async function listSpaceUsage(db: DbOrTx, kind: "user" | "group"): Promise<Map<string, number>> {
  const key = kind === "user" ? notes.ownerId : notes.groupId;
  const rows = await db.select({ id: key, used: sumUploadSizeSql() }).from(uploads).innerJoin(notes, eq(notes.id, uploads.noteId)).groupBy(key);
  const m = new Map<string, number>();
  for (const r of rows) if (r.id !== null) m.set(r.id, r.used);
  if (kind === "user") {
    const avatarRows = await db
      .select({ id: userAvatars.userId, bytes: sql<number>`coalesce(sum(${userAvatars.originalSize} + ${userAvatars.displaySize}), 0)::bigint`.mapWith(Number) })
      .from(userAvatars)
      .groupBy(userAvatars.userId);
    for (const r of avatarRows) m.set(r.id, (m.get(r.id) ?? 0) + r.bytes);
  }
  return m;
}

// Display only, never part of the limit. octet_length on a TOASTed bytea reads the stored raw size without detoasting. Trashed notes are included on purpose, like attachments.
const spaceColumn = (kind: "user" | "group") => sql.raw(kind === "user" ? "n.owner_id" : "n.group_id");

export async function readSpaceContentUsage(db: DbOrTx, space: StorageSpace): Promise<ContentUsageDto> {
  const col = spaceColumn(space.kind);
  const res = await db.execute<{ note_bytes: string; history_bytes: string }>(sql`
    select
      (select coalesce(sum(octet_length(s.ydoc)), 0) from note_states s join notes n on n.id = s.note_id where ${col} = ${space.id})::bigint as note_bytes,
      ((select coalesce(sum(octet_length(v.ydoc)), 0) from note_versions v join notes n on n.id = v.note_id where ${col} = ${space.id})
       + (select coalesce(sum(octet_length(b.ydoc)), 0) from note_state_backups b join notes n on n.id = b.note_id where ${col} = ${space.id}))::bigint as history_bytes`);
  const row = res.rows[0];
  return { noteBytes: Number(row?.note_bytes ?? 0), historyBytes: Number(row?.history_bytes ?? 0) };
}

/** Note plus history bytes per space in one statement; spaces with no content are absent (the caller fills in 0). */
export async function listSpaceContentUsage(db: DbOrTx, kind: "user" | "group"): Promise<Map<string, number>> {
  const col = spaceColumn(kind);
  const res = await db.execute<{ id: string; bytes: string }>(sql`
    select t.id, sum(t.bytes)::bigint as bytes from (
      select ${col} as id, octet_length(s.ydoc) as bytes from note_states s join notes n on n.id = s.note_id
      union all
      select ${col}, octet_length(v.ydoc) from note_versions v join notes n on n.id = v.note_id
      union all
      select ${col}, octet_length(b.ydoc) from note_state_backups b join notes n on n.id = b.note_id
    ) t where t.id is not null group by t.id`);
  return new Map(res.rows.map(r => [r.id, Number(r.bytes)]));
}
