import { useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "@/components/ui/icons";
import { indexFolders } from "@/components/sidebar/folder-index";
import { createTargetFor } from "@/lib/note-create-target";
import { PhoneBrowseContext } from "@/lib/phone-list";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";

/**
 * 手機筆記頁的底部瀏覽列：左邊像搜尋框的按鈕（開全螢幕搜尋層）、右邊「New note」（建在這篇所在的空間與資料夾；
 * 這篇不能在那裡建就不顯示）。列高 56（內距 6＋控制項 44＋6）加底部 safe area。
 * 螢幕鍵盤開著（例如正在改標題）時整條不渲染，免得被鍵盤頂著或蓋住。
 */
export function NoteBrowseBar({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const browse = useContext(PhoneBrowseContext);
  const foldersQuery = useFolders();
  const groupsQuery = useGroups();
  const keyboardOpen = isKeyboardOpen(useKeyboardInset());
  const [pending, setPending] = useState(false);
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const target = createTargetFor(note, { groups: groupsQuery.data ?? [], folders: folderIndex });
  if (keyboardOpen) return null;

  function handleCreate(): void {
    if (target === null || pending) return;
    setPending(true);
    void (browse?.createNote(target.groupId, target.folderId) ?? Promise.resolve()).finally(() => setPending(false));
  }

  return (
    <div
      data-testid="note-browse-bar"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-2 pt-1.5 pb-1.5"
    >
      <button
        type="button"
        data-note-browse-search=""
        aria-label={t("sidebar.searchLabel")}
        onClick={() => browse?.openSearch()}
        className="relative flex h-11 min-w-0 flex-1 items-center rounded-md border border-input bg-background pl-9 pr-3 text-left text-base text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
        <span className="truncate">{t("sidebar.searchPlaceholder")}</span>
      </button>
      {target !== null && (
        <Button type="button" variant="brand" className="h-11 shrink-0" onClick={handleCreate} disabled={pending}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("home.newNote")}
        </Button>
      )}
    </div>
  );
}
