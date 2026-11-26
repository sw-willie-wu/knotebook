/** Never injected in production; each point opens a race window for integration tests. */
export type GroupRacePoint =
  | "ref-authorized"
  | "membership-checked"
  /** Window: note moved into a group after authorization. */
  | "share-authorized"
  | "public-link-authorized"
  | "share-group-checked"
  | "group-roles-checked"
  | "group-members-checked"
  | "note-move-locked"
  | "note-move-slug-candidate"
  | "note-copy-target-locked"
  | "note-copy-locked"
  /** Outside any transaction, after attachment files are copied to their temp files; `note-copy-authorized` follows. `ctx.noteId` is the source (the copy doesn't exist yet). Tests throw here to simulate a failure. */
  | "note-copy-files-copied"
  /** Window: note moved after the by-path fetch. */
  | "path-resolved"
  | "group-transfer-slug-candidate"
  /** Outside the transaction, after all gates are open. Windows: a note enters the group after the gates; another admin's transfer finishes first. */
  | "group-delete-gated"
  | "group-delete-locked"
  | "storage-space-locked"
  | "note-trash-locked"
  | "note-restore-locked"
  | "note-purge-locked"
  | "trash-purge-locked"
  | "note-move-authorized"
  | "note-copy-authorized"
  /** Outside any transaction: the whole file is in its temp file and passed the whole-file checks; `upload-authorized` follows, right before the transaction. */
  | "upload-received"
  | "upload-authorized"
  | "folder-authorized"
  | "folder-structure-locked"
  | "folder-delete-gated"
  | "folder-delete-notes-locked"
  | "note-folder-authorized"
  | "note-folder-locked"
  | "note-copy-folder-locked"
  | "trash-restore-prejudged"
  /** Window: note permanently deleted after authorization. */
  | "favorite-authorized"
  /** Window: note moved to another space after authorization. */
  | "tag-note-authorized"
  /** Window: inside the tag transaction, after the group and note locks are held. */
  | "tag-note-locked";

export interface GroupHookCtx { noteId?: string; groupId?: string; slug?: string; folderId?: string }

export type GroupTestHook = (point: GroupRacePoint, ctx: GroupHookCtx) => Promise<void>;
