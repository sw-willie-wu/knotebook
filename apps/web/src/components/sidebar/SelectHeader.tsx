import "@/i18n/select-strings";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT, ROW_ICON_HIT_BORDERED } from "@/components/ui/hit-area";
import { cn } from "@/lib/utils";
import { X } from "@/components/ui/icons";
import { SelectAllCheckbox } from "@/components/ui/selection-checkbox";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { selectAllState } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { useWidePointer } from "@/lib/wide-pointer";
import { isCollapsed, useCollapseVersion } from "./collapse";
import { SelectActionBar } from "./SelectActionBar";
import { filteredSelectionKeys, selectedTargets, visibleSelectionKeys } from "./select-model";
import { useSelectRun } from "./select-run";
import { isFilterCollapsed, useFilterCollapsedSet } from "./tag-filter";
import type { SidebarNode } from "./tree";

/** An open Radix Toast (the root of `@radix-ui/react-toast` is `<li data-swipe-direction data-state>`). */
const OPEN_TOAST = 'li[data-swipe-direction][data-state="open"]';

/**
 * Select all ticks only visible rows (a collapsed subtree keeps earlier ticks); deselect all (click on the all-ticked tri-state box) clears everything, including collapsed subtrees.
 * "N selected" is folders + notes, ignoring collapse and not deduped (dedupe happens before sending).
 * Classes are the same as the select branch of `TrashPanel.renderHeader`.
 * Reuses the first bundle's `trash.*` strings (the key prefix is misleading, but renaming touches both locales of the first bundle and the trash tests). Import only through the SelectLazy chain and tests.
 */
export function SelectHeader({
  nodes,
  filtered = false,
  onMounted,
  onDone,
}: {
  nodes: readonly SidebarNode[];
  /** A tag filter is on: select-all takes every matching note (see `filteredSelectionKeys`) and the count ignores folders. */
  filtered?: boolean;
  onMounted: (done: HTMLButtonElement | null) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const wide = useWidePointer();
  const { selection } = useSidebarTabState();
  const actions = useSidebarTabActions();
  const { updateSelection } = actions;
  const run = useSelectRun(actions);
  // Re-render on collapse changes: select-all looks at visible rows.
  useCollapseVersion();
  useFilterCollapsedSet();
  /** The Esc guard finds its `[data-sidebar-instance]` through this: wide mounts on the outer element that stays (not swapped when the count turns into progress), narrow on the count slot. */
  const rootRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const onMountedRef = useRef(onMounted);
  onMountedRef.current = onMounted;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useLayoutEffect(() => {
    onMountedRef.current(doneRef.current);
  }, []);

  // Crossing the wide/narrow breakpoint mid-selection unmounts the focused button (✕, icon button, Done…) and focus falls to body.
  // Record at render (old DOM still present) whether focus is in this instance's header; if it ends up on body after the swap, hand it to the new form's doneRef (wide ✕, narrow Done).
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

  // Select mode doesn't end when the user leaves the sidebar, so the document-level listener is scoped: all conditions below must hold.
  useEffect(() => {
    /** Whether a toast was open when this key reached window capture (earliest): a real browser runs microtasks between listeners, so by bubble the toast may already be closed. */
    let toastOpenAt: Event | null = null;
    const capture = (event: KeyboardEvent) => {
      toastOpenAt = event.key === "Escape" && document.querySelector(OPEN_TOAST) !== null ? event : null;
    };
    const handler = (event: KeyboardEvent) => {
      // Esc only; Esc during IME composition cancels the composition; skip if already handled (drawer's Radix, destination/confirm dialogs preventDefault in capture).
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      // A dialog other than the drawer is open: Esc belongs to it.
      if (document.querySelector('[role="dialog"]:not([data-sidebar-drawer])')) return;
      // A toast was open when the key went down: Radix Toast doesn't preventDefault when closing it, so one Esc closes only one layer (an error toast after a stop doesn't drop the selection).
      if (toastOpenAt === event) return;
      const shell = rootRef.current?.closest("[data-sidebar-instance]");
      // This instance is visible: the drawer's always is; the static card is hidden below 1280 (floating and phone) while still mounted when the drawer is closed.
      if (!(shell?.hasAttribute("data-sidebar-drawer") || !window.matchMedia(OVERLAY_QUERY).matches)) return;
      // Focus on body (macOS Safari doesn't focus a clicked checkbox) or inside this instance: Esc in main-content inputs or the editor doesn't count.
      const target = event.target;
      if (!(target === document || target === document.body || target === document.documentElement || (target instanceof Node && shell?.contains(target)))) return;
      // Lets window listeners such as the NotePage preview yield via defaultPrevented (repo convention).
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

  const count = selectedTargets(nodes, selection.keys).filter((target) => !filtered || target.kind === "note").length;
  const visible = filtered ? filteredSelectionKeys(nodes, isFilterCollapsed) : visibleSelectionKeys(nodes, isCollapsed);
  const allState = selectAllState(visible, selection.keys);
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
      <Button type="button" variant="ghost" size="sm" disabled={visible.length === 0} onClick={toggleAll} className={cn("h-6 px-2 text-xs", ROW_ICON_HIT)}>
        {allState === "all" ? t("trash.deselectAll") : t("trash.selectAll")}
      </Button>
      <Button ref={doneRef} type="button" variant="outline" size="sm" onClick={onDone} className={cn("h-6 px-2 text-xs", ROW_ICON_HIT_BORDERED)}>
        {t("trash.done")}
      </Button>
    </>
  );
}
