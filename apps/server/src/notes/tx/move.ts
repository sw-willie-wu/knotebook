/**
 * Lock order: source note FOR UPDATE → target groups FOR KEY SHARE → target folder FOR KEY SHARE (an exception to the global order: the source is always personal and the target a group folder, so it isn't in any group-space folder transaction's note set).
 * The groups lock excludes `lockGroup` (delete group, member and role changes), so the membership read holds until commit; it doesn't block group renames (a non-key UPDATE is FOR NO KEY UPDATE; a test guards that FOR SHARE would stall it). Every write that changes existing membership or role flags must `lockGroup` first (`POST …/roles` only adds roles nobody holds, so it's exempt).
 * The space lock (`assertSpaceRoomInTx`) comes after the row locks above and before the shares delete and the group-scope slug write; no lock when the attachments total 0 (the source personal space only shrinks).
 * `uploads.charged_to_id` → the mover is set after `writeSlugInTx` returns, outside its callback: the callback re-runs after a savepoint rollback on a slug collision and this must run once. All attachments are charged to the mover regardless of uploader (the caller is the owner). It adds only the held note's uploads rows and the `users` FK KEY SHARE after the space lock.
 * Not the caller's personal note any more → 409 `conflict`. Only the current slug gets a redirect (`/n/<handle>/<old slug>`).
 * A delete-group racing this: the KEY SHARE waits for the delete to commit → 0 rows → 404. After the lock the group can't be deleted, so the UPDATE can't hit FK 23503; the `charged_to_id` → users FK only fires if the mover's account is hard-deleted mid-transaction (no such path in `src/`). The 23503 → 404 mapping in `notes/move-note.ts` is defence in depth.
 * Tag rows come last and only in the target group's space (after the groups lock), so they add no edge to this order. The tag upsert locks the target tags in `name_key` order, so two notes moving into one group with the same tag names can't wait on each other in opposite orders.
 * The comment and read-marker deletes come last, after the note lock, and add no lock edge.
 * No cycle with `lockGroup` paths: none of them locks a personal note after taking the groups lock, and the UPDATE's FK check would take this KEY SHARE anyway (we take it earlier).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups, noteCommentReads, noteComments, noteShares, notes, notifications, uploads } from "../../db/schema.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../../folders/messages.js";
import { lockFolderInTx } from "../../folders/tx/lock.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { sumUploadSizeSql } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";
import { moveNoteTagsInTx } from "../../tags/tx/space-change.js";
import { userNotePath } from "../redirects.js";
import { recordRedirectsInTx } from "./redirects.js";
import { clearPendingVersionStateInTx, resetNoteVersionsInTx } from "./versions.js";
import { writeSlugInTx } from "./write-slug.js";

export interface MoveNoteInput {
  noteId: string;
  userId: string;
  /** `request.user.handle`, already normalized (redirect key); the transaction must not query users. */
  userHandle: string;
  /** Lowercased: compared with `!==` against `folder.groupId`. */
  groupId: string;
  /** Caller checked visibility and group; null = group root. */
  folderId: string | null;
  lockTimeoutMs: number;
  /** true = keep the note's versions and comments; anything else clears them. */
  keepHistory?: boolean;
}

export async function moveNoteToGroupInTx(tx: Tx, input: MoveNoteInput, hook?: GroupTestHook): Promise<{ removedShareUserIds: string[]; clearedNotificationUserIds: string[] }> {
  const [row] = await tx
    .select({ ownerId: notes.ownerId, slug: notes.slug })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .for("update");
  if (!row) throw new TxAbort(404, "not_found", "No note with that id.");
  // The owner is the caller ⇒ a personal note (`notes_owner_xor_group_chk`): no group_id check needed.
  if (row.ownerId !== input.userId) throw new TxAbort(409, "conflict", "The note's owner or group changed. Reload and try again.");

  const [target] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)).for("key share");
  const [member] = await tx
    .select({ canCreate: groupRoles.canCreate, canEdit: groupRoles.canEdit })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
    .limit(1);
  if (!target && input.folderId !== null) throw new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  if (!target || !member || !member.canCreate) throw new TxAbort(404, "group_not_found", "No group with that id.");
  if (input.folderId !== null) {
    if (!member.canEdit) throw new TxAbort(403, "forbidden", NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE);
    const folder = await lockFolderInTx(tx, input.folderId, "key share");
    if (!folder || folder.kind !== "group" || folder.groupId !== input.groupId) throw new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  }
  await hook?.("note-move-locked", { noteId: input.noteId, groupId: input.groupId });

  // The note is held FOR UPDATE, which blocks uploads (they take KEY SHARE on it), so this sum is final.
  const [sized] = await tx.select({ incoming: sumUploadSizeSql() }).from(uploads).where(eq(uploads.noteId, input.noteId));
  await assertSpaceRoomInTx(tx, { kind: "group", id: input.groupId }, sized?.incoming ?? 0, {
    lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { noteId: input.noteId, groupId: input.groupId },
  });

  const removed = await tx.delete(noteShares).where(eq(noteShares.noteId, input.noteId)).returning({ userId: noteShares.userId });

  await writeSlugInTx(
    tx,
    { groupId: input.groupId },
    { base: row.slug },
    async slug => {
      await tx
        .update(notes)
        // folder_id is written explicitly (null = group root), not left to the trigger; updated_at is deliberately untouched.
        .set({ ownerId: null, groupId: input.groupId, folderId: input.folderId, slug, prevSlug: null, publicToken: null, publicSlug: null })
        .where(eq(notes.id, input.noteId));
    },
    { excludeNoteId: input.noteId, beforeWrite: slug => hook?.("note-move-slug-candidate", { noteId: input.noteId, groupId: input.groupId, slug }) },
  );

  await tx.update(uploads).set({ chargedToId: input.userId }).where(eq(uploads.noteId, input.noteId));
  await moveNoteTagsInTx(tx, { noteId: input.noteId, source: { kind: "personal", ownerId: input.userId }, target: { kind: "group", groupId: input.groupId }, createdBy: input.userId });

  await recordRedirectsInTx(tx, [userNotePath(input.userHandle, row.slug)], input.noteId);
  // Unless the mover chose to keep them, versions and editors from the personal period must not be exposed to group editors.
  let clearedNotificationUserIds: string[] = [];
  if (input.keepHistory === true) await clearPendingVersionStateInTx(tx, input.noteId);
  else {
    await resetNoteVersionsInTx(tx, { noteId: input.noteId });
    // Comments follow the same choice (mentions, notified rows and notifications cascade). A post that raced the move committed before the note lock was granted, so it is deleted too.
    // The cascade below does not report which rows it removed, so the owners are read first.
    clearedNotificationUserIds = (await tx.selectDistinct({ userId: notifications.userId }).from(notifications).where(eq(notifications.noteId, input.noteId))).map(r => r.userId);
    await tx.delete(noteComments).where(eq(noteComments.noteId, input.noteId));
    await tx.delete(noteCommentReads).where(eq(noteCommentReads.noteId, input.noteId));
  }
  return { removedShareUserIds: removed.map(r => r.userId), clearedNotificationUserIds };
}
