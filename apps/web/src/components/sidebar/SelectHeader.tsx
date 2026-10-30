import "@/i18n/select-strings";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { isCollapsed, useCollapseVersion } from "./collapse";
import { selectedTargets, visibleSelectionKeys } from "./select-model";
import type { SidebarNode } from "./tree";

/** 開著的 Radix Toast（`@radix-ui/react-toast` 的 root 是 `<li data-swipe-direction data-state>`）。 */
const OPEN_TOAST = 'li[data-swipe-direction][data-state="open"]';

/**
 * 一般 tab 選取模式的標題列（#181 PR-2c，spec §6.11；class 同 `TrashPanel.renderHeader` 的選取支）：「已選 N 項」＋全選／取消全選＋完成。
 * 「全選」只勾畫面上看得見的列（資料夾列與筆記列都算；收合的群組／資料夾的子樹不算，資料夾 spec §6.10）、不清掉先前在收合子樹裡勾的。
 * 「已選 N 項」＝資料夾與筆記合計、不看收合、不去重（去重在送出前，§6.10）。
 * 「全選／取消全選／完成」沿用首包的 `trash.*` 字串（鍵名前綴不準，但改名要動首包兩語系與 PR-2b 測試）。
 * 只准經 `SelectLazy` 引用。
 */
export function SelectHeader({
  nodes,
  onMounted,
  onDone,
}: {
  nodes: readonly SidebarNode[];
  /** 掛上時呼叫一次（useLayoutEffect）；NoteList 用它把焦點交給「完成」（只在發起的那一份設過旗標時）。 */
  onMounted: (done: HTMLButtonElement | null) => void;
  /** 「完成」與 Esc：NoteList 設焦點旗標後結束選取。 */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  // 收合變動時重繪：「全選／取消全選」看可見列。
  useCollapseVersion();
  const rootRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const onMountedRef = useRef(onMounted);
  onMountedRef.current = onMounted;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useLayoutEffect(() => {
    onMountedRef.current(doneRef.current);
  }, []);

  // Esc（plan 讀碼發現 20）：選取模式在使用者離開側欄時不會結束，所以 document 層監聽要有範圍，下列全部成立才動作。
  useEffect(() => {
    /** 本次按鍵在 window capture（最早）時是否有開著的 toast：真瀏覽器在 listener 之間跑 microtask，到 bubble 時 toast 可能已關。 */
    let toastOpenAt: Event | null = null;
    const capture = (event: KeyboardEvent) => {
      toastOpenAt = event.key === "Escape" && document.querySelector(OPEN_TOAST) !== null ? event : null;
    };
    const handler = (event: KeyboardEvent) => {
      // ① 只看 Esc；② 輸入法組字中的 Esc 是取消組字；③ 已有人處理（抽屜的 Radix、目的地框／確認框在 capture 先 preventDefault）。
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      // ④ 抽屜以外的對話框開著：Esc 是它的。
      if (document.querySelector('[role="dialog"]:not([data-sidebar-drawer])')) return;
      // ④b 按下當下有開著的 toast：Radix Toast 關 toast 時不 preventDefault，一下 Esc 只關一層（停下後的錯誤 toast 不連帶丟掉選取）。
      if (toastOpenAt === event) return;
      const shell = rootRef.current?.closest("[data-sidebar-instance]");
      // ⑤ 本實例看得見：抽屜那份恆看得見；靜態卡在窄螢幕是 hidden（抽屜關著時仍掛著）。
      if (!(shell?.hasAttribute("data-sidebar-drawer") || !window.matchMedia(NARROW_QUERY).matches)) return;
      // ⑥ 焦點在 body（macOS Safari 點勾選框不聚焦它）或本實例之內：主內容區的輸入框、編輯器裡的 Esc 不算。
      const target = event.target;
      if (!(target === document || target === document.body || target === document.documentElement || (target instanceof Node && shell?.contains(target)))) return;
      // 讓 NotePage 預覽等 window 監聽照 repo 慣例以 defaultPrevented 讓路。
      event.preventDefault();
      onDoneRef.current();
    };
    window.addEventListener("keydown", capture, { capture: true });
    document.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", capture, { capture: true });
      document.removeEventListener("keydown", handler);
    };
  }, []);

  const count = selectedTargets(nodes, selection.keys).length;
  const visible = visibleSelectionKeys(nodes, isCollapsed);
  const allVisibleSelected = visible.length > 0 && visible.every((key) => selection.keys.has(key));

  return (
    <>
      <span ref={rootRef} className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-brand-on-soft">
        <span className="truncate">{t("select.selected", { count })}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={visible.length === 0}
        onClick={() =>
          updateSelection(allVisibleSelected ? { type: "clear" } : { type: "setAll", keys: [...new Set([...selection.keys, ...visible])] })
        }
        className="h-6 px-2 text-xs"
      >
        {allVisibleSelected ? t("trash.deselectAll") : t("trash.selectAll")}
      </Button>
      <Button ref={doneRef} type="button" variant="outline" size="sm" onClick={onDone} className="h-6 px-2 text-xs">
        {t("trash.done")}
      </Button>
    </>
  );
}
