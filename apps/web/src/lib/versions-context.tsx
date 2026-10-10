import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VersionDto } from "@knotebook/shared";
import type { VersionTarget } from "@/api/versions";

/**
 * 版本歷史的頁面層狀態（spec §8.1）。`NotePage` 呼叫 `useVersionsController` 持有、以 `VersionsProvider`
 * 包住 `<NoteEditor>`；⋮ 選單、Ctrl+S、歷史泡泡、面板、預覽、對話框都從 `useVersions()` 取。
 *
 * **沒有 provider 時回 no-op 預設**（`enabled: false`）：`AiPanel.test.tsx`／`NoteEditorView.test.tsx`
 * 單獨包 `AiSessionProvider` 渲染、側欄每列的 ⋮（在 provider 之外）都靠它——入口一律以 `enabled` 判斷要不要渲染。
 *
 * 寬窄（起草裁定 3、4）：`open()` 當下以 `NARROW_QUERY` 決定開第三欄卡（`panel`）還是整頁（`sheet`）；
 * 開著時一跨斷點就整個關掉、預覽一併離開（RF4，比照 `AppShell` 的抽屜）。
 */
export const NARROW_QUERY = "(width < 48rem)";

export type VersionsMode = "panel" | "sheet";
export type VersionsDialog =
  | { kind: "save"; then?: VersionDto }
  | { kind: "apply"; version: VersionDto }
  | { kind: "rename"; version: VersionDto }
  | { kind: "delete"; version: VersionDto };
export type SplitMode = "auto" | "split" | "single";

export interface VersionsContextValue {
  enabled: boolean;
  noteId: string | null;
  mode: VersionsMode | null;
  panelOpen: boolean;
  preview: VersionTarget | null;
  previewSeq: number | null;
  /** 比較對象的右邊（spec §8.4【rev 10】）：預設 `"current"`（活文件的 fork）；左邊就是 `preview`。diff 方向固定左→右。 */
  compareRight: VersionTarget | "current";
  splitMode: SplitMode;
  onlyChanges: boolean;
  /** 預覽區夠不夠並排（`VersionPreview` 量到的 content box ≥ `SPLIT_MIN_WIDTH`、且不是 `forceSingle`）；由 `VersionPreview` 回報——
   * 寬度只有它量得到（final §14-6）。不夠寬時沒有並排：橫幅不渲染並排／單欄兩顆鈕。 */
  previewWide: boolean;
  /** 預覽目前實際是並排：`previewWide` 且使用者沒選單欄。窄時選過的「並排」留在 `splitMode`、不生效，變寬後恢復。
   * 「只看差異」只對單欄有效（spec §8.4），橫幅與整頁依它把開關停用（final M-1）；並排／單欄的按下態也看它。 */
  splitActive: boolean;
  dialog: VersionsDialog | null;
  open(): void;
  close(): void;
  openSave(then?: VersionDto): void;
  /** 只設左邊（面板點列、左下拉、整頁上下一版），右邊保持（Willie：「面板選版本的時候如果右側有選成其他版的話不用跳回目前」）。 */
  startPreview(target: VersionTarget): void;
  /** 離開預覽；右邊一併重設為 `"current"`（換筆記、`enabled` 翻 false、跨斷點同）。 */
  stopPreview(): void;
  setCompareRight(v: VersionTarget | "current"): void;
  setSplitMode(v: SplitMode): void;
  setOnlyChanges(v: boolean): void;
  /** `VersionPreview` 專用：回報 `previewWide`。 */
  reportPreviewWide(v: boolean): void;
  openDialog(d: VersionsDialog): void;
  closeDialog(): void;
  /** 套用成功後由 `useApplyFlow` 呼叫：轉給 controller 的 `onApplied` 選項（NotePage 用它讓筆記 query 整組失效）。 */
  onApplied(): void;
}

const noop = () => {};
export const NOOP_VERSIONS: VersionsContextValue = {
  enabled: false,
  noteId: null,
  mode: null,
  panelOpen: false,
  preview: null,
  previewSeq: null,
  compareRight: "current",
  splitMode: "auto",
  onlyChanges: false,
  previewWide: false,
  splitActive: false,
  dialog: null,
  open: noop,
  close: noop,
  openSave: noop,
  startPreview: noop,
  stopPreview: noop,
  setCompareRight: noop,
  setSplitMode: noop,
  setOnlyChanges: noop,
  reportPreviewWide: noop,
  openDialog: noop,
  closeDialog: noop,
  onApplied: noop,
};

const VersionsContext = createContext<VersionsContextValue>(NOOP_VERSIONS);

export function useVersions(): VersionsContextValue {
  return useContext(VersionsContext);
}

export function VersionsProvider({ value, children }: { value: VersionsContextValue; children: ReactNode }) {
  return <VersionsContext.Provider value={value}>{children}</VersionsContext.Provider>;
}

