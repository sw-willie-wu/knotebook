import { and, asc, desc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { AvatarRef, CommentDto, CommentListDto, CommentMentionDto } from "@knotebook/shared";
import { readAvatarRefs } from "../avatars/read.js";
import type { DbOrTx } from "../db/tx.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { noteCommentMentions, noteCommentReads, noteComments, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";

/** Code points, as for the notification excerpt. */
export const COMMENT_EXCERPT_MAX = 120;
export const COMMENT_PAGE_DEFAULT = 50;
export const COMMENT_PAGE_MAX = 100;

/**
 * `ts` is the microsecond text of `created_at`: a JavaScript Date keeps milliseconds only, and comments written in the same
 * millisecond must keep their order across pages.
 */
export interface CommentCursor {
  ts: string;
  id: string;
}

const CURSOR_TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

export const encodeCursor = (c: CommentCursor): string => Buffer.from(JSON.stringify([c.ts, c.id]), "utf8").toString("base64url");

export function decodeCursor(raw: string): CommentCursor | null {
  if (raw.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ts, id] = parsed as unknown[];
    if (typeof ts !== "string" || typeof id !== "string" || !CURSOR_TS_RE.test(ts) || !UUID_RE.test(id)) return null;
    // Millisecond part only: Date can't hold the microseconds, but it does reject dates that don't exist (02-31, month 99).
    if (ts.startsWith("0000") || new Date(ts).toISOString() !== `${ts.slice(0, 23)}Z`) return null;
    return { ts, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

export type CommentPageRequest =
  | { kind: "newest" }
  | { kind: "before"; cursor: CommentCursor }
  | { kind: "after"; cursor: CommentCursor }
  | { kind: "around"; commentId: string };

/** What the caller may do with comments they didn't write; `access.permissions.delete` of the note, resolved by the route. */
export interface CommentViewer {
  userId: string;
  isSiteAdmin: boolean;
  canDeleteOthers: boolean;
}

const cursorTsSql = sql<string>`to_char(${noteComments.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const rowSelect = {
  id: noteComments.id,
  noteId: noteComments.noteId,
  authorId: noteComments.authorId,
  authorHandle: users.handle,
  authorDisplayName: users.displayName,
  agentLabel: noteComments.agentLabel,
  replyToId: noteComments.replyToId,
  anchorBlockId: noteComments.anchorBlockId,
  anchorQuote: noteComments.anchorQuote,
  body: noteComments.body,
  createdAt: noteComments.createdAt,
  editedAt: noteComments.editedAt,
  cursorTs: cursorTsSql,
};

interface CommentRow {
  id: string;
  noteId: string;
  authorId: string;
  authorHandle: string;
  authorDisplayName: string;
  agentLabel: string | null;
  replyToId: string | null;
  anchorBlockId: string | null;
  anchorQuote: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  cursorTs: string;
}

const cursorOf = (row: { cursorTs: string; id: string }): CommentCursor => ({ ts: row.cursorTs, id: row.id });

const afterSql = (c: CommentCursor): SQL => sql`(${noteComments.createdAt}, ${noteComments.id}) > (${c.ts}::timestamptz, ${c.id}::uuid)`;
const beforeSql = (c: CommentCursor): SQL => sql`(${noteComments.createdAt}, ${noteComments.id}) < (${c.ts}::timestamptz, ${c.id}::uuid)`;

async function fetchRows(db: DbOrTx, noteId: string, extra: SQL | undefined, order: "asc" | "desc", limit: number): Promise<CommentRow[]> {
  const rows = await db
    .select(rowSelect)
    .from(noteComments)
    .innerJoin(users, eq(users.id, noteComments.authorId))
    .where(and(eq(noteComments.noteId, noteId), extra))
    .orderBy(...(order === "asc" ? [asc(noteComments.createdAt), asc(noteComments.id)] : [desc(noteComments.createdAt), desc(noteComments.id)]))
    .limit(limit);
  return rows as CommentRow[];
}

async function existsBeyond(db: DbOrTx, noteId: string, from: CommentCursor, direction: "older" | "newer"): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(noteComments)
    .where(and(eq(noteComments.noteId, noteId), direction === "older" ? beforeSql(from) : afterSql(from)))
    .limit(1);
  return rows.length > 0;
}

const excerptOf = (body: string): string => [...body].slice(0, COMMENT_EXCERPT_MAX).join("");

/** Rows of one note, in the order given. Access to the note is the caller's to have checked. */
async function toDtos(db: DbOrTx, rows: readonly CommentRow[], viewer: CommentViewer): Promise<CommentDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const noteId = rows[0]!.noteId;

  const mentionRows = await db
    .select({
      commentId: noteCommentMentions.commentId,
      start: noteCommentMentions.start,
      length: noteCommentMentions.length,
      userId: noteCommentMentions.userId,
      handle: users.handle,
      displayName: users.displayName,
      agentLabel: noteCommentMentions.agentLabel,
    })
    .from(noteCommentMentions)
    .innerJoin(users, eq(users.id, noteCommentMentions.userId))
    .where(inArray(noteCommentMentions.commentId, ids))
    .orderBy(asc(noteCommentMentions.start));

  const replyIds = [...new Set(rows.flatMap(r => (r.replyToId === null ? [] : [r.replyToId])))];
  const answered = new Map<string, { id: string; authorHandle: string; excerpt: string }>();
  if (replyIds.length > 0) {
    const found = await db
      .select({ id: noteComments.id, body: noteComments.body, authorHandle: users.handle })
      .from(noteComments)
      .innerJoin(users, eq(users.id, noteComments.authorId))
      .where(and(eq(noteComments.noteId, noteId), inArray(noteComments.id, replyIds)));
    for (const f of found) answered.set(f.id, { id: f.id, authorHandle: f.authorHandle, excerpt: excerptOf(f.body) });
  }

  const avatars: Map<string, AvatarRef> = await readAvatarRefs(db, [...rows.map(r => r.authorId), ...mentionRows.map(m => m.userId)]);
  const mentionsOf = new Map<string, CommentMentionDto[]>();
  for (const m of mentionRows) {
    const list = mentionsOf.get(m.commentId) ?? [];
    list.push({
      start: m.start,
      length: m.length,
      userId: m.userId,
      handle: m.handle,
      displayName: m.displayName,
      avatar: avatars.get(m.userId) ?? null,
      agentLabel: m.agentLabel,
    });
    mentionsOf.set(m.commentId, list);
  }

  return rows.map(r => {
    const own = r.authorId === viewer.userId;
    return {
      id: r.id,
      noteId: r.noteId,
      authorId: r.authorId,
      authorHandle: r.authorHandle,
      authorDisplayName: r.authorDisplayName,
      authorAvatar: avatars.get(r.authorId) ?? null,
      agentLabel: r.agentLabel,
      replyToId: r.replyToId,
      replyTo: r.replyToId === null ? null : (answered.get(r.replyToId) ?? null),
      anchor: r.anchorBlockId === null ? null : { blockId: r.anchorBlockId, quote: r.anchorQuote },
      body: r.body,
      mentions: mentionsOf.get(r.id) ?? [],
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt === null ? null : r.editedAt.toISOString(),
      canEdit: own,
      canDelete: own || viewer.canDeleteOthers || viewer.isSiteAdmin,
    };
  });
}

/**
 * Comments of a note, oldest first within the page. `limit` is already clamped to 1..COMMENT_PAGE_MAX. Null when `around` names a
 * comment that isn't on this note.
 */
export async function listComments(
  db: DbOrTx,
  input: { noteId: string; viewer: CommentViewer; request: CommentPageRequest; limit: number },
): Promise<CommentListDto | null> {
  const { noteId, limit, request } = input;
  let rows: CommentRow[];
  let olderCursor: CommentCursor | null = null;
  let newerCursor: CommentCursor | null = null;

  if (request.kind === "after") {
    const fetched = await fetchRows(db, noteId, afterSql(request.cursor), "asc", limit + 1);
    rows = fetched.slice(0, limit);
    if (rows.length > 0) {
      if (fetched.length > limit) newerCursor = cursorOf(rows[rows.length - 1]!);
      if (await existsBeyond(db, noteId, cursorOf(rows[0]!), "older")) olderCursor = cursorOf(rows[0]!);
    }
  } else if (request.kind === "around") {
    const [target] = await fetchRows(db, noteId, eq(noteComments.id, request.commentId), "asc", 1);
    if (!target) return null;
    const at = cursorOf(target);
    const room = limit - 1;
    const [olderRows, newerRows] = await Promise.all([
      fetchRows(db, noteId, beforeSql(at), "desc", room + 1),
      fetchRows(db, noteId, afterSql(at), "asc", room + 1),
    ]);
    // Half each side; whatever one side can't fill goes to the other.
    const wantOlder = Math.floor(room / 2);
    const availOlder = Math.min(olderRows.length, room);
    const availNewer = Math.min(newerRows.length, room);
    const takeOlder = Math.min(availOlder, Math.max(wantOlder, room - availNewer));
    const takeNewer = Math.min(availNewer, room - takeOlder);
    rows = [...olderRows.slice(0, takeOlder).reverse(), target, ...newerRows.slice(0, takeNewer)];
    if (olderRows.length > takeOlder) olderCursor = cursorOf(rows[0]!);
    if (newerRows.length > takeNewer) newerCursor = cursorOf(rows[rows.length - 1]!);
  } else {
    const fetched = await fetchRows(db, noteId, request.kind === "before" ? beforeSql(request.cursor) : undefined, "desc", limit + 1);
    rows = fetched.slice(0, limit).reverse();
    if (rows.length > 0) {
      if (fetched.length > limit) olderCursor = cursorOf(rows[0]!);
      if (request.kind === "before" && (await existsBeyond(db, noteId, cursorOf(rows[rows.length - 1]!), "newer"))) {
        newerCursor = cursorOf(rows[rows.length - 1]!);
      }
    }
  }

  return {
    comments: await toDtos(db, rows, input.viewer),
    olderCursor: olderCursor === null ? null : encodeCursor(olderCursor),
    newerCursor: newerCursor === null ? null : encodeCursor(newerCursor),
  };
}

/**
 * How far an agent's `since` reads stay behind the clock: `created_at` is taken at insert, so a write that commits a moment later than a
 * newer one would otherwise land behind a cursor that already passed it.
 */
export const AGENT_READ_LAG_SECONDS = 2;

export const agentLagSql = (createdAt: AnyColumn): SQL => sql`${createdAt} <= now() - ${`${AGENT_READ_LAG_SECONDS} seconds`}::interval`;

/** Comments created after `after` and at least the agent lag ago, oldest first. Access to the note is the caller's to have checked. */
export async function listCommentsForAgent(
  db: DbOrTx,
  input: { noteId: string; after: CommentCursor | null; limit: number; viewer: CommentViewer },
): Promise<{ comments: CommentDto[]; cursors: CommentCursor[]; hasMore: boolean }> {
  const fetched = await fetchRows(db, input.noteId, and(input.after === null ? undefined : afterSql(input.after), agentLagSql(noteComments.createdAt)), "asc", input.limit + 1);
  const rows = fetched.slice(0, input.limit);
  return { comments: await toDtos(db, rows, input.viewer), cursors: rows.map(cursorOf), hasMore: fetched.length > input.limit };
}

export type MentionView = Pick<CommentMentionDto, "start" | "length" | "handle" | "agentLabel">;

/** Body and mentions (current handles) of each comment that still exists. Access is the caller's to have checked. */
export async function commentBodiesByIds(db: DbOrTx, ids: readonly string[]): Promise<Map<string, { body: string; mentions: MentionView[] }>> {
  const out = new Map<string, { body: string; mentions: MentionView[] }>();
  if (ids.length === 0) return out;
  const bodies = await db.select({ id: noteComments.id, body: noteComments.body }).from(noteComments).where(inArray(noteComments.id, [...ids]));
  for (const b of bodies) out.set(b.id, { body: b.body, mentions: [] });
  const mentionRows = await db
    .select({ commentId: noteCommentMentions.commentId, start: noteCommentMentions.start, length: noteCommentMentions.length, handle: users.handle, agentLabel: noteCommentMentions.agentLabel })
    .from(noteCommentMentions)
    .innerJoin(users, eq(users.id, noteCommentMentions.userId))
    .where(inArray(noteCommentMentions.commentId, [...ids]))
    .orderBy(asc(noteCommentMentions.start));
  for (const m of mentionRows) out.get(m.commentId)?.mentions.push({ start: m.start, length: m.length, handle: m.handle, agentLabel: m.agentLabel });
  return out;
}

/** The note a comment is on, or null; the route authorizes against that note before it shows anything. */
export async function commentNoteId(db: DbOrTx, commentId: string): Promise<string | null> {
  if (!UUID_RE.test(commentId)) return null;
  const [row] = await db.select({ noteId: noteComments.noteId }).from(noteComments).where(eq(noteComments.id, commentId));
  return row?.noteId ?? null;
}

/** Access to the comment's note is the caller's to have checked. */
export async function getComment(db: DbOrTx, commentId: string, viewer: CommentViewer): Promise<CommentDto | null> {
  if (!UUID_RE.test(commentId)) return null;
  const rows = await db
    .select(rowSelect)
    .from(noteComments)
    .innerJoin(users, eq(users.id, noteComments.authorId))
    .where(eq(noteComments.id, commentId));
  return (await toDtos(db, rows as CommentRow[], viewer))[0] ?? null;
}

/** Other people's comments after the caller's marker; every one of them while the caller has never opened the note's comments. */
export async function countUnreadComments(db: DbOrTx, input: { noteId: string; userId: string }): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`
    select count(*) as n
      from ${noteComments} c
     where c.note_id = ${input.noteId}
       and c.author_id <> ${input.userId}
       and c.created_at > coalesce(
         (select r.read_at from ${noteCommentReads} r where r.user_id = ${input.userId} and r.note_id = ${input.noteId}),
         '-infinity'::timestamptz)
  `);
  return Number(res.rows[0]?.n ?? 0);
}

/** Same clock as `note_comments.created_at`, so a comment inserted after this call is always newer than the marker. False when the note is gone. */
export async function markCommentsRead(db: DbOrTx, input: { noteId: string; userId: string }): Promise<boolean> {
  try {
    await db
      .insert(noteCommentReads)
      .values({ userId: input.userId, noteId: input.noteId, readAt: sql`clock_timestamp()` })
      .onConflictDoUpdate({ target: [noteCommentReads.userId, noteCommentReads.noteId], set: { readAt: sql`clock_timestamp()` } });
    return true;
  } catch (err) {
    if (isForeignKeyViolation(err)) return false;
    throw err;
  }
}
