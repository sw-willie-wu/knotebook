/**
 * 舊碼複本（資料夾 spec docs/superpowers/specs/2026-10-22-folders-design.md §7【推-4】）：回滾到 0034 之前的版本時，舊碼的
 * 移入群組、刪群組轉移與全刪、還原在新 schema 上必須照跑、不 500（trigger 只走自癒分支）。`folders-groups.test.ts` FG-OLD 用。
 * 出處：commit 4a7e0c1（feat/folders，資料夾 PR-3a 的 base）——
 *   `apps/server/src/notes/tx/move.ts` `moveNoteToGroupInTx`、`apps/server/src/groups/tx/delete-group.ts` `transferGroupInTx`／
 *   `deleteGroupWithNotesInTx`、`apps/server/src/notes/tx/trash.ts` `restoreNotesInTx`（與它用的 `lockNotes`／`classifyTrashed`）。
 * 函式本體逐句照抄，只改名（加 `legacy` 前綴）、import 指回 src、輸入型別就地宣告；註解從略。不得為了配合新 schema 改語句。
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { TrashSkipDto } from "@knotebook/shared";
import type { Tx } from "../src/db/tx.js";
import { groupMembers, groupRoles, groups, noteShares, notes, uploads } from "../src/db/schema.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, lockGroup } from "../src/groups/queries.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { TxAbort } from "../src/http/tx-abort.js";
import { groupNotePath, userNotePath } from "../src/notes/redirects.js";
import { trashedAccessQuery, trashRightFromRow } from "../src/notes/service.js";
import { deleteNotesInTx } from "../src/notes/tx/delete-notes.js";
import { recordRedirectsInTx } from "../src/notes/tx/redirects.js";
import { resetNoteVersionsInTx } from "../src/notes/tx/versions.js";
import { writeSlugInTx } from "../src/notes/tx/write-slug.js";
import { sumUploadSizeSql } from "../src/storage/space.js";
import { assertSpaceRoomInTx } from "../src/storage/tx/quota.js";

// ---- notes/tx/move.ts @ 4a7e0c1 ----

export interface LegacyMoveNoteInput {
  noteId: string;
  userId: string;
  userHandle: string;
  groupId: string;
  lockTimeoutMs: number;
}

export async function legacyMoveNoteToGroupInTx(tx: Tx, input: LegacyMoveNoteInput, hook?: GroupTestHook): Promise<{ removedShareUserIds: string[] }> {
  const [row] = await tx
    .select({ ownerId: notes.ownerId, slug: notes.slug })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .for("update");
  if (!row) throw new TxAbort(404, "not_found", "No note with that id.");
  if (row.ownerId !== input.userId) throw new TxAbort(409, "conflict", "The note's owner or group changed. Reload and try again.");

  const [target] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)).for("key share");
  const [member] = await tx
    .select({ canCreate: groupRoles.canCreate })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
    .limit(1);
  if (!target || !member || !member.canCreate) throw new TxAbort(404, "group_not_found", "No group with that id.");
  await hook?.("note-move-locked", { noteId: input.noteId, groupId: input.groupId });

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
        .set({ ownerId: null, groupId: input.groupId, slug, prevSlug: null, publicToken: null, publicSlug: null })
        .where(eq(notes.id, input.noteId));
    },
    { excludeNoteId: input.noteId, beforeWrite: slug => hook?.("note-move-slug-candidate", { noteId: input.noteId, groupId: input.groupId, slug }) },
  );

  await tx.update(uploads).set({ chargedToId: input.userId }).where(eq(uploads.noteId, input.noteId));

  await recordRedirectsInTx(tx, [userNotePath(input.userHandle, row.slug)], input.noteId);
  await resetNoteVersionsInTx(tx, { noteId: input.noteId });
  return { removedShareUserIds: removed.map(r => r.userId) };
}

// ---- groups/tx/delete-group.ts @ 4a7e0c1 ----

export interface LegacyTransferGroupInput {
  groupId: string;
  transferTo: string;
  lockTimeoutMs: number;
}

export interface LegacyGroupDeletionResult {
  noteIds: string[];
  memberIds: string[];
}

export async function legacyTransferGroupInTx(tx: Tx, input: LegacyTransferGroupInput, hook?: GroupTestHook): Promise<LegacyGroupDeletionResult> {
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
  const locked = await tx
    .select({ id: notes.id, slug: notes.slug, createdUs: sql<string>`(extract(epoch from ${notes.createdAt}) * 1000000)::bigint` })
    .from(notes)
    .where(eq(notes.groupId, input.groupId))
    .orderBy(asc(notes.id))
    .for("update");
  const rows = locked
    .map(r => ({ ...r, us: BigInt(r.createdUs) }))
    .sort((x, y) => (x.us < y.us ? -1 : x.us > y.us ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const [sumRow] = await tx
    .select({ incoming: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .where(eq(notes.groupId, input.groupId));
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.transferTo }, sumRow?.incoming ?? 0, {
    lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { groupId: input.groupId },
  });

  await resetNoteVersionsInTx(tx, { groupId: input.groupId });

  for (const row of rows) {
    await writeSlugInTx(
      tx,
      { ownerId: input.transferTo },
      { base: row.slug },
      async slug => {
        await tx
          .update(notes)
          .set({ groupId: null, ownerId: input.transferTo, slug, prevSlug: null, publicToken: null, publicSlug: null })
          .where(eq(notes.id, row.id));
      },
      { excludeNoteId: row.id, beforeWrite: slug => hook?.("group-transfer-slug-candidate", { noteId: row.id, groupId: input.groupId, slug }) },
    );
    await recordRedirectsInTx(tx, [groupNotePath(input.groupId, row.slug)], row.id);
  }

  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds: rows.map(r => r.id), memberIds: members.map(m => m.userId) };
}

export async function legacyDeleteGroupWithNotesInTx(
  tx: Tx,
  input: { groupId: string },
  hook?: GroupTestHook,
): Promise<LegacyGroupDeletionResult & { uploadIds: string[] }> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });
  const rows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.groupId, input.groupId)).orderBy(asc(notes.id)).for("update");
  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  const noteIds = rows.map(r => r.id);
  const uploadIds = await deleteNotesInTx(tx, noteIds);
  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds, memberIds: members.map(m => m.userId), uploadIds };
}

// ---- notes/tx/trash.ts @ 4a7e0c1 ----

export interface LegacyTrashIdsInput { ids: readonly string[]; by: string }
export interface LegacyTrashBatchOutcome { done: string[]; skipped: TrashSkipDto[] }

async function legacyLockNotes(tx: Tx, ids: readonly string[]): Promise<Map<string, Date | null>> {
  const rows = await tx
    .select({ id: notes.id, deletedAt: notes.deletedAt })
    .from(notes)
    .where(inArray(notes.id, [...ids]))
    .orderBy(asc(notes.id))
    .for("update");
  return new Map(rows.map(r => [r.id, r.deletedAt]));
}

async function legacyClassifyTrashed(tx: Tx, input: LegacyTrashIdsInput, locked: Map<string, Date | null>): Promise<{ ok: string[]; skipped: TrashSkipDto[] }> {
  const ok: string[] = [];
  const skipped: TrashSkipDto[] = [];
  for (const id of input.ids) {
    if (!locked.has(id)) skipped.push({ id, reason: "not_found" });
    else if (locked.get(id) === null) skipped.push({ id, reason: "not_in_trash" });
    else if (!trashRightFromRow((await trashedAccessQuery(tx, input.by, id))[0], input.by)) skipped.push({ id, reason: "not_found" });
    else ok.push(id);
  }
  return { ok, skipped };
}

export async function legacyRestoreNotesInTx(tx: Tx, input: LegacyTrashIdsInput, hook?: GroupTestHook): Promise<LegacyTrashBatchOutcome> {
  if (input.ids.length === 0) return { done: [], skipped: [] };
  const locked = await legacyLockNotes(tx, input.ids);
  await hook?.("note-restore-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await legacyClassifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped };
  const rows = await tx
    .update(notes)
    .set({ deletedAt: null, deletedBy: null })
    .where(and(inArray(notes.id, ok), isNotNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  return { done: ok.filter(id => hit.has(id)), skipped };
}
