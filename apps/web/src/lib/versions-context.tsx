import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VersionDto } from "@knotebook/shared";
import type { VersionKindFilter, VersionTarget } from "@/api/versions";
import { PHONE_QUERY, isPhone } from "@/lib/layout-tiers";

/**
 * Without a provider it returns a no-op default (`enabled: false`): the AI components' test host (`test/ai-host.tsx`) and
 * the sidebar's per-row ⋮ (outside the provider) rely on it, so every entry point renders only when `enabled`.
 * open() opens `sheet` below 640, otherwise `panel` (floating at 640-1279, third column from 1280).
 * Crossing 640 closes the panel and preview; crossing 1280 keeps them (same component, list scroll kept).
 */

export type VersionsMode = "panel" | "sheet";
export type VersionsDialog =
  | { kind: "save"; then?: VersionDto }
  | { kind: "apply"; version: VersionDto }
  | { kind: "rename"; version: VersionDto }
  | { kind: "delete"; version: VersionDto };
export type SplitMode = "auto" | "split" | "single";

export const KIND_FILTER_STORAGE_KEY = "knotebook.versions.filter";

function readKindFilter(): VersionKindFilter {
  try {
    return window.localStorage.getItem(KIND_FILTER_STORAGE_KEY) === "manual" ? "manual" : "all";
  } catch {
    return "all";
  }
}

function writeKindFilter(v: VersionKindFilter): void {
  try {
    window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, v);
  } catch {
  }
}

export interface VersionsContextValue {
  enabled: boolean;
  noteId: string | null;
  mode: VersionsMode | null;
  panelOpen: boolean;
  preview: VersionTarget | null;
  previewSeq: number | null;
  compareRight: VersionTarget | "current";
  splitMode: SplitMode;
  onlyChanges: boolean;
  /** List filter (#258), one for the whole site in localStorage; **not reset when the note changes**. Affects only the list and compare options. */
  kindFilter: VersionKindFilter;
  /** Content box ≥ `SPLIT_MIN_WIDTH` and not `forceSingle`; when false the banner hides the side-by-side / single buttons.
   * Reported by `VersionPreview`, the only one that can measure the width. */
  previewWide: boolean;
  /** A "side by side" chosen while narrow stays in `splitMode` and resumes when wide again. "Differences only" works only in single column. */
  splitActive: boolean;
  dialog: VersionsDialog | null;
  open(): void;
  close(): void;
  openSave(then?: VersionDto): void;
  /** Sets only the left side; the right side stays. */
  startPreview(target: VersionTarget): void;
  stopPreview(): void;
  setCompareRight(v: VersionTarget | "current"): void;
  setSplitMode(v: SplitMode): void;
  setOnlyChanges(v: boolean): void;
  setKindFilter(v: VersionKindFilter): void;
  reportPreviewWide(v: boolean): void;
  openDialog(d: VersionsDialog): void;
  closeDialog(): void;
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
  kindFilter: "all",
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
  setKindFilter: noop,
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

/** The sidebar drawer does not count, same as AppShell's Ctrl+K back-off. */
export function isOverlayOpen(): boolean {
  return document.querySelector('[role="dialog"]:not([data-sidebar-drawer]), [role="menu"]') !== null;
}

export function useVersionsController({
  noteId,
  enabled,
  onApplied,
  onOpen,
}: {
  noteId: string | null;
  enabled: boolean;
  /** Kept in a ref so it stays out of the context value's deps. */
  onApplied?: () => void;
  /** Called before opening (kept in a ref too); NotePage closes the comments here so only one right-hand panel is open. */
  onOpen?: () => void;
}): VersionsContextValue {
  const onAppliedRef = useRef(onApplied);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onAppliedRef.current = onApplied;
    onOpenRef.current = onOpen;
  });
  const notifyApplied = useCallback(() => onAppliedRef.current?.(), []);
  const [mode, setMode] = useState<VersionsMode | null>(null);
  const [preview, setPreview] = useState<VersionTarget | null>(null);
  const [compareRight, setCompareRight] = useState<VersionTarget | "current">("current");
  const [splitMode, setSplitMode] = useState<SplitMode>("auto");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [kindFilter, setKindFilterState] = useState<VersionKindFilter>(readKindFilter);
  const [previewWide, reportPreviewWide] = useState(false);
  const [dialog, setDialog] = useState<VersionsDialog | null>(null);
  const [forNote, setForNote] = useState(noteId);

  // Note change: reset during render. **The wide panel (`mode === "panel"`) and the list filter are not reset** (#258): an open
  // panel stays and shows the new note's list (the effect below closes it only if the new note is not editable / terminal).
  // **The narrow full page (`"sheet"`) closes**: it covers the note full screen. NotePage passes through `noteId === null`
  // when changing notes, so the first change of noteId closes it.
  if (forNote !== noteId) {
    setForNote(noteId);
    if (mode === "sheet") setMode(null);
    setPreview(null);
    setDialog(null);
    setCompareRight("current");
    setSplitMode("auto");
    setOnlyChanges(false);
  }

  const active = enabled && noteId !== null;

  // When enabled turns false (downgraded to viewer, terminal state) → close the panel / preview / dialogs together: merely
  // hiding the output could let them reappear if enabled flips back while the collab role and the REST role briefly disagree.
  // Exception (#258): `noteId === null` is NotePage's note-change transition, not a downgrade: keep the panel's `mode` and
  // close only the preview / dialogs; the panel resumes once the new note resolves (`active` true).
  useEffect(() => {
    if (active) return;
    if (noteId !== null) setMode(null);
    setPreview(null);
    setCompareRight("current");
    setDialog(null);
  }, [active, noteId]);

  useEffect(() => {
    if (mode === null && preview === null) return;
    const mql = window.matchMedia(PHONE_QUERY);
    const onChange = () => {
      setMode(null);
      setPreview(null);
      setCompareRight("current");
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode, preview]);

  const open = useCallback(() => {
    if (!active) return;
    onOpenRef.current?.();
    setMode(isPhone() ? "sheet" : "panel");
  }, [active]);
  // Closing the panel also leaves the preview: the banner has no ✕ any more, so a preview left open would have no exit.
  // The right side resets to current as in stopPreview.
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
  const setCompareRightGated = useCallback((v: VersionTarget | "current") => {
    if (active) setCompareRight(v);
  }, [active]);
  const openDialog = useCallback((d: VersionsDialog) => {
    if (active) setDialog(d);
  }, [active]);
  const closeDialog = useCallback(() => setDialog(null), []);
  const setKindFilter = useCallback((v: VersionKindFilter) => {
    setKindFilterState(v);
    writeKindFilter(v);
  }, []);

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
      kindFilter,
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
      setKindFilter,
      reportPreviewWide,
      openDialog,
      closeDialog,
      onApplied: notifyApplied,
    }),
    [active, noteId, mode, preview, compareRight, splitMode, onlyChanges, kindFilter, previewWide, dialog, open, close, openSave, startPreview, stopPreview, setCompareRightGated, setKindFilter, openDialog, closeDialog, notifyApplied],
  );
}
