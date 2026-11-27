// Callers pass lowercase ids; `toLowerCase` is kept defensively (kicks and live docs are keyed by lowercase). `versions.relocated` and the connection kick run only after a successful commit. A `.transaction(` here must be a single `moveNoteToGroupInTx` call (test/unit/tx-nested-pool-borrow-structure.test.ts). With `folderId`: non-UUID or invisible → 404 `folder_not_found`, a folder of another group → 400 `folder_cross_space` (both returned as `aborted`); `can_edit` and the folder lock are judged in the transaction.
import { broadcastCommentsCleared } from "../comments/broadcast.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { CollabServer } from "../collab/server.js";
import type { NotificationHub } from "../notifications/hub.js";
import type { VersionService } from "../collab/versions.js";
import type { Db } from "../db/index.js";
import { foreignKeyViolationConstraint, isForeignKeyViolation, isNoteFolderSpaceViolation, isRetryableTxError } from "../db/pg-errors.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_CROSS_SPACE_MESSAGE } from "../folders/messages.js";
import { resolveFolderAccess } from "../folders/queries.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { TxAbort } from "../http/tx-abort.js";
import { resolveNoteAccess, UUID_RE } from "./service.js";
import { moveNoteToGroupInTx } from "./tx/move.js";

export interface MoveNoteDeps {
  db: Db;
  collabHooks: CollabHooks;
  collab?: CollabServer;
  notifications?: NotificationHub;
  versions: VersionService;
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
}

export type MoveOutcome =
  | { kind: "moved" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "group_not_found" }
  | { kind: "aborted"; err: TxAbort }
  | { kind: "busy" };

export async function moveNoteToGroup(
  deps: MoveNoteDeps,
  input: { noteId: string; userId: string; userHandle: string; groupId: string; folderId?: string; keepHistory?: boolean },
): Promise<MoveOutcome> {
  const noteId = input.noteId.toLowerCase();
  const access = await resolveNoteAccess(deps.db, input.userId, noteId);
  if (access.role === "none") return { kind: "not_found" };
  if (!access.permissions.moveToGroup) return { kind: "forbidden" };
  if (!UUID_RE.test(input.groupId)) return { kind: "group_not_found" };
  const groupId = input.groupId.toLowerCase();
  let folderId: string | null = null;
  if (input.folderId !== undefined) {
    const folder = await resolveFolderAccess(deps.db, input.userId, input.folderId);
    if (folder === null) return { kind: "aborted", err: new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE) };
    if (folder.space.kind !== "group" || folder.space.groupId !== groupId) {
      return { kind: "aborted", err: new TxAbort(400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE) };
    }
    folderId = folder.folder.id;
  }
  const txInput = {
    noteId, userId: input.userId, userHandle: input.userHandle, groupId, folderId, keepHistory: input.keepHistory === true, lockTimeoutMs: deps.storageLockTimeoutMs,
  };
  let moved;
  try {
    await deps.groupTestHook?.("note-move-authorized", { noteId });
    moved = await deps.db.transaction(tx => moveNoteToGroupInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    // Check the subclass first: `StorageQuotaExceeded` extends `TxAbort` and callers need its numbers.
    if (err instanceof TxAbort) return { kind: "aborted", err };
    // Defence in depth: the folder holds KEY SHARE and its group was checked, so the UPDATE can't hit `notes_folder_fk`/KF001.
    if (isNoteFolderSpaceViolation(err) || foreignKeyViolationConstraint(err) === "notes_folder_fk") {
      return { kind: "aborted", err: new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE) };
    }
    // Defence in depth: the group's KEY SHARE is held. Only a hard-deleted mover account (`uploads.charged_to_id` FK; no such path in `src/`) could hit an FK here; both map to `group_not_found`.
    if (isForeignKeyViolation(err)) return { kind: "group_not_found" };
    if (isRetryableTxError(err)) return { kind: "busy" };
    throw err;
  }
  deps.versions.relocated([noteId]);
  deps.collabHooks.onGroupAccessChanged([noteId], [...new Set([...moved.removedShareUserIds, input.userId])]);
  if (input.keepHistory !== true) {
    broadcastCommentsCleared(deps.collab, noteId);
    deps.notifications?.notify(moved.clearedNotificationUserIds);
  }
  return { kind: "moved" };
}
