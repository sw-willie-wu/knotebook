import "@/i18n/folder-strings";
import { useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import { folderErrorMessage, useDeleteFolder, useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { useTrash } from "@/api/trash";
import { isTerminal } from "@/collab/connection";
import { useNotePageControls } from "@/lib/note-page-controls";
import { showTrashedToast } from "@/lib/trash-undo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { folderDeleteBody, folderDeleteFacts } from "./folder-delete";
import { indexFolders } from "./folder-index";
import { noteSpaceKey } from "./tree";

const EMPTY_NOTES: NoteDto[] = [];
const EMPTY_FOLDERS: FolderDto[] = [];

/**
 * 刪除／移除資料夾確認框（資料夾 spec §6.6，F6：一律跳）。篇數與子資料夾數由快取即時算；保留天數取 `useTrash()`（未載到用通用句）。
 * 送出中兩鈕 disabled、忽略關閉要求（同 `select-dialogs.tsx`）。開著的那篇在子樹裡（讀碼發現 11）：送出前設 NotePage 的
 * `leavingRef`，成功導回首頁（只有資料夾這一則 toast）、「復原」導回那篇；失敗且非終態撥回、終態導回首頁。成敗都關框。
 * 只准被 FolderLazy 鏈與測試 import。
 */
export function FolderDeleteDialog({
  folder,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  folder: FolderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const controls = useNotePageControls();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const trashQuery = useTrash();
  const deleteFolder = useDeleteFolder();
  const [busy, setBusy] = useState(false);

  const openNoteId = controls?.noteId ?? null;
  const facts = useMemo(() => {
    const groupIds = new Set((groupsQuery.data ?? []).map((group) => group.id));
    return folderDeleteFacts(indexFolders(foldersQuery.data ?? EMPTY_FOLDERS), folder, notesQuery.data ?? EMPTY_NOTES, openNoteId, (note) =>
      noteSpaceKey(note, groupIds),
    );
  }, [groupsQuery.data, foldersQuery.data, folder, notesQuery.data, openNoteId]);
  const body = folderDeleteBody(facts, trashQuery.data?.retentionDays, t);

  async function handleConfirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const count = facts.liveNotes.length;
    // 共享移除不經垃圾桶、筆記沒被刪：開著那篇照樣可用，不離場。
    const containsOpen = facts.containsOpen && !facts.shared;
    if (containsOpen && controls) controls.leavingRef.current = true;
    try {
      const result = await deleteFolder.mutateAsync(folder.id);
      if (facts.shared) {
        toast({ title: count > 0 ? t("folderDialogs.removed", { count }) : t("folderDialogs.removedEmpty") });
      } else if (result.trashedNoteIds.length > 0) {
        showTrashedToast({
          notes: [],
          undoIds: result.trashedNoteIds,
          title: t("folderDialogs.deleted", { count: result.trashedNoteIds.length }),
          reopen: false,
          reopenId: containsOpen ? openNoteId : null,
          queryClient,
          navigate,
          t,
        });
      } else {
        toast({ title: t("folderDialogs.deletedEmpty") });
      }
      if (containsOpen) void navigate("/", { replace: true });
    } catch (err) {
      if (containsOpen && controls) {
        if (isTerminal(controls.state)) void navigate("/", { replace: true });
        else controls.leavingRef.current = false;
      }
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setBusy(false);
      onOpenChange(false);
    }
  }

  const title = facts.shared ? t("folderDialogs.removeTitle", { name: folder.name }) : t("folderDialogs.deleteTitle", { name: folder.name });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        dismissOnOutside={false}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("home.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void handleConfirm()}>
            {facts.shared ? t("folderDialogs.remove") : t("folderDialogs.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
