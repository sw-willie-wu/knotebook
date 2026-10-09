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
export type CompareTo = "previous" | "current";
export type SplitMode = "auto" | "split" | "single";

export interface VersionsContextValue {
  enabled: boolean;
  noteId: string | null;
  mode: VersionsMode | null;
  panelOpen: boolean;
  preview: VersionTarget | null;
  previewSeq: number | null;
  compareTo: CompareTo;
  splitMode: SplitMode;
  onlyChanges: boolean;
  dialog: VersionsDialog | null;
  open(): void;
  close(): void;
  openSave(then?: VersionDto): void;
  startPreview(target: VersionTarget): void;
  stopPreview(): void;
  setCompareTo(v: CompareTo): void;
  setSplitMode(v: SplitMode): void;
  setOnlyChanges(v: boolean): void;
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
  compareTo: "previous",
  splitMode: "auto",
  onlyChanges: false,
  dialog: null,
  open: noop,
  close: noop,
  openSave: noop,
  startPreview: noop,
  stopPreview: noop,
  setCompareTo: noop,
  setSplitMode: noop,
  setOnlyChanges: noop,
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
  const [compareTo, setCompareTo] = useState<CompareTo>("previous");
  const [splitMode, setSplitMode] = useState<SplitMode>("auto");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [dialog, setDialog] = useState<VersionsDialog | null>(null);
  const [forNote, setForNote] = useState(noteId);

  // 換筆記：render 期間重設（React 文件的「依 props 重設 state」形），不留上一篇的面板／預覽／對話框。
  if (forNote !== noteId) {
    setForNote(noteId);
    setMode(null);
    setPreview(null);
    setDialog(null);
    setCompareTo("previous");
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
    setDialog(null);
  }, [active]);

  useEffect(() => {
    if (mode === null && preview === null) return;
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setMode(null);
      setPreview(null);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode, preview]);

  const open = useCallback(() => {
    if (active) setMode(isNarrow() ? "sheet" : "panel");
  }, [active]);
  const close = useCallback(() => setMode(null), []);
  const openSave = useCallback((then?: VersionDto) => {
    if (active) setDialog(then ? { kind: "save", then } : { kind: "save" });
  }, [active]);
  const startPreview = useCallback((t: VersionTarget) => {
    if (active) setPreview(t);
  }, [active]);
  const stopPreview = useCallback(() => setPreview(null), []);
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
      compareTo,
      splitMode,
      onlyChanges,
      dialog: active ? dialog : null,
      open,
      close,
      openSave,
      startPreview,
      stopPreview,
      setCompareTo,
      setSplitMode,
      setOnlyChanges,
      openDialog,
      closeDialog,
      onApplied: notifyApplied,
    }),
    [active, noteId, mode, preview, compareTo, splitMode, onlyChanges, dialog, open, close, openSave, startPreview, stopPreview, openDialog, closeDialog, notifyApplied],
  );
}
