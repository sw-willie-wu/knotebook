import "@/i18n/folder-strings";
import type { QueryClient } from "@tanstack/react-query";
import type { FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import {
  createFolderRequest,
  deleteFolderRequest,
  FOLDERS_QUERY_KEY,
  folderErrorMessage,
  invalidateFolderRelated,
  isFolderNotEmpty,
  isFolderNotFound,
  placeNoteRequest,
} from "@/api/folders";
import type { Translate } from "@/components/sidebar/destination-level";
import { stackFolderName } from "@/components/sidebar/drag-zone";
import { toast } from "@/components/ui/toast";

/**
 * 疊資料夾的三發、補償、復原與兩句 toast（資料夾 spec §6.13「疊資料夾」第 5–8 步；D17 定案 B）。
 * lazy 模組：只准 `import("@/lib/stack-folder")`（useSidebarDrag 在 dragstart 預載、drop 時 await）；字串在 folders.*.json。
 */

/** ① 撞名（409 folder_name_taken）時換下一個編號重送，① 總共最多這麼多發。 */
export const STACK_CREATE_ATTEMPTS = 5;

/** 被疊的一篇：`from`＝樹上的原位置（null＝根層）。 */
export interface StackNote {
  noteId: string;
  from: string | null;
}

function isNameTaken(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "folder_name_taken";
}

function errorToast(t: Translate, err: unknown): void {
  toast({ title: folderErrorMessage(t, err), variant: "destructive" });
}

async function place(queryClient: QueryClient, noteId: string, folderId: string | null): Promise<void> {
  const note: NoteDto = await placeNoteRequest(noteId, folderId);
  queryClient.setQueryData(["note", note.id], note);
}

/** ① 失敗不建；撞名換號重送，最多 STACK_CREATE_ATTEMPTS 發。成功回 folder，失敗丟最後那一發的錯。 */
async function createWithRetry(input: {
  parent: { folderId: string } | { space: FolderSpaceDto };
  firstName: string;
  takenNames: readonly string[];
  t: Translate;
}): Promise<FolderDto> {
  const { parent, takenNames, t } = input;
  const tried = new Set<string>();
  let name = input.firstName;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createFolderRequest("folderId" in parent ? { name, parentId: parent.folderId } : { name, space: parent.space });
    } catch (err) {
      if (!isNameTaken(err) || attempt >= STACK_CREATE_ATTEMPTS) throw err;
      tried.add(name);
      name = stackFolderName(takenNames, t, tried);
    }
  }
}

/**
 * 補償（第 7 步）：b 已放進新資料夾時先把 b 移回 → DELETE 新資料夾 {onlyIfEmpty}。
 * DELETE 回 409 folder_not_empty（別人剛放了東西進去）→ 保留、停；補償任一發失敗 → 停、重抓清單（不另出 toast，總管裁定 2026-10-30 Q2）。
 */
async function compensate(args: { folderId: string; b: StackNote | null; queryClient: QueryClient }): Promise<void> {
  const { folderId, b, queryClient } = args;
  try {
    if (b !== null) await place(queryClient, b.noteId, b.from);
    await deleteFolderRequest(folderId, { onlyIfEmpty: true });
  } catch (err) {
    if (!isFolderNotEmpty(err)) invalidateFolderRelated(queryClient);
  }
}

/**
 * ① POST（撞名換號重送）→ ② PUT B → ③ PUT A；不樂觀（新資料夾的 id 要等 server）。
 * 成功：await ["folders"]、["notes"] 的失效重抓後回 folder。失敗：第 7 步補償、恰一則錯誤 toast（失敗那一步的錯）、回 null。
 */
export async function runStackFolder(input: {
  a: StackNote;
  b: StackNote;
  parent: { folderId: string } | { space: FolderSpaceDto };
  firstName: string;
  takenNames: readonly string[];
  queryClient: QueryClient;
  t: Translate;
}): Promise<FolderDto | null> {
  const { a, b, queryClient, t } = input;
  let folder: FolderDto;
  try {
    folder = await createWithRetry(input);
  } catch (err) {
    errorToast(t, err);
    return null;
  }
  try {
    await place(queryClient, b.noteId, folder.id);
  } catch (err) {
    await compensate({ folderId: folder.id, b: null, queryClient });
    errorToast(t, err);
    return null;
  }
  try {
    await place(queryClient, a.noteId, folder.id);
  } catch (err) {
    await compensate({ folderId: folder.id, b, queryClient });
    errorToast(t, err);
    return null;
  }
  await Promise.all([queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY }), queryClient.invalidateQueries({ queryKey: ["notes"] })]);
  return folder;
}

/**
 * 第 8 步「復原」：PUT A 回原處 → PUT B 回原處 → DELETE {onlyIfEmpty}（server 判空）→ 重抓。
 * 200 → 不出 toast；409 folder_not_empty → 保留資料夾並提示；404 folder_not_found → 視為完成；任一 PUT 失敗 → 錯誤 toast、不送 DELETE、不重試。
 */
export async function undoStackFolder(args: { folderId: string; a: StackNote; b: StackNote; queryClient: QueryClient; t: Translate }): Promise<void> {
  const { folderId, a, b, queryClient, t } = args;
  try {
    await place(queryClient, a.noteId, a.from);
    await place(queryClient, b.noteId, b.from);
  } catch (err) {
    invalidateFolderRelated(queryClient);
    errorToast(t, err);
    return;
  }
  try {
    await deleteFolderRequest(folderId, { onlyIfEmpty: true });
  } catch (err) {
    if (isFolderNotEmpty(err)) toast({ title: t("folderDialogs.stackKept") });
    else if (!isFolderNotFound(err)) errorToast(t, err);
  }
  invalidateFolderRelated(queryClient);
}

/** 改名框關閉後（spec §6.13 第 6 步）：toast「已建立「name」並放入 2 篇筆記」＋「復原」。handler 只用參數捕捉的值。 */
export function showStackCreatedToast(args: { folderId: string; name: string; a: StackNote; b: StackNote; queryClient: QueryClient; t: Translate }): void {
  const { folderId, name, a, b, queryClient, t } = args;
  toast({
    title: t("folderDialogs.stackCreated", { name }),
    action: { label: t("trash.undo"), onClick: () => void undoStackFolder({ folderId, a, b, queryClient, t }) },
  });
}
