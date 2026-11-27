/**
 * Lock order, the same as tag writes (`lockNoteTagSpaceInTx`): the group's row FOR KEY SHARE (group notes), then the note row FOR KEY
 * SHARE with `deleted_at is null`, then (edit and delete) the comment row FOR UPDATE; mention, notified and notification rows come
 * last. Access is first read without locks to learn which space was authorized; a space that differs once the note is locked is a 409
 * `conflict` (the client retries and takes the group lock in order), and access is read again under the locks.
 * Move takes the note FOR UPDATE first; group delete takes the group row first, which a comment write on a group note also takes first.
 * So a racing write either commits before them or re-checks against the new audience. Content saves take FOR NO KEY UPDATE, which doesn't wait for KEY SHARE.
 * Comment writes never touch `notes.updated_at` or the Yjs document.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { BLOCK_ANCHOR_RE, COMMENT_BODY_MAX, COMMENT_QUOTE_MAX, TOP_SECTION_ID, type CommentAnchorDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { noteCommentMentions, noteComments } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { accessQuery, noteAccessFromRow, UUID_RE, type NoteAccess } from "../../notes/service.js";
import { hasUnstorableChar } from "../../oauth/storable.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../../tags/messages.js";
import type { TagSpace } from "../../tags/space.js";
import { lockNoteTagSpaceInTx } from "../../tags/tx/note-tags.js";
import {
  COMMENT_CONFLICT_MESSAGE,
  COMMENT_DELETE_FORBIDDEN_MESSAGE,
  COMMENT_EDIT_FORBIDDEN_MESSAGE,
  COMMENT_NOT_FOUND_MESSAGE,
  INVALID_COMMENT_ANCHOR_MESSAGE,
  INVALID_COMMENT_BODY_MESSAGE,
  INVALID_COMMENT_REPLY_MESSAGE,
} from "../messages.js";
import { resolveMentions, targetKey, type MentionTarget, type StoredMention } from "../mentions.js";
import { writeCommentNotifications } from "../notify.js";

export interface CommentActor {
  userId: string;
  tokenId: string | null;
  /** The token's label as shown elsewhere (explicit or derived); null for a person writing in the app. */
  agentLabel: string | null;
  isSiteAdmin: boolean;
}

export type NoteCommentRow = typeof noteComments.$inferSelect;

export interface CommentWriteResult {
  comment: NoteCommentRow;
  noteId: string;
  /** Distinct recipients of the notification rows this write created. */
  newNotificationUserIds: string[];
}

const codePointLength = (s: string): number => [...s].length;

function assertBody(body: string): void {
  const n = codePointLength(body);
  if (n < 1 || n > COMMENT_BODY_MAX || body.trim() === "" || hasUnstorableChar(body)) {
    throw new TxAbort(400, "invalid_comment", INVALID_COMMENT_BODY_MESSAGE);
  }
}

function assertAnchor(anchor: CommentAnchorDto): void {
  const quoteOk =
    anchor.quote === null ||
    (codePointLength(anchor.quote) >= 1 && codePointLength(anchor.quote) <= COMMENT_QUOTE_MAX && !hasUnstorableChar(anchor.quote));
  if (!BLOCK_ANCHOR_RE.test(anchor.blockId) || anchor.blockId === TOP_SECTION_ID || !quoteOk) {
    throw new TxAbort(400, "invalid_comment", INVALID_COMMENT_ANCHOR_MESSAGE);
  }
}

async function readAccess(tx: Tx, userId: string, noteId: string): Promise<NoteAccess> {
  return noteAccessFromRow((await accessQuery(tx, userId, noteId))[0], userId);
}

async function lockSpace(tx: Tx, noteId: string, authorized: NoteAccess): Promise<TagSpace | null> {
  const space = await lockNoteTagSpaceInTx(tx, noteId, { ownerId: authorized.ownerId, groupId: authorized.groupId });
  if (space === "not_found") return null;
  if (space === "conflict") throw new TxAbort(409, "conflict", COMMENT_CONFLICT_MESSAGE);
  return space;
}

async function loadMentions(tx: Tx, commentId: string): Promise<StoredMention[]> {
  return tx
    .select({ userId: noteCommentMentions.userId, agentLabel: noteCommentMentions.agentLabel, start: noteCommentMentions.start, length: noteCommentMentions.length })
    .from(noteCommentMentions)
    .where(eq(noteCommentMentions.commentId, commentId))
    .orderBy(asc(noteCommentMentions.start));
}

async function insertMentions(tx: Tx, commentId: string, mentions: readonly StoredMention[]): Promise<void> {
  if (mentions.length === 0) return;
  await tx.insert(noteCommentMentions).values(mentions.map(m => ({ commentId, ...m })));
}

function distinctTargets(mentions: readonly StoredMention[]): MentionTarget[] {
  const seen = new Map<string, MentionTarget>();
  for (const m of mentions) if (!seen.has(targetKey(m))) seen.set(targetKey(m), { userId: m.userId, agentLabel: m.agentLabel });
  return [...seen.values()];
}

