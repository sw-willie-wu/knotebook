/**
 * Lock order: target groups KEY SHARE → target folder KEY SHARE → source note KEY SHARE (a personal target has no first lock; without `folderId`, no second). Only the source's own attachments are copied (others keep their URLs); missing files (ENOENT) are skipped; incoming counts only copied files, each once.
 * Groups before the source: if source and target are in the same group G, locking the source first and then taking G's KEY SHARE through the INSERT's FK check would cycle with "groups FOR UPDATE → that group's notes FOR UPDATE" (delete group, delete all): 40P01, pinned by `groups-v2-copy.test.ts`. The folder lock is explicit rather than the INSERT's implicit FK lock: a same-space copy has its source inside the folder's subtree, so taking it after the source would cycle with folder delete's "subtree folders FU → subtree notes FU".
 * The groups KEY SHARE excludes `lockGroup` (FOR UPDATE: delete/transfer group, member and role changes), so the membership read holds until commit (role changes `lockGroup` first: `groups-v2-roles-race.test.ts`). The same statement returns group name and role flags for the 201 response; the pre-transaction `loadCreateTarget` is only a fast 404. Once held, the group can't be deleted, so the INSERT can't hit FK 23503 (the route's 23503 → 404 is defence in depth).
 * The space lock comes after the row locks above and before the slug write; afterwards only locks that can't cycle are taken (new row, `users` FK KEY SHARE, rows already held, slug-index insert waits). No space lock when incoming is 0. Tag rows are locked after all of these, and only in the target space. The knowledge index locks come after the full-text index's and touch only the new note's own rows.
 * Other paths: move (note FU → groups KS) meets this only on the source row and then needs nothing exclusive from us; PATCH slug/delete lock only the note row; shares PUT (FOR SHARE) and group rename (NO KEY UPDATE) are compatible with KEY SHARE. A group folder's space is pinned by the groups KEY SHARE; a personal folder's space never changes.
 * Files are copied without holding the space lock; `copiedFileIds` is an out-parameter so the route can delete written files after a failure. The copy's `updated_at` takes the DB default (this transaction's `now()`, later than the source's; guarded by `test/unit/copy-doc.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as Y from "yjs";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups, noteStates, notes, uploads } from "../../db/schema.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../../folders/messages.js";
import { folderSpaceOfRow, sameFolderSpace, type FolderSpace } from "../../folders/space.js";
import { lockFolderInTx } from "../../folders/tx/lock.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import type { TagSpace } from "../../tags/space.js";
import { copyNoteTagsInTx } from "../../tags/tx/space-change.js";
import { uploadFilePath } from "../../uploads/service.js";
import type { StorageSpace } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";
import { rewriteUploadUrls, type CopyDoc } from "../copy-doc.js";
import { insertNoteWithAutoSlug, type NoteCreateHooks } from "../create.js";
import type { NoteGroupFlags } from "../service.js";
import type { SearchExtract } from "../search-text.js";
import type { SlugScope } from "../slug.js";
import { replaceNoteSearchIndexInTx, type SearchIndexHooks } from "./search-index.js";
import type { KnowledgeIndexExtract } from "../../knowledge/extract.js";
import { replaceNoteKnowledgeIndexInTx, type KnowledgeIndexHooks } from "../../knowledge/tx/index-write.js";

export interface CopyNoteInput {
  sourceId: string;
  userId: string;
  scope: SlugScope;
  /** Caller checked visibility and space outside the transaction (rechecked inside); null = root. */
  folderId: string | null;
  copy: CopyDoc;
  uploadsDir: string;
  copiedFileIds: string[];
  /** Extracted before the transaction from the clone; `rewriteUploadUrls` only changes `url` attributes, which aren't indexed. */
  searchExtract: SearchExtract;
  /** Same as `searchExtract`: `rewriteUploadUrls` only changes `url` attributes, which the knowledge index doesn't read. */
  knowledgeExtract: KnowledgeIndexExtract;
  lockTimeoutMs: number;
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

export interface CopyTargetInTx extends NoteGroupFlags {
  name: string;
}

export interface CopyNoteResult {
  note: typeof notes.$inferSelect;
  target: CopyTargetInTx | null;
}

