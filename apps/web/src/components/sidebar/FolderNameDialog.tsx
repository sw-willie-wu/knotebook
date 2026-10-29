import "@/i18n/folder-strings";
import { useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FOLDER_NAME_MAX, type FolderDto, type FolderSpaceDto } from "@knotebook/shared";
import { FOLDERS_QUERY_KEY, folderErrorMessage, useCreateFolder, useRenameFolder } from "@/api/folders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setCollapsed } from "./collapse";
import { expandFolderChain, indexFolders } from "./folder-index";

/**
 * 字元集與 server `apps/server/src/folders/names.ts` 的 `CONTROL_CHAR_RE` 相同：C0、DEL＋C1、U+2028–2029、U+202A–202E、U+2066–2069
 * （plan 讀碼發現 18）。以 code point 比對（不寫成含控制字元的正規式，`no-control-regex` 不收）。落單代理與 NFC 由 server 判。
 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      return true;
    }
  }
  return false;
}

export type FolderCreateParent = { folderId: string } | { space: FolderSpaceDto };

type FolderNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 關閉時把焦點還給誰（受控 Dialog 沒有 trigger，Radix 不會自己還）；已卸載就交給 Radix 預設。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
} & ({ mode: "create"; parent: FolderCreateParent } | { mode: "rename"; folder: FolderDto });

/**
 * 新增／重新命名資料夾（資料夾 spec §6.6，比照 `GroupNameDialog`：只在開啟時掛載、關閉還焦點）。
 * 名稱檢查順序照 server：trim → 字元集 → 以 code point 計 1–80；送出 trim 後的字串。錯誤（含 409 撞名）留在框內 `role="alert"`。
 * create 成功：parent 是資料夾 → 它與祖先寫成展開；parent 是群組空間 → 展開該群組（spec §6.8；新資料夾本身沒有鍵＝展開）。
 * 只准被 FolderLazy 鏈與測試 import。
 */
export function FolderNameDialog(props: FolderNameDialogProps) {
  const { t } = useTranslation();
  const { open, onOpenChange, returnFocusRef } = props;
  const queryClient = useQueryClient();
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const [name, setName] = useState(props.mode === "rename" ? props.folder.name : "");
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const invalid = hasControlChar(trimmed)
    ? t("folderDialogs.nameControlChars")
    : [...trimmed].length > FOLDER_NAME_MAX
      ? t("folderDialogs.nameTooLong", { max: FOLDER_NAME_MAX })
      : null;
  const pending = createFolder.isPending || renameFolder.isPending;
  const message = invalid ?? error;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || invalid !== null || pending) return;
    setError(null);
    try {
      if (props.mode === "rename") {
        await renameFolder.mutateAsync({ id: props.folder.id, name: trimmed });
      } else {
        const { parent } = props;
        await createFolder.mutateAsync("folderId" in parent ? { name: trimmed, parentId: parent.folderId } : { name: trimmed, space: parent.space });
        if ("folderId" in parent) {
          expandFolderChain(indexFolders(queryClient.getQueryData<FolderDto[]>(FOLDERS_QUERY_KEY) ?? []), parent.folderId);
        } else if (parent.space.kind === "group") {
          setCollapsed(`group:${parent.space.groupId}`, false);
        }
      }
      onOpenChange(false);
    } catch (err) {
      setError(folderErrorMessage(t, err));
    }
  }

  const title = props.mode === "create" ? t("sidebar.newFolder") : t("folderDialogs.renameTitle");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissOnOutside={false}
        // 只有標題與一個欄位，沒有另外的說明句；明示沒有描述（不放與標題相同的 sr-only 描述，避免讀屏唸兩次）。
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="folder-name-input" className="text-sm font-medium">
              {t("folderDialogs.nameLabel")}
            </label>
            <Input
              id="folder-name-input"
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              aria-invalid={message !== null || undefined}
            />
          </div>
          {message !== null && (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" variant="brandDeep" disabled={trimmed.length === 0 || invalid !== null || pending}>
              {props.mode === "create" ? t("groups.dialog.create") : t("groups.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
