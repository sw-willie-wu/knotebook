import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { uploadServedName, type AvatarRef, type CommentNotificationDto, type NotificationDto, type NotificationListDto } from "@knotebook/shared";
import { readAvatarRefs } from "../avatars/read.js";
import { agentLagSql, encodeCursor, type CommentCursor } from "../comments/queries.js";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, noteComments, noteShares, notes, notificationSeen, notifications, uploads, users } from "../db/schema.js";
import { UUID_RE, noteAccessFromRow } from "../notes/service.js";

export const NOTIFICATION_PAGE_DEFAULT = 30;
export const NOTIFICATION_PAGE_MAX = 30;
export const NOTIFICATION_EXCERPT_MAX = 120;

const cursorTsSql = sql<string>`to_char(${notifications.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The access columns and joins of `accessQuery` (notes/service.ts) for many notes at once; must stay identical to it. */
async function accessRowsFor(db: DbOrTx, userId: string, noteIds: string[]) {
  return db
    .select({
      id: notes.id,
      title: notes.title,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      shareRole: noteShares.role,
      roleId: groupRoles.id,
      canRead: groupRoles.canRead,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(notes)
    .leftJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId), isNull(notes.groupId)))
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .leftJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(inArray(notes.id, noteIds), isNull(notes.deletedAt)));
}

/**
 * The caller's notifications, newest first, with agent-addressed ones included. A comment row whose note the caller can't read any more
 * carries the actor, kind and time only; an upload row, the file name, kind and time.
 */
export async function listNotifications(db: DbOrTx, input: { userId: string; before: CommentCursor | null; limit: number }): Promise<NotificationListDto> {
  const { userId, limit } = input;
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      agentLabel: notifications.agentLabel,
      noteId: notifications.noteId,
      commentId: notifications.commentId,
      uploadId: notifications.uploadId,
      blockId: notifications.blockId,
      uploadFileName: uploads.fileName,
      uploadMime: uploads.mime,
      actorId: notifications.actorId,
      actorAgentLabel: notifications.actorAgentLabel,
      createdAt: notifications.createdAt,
      cursorTs: cursorTsSql,
      isNew: sql<boolean>`${notifications.createdAt} > coalesce((select s.seen_at from ${notificationSeen} s where s.user_id = ${userId}), '-infinity'::timestamptz)`,
      actorHandle: users.handle,
      actorDisplayName: users.displayName,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(uploads, eq(uploads.id, notifications.uploadId))
    .where(
      and(
        eq(notifications.userId, userId),
        input.before === null ? undefined : sql`(${notifications.createdAt}, ${notifications.id}) < (${input.before.ts}::timestamptz, ${input.before.id}::uuid)`,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ ts: last.cursorTs, id: last.id }) : null;
  if (page.length === 0) return { notifications: [], nextCursor };

  const noteIds = [...new Set(page.map(r => r.noteId))];
  const readable = new Map<string, string>();
  for (const a of await accessRowsFor(db, userId, noteIds)) {
    if (noteAccessFromRow(a, userId).permissions.read) readable.set(a.id, a.title);
  }
  const openIds = page.flatMap(r => (r.commentId !== null && readable.has(r.noteId) ? [r.commentId] : []));
  const excerpts = new Map<string, string>();
  if (openIds.length > 0) {
    const found = await db
      .select({ id: noteComments.id, excerpt: sql<string>`left(${noteComments.body}, ${NOTIFICATION_EXCERPT_MAX})` })
      .from(noteComments)
      .where(inArray(noteComments.id, openIds));
    for (const f of found) excerpts.set(f.id, f.excerpt);
  }
  const commentRows = page.filter(r => r.kind !== "upload_finished");
  const avatars: Map<string, AvatarRef> = await readAvatarRefs(db, [...new Set(commentRows.map(r => r.actorId))]);

  return {
    notifications: page.map((r): NotificationDto => {
      const title = readable.get(r.noteId);
      const open = title !== undefined;
      if (r.kind === "upload_finished") {
        return {
          id: r.id,
          kind: "upload_finished",
          createdAt: r.createdAt.toISOString(),
          canOpen: open,
          noteId: open ? r.noteId : null,
          noteTitle: open ? title : null,
          blockId: open ? r.blockId : null,
          fileName: r.uploadFileName ?? uploadServedName(null, r.uploadMime ?? "", r.uploadId!),
          isNew: r.isNew,
        };
      }
      return {
        id: r.id,
        kind: r.kind as CommentNotificationDto["kind"],
        agentLabel: r.agentLabel,
        actor: {
          userId: r.actorId,
          handle: r.actorHandle,
          displayName: r.actorDisplayName,
          avatar: avatars.get(r.actorId) ?? null,
          agentLabel: r.actorAgentLabel,
        },
        createdAt: r.createdAt.toISOString(),
        canOpen: open,
        noteId: open ? r.noteId : null,
        noteTitle: open ? title : null,
        commentId: open ? r.commentId : null,
        excerpt: open && r.commentId !== null ? (excerpts.get(r.commentId) ?? "") : null,
        isNew: r.isNew,
      };
    }),
    nextCursor,
  };
}

export interface AgentNotificationRow {
  id: string;
  kind: CommentNotificationDto["kind"];
  noteId: string;
  commentId: string;
  actorHandle: string;
  actorAgentLabel: string | null;
  createdAt: Date;
  cursor: CommentCursor;
  /** Null when the caller can't read the note any more. */
  noteTitle: string | null;
}

/**
 * Up to `max` of the comment rows addressed to exactly `agentLabel` (null: the person), oldest first, after `after` and at least the agent lag
 * ago, whether or not the caller can still read their notes; `hasMore` when more such rows wait. Upload rows are the person's own trace,
 * never addressed to an agent, so they are left out even for the person.
 */
export async function scanAgentNotifications(
  db: DbOrTx,
  input: { userId: string; agentLabel: string | null; after: CommentCursor | null; max: number },
): Promise<{ rows: AgentNotificationRow[]; hasMore: boolean }> {
  const { userId } = input;
  const fetched = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      noteId: notifications.noteId,
      commentId: notifications.commentId,
      actorAgentLabel: notifications.actorAgentLabel,
      createdAt: notifications.createdAt,
      cursorTs: cursorTsSql,
      actorHandle: users.handle,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.actorId))
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.kind, ["mention", "reply"]),
        input.agentLabel === null ? isNull(notifications.agentLabel) : eq(notifications.agentLabel, input.agentLabel),
        input.after === null ? undefined : sql`(${notifications.createdAt}, ${notifications.id}) > (${input.after.ts}::timestamptz, ${input.after.id}::uuid)`,
        agentLagSql(notifications.createdAt),
      ),
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(input.max + 1);
  const page = fetched.slice(0, input.max);
  const titles = new Map<string, string>();
  if (page.length > 0) {
    for (const a of await accessRowsFor(db, userId, [...new Set(page.map(r => r.noteId))])) {
      if (noteAccessFromRow(a, userId).permissions.read) titles.set(a.id, a.title);
    }
  }
  return {
    rows: page.map(r => ({
      id: r.id,
      kind: r.kind as CommentNotificationDto["kind"],
      noteId: r.noteId,
      // notifications_comment_kind_chk: mention and reply rows always have one.
      commentId: r.commentId!,
      actorHandle: r.actorHandle,
      actorAgentLabel: r.actorAgentLabel,
      createdAt: r.createdAt,
      cursor: { ts: r.cursorTs, id: r.id },
      noteTitle: titles.get(r.noteId) ?? null,
    })),
    hasMore: fetched.length > input.max,
  };
}

/** Rows newer than the last time the panel was opened; every row while it never was. */
export async function countUnreadNotifications(db: DbOrTx, userId: string): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`
    select count(*) as n
      from ${notifications} n
     where n.user_id = ${userId}
       and n.created_at > coalesce((select s.seen_at from ${notificationSeen} s where s.user_id = ${userId}), '-infinity'::timestamptz)
  `);
  return Number(res.rows[0]?.n ?? 0);
}

/** Same clock as `notifications.created_at`, so a notification written after this call is newer than the marker. */
export async function markNotificationsSeen(db: DbOrTx, userId: string): Promise<void> {
  await db
    .insert(notificationSeen)
    .values({ userId, seenAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({ target: notificationSeen.userId, set: { seenAt: sql`clock_timestamp()` } });
}

/** Only the caller's own row; false when there is none. */
export async function deleteNotification(db: DbOrTx, userId: string, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const gone = await db
    .delete(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });
  return gone.length > 0;
}

export async function clearNotifications(db: DbOrTx, userId: string): Promise<void> {
  await db.delete(notifications).where(eq(notifications.userId, userId));
}
