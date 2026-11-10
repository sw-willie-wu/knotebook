/**
 * 把筆記放進／移出資料夾的交易本體（筆記放置與共享放置）。S14：只收 `tx`／純資料／測試縫。不取結構鎖（放置不改變結構）。
 * 鎖序：（群組筆記）groups KS → 目標資料夾 KS → 筆記（個人／群組 `FOR UPDATE`；共享 `FOR KEY SHARE`，不擋擁有者的寫入）。
 * 鎖完才重判，判的順序照入口：筆記授權 → 資料夾可見性 → 空間。
 * 寫入：個人／群組＝`UPDATE notes SET folder_id`（已在該處 → 不寫）；共享＝upsert／刪 `note_placements`（沒變 → 0 列）。
 * 不動 `updated_at`、slug、版本。失敗一律 throw `TxAbort`；撤分享的 23503、trigger 的 KF00x 交給服務層映射。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notePlacements, notes } from "../../db/schema.js";
import type { GroupHookCtx, GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { accessQuery, noteAccessFromRow } from "../../notes/service.js";
import {
  FOLDER_NOT_FOUND_MESSAGE,
  NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_PLACE_FORBIDDEN_MESSAGE,
} from "../messages.js";
import { sameFolderSpace, type FolderSpace } from "../space.js";
import { folderAccessInTx, lockFolderInTx, lockGroupsKeyShareInTx } from "./lock.js";

/** owned＝呼叫者是個人筆記的 owner；group＝群組筆記（呼叫者要 `can_edit`）；shared＝被分享者（editor／viewer）整理自己的放置。 */
export type PlaceMode = { kind: "owned" } | { kind: "group"; groupId: string } | { kind: "shared" };

export interface PlaceNoteInput {
  by: string;
  /** id 皆已小寫；`folderId` null＝根層。 */
  noteId: string;
  folderId: string | null;
  mode: PlaceMode;
}

/** 這個模式要求的資料夾空間。 */
export function placeTargetSpace(mode: PlaceMode, by: string): FolderSpace {
  switch (mode.kind) {
    case "owned":
      return { kind: "personal", ownerId: by };
    case "group":
      return { kind: "group", groupId: mode.groupId };
    case "shared":
      return { kind: "shared", ownerId: by };
  }
}

export async function placeNoteInTx(tx: Tx, input: PlaceNoteInput, hook?: GroupTestHook): Promise<{ changed: boolean }> {
  const { by, noteId, folderId, mode } = input;
  const noteNotFound = (): TxAbort => new TxAbort(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  const folderNotFound = (): TxAbort => new TxAbort(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  const hookCtx: GroupHookCtx = {
    noteId,
    ...(folderId !== null ? { folderId } : {}),
    ...(mode.kind === "group" ? { groupId: mode.groupId } : {}),
  };

  // 群組不在＝筆記已不在原群組（轉移）：筆記優先 → not_found。
  if (mode.kind === "group") {
    const present = await lockGroupsKeyShareInTx(tx, [mode.groupId]);
    if (!present.has(mode.groupId)) throw noteNotFound();
  }
  // 先資料夾後筆記（與刪資料夾的「資料夾 → 筆記」同向）。
  const folder = folderId !== null ? await lockFolderInTx(tx, folderId, "key share") : undefined;
  const [row] = await tx
    .select({ id: notes.id, folderId: notes.folderId })
    .from(notes)
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .for(mode.kind === "shared" ? "key share" : "update");
  if (!row) throw noteNotFound();

  const access = noteAccessFromRow((await accessQuery(tx, by, noteId))[0], by);
  if (access.role === "none") throw noteNotFound();
  const allowed = mode.kind === "owned"
    ? access.role === "owner"
    : mode.kind === "group"
      ? access.groupId === mode.groupId && access.permissions.edit
      : (access.role === "editor" || access.role === "viewer") && access.groupId === null;
  if (!allowed) throw new TxAbort(403, "forbidden", NOTE_PLACE_FORBIDDEN_MESSAGE);

  if (folderId !== null) {
    if (!folder) throw folderNotFound();
    const target = await folderAccessInTx(tx, by, folder);
    if (target === null) throw folderNotFound();
    if (!sameFolderSpace(target.space, placeTargetSpace(mode, by))) throw new TxAbort(400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE);
  }
  await hook?.("note-folder-locked", hookCtx);

  if (mode.kind !== "shared") {
    if (row.folderId === folderId) return { changed: false };
    await tx.update(notes).set({ folderId }).where(eq(notes.id, noteId));
    return { changed: true };
  }
  if (folderId === null) {
    const gone = await tx
      .delete(notePlacements)
      .where(and(eq(notePlacements.userId, by), eq(notePlacements.noteId, noteId)))
      .returning({ noteId: notePlacements.noteId });
    return { changed: gone.length > 0 };
  }
  const written = await tx
    .insert(notePlacements)
    .values({ userId: by, noteId, folderId })
    .onConflictDoUpdate({
      target: [notePlacements.userId, notePlacements.noteId],
      set: { folderId: sql`excluded.folder_id` },
      setWhere: sql`${notePlacements.folderId} is distinct from excluded.folder_id`,
    })
    .returning({ noteId: notePlacements.noteId });
  return { changed: written.length > 0 };
}
