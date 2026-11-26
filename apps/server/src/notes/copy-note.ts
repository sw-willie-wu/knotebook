// `sourceId` is lowercased defensively: live docs and kicks are keyed by lowercase strings.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import type { FastifyBaseLogger } from "fastify";
import type { CollabServer } from "../collab/server.js";
import { docClock } from "../collab/store.js";
import type { Db } from "../db/index.js";
import { foreignKeyViolationConstraint, isForeignKeyViolation, isNoteFolderSpaceViolation, isRetryableTxError } from "../db/pg-errors.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_CROSS_SPACE_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../folders/messages.js";
import { resolveFolderAccess } from "../folders/queries.js";
import { newNoteFolderConsistent } from "../folders/space.js";
import { notes, uploads } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import type { StorageSpace } from "../storage/space.js";
import { isSpaceFull, readSpaceUsage, remainingRoom, type SpaceUsage } from "../storage/usage.js";
import { deleteUploadFilesAnyName, uploadFilePath, uploadTempPath } from "../uploads/service.js";
import { cloneForCopy } from "./copy-doc.js";
import type { NoteCreateHooks } from "./create.js";
import { loadCreateTarget } from "./create-target.js";
import { loadNoteDoc } from "./editing/read.js";
import { syncLinksFromDoc } from "./links.js";
import { growsPastCap } from "./note-size.js";
import { extractKnowledgeForIndex } from "../knowledge/extract.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { extractForIndex } from "./search-index.js";
import { resolveNoteAccess, UUID_RE } from "./service.js";
import type { SlugScope } from "./slug.js";
import { copyNoteInTx, type CopyPreparedFile, type CopyTargetInTx } from "./tx/copy.js";
import type { SearchIndexHooks } from "./tx/search-index.js";
import type { KnowledgeIndexHooks } from "../knowledge/tx/index-write.js";

export interface CopyNoteDeps {
  db: Db;
  collab?: CollabServer;
  log: FastifyBaseLogger;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  /** Must be the same instances as the upload endpoint and REST copy. */
  limiters: { edit: FixedWindowLimiter; upload: FixedWindowLimiter };
  noteMaxBytes?: number;
  groupTestHook?: GroupTestHook;
  noteCreateHooks?: NoteCreateHooks;
  searchIndexHooks?: SearchIndexHooks;
  knowledgeIndexHooks?: KnowledgeIndexHooks;
}

export type CopyOutcome =
  | { kind: "copied"; note: typeof notes.$inferSelect; target: CopyTargetInTx | null }
  | { kind: "not_found" }
  | { kind: "group_not_found" }
  | { kind: "edit_rate_limited" }
  | { kind: "upload_rate_limited" }
  /** `incomingBytes` is null when the space is already full. */
  | { kind: "space_full"; space: StorageSpace; usage: SpaceUsage & { quotaBytes: number }; incomingBytes: number | null }
  | { kind: "aborted"; err: TxAbort }
  | { kind: "fk_personal" }
  | { kind: "busy" }
  | { kind: "too_large"; limitBytes: number };