/** 有沒有任何會自己吃 Esc／該擋 Ctrl+S 的浮層開著（側欄抽屜除外，比照 AppShell 的 Ctrl+K 讓路判準）。 */
export function isOverlayOpen(): boolean {
  return document.querySelector('[role="dialog"]:not([data-sidebar-drawer]), [role="menu"]') !== null;
}

function isNarrow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

export function useVersionsController({
  noteId,
  enabled,
  onApplied,
}: {
  noteId: string | null;
  enabled: boolean;
  /** 套用成功後的通知（NotePage：`invalidateNoteQueries`）。存 ref 取最新值，不進 context value 的 deps。 */
  onApplied?: () => void;
}): VersionsContextValue {
  const onAppliedRef = useRef(onApplied);
  useEffect(() => {
    onAppliedRef.current = onApplied;
  });
  const notifyApplied = useCallback(() => onAppliedRef.current?.(), []);
  const [mode, setMode] = useState<VersionsMode | null>(null);
  const [preview, setPreview] = useState<VersionTarget | null>(null);
  const [compareRight, setCompareRight] = useState<VersionTarget | "current">("current");
  const [splitMode, setSplitMode] = useState<SplitMode>("auto");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [previewWide, reportPreviewWide] = useState(false);
  const [dialog, setDialog] = useState<VersionsDialog | null>(null);
  const [forNote, setForNote] = useState(noteId);

  // 換筆記：render 期間重設（React 文件的「依 props 重設 state」形），不留上一篇的面板／預覽／對話框。
  if (forNote !== noteId) {
    setForNote(noteId);
    setMode(null);
    setPreview(null);
    setDialog(null);
    setCompareRight("current");
    setSplitMode("auto");
    setOnlyChanges(false);
  }

  const active = enabled && noteId !== null;

  // enabled 翻 false（降級成 viewer、終態）→ 面板／預覽／對話框一併關掉（Task 10 fix round 1，總管裁定）。
  // 只遮輸出不清 state 的話，共編角色與 REST 角色短暫不一致時 enabled 會翻回 true，降級前開著的東西會重現。
  useEffect(() => {
    if (active) return;
    setMode(null);
    setPreview(null);
    setCompareRight("current");
    setDialog(null);
  }, [active]);

  useEffect(() => {
    if (mode === null && preview === null) return;
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setMode(null);
      setPreview(null);
      setCompareRight("current");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode, preview]);

  const open = useCallback(() => {
    if (active) setMode(isNarrow() ? "sheet" : "panel");
  }, [active]);
  // 關面板＝一併離開預覽（spec §8.4 rev 10 追記，Task 19）：橫幅不再有 ✕，面板關了預覽卻留著就沒有出口。
  // 右邊同 stopPreview 重設 current。CornerStack 的 AI 橋接呼叫 close() 也因此一併離開預覽。
  const close = useCallback(() => {
    setMode(null);
    setPreview(null);
    setCompareRight("current");
  }, []);
  const openSave = useCallback((then?: VersionDto) => {
    if (active) setDialog(then ? { kind: "save", then } : { kind: "save" });
  }, [active]);
  const startPreview = useCallback((t: VersionTarget) => {
    if (active) setPreview(t);
  }, [active]);
  const stopPreview = useCallback(() => {
    setPreview(null);
    setCompareRight("current");
  }, []);
  // 同 startPreview／openDialog：inactive 時不收（review N-2）。
  const setCompareRightGated = useCallback((v: VersionTarget | "current") => {
    if (active) setCompareRight(v);
  }, [active]);
  const openDialog = useCallback((d: VersionsDialog) => {
    if (active) setDialog(d);
  }, [active]);
  const closeDialog = useCallback(() => setDialog(null), []);

  return useMemo<VersionsContextValue>(
    () => ({
      enabled: active,
      noteId,
      mode: active ? mode : null,
      panelOpen: active && mode === "panel",
      preview: active ? preview : null,
      previewSeq: active ? (preview?.seq ?? null) : null,
      compareRight: active ? compareRight : "current",
      splitMode,
      onlyChanges,
      previewWide: active && preview !== null && previewWide,
      splitActive: active && preview !== null && previewWide && splitMode !== "single",
      dialog: active ? dialog : null,
      open,
      close,
      openSave,
      startPreview,
      stopPreview,
      setCompareRight: setCompareRightGated,
      setSplitMode,
      setOnlyChanges,
      reportPreviewWide,
      openDialog,
      closeDialog,
      onApplied: notifyApplied,
    }),
    [active, noteId, mode, preview, compareRight, splitMode, onlyChanges, previewWide, dialog, open, close, openSave, startPreview, stopPreview, setCompareRightGated, openDialog, closeDialog, notifyApplied],
  );
}
