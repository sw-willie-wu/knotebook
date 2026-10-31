import { lazy } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarTabState } from "@/lib/sidebar-tab";
import { Button } from "@/components/ui/button";
import { Plus } from "@/components/ui/icons";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";

/** 只有打開垃圾桶 tab 才下載（首包上限）；與 AppShell 的 `TrashPanel` 同一個 chunk（`TrashLazy`）。 */
const TrashFooter = lazy(() => import("@/components/sidebar/TrashLazy").then((m) => ({ default: m.TrashFooter })));
/** 一般 tab 選取模式的動作列：與 NoteList 的選取標題列／勾選樹同一個 chunk（`SelectLazy`，首包上限）。 */
const SelectActionBar = lazy(() => import("@/components/sidebar/SelectLazy").then((m) => ({ default: m.SelectActionBar })));

/**
 * 側欄底部（tab 列與 UserMenu 之間）：「我的筆記」「最近」tab 是「新增筆記」（永遠建個人筆記，所以「群組」「與我共享」tab 不顯示）；垃圾桶 tab 換成保留天數說明（spec §6.10.1），
 * 垃圾桶選取模式換成動作列（spec §6.10.2），兩者在 `TrashFooter.tsx`；一般 tab 的選取模式換成 `SelectActionBar`（spec §6.11，PR-2c）。
 * 搜尋中一律「新增筆記」（搜尋視圖不是任何 tab 的清單）。
 * ⚠ 本體不呼叫 `useTrash()`／`useNotes()`（讀碼發現 28）：只有對應狀態才渲染的子元件呼叫，其他 tab 不多打 `GET /api/trash`。
 */
export function SidebarFooter({
  searching,
  onCreateNote,
  newNotePending,
}: {
  searching: boolean;
  onCreateNote: () => void;
  newNotePending: boolean;
}) {
  const { t } = useTranslation();
  const { tab, selection } = useSidebarTabState();
  const newNote = (
    <div className="m-2">
      <Button variant="brand" className="w-full" onClick={() => onCreateNote()} disabled={newNotePending}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        {t("home.newNote")}
      </Button>
    </div>
  );
  if (searching) return newNote;
  if (tab !== "trash" && selection.active) {
    // 佔位與動作列同高；chunk 失敗時錯誤＋重試由清單那份（同一個 chunk）顯示，這裡隱藏。
    return (
      <SidebarLazyBoundary chunk="select" fallback={<div className="m-2 h-8" />} errorClassName="hidden">
        <SelectActionBar />
      </SidebarLazyBoundary>
    );
  }
  if (tab === "myNotes" || tab === "recent") return newNote;
  if (tab !== "trash") return null;
  // 佔位與保留天數說明「載入中」同高，chunk 到了版面不跳。chunk 載入失敗時錯誤＋重試由面板那份（同一個 chunk）顯示，
  // 底部的錯誤內容隱藏、不重複一顆重試鈕。
  return (
    <SidebarLazyBoundary chunk="trash" fallback={<div className="h-7" />} errorClassName="hidden">
      <TrashFooter />
    </SidebarLazyBoundary>
  );
}