export async function copyNote(
  deps: CopyNoteDeps,
  input: { sourceId: string; userId: string; groupId?: string; folderId?: string },
): Promise<CopyOutcome> {
  const sourceId = input.sourceId.toLowerCase();
  const userId = input.userId;

  // Visible implies readable, so the read flag isn't checked.
  if ((await resolveNoteAccess(deps.db, userId, sourceId)).role === "none") return { kind: "not_found" };

  let folderId: string | null = null;
  let groupFolder = false;
  if (input.folderId !== undefined) {
    const folder = await resolveFolderAccess(deps.db, userId, input.folderId);
    if (folder === null) return { kind: "aborted", err: new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE) };
    const space = folder.space;
    const consistent = newNoteFolderConsistent(space, input.groupId);
    if (!consistent) return { kind: "aborted", err: new TxAbort(400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE) };
    folderId = folder.folder.id;
    groupFolder = space.kind === "group";
  }

  let scope: SlugScope;
  if (input.groupId === undefined) {
    scope = { ownerId: userId };
  } else {
    if (!UUID_RE.test(input.groupId)) return { kind: "group_not_found" };
    const groupId = input.groupId.toLowerCase();
    // Fast 404 only: the DTO must not use this result (a demotion can land before the in-transaction recheck).
    const m = await loadCreateTarget(deps.db, userId, groupId);
    if (!m || !m.canCreate) return { kind: "group_not_found" };
    if (groupFolder && !m.canEdit) return { kind: "aborted", err: new TxAbort(403, "forbidden", NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE) };
    scope = { groupId };
  }
  // Edit limiter first; refunded if the size cap rejects (a 413 copy costs no quota).
  const editTicket = deps.limiters.edit.consumeTicket(userId);
  if (editTicket === null) return { kind: "edit_rate_limited" };

  const { doc: snapshot } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, sourceId);
  const copy = cloneForCopy(snapshot);
  // A copy is a new note; the size change from rewritten attachment URLs is negligible.
  const cap = deps.noteMaxBytes;
  if (cap !== undefined) {
    const size = Y.encodeStateAsUpdate(copy.doc).byteLength;
    if (growsPastCap(0, size, cap)) {
      deps.limiters.edit.refund(userId, editTicket);
      return { kind: "too_large", limitBytes: cap };
    }
  }
  const searchExtract = extractForIndex(copy.doc);
  const knowledgeExtract = extractKnowledgeForIndex(copy.doc);
  // #175: charge the upload limiter per attachment copied (same limiter and 429 as uploads; unit = files, 0 attachments skips it). On 429 nothing is written and the edit limiter stays charged (a 413 refunds it). A file missing on disk is still charged. Counted before the transaction and read again inside it, so the charge can be off by a few files if attachments change in between; not worth moving into the transaction.
  const wanted = [...copy.uploadNodes.keys()];
  const owned = wanted.length === 0
    ? []
    : await deps.db.select({ id: uploads.id, size: uploads.size }).from(uploads).where(and(inArray(uploads.id, wanted), eq(uploads.noteId, sourceId)));
  // Lock-free room check (409; only when there are attachments: copies without them aren't quota-limited) so a doomed copy writes no file, opens no transaction and consumes no upload quota; the authoritative check is in the transaction, under the lock. Files missing on disk won't be copied, so they don't count, as in the transaction.
  if (owned.length > 0) {
    const space: StorageSpace = "groupId" in scope ? { kind: "group", id: scope.groupId } : { kind: "user", id: userId };
    const usage = await readSpaceUsage(deps.db, space);
    if (isSpaceFull(usage)) return { kind: "space_full", space, usage, incomingBytes: null };
    const room = remainingRoom(usage);
    if (room !== null) {
      const present = await Promise.all(owned.map(u => sourceFileExists(deps.uploadsDir, u.id)));
      const incoming = owned.reduce((sum, u, i) => (present[i] ? sum + u.size : sum), 0);
      if (incoming > room) return { kind: "space_full", space, usage: usage as SpaceUsage & { quotaBytes: number }, incomingBytes: incoming };
    }
  }
  if (!deps.limiters.upload.consumeMany(userId, owned.length)) return { kind: "upload_rate_limited" };

  // Every id whose file may exist under either name; recorded before `copyFile` so a partial temp file is covered too.
  const copiedFileIds: string[] = [];
  const prepared: CopyPreparedFile[] = [];
  let created;
  try {
    for (const u of owned) {
      const newId = randomUUID();
      const tempPath = uploadTempPath(deps.uploadsDir, newId);
      copiedFileIds.push(newId);
      try {
        await copyFile(uploadFilePath(deps.uploadsDir, u.id), tempPath, constants.COPYFILE_FICLONE);
      } catch (err) {
        if (!isMissingFile(err)) throw err;
        continue;
      }
      prepared.push({ oldId: u.id, newId, tempPath });
    }
    await deps.groupTestHook?.("note-copy-files-copied", { noteId: sourceId });
    await deps.groupTestHook?.("note-copy-authorized", { noteId: sourceId });
    // Data is prepared before the transaction (`loadNoteDoc` borrows a connection); the callback is a single `copyNoteInTx` call.
    const txInput = { sourceId, userId, scope, folderId, copy, uploadsDir: deps.uploadsDir, prepared, searchExtract, knowledgeExtract, lockTimeoutMs: deps.storageLockTimeoutMs };
    created = await deps.db.transaction(tx => copyNoteInTx(tx, txInput, deps.groupTestHook, deps.noteCreateHooks, deps.searchIndexHooks, deps.knowledgeIndexHooks));
  } catch (err) {
    await deleteUploadFilesAnyName(deps.uploadsDir, copiedFileIds, deps.log);
    // Check the subclass first: `StorageQuotaExceeded` extends `TxAbort` and callers need its numbers.
    if (err instanceof TxAbort) return { kind: "aborted", err };
    // Defence in depth: the folder holds KEY SHARE and was rechecked, so the INSERT can't hit `notes_folder_fk`/KF001.
    if (isNoteFolderSpaceViolation(err) || foreignKeyViolationConstraint(err) === "notes_folder_fk") {
      return { kind: "aborted", err: new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE) };
    }
    if (isForeignKeyViolation(err)) {
      // Defence in depth: groups KEY SHARE is held, so the group can't vanish and the INSERT can't hit FK 23503.
      if ("groupId" in scope) return { kind: "group_not_found" };
      // The only possible personal 23503 is the copier's account being hard-deleted mid-transaction (no such path in `src/`). The personal create path has no matching error shape, so use the generic `not_found` rather than `group_not_found` (callers map `fk_personal` to not_found).
      return { kind: "fk_personal" };
    }
    if (isRetryableTxError(err)) return { kind: "busy" };
    throw redactDbError(deps.log, err, "copy note");
  }
  await deleteUploadFilesAnyName(deps.uploadsDir, created.unusedTempIds, deps.log);
  await syncLinksFromDoc({ db: deps.db, log: deps.log }, { sourceNoteId: created.note.id, userId, doc: copy.doc, clock: docClock(copy.doc) });
  return { kind: "copied", note: created.note, target: created.target };
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** Any other stat error counts as present: `copyFile` then fails and the copy is cleaned up. */
async function sourceFileExists(uploadsDir: string, id: string): Promise<boolean> {
  try {
    await stat(uploadFilePath(uploadsDir, id));
    return true;
  } catch (err) {
    return !isMissingFile(err);
  }
}
