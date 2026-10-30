import type { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { applyPlacedNote, folderErrorMessage, invalidateFolderRelated, isFolderNotFound, placeNoteRequest } from "@/api/folders";
import { expandFolderChain, type FolderIndex } from "@/components/sidebar/folder-index";
import { toast } from "@/components/ui/toast";

/**
 * ⋮「移動到…」的同空間移動（資料夾 spec §6.11.2「選定後」；PR-3c 拖曳也走同一則 toast，§6.13）。
 * 首包模組：不 import 字串包（`folders.movedTo`、`trash.undo` 都在主檔）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 404 `folder_not_found`＝快取裡的資料夾已不在：失效 folders／notes 讓樹重抓（spec §6.15）。 */
function invalidateIfFolderGone(queryClient: QueryClient, err: unknown): void {
  if (isFolderNotFound(err)) invalidateFolderRelated(queryClient);
}

/** 只改 ["notes"] 裡那一篇的 folderId（其他篇照快取現況）。 */
function setCachedFolderId(queryClient: QueryClient, noteId: string, folderId: string | null): void {
  queryClient.setQueryData<NoteDto[]>(["notes"], (list) => list?.map((note) => (note.id === noteId ? { ...note, folderId } : note)));
}

/**
 * spec §6.11.2 同空間移動：PUT → applyPlacedNote → expandFolderChain(目標) → toast「已移到「name」」＋「復原」。
 * 復原：PUT 回 from；成功不另出 toast（清單即時歸位）、失敗出 folderErrorMessage 錯誤 toast、不重試。
 * 失敗：folderErrorMessage 錯誤 toast；404 folder_not_found 另 invalidateFolderRelated。
 * toast 的 handler 只用參數捕捉的值：按「復原」時選單常已卸載（同 `lib/trash-undo.ts`）。
 * optimistic（拖曳，§6.13；⋮ 不帶）：PUT 前取消 ["notes"]（exact：不動版本面板的 ["notes", id, "versions"]）的進行中請求、記下該篇原本的
 * folderId、換成目標並展開目標鏈（放到收合的資料夾上時筆記不會先消失）；失敗只把該篇的 folderId 還原（PUT 期間別的寫入不被蓋掉），再走上述錯誤路徑。
 */
export async function placeNoteWithUndo(args: {
  noteId: string;
  from: string | null;
  to: { folderId: string | null; name: string };
  index: FolderIndex;
  queryClient: QueryClient;
  t: Translate;
  optimistic?: true;
}): Promise<void> {
  const { noteId, from, to, index, queryClient, t } = args;
  const optimistic = args.optimistic === true;
  /** 快取裡該篇原本的 folderId；undefined＝沒有快取或快取裡沒有這篇（不寫入）。 */
  let previous: { folderId: string | null } | undefined;
  if (optimistic) {
    await queryClient.cancelQueries({ queryKey: ["notes"], exact: true });
    const note = queryClient.getQueryData<NoteDto[]>(["notes"])?.find((item) => item.id === noteId);
    if (note !== undefined) {
      previous = { folderId: note.folderId };
      setCachedFolderId(queryClient, noteId, to.folderId);
    }
    if (to.folderId !== null) expandFolderChain(index, to.folderId);
  }
  try {
    const placed = await placeNoteRequest(noteId, to.folderId);
    applyPlacedNote(queryClient, placed);
    if (to.folderId !== null) expandFolderChain(index, to.folderId);
  } catch (err) {
    if (previous !== undefined) setCachedFolderId(queryClient, noteId, previous.folderId);
    invalidateIfFolderGone(queryClient, err);
    // optimistic 先取消了 ["notes"] 的進行中請求：非 404 的失敗也要重抓，否則被取消的那次帶的別人改動要等到下次 refetch。
    if (optimistic && !isFolderNotFound(err)) void queryClient.invalidateQueries({ queryKey: ["notes"] });
    toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    return;
  }
  toast({
    title: t("folders.movedTo", { name: to.name }),
    action: { label: t("trash.undo"), onClick: () => void undoPlace({ noteId, from, queryClient, t }) },
  });
}

/** 復原：PUT 回原處；成功只更新快取（Radix 已在按下時關掉原 toast），失敗出錯誤 toast、不重試。 */
async function undoPlace(args: { noteId: string; from: string | null; queryClient: QueryClient; t: Translate }): Promise<void> {
  const { noteId, from, queryClient, t } = args;
  try {
    applyPlacedNote(queryClient, await placeNoteRequest(noteId, from));
  } catch (err) {
    invalidateIfFolderGone(queryClient, err);
    toast({ title: folderErrorMessage(t, err), variant: "destructive" });
  }
}
