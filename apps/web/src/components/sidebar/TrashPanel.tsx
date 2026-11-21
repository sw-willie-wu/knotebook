import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TrashItemDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { usePurgeTrash, useRestoreTrash, useTrash } from "@/api/trash";
import { useSession } from "@/auth/useSession";
import { selectAllState, selectionKey } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { selectedTrashIds, splitTrashSections, trashDetailLine, trashItemTitle, trashLocationLine } from "@/lib/trash-display";
import { useWidePointer } from "@/lib/wide-pointer";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT, ROW_ICON_HIT_BORDERED, ROW_ICON_ROW } from "@/components/ui/hit-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EllipsisVertical, SquareCheck, Trash, X } from "@/components/ui/icons";
import { RotateCcw } from "@/components/ui/icons-extra";
import { hoverReveal } from "@/components/ui/reveal";
import { SelectAllCheckbox, SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { cn } from "@/lib/utils";
import { tabSpec, type HeaderActionId } from "@/components/sidebar/tab-specs";
import { EmptyTrashDialog, PurgeConfirmDialog, toastTrashFailure, toastTrashResult } from "@/components/sidebar/trash-dialogs";
import { TrashWideToolbar } from "@/components/sidebar/TrashFooter";
import { PHONE_LIST_HEADER_STICKY, PHONE_LIST_SCROLLER } from "@/components/sidebar/phone-bar";
import { usePhoneListScroll } from "@/components/sidebar/phone-list-scroll";

/**
 * Rows are not links (trashed notes can't be opened). "Empty" sends every id on the list to purge: items trashed afterwards are unaffected; `purgeTrashIds` batches above 200.
 * Focus moves only from the instance that started the action (`focusAfterRef`).
 */

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

const MESSAGE_CLASS = "p-2 text-sm text-muted-foreground";

interface RowActions {
  onRestore: (id: string) => void;
  onPurge: (id: string, trigger: HTMLElement | null) => void;
}

function TrashRow({ item, now, actions }: { item: TrashItemDto; now: number; actions: RowActions }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const locale = i18n.language;
  return (
    <li
      data-node-kind="note"
      data-node-id={item.id}
      title={trashItemTitle(item, { t, locale })}
      className={cn("group/noterow flex items-center gap-0.5 rounded-md py-1.5 pl-2 pr-0.75 text-[13px] hover:bg-brand-soft hover:text-brand-on-soft", ROW_ICON_ROW)}
    >
      {/* Both lines are <div>, as NoteList recents rows */}
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.title}</div>
        {/* title = full path when the location is truncated; none at root */}
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={trashLocationLine(item) || undefined}>
          {trashDetailLine(item, { now, t, locale })}
        </div>
      </div>
      {/* 24px sidebar exception (see button.tsx header); shares hoverReveal("noterow") with the note row ⋮ */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("trash.restoreFor", { title: item.title })}
        title={t("trash.restore")}
        onClick={() => actions.onRestore(item.id)}
        className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, hoverReveal("noterow"))}
      >
        <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      {/* controlled + three steps (preventDefault → close menu → action): focus-trap rule, as NoteMenu */}
      <DropdownMenu phoneSheet open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.menuFor", { title: item.title })}
            className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, hoverReveal("noterow"))}
          >
            <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sheetTitle={item.title}>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              actions.onRestore(item.id);
            }}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("trash.restore")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              actions.onPurge(item.id, triggerRef.current);
            }}
          >
            <Trash className="mr-2 h-4 w-4" />
            {t("trash.purge")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** memo: ticking a row doesn't re-render others or recompute dates (`now`/`onToggle` are stable from `TrashPanel`). */
const SelectableTrashRow = memo(function SelectableTrashRow({
  item,
  now,
  checked,
  onToggle,
}: {
  item: TrashItemDto;
  now: number;
  checked: boolean;
  onToggle: (key: string, shiftKey: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  return (
    <li data-node-kind="note" data-node-id={item.id} title={trashItemTitle(item, { t, locale })}>
      {/* select-none: Shift+click on text must not select page text; a label holds only phrasing content, so the two lines are block spans */}
      <label
        className={cn(
          "flex cursor-pointer select-none items-start gap-2 rounded-md py-1.5 pl-2 pr-1 text-[13px]",
          checked ? "bg-brand-soft font-medium text-brand-on-soft" : "hover:bg-brand-soft hover:text-brand-on-soft",
        )}
        // Firefox doesn't forward a label's click to the checkbox when a modifier is held (left for text selection), so Shift/Ctrl+click on the row text did nothing:
        // with a modifier and a target other than the checkbox, cancel the forward and toggle ourselves (same in all three engines; Chromium/WebKit don't toggle twice).
        onClick={(event) => {
          if (!(event.shiftKey || event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          onToggle(selectionKey({ kind: "note", id: item.id }), event.shiftKey);
        }}
      >
        <SelectionCheckbox
          checked={checked}
          // Shift = range; Ctrl/⌘+click is a plain toggle. Ctrl+click on macOS is a right-click and fires no click, hence ⌘.
          onChange={(event) => onToggle(selectionKey({ kind: "note", id: item.id }), (event.nativeEvent as MouseEvent).shiftKey)}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.title}</span>
          <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground" title={trashLocationLine(item) || undefined}>
            {trashDetailLine(item, { now, t, locale })}
          </span>
        </span>
      </label>
    </li>
  );
});

function TrashSection({ label, items, renderItem }: { label: string; items: TrashItemDto[]; renderItem: (item: TrashItemDto) => ReactNode }) {
  const headingId = useId();
  return (
    <>
      <h3 id={headingId} className="flex h-6 items-center px-2 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul aria-labelledby={headingId} className="space-y-0.5">
        {items.map(renderItem)}
      </ul>
    </>
  );
}

export function TrashPanel() {
  const { t } = useTranslation();
  const trash = useTrash();
  const { user } = useSession();
  const restore = useRestoreTrash();
  const purge = usePurgeTrash();
  const { selection } = useSidebarTabState();
  const { updateSelection, endSelectionIfActive } = useSidebarTabActions();
  const wide = useWidePointer();
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  usePhoneListScroll(listRef, headerRef);
  const emptyButtonRef = useRef<HTMLButtonElement>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  /** Set only by the initiating instance: the static card and the drawer are both in the DOM, and the other must not take focus. */
  const focusAfterRef = useRef<"done" | "select" | null>(null);
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);
  /** +1 per opening: on response the dialog closes only if it is still the same opening (one cancelled and reopened meanwhile isn't). */
  const emptyRoundRef = useRef(0);
  /** Opener of the dialog (row ⋮ / "Empty"): focus returns here on cancel (no DialogTrigger; Radix's default falls to body). A ref because state is already cleared in the closing render. */
  const openerRef = useRef<HTMLElement | null>(null);
  const submittedRef = useRef(false);
  /** No double send on rapid clicks: the mutation's `isPending` reaches `disabled` only a macrotask later. */
  const busyRef = useRef(false);

  const items = trash.data?.items ?? [];
  const actionsDisabled = !trash.isSuccess || items.length === 0;
  const selectedIds = selectedTrashIds(items, selection.keys);
  const allSelected = items.length > 0 && selectedIds.length === items.length;

  useEffect(() => {
    const target = focusAfterRef.current;
    if (target === null) return;
    focusAfterRef.current = null;
    (target === "done" ? doneButtonRef : selectButtonRef).current?.focus();
  }, [selection.active]);

  // Crossing the wide/narrow breakpoint mid-selection (as SelectHeader) swaps the header and unmounts the focused button; focus falls to body.
  // Record at render (old DOM still present) whether focus is in this instance's header; if it ends up on body after the swap, hand it to the new form's doneButtonRef (wide ✕, narrow Done).
  const focusInHeaderRef = useRef(false);
  focusInHeaderRef.current = headerRef.current?.contains(document.activeElement) ?? false;
  const prevWideRef = useRef(wide);
  useLayoutEffect(() => {
    if (prevWideRef.current === wide) return;
    prevWideRef.current = wide;
    const active = document.activeElement;
    if (focusInHeaderRef.current && (active === null || active === document.body)) doneButtonRef.current?.focus();
  }, [wide]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Ignore keys bubbling from a portal (the wide toolbar's purge dialog) through the React tree: Esc in the dialog only closes it, doesn't end selection.
    if (!event.currentTarget.contains(event.target as Node)) return;
    // The static card's Esc. In the drawer AppShell's onEscapeKeyDown (document capture) ends selection and hands focus; a real browser commits after that
    // and before React's onKeyDown, with the checkboxes already unmounted, so this never sees it.
    if (event.key !== "Escape" || !selection.active) return;
    focusAfterRef.current = "select";
    if (endSelectionIfActive()) event.preventDefault(); // Only ends selection; the search-highlight Esc listener yields on defaultPrevented
  }

  const toggleRow = useCallback(
    (key: string, shiftKey: boolean): void => {
      const { order } = splitTrashSections(trash.data?.items ?? []);
      updateSelection(shiftKey ? { type: "range", key, order } : { type: "toggle", key });
    },
    [trash.data, updateSelection],
  );

  async function exclusive(run: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await run();
    } finally {
      busyRef.current = false;
    }
  }

  const rowActions: RowActions = {
    onRestore: (id) =>
      void exclusive(async () => {
        try {
          toastTrashResult("restore", await restore.mutateAsync([id]), t);
        } catch (err) {
          toastTrashFailure("restore", err, t);
        }
        // A restored row unmounts: pull focus to the list only if it was in the panel (or already on body); if the user moved elsewhere (e.g. the editor) while waiting, don't grab it.
        const active = document.activeElement;
        if (active === null || active === document.body || rootRef.current?.contains(active)) listRef.current?.focus();
      }),
    onPurge: (id, trigger) => {
      openerRef.current = trigger;
      submittedRef.current = false;
      setPurgeId(id);
    },
  };

  async function purgeIds(ids: readonly string[], close: () => void): Promise<void> {
    await exclusive(async () => {
      submittedRef.current = true;
      try {
        toastTrashResult("purge", await purge.mutateAsync(ids), t);
      } catch (err) {
        toastTrashFailure("purge", err, t);
      } finally {
        close();
      }
    });
  }

  function focusAfterClose(event: Event): void {
    event.preventDefault();
    const opener = openerRef.current;
    if (!submittedRef.current && opener?.isConnected) opener.focus();
    else listRef.current?.focus();
  }

  function renderAction(action: HeaderActionId): ReactNode {
    switch (action) {
      case "selectMode":
        return (
          <Button
            key={action}
            ref={selectButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.select")}
            title={t("trash.select")}
            disabled={actionsDisabled}
            // Handle: after the bottom action bar leaves select mode, find this same instance's button via `[data-sidebar-instance]` and focus it.
            data-sidebar-select=""
            onClick={() => {
              // Don't resend `start` while selecting: the reducer's `start` clears ticks (a double-click before the header text swaps does the same).
              if (selection.active) return;
              focusAfterRef.current = "done";
              updateSelection({ type: "start" });
            }}
            className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT)}
          >
            <SquareCheck aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        );
      case "emptyTrash":
        return (
          <Button
            key={action}
            ref={emptyButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            disabled={actionsDisabled}
            onClick={() => {
              openerRef.current = emptyButtonRef.current;
              submittedRef.current = false;
              emptyRoundRef.current += 1;
              setEmptyOpen(true);
            }}
            className={cn("h-6 shrink-0 px-2 text-xs text-destructive hover:text-destructive", ROW_ICON_HIT)}
          >
            {t("trash.emptyTrash")}
          </Button>
        );
      case "openIndex":
      case "tagFilter":
      case "newPersonalNote":
      case "newGroup":
      case "newFolder":
        return null;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  function renderBody(): ReactNode {
    if (trash.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    if (trash.isError) {
      return (
        <p role="alert" className="p-2 text-sm text-destructive">
          {errorMessage(t, trash.error)}
        </p>
      );
    }
    if (items.length === 0) return <p className={MESSAGE_CLASS}>{t("trash.empty")}</p>;
    const { personal, workspace } = splitTrashSections(items);
    // "N days left" is computed from the time the list was fetched (updated per refetch): ticking and other re-renders don't change it, so the select rows' memo works.
    const now = trash.dataUpdatedAt;
    const renderItem = (item: TrashItemDto) =>
      selection.active ? (
        <SelectableTrashRow
          key={item.id}
          item={item}
          now={now}
          checked={selection.keys.has(selectionKey({ kind: "note", id: item.id }))}
          onToggle={toggleRow}
        />
      ) : (
        <TrashRow key={item.id} item={item} now={now} actions={rowActions} />
      );
    return (
      <>
        {personal.length > 0 && <TrashSection label={t("sidebar.myNotes")} items={personal} renderItem={renderItem} />}
        {workspace.length > 0 && <TrashSection label={t("trash.sectionWorkspace")} items={workspace} renderItem={renderItem} />}
        {trash.data.truncated && <p className="p-2 text-[11px] text-muted-foreground">{t("trash.truncated")}</p>}
      </>
    );
  }

  function renderHeader(): ReactNode {
    if (!selection.active) {
      return (
        <>
          <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
            <span className="truncate">{trash.isSuccess ? t("trash.header", { count: items.length }) : t("sidebar.trash")}</span>
          </span>
          {tabSpec("trash").actions.map(renderAction)}
        </>
      );
    }
    const endSelecting = () => {
      focusAfterRef.current = "select";
      updateSelection({ type: "end" });
    };
    if (wide) {
      const { order } = splitTrashSections(items);
      const allState = selectAllState(order, selection.keys);
      const countText = t("trash.selected", { count: selectedIds.length });
      return (
        <>
          <Button
            ref={doneButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.exitSelect")}
            title={t("trash.exitSelect")}
            onClick={endSelecting}
            className="h-6 w-6 shrink-0"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <SelectAllCheckbox
            state={allState}
            // The list was refetched to 0 while selecting (cleared elsewhere): nothing selectable.
            disabled={items.length === 0}
            onToggle={() => updateSelection(allState === "all" ? { type: "clear" } : { type: "setAll", keys: order })}
            label={t("trash.selectAll")}
            title={allState === "all" ? t("trash.deselectAll") : t("trash.selectAll")}
          />
          <span className="flex h-6 min-w-0 flex-1 items-center px-1 text-[11px] font-semibold tracking-wide text-brand-on-soft">
            <span className="truncate" title={countText}>
              {countText}
            </span>
          </span>
          <TrashWideToolbar />
        </>
      );
    }
    return (
      <>
        <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-brand-on-soft">
          <span className="truncate">{t("trash.selected", { count: selectedIds.length })}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // The list was refetched to 0 while selecting (cleared elsewhere): nothing selectable.
          disabled={items.length === 0}
          onClick={() => updateSelection(allSelected ? { type: "clear" } : { type: "setAll", keys: splitTrashSections(items).order })}
          className={cn("h-6 px-2 text-xs", ROW_ICON_HIT)}
        >
          {allSelected ? t("trash.deselectAll") : t("trash.selectAll")}
        </Button>
        <Button
          ref={doneButtonRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={endSelecting}
          className={cn("h-6 px-2 text-xs", ROW_ICON_HIT_BORDERED)}
        >
          {t("trash.done")}
        </Button>
      </>
    );
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
      <div ref={headerRef} data-sidebar-header="" className={cn("flex items-center gap-0.5 pl-2 pr-2.75 pt-3 pb-1 pointer-coarse:pb-2.5", ROW_ICON_ROW, PHONE_LIST_HEADER_STICKY)}>
        {renderHeader()}
      </div>
      <div data-sidebar-list="" tabIndex={-1} ref={listRef} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2 focus-visible:outline-none", PHONE_LIST_SCROLLER)}>
        {renderBody()}
      </div>
      <PurgeConfirmDialog
        count={1}
        open={purgeId !== null}
        // Also disabled while the row's restore is in flight: `exclusive` would swallow this click.
        pending={purge.isPending || restore.isPending}
        onConfirm={() => {
          if (purgeId === null) return;
          const target = purgeId;
          // Cancelled and reopened on another row before the response: don't close that second dialog.
          void purgeIds([target], () => setPurgeId((current) => (current === target ? null : current)));
        }}
        onOpenChange={(open) => {
          if (!open) setPurgeId(null);
        }}
        onCloseAutoFocus={focusAfterClose}
      />
      <EmptyTrashDialog
        items={items}
        meHandle={user?.handle ?? null}
        open={emptyOpen}
        pending={purge.isPending || restore.isPending}
        onConfirm={() => {
          // The list was refetched to 0 after opening (emptied elsewhere): no empty request or "deleted 0" report, just close.
          if (items.length === 0) {
            setEmptyOpen(false);
            return;
          }
          const round = emptyRoundRef.current;
          void purgeIds(
            items.map((item) => item.id),
            () => {
              if (emptyRoundRef.current === round) setEmptyOpen(false);
            },
          );
        }}
        onOpenChange={setEmptyOpen}
        onCloseAutoFocus={focusAfterClose}
      />
    </div>
  );
}
