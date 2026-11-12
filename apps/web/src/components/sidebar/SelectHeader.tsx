import "@/i18n/select-strings";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { SelectAllCheckbox } from "@/components/ui/selection-checkbox";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { selectAllState } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { useWidePointer } from "@/lib/wide-pointer";
import { isCollapsed, useCollapseVersion } from "./collapse";
import { SelectActionBar } from "./SelectActionBar";
import { selectedTargets, visibleSelectionKeys } from "./select-model";
import { useSelectRun } from "./select-run";
import type { SidebarNode } from "./tree";

/** 開著的 Radix Toast（`@radix-ui/react-toast` 的 root 是 `<li data-swipe-direction data-state>`）。 */
const OPEN_TOAST = 'li[data-swipe-direction][data-state="open"]';

/**
 * 一般 tab 選取模式的標題列（#181，class 同 `TrashPanel.renderHeader` 的選取支）。兩種形（`useWidePointer`）：
 * - 窄：「已選 N 項」＋全選／取消全選＋完成；動作列在底部（`SidebarFooter`）。
 * - 寬：一列——✕（結束選取，就是「完成」的角色：`onMounted` 交它、Esc 規則不變）＋三態全選框＋數量位（批次執行中換成進度 status）＋
 *   `SelectActionBar` 的 `toolbar` 形；底部不顯示。
 * 「全選」只勾畫面上看得見的列（資料夾列與筆記列都算；收合的群組／資料夾的子樹不算）、不清掉先前在收合子樹裡勾的；
 * 「取消全選」（三態框全勾時點下去）清掉全部、含收合子樹裡勾的。
 * 「已選 N 項」＝資料夾與筆記合計、不看收合、不去重（去重在送出前）。
 * 「全選／取消全選／完成／結束選取」沿用首包的 `trash.*` 字串（鍵名前綴不準，但改名要動首包兩語系與垃圾桶的測試）。
 * 只准經 `SelectLazy` 引用。
 */
export function SelectHeader({
  nodes,
  onMounted,
  onDone,
}: {
  nodes: readonly SidebarNode[];
  /** 掛上時呼叫一次（useLayoutEffect）；NoteList 用它把焦點交給「完成」（寬形是 ✕；只在發起的那一份設過旗標時）。 */
  onMounted: (done: HTMLButtonElement | null) => void;
  /** 「完成」／✕ 與 Esc：NoteList 設焦點旗標後結束選取。 */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const wide = useWidePointer();
  const { selection } = useSidebarTabState();
  const actions = useSidebarTabActions();
  const { updateSelection } = actions;
  // 批次執行中（所有實例共用，見 select-run.ts）：寬形把數量位換成進度。
  const run = useSelectRun(actions);
  // 收合變動時重繪：「全選／取消全選」看可見列。
  useCollapseVersion();
  /** Esc 守衛 ⑤⑥ 由它找所在的 `[data-sidebar-instance]`：寬形掛在恆在的外層（數量位換成進度時不換），窄形掛在數量位。 */
  const rootRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const onMountedRef = useRef(onMounted);
  onMountedRef.current = onMounted;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useLayoutEffect(() => {
    onMountedRef.current(doneRef.current);
  }, []);

  // 選取中跨過寬窄判準：焦點所在的鈕（✕、圖示鈕、完成…）隨換形卸載，焦點會掉到 body。
  // render 時（舊 DOM 還在）記下焦點是否在本實例的標題列裡；換形後焦點落在 body 就交給新形的 doneRef（寬＝✕、窄＝完成）。
  const focusInHeaderRef = useRef(false);
  const header = rootRef.current?.closest("[data-sidebar-header]") ?? null;
  focusInHeaderRef.current = header !== null && header.contains(document.activeElement);
  const prevWideRef = useRef(wide);
  useLayoutEffect(() => {
    if (prevWideRef.current === wide) return;
    prevWideRef.current = wide;
    const active = document.activeElement;
    if (focusInHeaderRef.current && (active === null || active === document.body)) doneRef.current?.focus();
  }, [wide]);

  // Esc：選取模式在使用者離開側欄時不會結束，所以 document 層監聽要有範圍，下列全部成立才動作。
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
      // ⑤ 本實例看得見：抽屜那份恆看得見；靜態卡在 1280 以下（浮動與手機）是 hidden（抽屜關著時仍掛著）。
      if (!(shell?.hasAttribute("data-sidebar-drawer") || !window.matchMedia(OVERLAY_QUERY).matches)) return;
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
  const allState = selectAllState(visible, selection.keys);
  /** 全勾 → 清空全部（含收合子樹裡勾的）；否則 → 勾上可見列、保留已勾的。 */
  const toggleAll = () =>
    updateSelection(allState === "all" ? { type: "clear" } : { type: "setAll", keys: [...new Set([...selection.keys, ...visible])] });
  const countText = t("select.selected", { count });

  if (wide) {
    const progressText = run === null ? null : t("select.progress", run.progress);
    return (
      <span ref={rootRef} className="flex min-w-0 flex-1 items-center gap-0.5">
        <Button
          ref={doneRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("trash.exitSelect")}
          title={t("trash.exitSelect")}
          onClick={onDone}
          className="h-6 w-6 shrink-0"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <SelectAllCheckbox
          state={allState}
          disabled={visible.length === 0}
          onToggle={toggleAll}
          label={t("trash.selectAll")}
          title={allState === "all" ? t("trash.deselectAll") : t("trash.selectAll")}
        />
        <span className="flex h-6 min-w-0 flex-1 items-center px-1 text-[11px] font-semibold tracking-wide text-brand-on-soft">
          {progressText === null ? (
            <span className="truncate" title={countText}>
              {countText}
            </span>
          ) : (
            <span role="status" className="truncate font-normal text-muted-foreground" title={progressText}>
              {progressText}
            </span>
          )}
        </span>
        <SelectActionBar layout="toolbar" />
      </span>
    );
  }

  return (
    <>
      <span ref={rootRef} className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-brand-on-soft">
        <span className="truncate">{countText}</span>
      </span>
      <Button type="button" variant="ghost" size="sm" disabled={visible.length === 0} onClick={toggleAll} className="h-6 px-2 text-xs">
        {allState === "all" ? t("trash.deselectAll") : t("trash.selectAll")}
      </Button>
      <Button ref={doneRef} type="button" variant="outline" size="sm" onClick={onDone} className="h-6 px-2 text-xs">
        {t("trash.done")}
      </Button>
    </>
  );
}
