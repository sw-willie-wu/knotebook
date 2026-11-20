import "@/i18n/select-strings";
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { folderErrorMessage, invalidateFolderRelated, isFolderNotFound, useFolders } from "@/api/folders";
import { useFavorites } from "@/api/favorites";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { PHONE_BAR_CONTROL_HEIGHT, PHONE_BAR_FRAME, phoneBarBottomPadding } from "./phone-bar";
import { isTerminal } from "@/collab/connection";
import { useNotePageControls } from "@/lib/note-page-controls";
import {
  copyNotesInOrder,
  deleteTargetsInOrder,
  moveNotesInOrder,
  placeTargetsInOrder,
  undoPlacements,
  unfavoriteInOrder,
  type BatchOutcome,
  type PlacedItem,
} from "@/lib/select-batch";
import { selectionKey, SIDEBAR_SELECT_BUTTON } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { showTrashedToast } from "@/lib/trash-undo";
import { Button } from "@/components/ui/button";
import { Copy, FolderInput, Trash } from "@/components/ui/icons";
import { StarOff } from "@/components/ui/icons-extra";
import { toast } from "@/components/ui/toast";
import {
  buildDestinationLevel,
  destinationPathLabel,
  destinationShortLabel,
  isEmptyDestination,
  isSameSpace,
  livePath,
  type DestMode,
  type DestPathStep,
  type DestSpace,
  type DestTarget,
} from "./destination-level";
import { DestinationPickerDialog } from "./DestinationPickerDialog";
import { CopyConfirmDialog, DeleteFoldersConfirmDialog, MoveConfirmDialog, UnfavoriteConfirmDialog } from "./select-dialogs";
import {
  batchDestSource,
  dedupeByAncestor,
  partitionTargets,
  SELECT_ACTIONS,
  selectedTargets,
  selectionResultTitle,
  type Eligibility,
  type SelectableTab,
  type SelectionTarget,
} from "./select-model";
import { beginSelectRun, endSelectRun, updateSelectRun, useSelectRun } from "./select-run";
import { expandFolderChain, indexFolders, liveNotesUnder, type FolderIndex } from "./folder-index";
import { useFolderSortOf } from "./folder-sort";
import { applyTagFilter, tagFilterView, useTagFilter } from "./tag-filter";
import { buildTabNodes, noteSpaceKey, partitionNotes } from "./tree";

/**
 * An item whose ancestor is also selected is neither sent nor counted as skipped; nothing actionable → disabled, no "0 items" toast.
 * Snapshot: the items and count to send are captured when the destination is chosen (or Delete pressed); the confirm dialog and execution use it, so a list refetch during submit doesn't count down.
 * Focus: after a destination is picked the picker doesn't return focus (the confirm dialog's own autofocus takes it; same-space has no dialog, so finish handles it); cancel returns it to the opener.
 * Reason-disabled buttons (cross-group Move, Copy with a folder selected) use `aria-disabled` + `title` + `aria-describedby`, not `disabled`: `disabled:pointer-events-none` would kill the hover hint; `bar` also toasts the reason (touch has no hover).
 * Priority: running (`disabled`) > reason (`aria-disabled`) > nothing actionable / empty first level (`disabled`).
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
type PlaceTarget = Extract<DestTarget, { kind: "place" }>;
type Stopped = BatchOutcome<unknown>["stopped"];

/** Icon-only; `min-w-0` lets it share a row with the 36px delete button on the narrowest sidebar (200px; ~182px inside the card). The `aria-disabled:` classes are always present, not conditional (an e2e asserts identical className). */
const ACTION_BUTTON =
  "min-w-0 flex-1 px-1.5 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-input aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit aria-disabled:active:[background:transparent]";
const ACTION_ICON = "h-4 w-4 shrink-0";
const TOOLBAR_ICON_BUTTON =
  "h-6 w-6 shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit";
const TOOLBAR_DELETE_BUTTON = "h-6 w-6 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive";
const TOOLBAR_ICON = "h-3.5 w-3.5";

