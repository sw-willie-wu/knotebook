/**
 * Lock order: groups → structure locks → folder rows → note rows → quota lock; group notes by ascending id, like trash move/restore/purge and `deleteNotesInTx`.
 * Transfer writes folders after the note locks on purpose: a group folder's FOR UPDATE is only taken by folder deletion, which first needs groups KEY SHARE
 * (blocked by `lockGroup`), and structure writes in the recipient's space take its structure lock first.
 * Every transaction touching group-space folders takes groups KEY SHARE first, so it conflicts with `lockGroup`: creates/moves/copies arriving after it wait,
 * then get 23503 or see the group gone → 404. Delete-all takes no quota lock. Roles and members go via FK CASCADE.
 * Tag rows come after the note locks, and only the recipient's personal tags are locked (the group's own tags are only read).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders, groupMembers, groupRoles, groups, notes, uploads } from "../../db/schema.js";
import { normalizeFolderNameLoose } from "../../folders/names.js";
import { lockFolderSpacesInTx } from "../../folders/tx/lock.js";
import { createSystemTopFolderInTx } from "../../folders/tx/system-top.js";
import { TxAbort } from "../../http/tx-abort.js";
import { groupNotePath } from "../../notes/redirects.js";
import { deleteNotesInTx } from "../../notes/tx/delete-notes.js";
import { recordRedirectsInTx } from "../../notes/tx/redirects.js";
import { resetNoteVersionsInTx } from "../../notes/tx/versions.js";
import { writeSlugInTx } from "../../notes/tx/write-slug.js";
import { moveGroupTagsToPersonalInTx } from "../../tags/tx/space-change.js";
import { sumUploadSizeSql } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, lockGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

export interface TransferGroupInput {
  groupId: string;
  transferTo: string;
  by: string;
  fallbackFolderName: string;
  lockTimeoutMs: number;
}

export interface GroupDeletionResult {
  noteIds: string[];
  /** Read before `DELETE groups` cascades them away. */
  memberIds: string[];
}

export async function transferGroupInTx(tx: Tx, input: TransferGroupInput, hook?: GroupTestHook): Promise<GroupDeletionResult> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  const [target] = await tx
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.transferTo)))
    .limit(1);
  if (target?.builtin !== "admin") throw new TxAbort(409, "not_admin", NOT_ADMIN_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });

  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  await lockFolderSpacesInTx(tx, [{ kind: "group", groupId: input.groupId }, { kind: "personal", ownerId: input.transferTo }], {
    lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { groupId: input.groupId },
  });
  // Processed in created_at, id order; created_at as a microsecond integer because JS Date is millisecond-only and would misorder ties, so collision suffixes are assigned deterministically.
  const locked = await tx
    .select({
      id: notes.id,
      slug: notes.slug,
      createdUs: sql<string>`(extract(epoch from ${notes.createdAt}) * 1000000)::bigint`,
      folderId: notes.folderId,
      // A stale snapshot on a live note (restored by older code during a rollback) doesn't count.
      trashedWithPath: sql<boolean>`${notes.trashFolderPath} is not null and ${notes.deletedAt} is not null`,
    })
    .from(notes)
    .where(eq(notes.groupId, input.groupId))
    .orderBy(asc(notes.id))
    .for("update");
  const rows = locked
    .map(r => ({ ...r, us: BigInt(r.createdUs) }))
    .sort((x, y) => (x.us < y.us ? -1 : x.us > y.us ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // The recipient's quota lock comes before the first writeSlugInTx (pinned by `storage-quota-race.test.ts`).
  // Rejection writes nothing. Incoming includes notes that entered after the gates (anything the group predicate locked).
  // SUM by group predicate, not `inArray(…, ids)`: a bind parameter per note exceeds the protocol limit (65535) for big groups.
  const [sumRow] = await tx
    .select({ incoming: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .where(eq(notes.groupId, input.groupId));
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.transferTo }, sumRow?.incoming ?? 0, {
    lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { groupId: input.groupId },
  });

  // By group predicate, before group_id changes; the group's tag rows are removed with the group below.
  await moveGroupTagsToPersonalInTx(tx, { groupId: input.groupId, ownerId: input.transferTo, createdBy: input.by });
  await resetNoteVersionsInTx(tx, { groupId: input.groupId });

  const [anyFolder] = await tx.select({ id: folders.id }).from(folders).where(eq(folders.groupId, input.groupId)).limit(1);
  const groupHasFolders = anyFolder !== undefined;
  let top: { id: string; name: string } | null = null;
  if (groupHasFolders || rows.some(r => r.folderId === null && r.trashedWithPath)) {
    const [g] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, input.groupId));
    const baseName = normalizeFolderNameLoose(g!.name, input.fallbackFolderName);
    top = await createSystemTopFolderInTx(tx, { ownerId: input.transferTo, baseName, by: input.by });
  }
  // One statement: the same-space trigger is AFTER ROW and checks at statement end; separate statements would see mixed spaces midway.
  if (top !== null && groupHasFolders) {
    await tx
      .update(folders)
      .set({ kind: "personal", ownerId: input.transferTo, groupId: null, parentId: sql`coalesce(${folders.parentId}, ${top.id}::uuid)` })
      .where(eq(folders.groupId, input.groupId));
  }

  for (const row of rows) {
    // Root notes with a snapshot keep folder_id NULL; the snapshot is prefixed with the name actually written for the new top level (suffix included), so restore rebuilds the path under it.
    const place = row.folderId !== null || top === null
      ? {}
      : row.trashedWithPath
        ? { trashFolderPath: sql`jsonb_build_array(${top.name}::text) || ${notes.trashFolderPath}` }
        : { folderId: top.id };
    await writeSlugInTx(
      tx,
      { ownerId: input.transferTo },
      { base: row.slug },
      async slug => {
        await tx
          .update(notes)
          .set({ groupId: null, ownerId: input.transferTo, slug, prevSlug: null, publicToken: null, publicSlug: null, ...place })
          .where(eq(notes.id, row.id));
      },
      { excludeNoteId: row.id, beforeWrite: slug => hook?.("group-transfer-slug-candidate", { noteId: row.id, groupId: input.groupId, slug }) },
    );
    await recordRedirectsInTx(tx, [groupNotePath(input.groupId, row.slug)], row.id);
  }

  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds: rows.map(r => r.id), memberIds: members.map(m => m.userId) };
}

/**
 * Locks by group predicate, not the gated list, so notes that entered after the gates are included (an accepted cost), trashed group notes too. Gates are opened by the route before the transaction, not here. `deleteNotesInTx` re-locks them (#188), but this lock
 * stays so delete-all doesn't depend on no path moving a note out of a group without `lockGroup`.
 */
export async function deleteGroupWithNotesInTx(
  tx: Tx,
  input: { groupId: string; lockTimeoutMs: number },
  hook?: GroupTestHook,
): Promise<GroupDeletionResult & { uploadIds: string[] }> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });
  await lockFolderSpacesInTx(tx, [{ kind: "group", groupId: input.groupId }], {
    lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { groupId: input.groupId },
  });
  const rows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.groupId, input.groupId)).orderBy(asc(notes.id)).for("update");
  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  const noteIds = rows.map(r => r.id);
  const uploadIds = await deleteNotesInTx(tx, noteIds);
  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds, memberIds: members.map(m => m.userId), uploadIds };
}