/** Read access to the note. A Bearer caller's `notes:write` scope is the caller's to check. */
export async function postCommentInTx(
  tx: Tx,
  input: { noteId: string; actor: CommentActor; body: string; replyToId?: string | null; anchor?: CommentAnchorDto | null },
  hook?: GroupTestHook,
): Promise<CommentWriteResult> {
  const { noteId, actor } = input;
  assertBody(input.body);
  if (input.anchor) assertAnchor(input.anchor);
  const replyToId = input.replyToId ?? null;
  if (replyToId !== null && !UUID_RE.test(replyToId)) throw new TxAbort(400, "invalid_comment", INVALID_COMMENT_REPLY_MESSAGE);
  const notFound = new TxAbort(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  if (!UUID_RE.test(noteId)) throw notFound;

  const authorized = await readAccess(tx, actor.userId, noteId);
  if (!authorized.permissions.read) throw notFound;
  await hook?.("comment-authorized", { noteId });
  const space = await lockSpace(tx, noteId, authorized);
  if (space === null) throw notFound;
  await hook?.("comment-locked", { noteId });
  if (!(await readAccess(tx, actor.userId, noteId)).permissions.read) throw notFound;

  let replyTarget: MentionTarget | null = null;
  if (replyToId !== null) {
    const [answered] = await tx
      .select({ authorId: noteComments.authorId, agentLabel: noteComments.agentLabel })
      .from(noteComments)
      .where(and(eq(noteComments.id, replyToId), eq(noteComments.noteId, noteId)));
    if (!answered) throw new TxAbort(400, "invalid_comment", INVALID_COMMENT_REPLY_MESSAGE);
    replyTarget = { userId: answered.authorId, agentLabel: answered.agentLabel };
  }

  const mentions = await resolveMentions(tx, { body: input.body, space, noteId });
  const [comment] = await tx
    .insert(noteComments)
    .values({
      noteId,
      authorId: actor.userId,
      tokenId: actor.tokenId,
      agentLabel: actor.agentLabel,
      replyToId,
      anchorBlockId: input.anchor?.blockId ?? null,
      anchorQuote: input.anchor?.quote ?? null,
      body: input.body,
    })
    .returning();
  await insertMentions(tx, comment!.id, mentions);
  const newNotificationUserIds = await writeCommentNotifications(tx, {
    commentId: comment!.id,
    noteId,
    space,
    actor,
    mentionTargets: distinctTargets(mentions),
    replyTarget,
  });
  return { comment: comment!, noteId: comment!.noteId, newNotificationUserIds };
}

interface LockedComment {
  row: NoteCommentRow;
  space: TagSpace;
  access: NoteAccess;
}

/** Everything a caller can't see is the same 404 as a missing comment. */
async function lockCommentInTx(tx: Tx, commentId: string, actor: CommentActor, allowed: (row: NoteCommentRow, access: NoteAccess) => string | null, hook?: GroupTestHook): Promise<LockedComment> {
  const notFound = new TxAbort(404, "comment_not_found", COMMENT_NOT_FOUND_MESSAGE);
  if (!UUID_RE.test(commentId)) throw notFound;
  const [seen] = await tx.select({ noteId: noteComments.noteId }).from(noteComments).where(eq(noteComments.id, commentId));
  if (!seen) throw notFound;

  const authorized = await readAccess(tx, actor.userId, seen.noteId);
  if (!authorized.permissions.read) throw notFound;
  await hook?.("comment-authorized", { noteId: seen.noteId });
  const space = await lockSpace(tx, seen.noteId, authorized);
  if (space === null) throw notFound;
  const [row] = await tx.select().from(noteComments).where(eq(noteComments.id, commentId)).for("update");
  if (!row) throw notFound;
  await hook?.("comment-locked", { noteId: seen.noteId });
  const access = await readAccess(tx, actor.userId, seen.noteId);
  if (!access.permissions.read) throw notFound;
  const refusal = allowed(row, access);
  if (refusal !== null) throw new TxAbort(403, "forbidden", refusal);
  return { row, space, access };
}

/** The author only (same user, so a person may edit their agent's comments and the other way round). */
export async function editCommentInTx(
  tx: Tx,
  input: { commentId: string; actor: CommentActor; body: string },
  hook?: GroupTestHook,
): Promise<CommentWriteResult> {
  assertBody(input.body);
  const { row, space } = await lockCommentInTx(
    tx,
    input.commentId,
    input.actor,
    r => (r.authorId === input.actor.userId ? null : COMMENT_EDIT_FORBIDDEN_MESSAGE),
    hook,
  );
  if (row.body === input.body) return { comment: row, noteId: row.noteId, newNotificationUserIds: [] };

  const previous = { body: row.body, mentions: await loadMentions(tx, row.id) };
  const mentions = await resolveMentions(tx, { body: input.body, space, noteId: row.noteId, previous });
  const [comment] = await tx
    .update(noteComments)
    .set({ body: input.body, editedAt: sql`clock_timestamp()` })
    .where(eq(noteComments.id, row.id))
    .returning();
  await tx.delete(noteCommentMentions).where(eq(noteCommentMentions.commentId, row.id));
  await insertMentions(tx, row.id, mentions);
  // Only mentions: the comment it answers can't change on edit, and its author was considered when the comment was posted.
  const newNotificationUserIds = await writeCommentNotifications(tx, {
    commentId: row.id,
    noteId: row.noteId,
    space,
    actor: input.actor,
    mentionTargets: distinctTargets(mentions),
    replyTarget: null,
  });
  return { comment: comment!, noteId: row.noteId, newNotificationUserIds };
}

/** Mentions, notified rows and notifications go with the comment (FK cascade). */
export async function deleteCommentInTx(tx: Tx, input: { commentId: string; actor: CommentActor }, hook?: GroupTestHook): Promise<CommentWriteResult> {
  const { row } = await lockCommentInTx(
    tx,
    input.commentId,
    input.actor,
    (r, access) => (r.authorId === input.actor.userId || access.permissions.delete || input.actor.isSiteAdmin ? null : COMMENT_DELETE_FORBIDDEN_MESSAGE),
    hook,
  );
  await tx.delete(noteComments).where(eq(noteComments.id, row.id));
  return { comment: row, noteId: row.noteId, newNotificationUserIds: [] };
}