const NO_SKIPS: Eligibility = { eligible: [], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 };

const isFolder = (target: SelectionTarget): boolean => target.kind === "folder";
const notesOf = (targets: readonly SelectionTarget[]): NoteDto[] => targets.flatMap((target) => (target.kind === "note" ? [target.note] : []));

/** Folders by error code: `folder_delete_blocked` → blocked, `folder_not_found` → gone, anything else → skipped. */
function skippedCounts(pre: Eligibility, skippedDetail: BatchOutcome<unknown>["skippedDetail"]) {
  const out = { notesSkipped: pre.notesSkipped, foldersSkipped: pre.foldersSkipped, foldersBlocked: pre.foldersBlocked, foldersGone: 0 };
  for (const { node, err } of skippedDetail) {
    if (node.kind === "note") out.notesSkipped += 1;
    else if (err instanceof ApiFail && err.code === "folder_delete_blocked") out.foldersBlocked += 1;
    else if (isFolderNotFound(err)) out.foldersGone += 1;
    else out.foldersSkipped += 1;
  }
  return out;
}

function stoppedCopy(t: Translate, stopped: Stopped, done: number, items: boolean): { title: string; description: string } | null {
  if (stopped === null) return null;
  return { title: folderErrorMessage(t, stopped.cause), description: t(items ? "select.stoppedAfterItems" : "select.stoppedAfter", { count: done }) };
}

/** The toast handler uses only captured values: at Undo the action bar is usually unmounted (as `lib/trash-undo.ts`). */
async function undoBatchPlacement(done: readonly PlacedItem[], queryClient: QueryClient, t: Translate): Promise<void> {
  const outcome = await undoPlacements(done, { queryClient });
  if (outcome.stopped === null) return;
  toast({
    title: folderErrorMessage(t, outcome.stopped.cause),
    description: t("select.undoStopped", { count: outcome.done.length }),
    variant: "destructive",
  });
}

type Confirm =
  | { kind: "move"; target: PlaceTarget; groupId: string; pathLabel: string; notes: NoteDto[]; pre: Eligibility }
  | { kind: "copy"; target: DestTarget; pathLabel: string; notes: NoteDto[]; copySource: DestSpace | null }
  | { kind: "unfavorite"; noteIds: string[] }
  | { kind: "delete"; items: SelectionTarget[]; pre: Eligibility; folderCount: number; noteCount: number; alsoNotes: number; shared: boolean };

interface RunResult {
  stopped: Stopped;
  afterSelection?: () => void;
}