export async function copyNoteInTx(tx: Tx, input: CopyNoteInput, hook?: GroupTestHook, createHooks?: NoteCreateHooks, searchHooks?: SearchIndexHooks, knowledgeHooks?: KnowledgeIndexHooks): Promise<CopyNoteResult> {
  let target: CopyTargetInTx | null = null;
  if ("groupId" in input.scope) {
    const groupId = input.scope.groupId;
    const [g] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId)).for("key share");
    const [member] = await tx
      .select({
        canRead: groupRoles.canRead,
        canCreate: groupRoles.canCreate,
        canEdit: groupRoles.canEdit,
        canDelete: groupRoles.canDelete,
        canManagePublicLink: groupRoles.canManagePublicLink,
      })
      .from(groupMembers)
      .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, input.userId)))
      .limit(1);
    if (!g && input.folderId !== null) throw new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!g || !member || !member.canCreate) throw new TxAbort(404, "group_not_found", "No group with that id.");
    if (input.folderId !== null && !member.canEdit) throw new TxAbort(403, "forbidden", NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE);
    target = { name: g.name, canRead: member.canRead, canEdit: member.canEdit, canDelete: member.canDelete, canManagePublicLink: member.canManagePublicLink };
    await hook?.("note-copy-target-locked", { noteId: input.sourceId, groupId });
  }

  if (input.folderId !== null) {
    const folder = await lockFolderInTx(tx, input.folderId, "key share");
    const wanted: FolderSpace = "groupId" in input.scope
      ? { kind: "group", groupId: input.scope.groupId }
      : { kind: "personal", ownerId: input.scope.ownerId };
    if (!folder || !sameFolderSpace(folderSpaceOfRow(folder), wanted)) throw new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    await hook?.("note-copy-folder-locked", { noteId: input.sourceId, folderId: input.folderId, ...("groupId" in input.scope ? { groupId: input.scope.groupId } : {}) });
  }

  const [src] = await tx.select({ id: notes.id, title: notes.title }).from(notes).where(and(eq(notes.id, input.sourceId), isNull(notes.deletedAt))).for("key share");
  if (!src) throw new TxAbort(404, "not_found", "No note with that id.");
  await hook?.("note-copy-locked", { noteId: input.sourceId });

  const wanted = [...input.copy.uploadNodes.keys()];
  const owned = wanted.length === 0 ? [] : await tx
    .select({ id: uploads.id, mime: uploads.mime, size: uploads.size })
    .from(uploads)
    .where(and(inArray(uploads.id, wanted), eq(uploads.noteId, input.sourceId)));

  // Record before copying: if `copyFile` fails midway (partial destination), the route's cleanup list still covers it.
  const copied: Array<{ newId: string; oldId: string; mime: string; size: number }> = [];
  for (const u of owned) {
    const newId = randomUUID();
    input.copiedFileIds.push(newId);
    try {
      await copyFile(uploadFilePath(input.uploadsDir, u.id), uploadFilePath(input.uploadsDir, newId));
    } catch (err) {
      if (isMissingFile(err)) {
        input.copiedFileIds.pop(); // source file missing: nothing to clean (`deleteUploadFiles` logs an error for nonexistent files)
        continue;
      }
      throw err;
    }
    copied.push({ newId, oldId: u.id, mime: u.mime, size: u.size });
  }
  await hook?.("note-copy-files-copied", { noteId: input.sourceId });

  const incoming = copied.reduce((sum, c) => sum + c.size, 0);
  const targetSpace: StorageSpace = "groupId" in input.scope ? { kind: "group", id: input.scope.groupId } : { kind: "user", id: input.scope.ownerId };
  await assertSpaceRoomInTx(tx, targetSpace, incoming, {
    lockTimeoutMs: input.lockTimeoutMs,
    hook,
    hookCtx: "groupId" in input.scope ? { noteId: input.sourceId, groupId: input.scope.groupId } : { noteId: input.sourceId },
  });

  const tagTarget: TagSpace = "groupId" in input.scope ? { kind: "group", groupId: input.scope.groupId } : { kind: "personal", ownerId: input.scope.ownerId };
  const created = await insertNoteWithAutoSlug(tx, { scope: input.scope, folderId: input.folderId }, src.title, createHooks, { inTx: true });

  const mapping = new Map<string, string>();
  for (const c of copied) {
    await tx.insert(uploads).values({ id: c.newId, noteId: created.id, uploaderId: input.userId, chargedToId: input.userId, mime: c.mime, size: c.size });
    mapping.set(c.oldId.toLowerCase(), c.newId);
  }
  rewriteUploadUrls(input.copy, mapping);

  // version 1, same shape as `persistNoteState`'s first write.
  await tx.insert(noteStates).values({ noteId: created.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(input.copy.doc)), version: 1 });
  // Same transaction: a failure rolls the index back with the copy. `SearchIndexSkip` can't happen (the note was created in this transaction); if it did, fail the copy rather than swallow it.
  await replaceNoteSearchIndexInTx(tx, { noteId: created.id, sourceVersion: 1, extract: input.searchExtract }, searchHooks);
  await replaceNoteKnowledgeIndexInTx(tx, { noteId: created.id, sourceVersion: 1, extract: input.knowledgeExtract }, knowledgeHooks);
  await copyNoteTagsInTx(tx, { sourceNoteId: src.id, targetNoteId: created.id, target: tagTarget, createdBy: input.userId });
  return { note: created, target };
}
