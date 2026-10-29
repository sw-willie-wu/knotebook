import "@/i18n/folder-strings";
import type { RefObject } from "react";
import type { FolderDialogRequest } from "@/components/NoteList";
import { FolderDeleteDialog } from "./FolderDeleteDialog";
import { FolderNameDialog } from "./FolderNameDialog";

/** 依 `request` 渲染新增／改名／刪除其一（只在開啟時掛載，關閉就交回 `onClose`）。只准經 `FolderLazy` 引用。 */
export function FolderDialogs({
  request,
  returnFocusRef,
  onClose,
}: {
  request: FolderDialogRequest;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  if (request.kind === "create") {
    return <FolderNameDialog mode="create" parent={request.parent} open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />;
  }
  if (request.kind === "rename") {
    return <FolderNameDialog mode="rename" folder={request.folder} open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />;
  }
  return <FolderDeleteDialog folder={request.folder} open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />;
}