/** `safeBottom`: the phone full-screen `bar` shares classes with `PhoneListBar` (`phone-bar.ts`) so both are the same height and include the bottom safe area; not given when the sidebar sits in a frame that already provides it (it would double). */
export function SelectActionBar({ layout = "bar", safeBottom = false }: { layout?: "bar" | "toolbar"; safeBottom?: boolean }) {
  const { t } = useTranslation();
  const { tab: currentTab, selection } = useSidebarTabState();
  const actions = useSidebarTabActions();
  const { updateSelection, getSelectionSession } = actions;
  const keyboardOpen = isKeyboardOpen(useKeyboardInset());
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const favoritesQuery = useFavorites({ enabled: currentTab === "favorites" });
  const foldersQuery = useFolders();
  const sortOf = useFolderSortOf();
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const controls = useNotePageControls();
  // Batch hooks may run after unmount or navigation: always read the latest (`?.`; hooks must not throw).
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const run = useSelectRun(actions);
  // SidebarFooter mounts this component only on non-trash tabs.
  const tab = currentTab as SelectableTab;
  const acrossGroupsId = useId();
  const cantCopyId = useId();

  const [pickerMode, setPickerMode] = useState<DestMode | null>(null);
  const [path, setPath] = useState<readonly DestPathStep[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pickedRef = useRef(false);
  const submittedRef = useRef(false);
  const confirmContentRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const groups = groupsQuery.data;
  const nodes = useMemo(
    () =>
      notesQuery.isSuccess && (tab !== "workspace" || groups !== undefined) && (tab !== "favorites" || favoritesQuery.data !== undefined)
        ? buildTabNodes(tab, notesQuery.data, groups ?? [], folderIndex, sortOf, favoritesQuery.data)
        : null,
    [tab, notesQuery.isSuccess, notesQuery.data, groups, favoritesQuery.data, folderIndex, sortOf],
  );
  const groupIds = useMemo<ReadonlySet<string>>(() => new Set((groups ?? []).map((group) => group.id)), [groups]);
  const notes = notesQuery.data ?? [];
  const spaceOf = (note: NoteDto) => noteSpaceKey(note, groupIds);
  // Same view the list shows: under a tag filter the batch reaches only the visible notes (a ticked folder from before the filter would also take the notes the filter hides).
  const tagFilter = useTagFilter();
  const filterView = useMemo(
    () => tagFilterView(tab, tagFilter, notesQuery.data === undefined ? null : partitionNotes(notesQuery.data, groups ?? []), groups ?? []),
    [tab, tagFilter, notesQuery.data, groups],
  );
  const filtered = filterView !== null && filterView.selected.length > 0;
  const viewNodes = useMemo(() => (nodes === null ? null : applyTagFilter(tab, nodes, filterView)), [nodes, tab, filterView]);
  const targets = viewNodes === null ? [] : selectedTargets(viewNodes, selection.keys).filter((target) => !filtered || target.kind === "note");
  const deduped = dedupeByAncestor(targets, folderIndex);
  const ctx = { tab, index: folderIndex, notes, groupIds };
  const unfavoriteElig = partitionTargets("unfavorite", deduped, ctx);
  const moveElig = partitionTargets("move", deduped, ctx);
  const copyElig = partitionTargets("copy", deduped, ctx);
  const deleteElig = partitionTargets("delete", deduped, ctx);
  const sourceFor = (mode: DestMode) =>
    batchDestSource({ tab, mode, eligible: (mode === "move" ? moveElig : copyElig).eligible, groups: groups ?? [], groupIds });
  const moveSource = sourceFor("move");
  const levelReady = (mode: DestMode) => groups !== undefined || (mode === "move" && tab === "shared");
  const busy = run !== null;
  const available = SELECT_ACTIONS[tab];

  /** Move focus only if it is still in this instance, the dialog or body (the pressed button is disabled / the dialog unmounted); if the user moved elsewhere while waiting, don't grab it. */
  function mayReclaimFocus(shell: Element | null, confirmEl: Element | null): boolean {
    if (!mountedRef.current) return false;
    const active = document.activeElement;
    return active === null || active === document.body || shell?.contains(active) === true || confirmEl?.contains(active) === true;
  }

  async function runBatch(input: {
    total: number;
    opener: HTMLElement | null;
    fromConfirm: boolean;
    execute: (onProgress: (processed: number) => void) => Promise<RunResult>;
  }): Promise<void> {
    const { total, opener, fromConfirm, execute } = input;
    if (!beginSelectRun(actions, total)) return;
    submittedRef.current = fromConfirm;
    const session = getSelectionSession();
    const shell = opener?.closest("[data-sidebar-instance]") ?? null;
    let focusTo: "select" | "opener" | null = null;
    try {
      const { stopped, afterSelection } = await execute((processed) => updateSelectRun(actions, processed));
      if (stopped !== null && isFolderNotFound(stopped.cause)) invalidateFolderRelated(queryClient);
      // The guard is evaluated before the selection result is applied (success ends selection and unmounts this); focus moves after finish (dialog closed, opener enabled again).
      if (mayReclaimFocus(shell, confirmContentRef.current)) focusTo = stopped ? "opener" : "select";
      // The selection result depends on the session, not on mounting (applies with the drawer closed; ending and restarting mid-run doesn't overwrite the new round).
      if (getSelectionSession() === session) {
        flushSync(() => updateSelection(stopped ? { type: "setAll", keys: stopped.remaining.map(selectionKey) } : { type: "end" }));
      }
      afterSelection?.();
    } finally {
      flushSync(() => {
        setConfirmOpen(false);
        endSelectRun(actions);
      });
    }
    if (focusTo === "select") {
      // The list is already empty at finish (favorites filter the cache note by note): the "Select" button is disabled, so focus would be lost; focus the panel.
      // Other tabs empty only after a refetch, by which time the browser has moved focus from the disabled "Select" to body; NoteList listens for focusout and hands it to the panel.
      const selectButton = shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON) ?? null;
      if (selectButton !== null && !selectButton.disabled) selectButton.focus();
      else shell?.querySelector<HTMLElement>('[role="tabpanel"]')?.focus();
    } else if (focusTo === "opener" && opener?.isConnected) opener.focus();
  }

  function runPlace(target: PlaceTarget, items: SelectionTarget[], pre: Eligibility, index: FolderIndex, opener: HTMLElement | null): void {
    const folderId = target.folder?.id ?? null;
    void runBatch({
      total: items.length,
      opener,
      fromConfirm: false,
      execute: async (onProgress) => {
        const outcome = await placeTargetsInOrder(items, folderId, { queryClient, onProgress });
        const { done, stopped } = outcome;
        if (done.length > 0 && folderId !== null) expandFolderChain(index, folderId);
        const title = selectionResultTitle(
          {
            action: "move",
            tab,
            notesDone: done.filter((item) => item.kind === "note").length,
            foldersDone: done.filter((item) => item.kind === "folder").length,
            trashedViaFolders: 0,
            ...skippedCounts(pre, outcome.skippedDetail),
            destinationName: destinationShortLabel(target.folder, t),
            sameSpace: true,
            destination: target,
            copySource: null,
          },
          t,
        );
        // Same-space results always count "items" (movedItems); the stop description does too, also when only notes were moved.
        const halted = stoppedCopy(t, stopped, done.length, true);
        toast({
          title: halted?.title ?? title,
          description: halted?.description,
          variant: stopped || done.length === 0 ? "destructive" : "default",
          action: done.length === 0 ? undefined : { label: t("trash.undo"), onClick: () => void undoBatchPlacement(done, queryClient, t) },
        });
        return { stopped };
      },
    });
  }

  function runMove(snapshot: Extract<Confirm, { kind: "move" }>): void {
    const { target, groupId, pathLabel, notes: items, pre } = snapshot;
    void runBatch({
      total: items.length,
      opener: openerRef.current,
      fromConfirm: true,
      execute: async (onProgress) => {
        const body = target.folder === null ? { groupId } : { groupId, folderId: target.folder.id };
        const outcome = await moveNotesInOrder(items, body, { queryClient, onProgress });
        const { done, stopped } = outcome;
        const title = selectionResultTitle(
          {
            action: "move",
            tab,
            notesDone: done.length,
            foldersDone: 0,
            trashedViaFolders: 0,
            ...skippedCounts(pre, outcome.skippedDetail),
            destinationName: pathLabel,
            sameSpace: false,
            destination: target,
            copySource: null,
          },
          t,
        );
        const halted = stoppedCopy(t, stopped, done.length, false);
        toast({ title: halted?.title ?? title, description: halted?.description, variant: stopped || done.length === 0 ? "destructive" : "default" });
        return { stopped };
      },
    });
  }

  function runCopy(snapshot: Extract<Confirm, { kind: "copy" }>): void {
    const { target, pathLabel, notes: items, copySource } = snapshot;
    void runBatch({
      total: items.length,
      opener: openerRef.current,
      fromConfirm: true,
      execute: async (onProgress) => {
        const outcome = await copyNotesInOrder(items, target, { queryClient, onProgress });
        const { done, stopped } = outcome;
        const title = selectionResultTitle(
          {
            action: "copy",
            tab,
            notesDone: done.length,
            foldersDone: 0,
            trashedViaFolders: 0,
            ...skippedCounts(NO_SKIPS, outcome.skippedDetail),
            destinationName: pathLabel,
            sameSpace: false,
            destination: target,
            copySource,
          },
          t,
        );
        const halted = stoppedCopy(t, stopped, done.length, false);
        toast({ title: halted?.title ?? title, description: halted?.description, variant: stopped || done.length === 0 ? "destructive" : "default" });
        return { stopped };
      },
    });
  }

  function runUnfavorite(snapshot: Extract<Confirm, { kind: "unfavorite" }>): void {
    const { noteIds } = snapshot;
    void runBatch({
      total: noteIds.length,
      opener: openerRef.current,
      fromConfirm: true,
      execute: async (onProgress) => {
        const { done, skipped, stopped } = await unfavoriteInOrder(noteIds, { queryClient, onProgress });
        const halted = stoppedCopy(t, stopped, done.length, false);
        let title = t("select.unfavorited", { count: done.length });
        if (done.length === 0 && stopped === null) title = t("select.noneDone", { count: skipped });
        else if (skipped > 0) title += t("select.skippedSuffix", { count: skipped });
        toast({
          title: halted?.title ?? title,
          description: halted?.description,
          variant: stopped || done.length === 0 ? "destructive" : "default",
        });
        return { stopped };
      },
    });
  }

  function runDelete(items: readonly SelectionTarget[], pre: Eligibility, opener: HTMLElement | null, fromConfirm: boolean): void {
    const openId = controlsRef.current?.noteId ?? null;
    const leavingFolder =
      openId === null
        ? null
        : (items.find(
            (target) =>
              target.kind === "folder" &&
              target.folder.space.kind !== "shared" &&
              liveNotesUnder(folderIndex, target.folder.id, notes, spaceOf).some((note) => note.id === openId),
          ) ?? null);
    const isLeaving = (target: SelectionTarget): boolean =>
      target.kind === "folder" ? target === leavingFolder : openId !== null && target.note.id === openId;
    // Open note goes last: leavingRef is set only just before sending it, so an earlier failure doesn't gate the page (deleteTargetsInOrder then splits folder and note segments, each order-preserving).
    // A directly selected note, or a note inside a personal/group folder being deleted (that folder then goes last among folders), counts; removing a shared folder sets nothing (its notes just go back to top level).
    // Success returns home and Undo returns to the note; no per-note `note.deleted` toast, a batch shows one.
    const ordered = [...items.filter((target) => !isLeaving(target)), ...items.filter(isLeaving)];
    const hasFolders = items.some(isFolder);
    void runBatch({
      total: ordered.length,
      opener,
      fromConfirm,
      execute: async (onProgress) => {
        let leaveHome = false;
        const outcome = await deleteTargetsInOrder(ordered, {
          queryClient,
          onProgress,
          beforeEach: (target) => {
            const page = controlsRef.current;
            // Switched to another note within the same NotePage mid-run: leavingRef now belongs to that one, don't set it.
            if (isLeaving(target) && page?.noteId === openId) page.leavingRef.current = true;
          },
          afterFailure: (target) => {
            const page = controlsRef.current;
            if (!isLeaving(target) || page?.noteId !== openId) return;
            if (isTerminal(page.state)) leaveHome = true;
            else page.leavingRef.current = false;
          },
        });
        const { done, stopped } = outcome;
        const doneNotes = done.flatMap((item) => (item.target.kind === "note" ? [item.target.note] : []));
        // A note item's trashedNoteIds is just itself, already counted in notesDone; only folder items bring more notes.
        const undoIds = done.flatMap((item) => (item.target.kind === "folder" ? item.trashedNoteIds : []));
        const reopened = done.some((item) => isLeaving(item.target));
        if (reopened) leaveHome = true;
        const title = selectionResultTitle(
          {
            action: "delete",
            tab,
            notesDone: doneNotes.length,
            foldersDone: done.length - doneNotes.length,
            trashedViaFolders: undoIds.length,
            ...skippedCounts(pre, outcome.skippedDetail),
            destinationName: null,
            sameSpace: false,
            destination: null,
            copySource: null,
          },
          t,
        );
        const halted = stoppedCopy(t, stopped, done.length, hasFolders);
        if (tab !== "shared" && (undoIds.length > 0 || doneNotes.length > 0)) {
          showTrashedToast({
            notes: doneNotes,
            undoIds,
            queryClient,
            navigate,
            t,
            reopen: false,
            reopenId: reopened ? openId : null,
            title: halted?.title ?? title,
            description: halted?.description,
            variant: stopped ? "destructive" : "default",
          });
        } else {
          toast({ title: halted?.title ?? title, description: halted?.description, variant: stopped || done.length === 0 ? "destructive" : "default" });
        }
        return {
          stopped,
          // Don't navigate home if the user moved to another note mid-run (controlsRef is updated via the page's bridge; the noteId no longer matches).
          afterSelection: () => {
            if (leaveHome && controlsRef.current?.noteId === openId) void navigate("/", { replace: true });
          },
        };
      },
    });
  }

  function openPicker(mode: DestMode, event: MouseEvent<HTMLButtonElement>): void {
    openerRef.current = event.currentTarget;
    pickedRef.current = false;
    setPath([]);
    setPickerMode(mode);
  }

  function startUnfavorite(event: MouseEvent<HTMLButtonElement>): void {
    openerRef.current = event.currentTarget;
    submittedRef.current = false;
    setConfirm({ kind: "unfavorite", noteIds: notesOf(unfavoriteElig.eligible).map((note) => note.id) });
    setConfirmOpen(true);
  }

  function startDelete(event: MouseEvent<HTMLButtonElement>): void {
    const opener = event.currentTarget;
    openerRef.current = opener;
    const { eligible } = deleteElig;
    const folders = eligible.flatMap((target) => (target.kind === "folder" ? [target.folder] : []));
    if (folders.length === 0) {
      runDelete(eligible, deleteElig, opener, false);
      return;
    }
    const trashed = new Set(folders.flatMap((folder) => liveNotesUnder(folderIndex, folder.id, notes, spaceOf).map((note) => note.id)));
    submittedRef.current = false;
    setConfirm({
      kind: "delete",
      items: eligible,
      pre: deleteElig,
      folderCount: folders.length,
      noteCount: trashed.size,
      alsoNotes: eligible.length - folders.length,
      shared: tab === "shared",
    });
    setConfirmOpen(true);
  }

  /** The confirm dialog has no DialogTrigger (Radix would drop focus to body): on cancel focus returns to the opener; after a submit finish handles it. */
  function onConfirmCloseAutoFocus(event: Event): void {
    event.preventDefault();
    if (!submittedRef.current && openerRef.current?.isConnected) openerRef.current.focus();
  }

  const pickerSource = pickerMode === null ? null : pickerMode === "move" ? moveSource : sourceFor("copy");
  const source = pickerSource === null || pickerSource === "mixedGroups" ? null : pickerSource;
  const level = source !== null && pickerMode !== null && levelReady(pickerMode) ? buildDestinationLevel({ source, path, index: folderIndex, t }) : null;

  function pick(target: DestTarget): void {
    if (pickerMode === null || source === null) return;
    const opener = openerRef.current;
    if (pickerMode === "move") {
      if (target.kind !== "place") return;
      if (isSameSpace(target, source)) {
        pickedRef.current = true;
        setPickerMode(null);
        runPlace(target, moveElig.eligible, moveElig, folderIndex, opener);
        return;
      }
      if (target.space.kind !== "group") return;
      setConfirm({
        kind: "move",
        target,
        groupId: target.space.groupId,
        pathLabel: destinationPathLabel(target.space, target.folder, folderIndex, t),
        notes: notesOf(moveElig.eligible),
        pre: moveElig,
      });
    } else {
      setConfirm({
        kind: "copy",
        target,
        pathLabel: target.kind === "place" ? destinationPathLabel(target.space, target.folder, folderIndex, t) : "",
        notes: notesOf(copyElig.eligible),
        copySource: source.current,
      });
    }
    pickedRef.current = true;
    submittedRef.current = false;
    setPickerMode(null);
    setConfirmOpen(true);
  }

  const moveReason = moveSource === "mixedGroups" ? t("select.acrossGroups") : null;
  const copyReason = targets.some(isFolder) ? t("select.foldersCantCopy") : null;
  const moveSoftDisabled = !busy && moveReason !== null;
  const copySoftDisabled = !busy && copyReason !== null;
  const moveDisabled =
    busy ||
    (!moveSoftDisabled &&
      (moveElig.eligible.length === 0 ||
        (moveSource !== "mixedGroups" && levelReady("move") && isEmptyDestination(moveSource, folderIndex, t))));
  const copyDisabled = busy || (!copySoftDisabled && copyElig.eligible.length === 0);
  const showDelete = available.includes("delete") && (tab !== "shared" || (deduped.length > 0 && deduped.every(isFolder)));
  const deleteLabel =
    tab === "shared"
      ? t("select.removeSelectedFolders", { count: targets.filter(isFolder).length })
      : t("select.deleteSelected", { count: targets.length });

  function showReason(reason: string | null): void {
    if (reason !== null && layout === "bar") toast({ title: reason });
  }

  const moveProps = {
    title: moveReason ?? t("select.moveTo"),
    "aria-describedby": moveReason !== null ? acrossGroupsId : undefined,
    "aria-disabled": moveSoftDisabled || undefined,
    disabled: moveDisabled,
    onClick: (event: MouseEvent<HTMLButtonElement>) => (moveSoftDisabled ? showReason(moveReason) : openPicker("move", event)),
  };
  const copyProps = {
    title: copyReason ?? t("select.copyTo"),
    "aria-describedby": copyReason !== null ? cantCopyId : undefined,
    "aria-disabled": copySoftDisabled || undefined,
    disabled: copyDisabled,
    onClick: (event: MouseEvent<HTMLButtonElement>) => (copySoftDisabled ? showReason(copyReason) : openPicker("copy", event)),
  };
  const unfavoriteProps = {
    title: t("select.unfavorite"),
    disabled: busy || unfavoriteElig.eligible.length === 0,
    onClick: startUnfavorite,
  };
  const deleteProps = {
    "aria-label": deleteLabel,
    title: deleteLabel,
    disabled: busy || deleteElig.eligible.length === 0,
    onClick: startDelete,
  };
  // aria-describedby so screen readers read the reason (title isn't always read): a second sr-only copy of the same text.
  const reasonTexts = (
    <>
      {moveReason !== null && available.includes("move") && (
        <span id={acrossGroupsId} className="sr-only">
          {moveReason}
        </span>
      )}
      {copyReason !== null && available.includes("copy") && (
        <span id={cantCopyId} className="sr-only">
          {copyReason}
        </span>
      )}
    </>
  );

  const buttons =
    layout === "toolbar" ? (
      <div className="flex shrink-0 items-center gap-0.5" data-select-action-bar="" aria-busy={busy}>
        {available.includes("unfavorite") && (
          <Button type="button" variant="ghost" size="icon" className={TOOLBAR_ICON_BUTTON} aria-label={t("select.unfavorite")} {...unfavoriteProps}>
            <StarOff aria-hidden="true" className={TOOLBAR_ICON} />
          </Button>
        )}
        {available.includes("move") && (
          <Button type="button" variant="ghost" size="icon" className={TOOLBAR_ICON_BUTTON} aria-label={t("select.moveTo")} {...moveProps}>
            <FolderInput aria-hidden="true" className={TOOLBAR_ICON} />
          </Button>
        )}
        {available.includes("copy") && (
          <Button type="button" variant="ghost" size="icon" className={TOOLBAR_ICON_BUTTON} aria-label={t("select.copyTo")} {...copyProps}>
            <Copy aria-hidden="true" className={TOOLBAR_ICON} />
          </Button>
        )}
        {showDelete && (
          <Button type="button" variant="ghost" size="icon" className={TOOLBAR_DELETE_BUTTON} {...deleteProps}>
            <Trash aria-hidden="true" className={TOOLBAR_ICON} />
          </Button>
        )}
        {reasonTexts}
      </div>
    ) : (
      <div
        className={safeBottom ? `flex flex-col gap-1 ${PHONE_BAR_FRAME} ${phoneBarBottomPadding(keyboardOpen)}` : "m-2 flex flex-col gap-1"}
        data-select-action-bar=""
        aria-busy={busy}
      >
        {run !== null && (
          <p role="status" className="px-1 text-center text-[11px] text-muted-foreground">
            {t("select.progress", run.progress)}
          </p>
        )}
        <div className={safeBottom ? `flex items-center gap-1 ${PHONE_BAR_CONTROL_HEIGHT}` : "flex gap-1"}>
          {available.includes("unfavorite") && (
            <Button type="button" variant="outline" className={ACTION_BUTTON} aria-label={t("select.unfavorite")} {...unfavoriteProps}>
              <StarOff aria-hidden="true" className={ACTION_ICON} />
            </Button>
          )}
          {/* outline: select mode has no single primary action */}
          {available.includes("move") && (
            <Button type="button" variant="outline" className={ACTION_BUTTON} aria-label={t("select.moveTo")} {...moveProps}>
              <FolderInput aria-hidden="true" className={ACTION_ICON} />
            </Button>
          )}
          {available.includes("copy") && (
            <Button type="button" variant="outline" className={ACTION_BUTTON} aria-label={t("select.copyTo")} {...copyProps}>
              <Copy aria-hidden="true" className={ACTION_ICON} />
            </Button>
          )}
          {showDelete && (
            // Not outline: its hover fills brand-deep, which clashes with red text (as TrashFooter's permanent delete).
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="w-9 shrink-0 border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
              {...deleteProps}
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
            </Button>
          )}
        </div>
        {reasonTexts}
      </div>
    );

  return (
    <>
      {buttons}
      {/* Outside the bar's div (layout only); Esc is handled by SelectHeader's document listener, which does nothing while a dialog is open */}
      <DestinationPickerDialog
        mode={pickerMode ?? "copy"}
        count={pickerMode === "move" ? moveElig.eligible.length : copyElig.eligible.length}
        hasFolders={pickerMode === "move" && moveElig.eligible.some(isFolder)}
        level={level}
        levelKey={JSON.stringify(path)}
        error={pickerMode !== null && !levelReady(pickerMode) && groupsQuery.isError ? groupsQuery.error : null}
        open={pickerMode !== null}
        // Every level continues from livePath: when a path step went stale buildDestinationLevel silently truncates, so path.length can't be used.
        onDrill={(step) => {
          if (source !== null) setPath([...livePath(source, path, folderIndex, t), step]);
        }}
        onBack={() => {
          if (source !== null) setPath(livePath(source, path, folderIndex, t).slice(0, -1));
        }}
        onPick={pick}
        onOpenChange={(open) => {
          if (!open) setPickerMode(null);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!pickedRef.current && openerRef.current?.isConnected) openerRef.current.focus();
        }}
      />
      {confirm?.kind === "move" && (
        <MoveConfirmDialog
          count={confirm.notes.length}
          groupName={confirm.pathLabel}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runMove(confirm)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
      {confirm?.kind === "copy" && (
        <CopyConfirmDialog
          count={confirm.notes.length}
          target={confirm.target}
          pathLabel={confirm.pathLabel}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runCopy(confirm)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
      {confirm?.kind === "unfavorite" && (
        <UnfavoriteConfirmDialog
          count={confirm.noteIds.length}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runUnfavorite(confirm)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
      {confirm?.kind === "delete" && (
        <DeleteFoldersConfirmDialog
          folderCount={confirm.folderCount}
          noteCount={confirm.noteCount}
          alsoNotes={confirm.alsoNotes}
          shared={confirm.shared}
          open={confirmOpen}
          progress={run?.progress ?? null}
          contentRef={confirmContentRef}
          onConfirm={() => runDelete(confirm.items, confirm.pre, openerRef.current, true)}
          onOpenChange={setConfirmOpen}
          onCloseAutoFocus={onConfirmCloseAutoFocus}
        />
      )}
    </>
  );
}
