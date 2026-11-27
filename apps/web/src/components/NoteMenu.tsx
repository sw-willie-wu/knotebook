import { lazy, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { errorMessage, useAddFavorite, useFavoriteStatus, useRemoveFavorite } from "@/api/favorites";
import { useDeleteNote } from "@/api/notes";
import { isTerminal, type CollabState } from "@/collab/connection";
import { copyText } from "@/lib/clipboard";
import { captureRemoveContext, focusAfterRemoveLater, type RemoveContext } from "@/lib/favorite-focus";
import { placeNoteWithUndo } from "@/lib/note-place";
import { useNotePageControls, type OpenEditsState } from "@/lib/note-page-controls";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { showTrashedToast } from "@/lib/trash-undo";
import { useIsOutlineCompact, useIsPhone } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { HEADER_ICON_HIT, ROW_ICON_HIT } from "@/components/ui/hit-area";
import { hoverReveal, NOTE_MENU_COLLAPSE } from "@/components/ui/reveal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { NoteWidthItemsControl } from "@/components/NoteWidthMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuMainLevel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisVertical, History, Link as LinkIcon, ListTree, MessageCircle, MessageSquare, Presentation, Star, Tag, Trash } from "@/components/ui/icons";
import { useOutlineMenu, type OutlineMenuValue } from "@/components/outline/outline-menu-context";
import { FavoriteRemoveDialog } from "@/components/FavoriteRemoveDialog";
import { ManualCopyField } from "@/components/ManualCopyField";
import {
  EMPTY_DEST_PATHS,
  GroupTransferMenuItems,
  isSameSpaceMove,
  transferTargetOf,
  type DestinationPick,
  type DestPaths,
  type GroupTransferKind,
  type GroupTransferPick,
} from "@/components/share/GroupTransfer";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { destinationShortLabel } from "@/components/sidebar/destination-level";
import { toast } from "@/components/ui/toast";
import { usePresentEntry } from "@/present/usePresentEntry";
import { tourTarget } from "@/lib/tour-targets";

const GroupTransferDialog = lazy(() => import("@/components/share/GroupTransferDialog").then((m) => ({ default: m.GroupTransferDialog })));

export interface NoteMenuProps {
  note: NoteDto;
  state: CollabState;
  /** Shared with NotePage: collab `deleted` and "delete from ⋮" are two leave paths; one gate avoids double toast and navigation. Required on purpose (as is `state`) so NotePage cannot forget it; do not make it optional. */
  leavingRef: RefObject<boolean>;
  onOpenEdits: () => void;
  /** Fallback focus target when the full-page version history closes. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** Passed in by NotePage so this shared file (sidebar imports it) has no static dependency. */
  widthItems?: (control: NoteWidthItemsControl) => ReactNode;
  /** Header only; undefined (the viewer cannot change tags, and every sidebar row) leaves the item out. Runs inside the select event: see the item's comment. */
  onAddTag?: () => void;
  /** Header only, from NotePage, so the comments context stays out of this shared file; undefined leaves the phone item out. */
  onOpenComments?: () => void;
}

/**
 * Focus trap: Radix DropdownMenu is modal and fights Dialog FocusScope; `lib/clipboard.ts` `execCommand` fallback only accepts `[role="dialog"],[role="menu"]` hosts. So the copy item calls `event.preventDefault()`, awaits `copyText` while the menu still has focus, and only then closes the menu manually (`DropdownMenu` is therefore controlled).
 * Delete vs collaboration `deleted` terminal state: the server closes the initiator connection first, so `close(NOTE_DELETED)` can arrive before the DELETE response. The handler sets `leavingRef` before awaiting. On failure in a terminal state NotePage terminal effect will never fire (it is gated by `leavingRef`), so this handler must reproduce its exit (kicked -> `note.accessRevoked`, else `note.deleted`, destructive toast, navigate home). On failure otherwise, reset `leavingRef` to false so the error toast is not swallowed. Terminal state is read from `stateRef.current`, not the closure `state`, which is likely still `connected`.
 * Sidebar rows decide "the open note" from `NotePageControlsContext`, not `useActiveNote`: `activeNoteId` is set optimistically on click, before NotePage holds that note's `leavingRef`. Open note: same leave path as header; AI history opens the dialog directly without navigating (a different canonical path would re-resolve and tear down collaboration). Other note: delete only toasts; AI history navigates with `state.openEdits`, which NotePage reads and `replace`s away.
 */

interface PageExit {
  state: CollabState;
  leavingRef: RefObject<boolean>;
}

interface NoteMenuCoreProps {
  note: NoteDto;
  trigger: "header" | "sidebar";
  onOpenEdits: () => void;
  /** Called synchronously in onSelect: fullscreen needs a user gesture. */
  onPresent: () => void;
  page: PageExit | null;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  widthItems?: (control: NoteWidthItemsControl) => ReactNode;
  onAddTag?: () => void;
  onOpenComments?: () => void;
}

export function NoteMenu({ note, state, leavingRef, onOpenEdits, triggerRef, widthItems, onAddTag, onOpenComments }: NoteMenuProps) {
  const { presentHere } = usePresentEntry();
  return (
    <NoteMenuCore
      note={note}
      trigger="header"
      onOpenEdits={onOpenEdits}
      onPresent={presentHere}
      page={{ state, leavingRef }}
      triggerRef={triggerRef}
      widthItems={widthItems}
      onAddTag={onAddTag}
      onOpenComments={onOpenComments}
    />
  );
}

export function SidebarNoteMenu({ note }: { note: NoteDto }) {
  const navigate = useNavigate();
  const controls = useNotePageControls();
  const closeDrawer = useCloseSidebarDrawer();
  const isOpenPage = controls !== null && controls.noteId === note.id;
  const { presentHere, presentNote } = usePresentEntry();
  return (
    <NoteMenuCore
      note={note}
      trigger="sidebar"
      onPresent={isOpenPage ? presentHere : () => presentNote(canonicalNotePath(note))}
      page={isOpenPage ? { state: controls.state, leavingRef: controls.leavingRef } : null}
      onOpenEdits={
        isOpenPage
          ? () => {
              closeDrawer(); // close the drawer first when pressed inside it (the other-note path is closed by AppShell's pathname effect)
              controls.openEdits();
            }
          : () => void navigate(canonicalNotePath(note), { state: { openEdits: true } satisfies OpenEditsState })
      }
    />
  );
}

/** Version history and comments, phone only (below 640px; other widths have the CornerStack bubbles, which read the same `useIsPhone()`, so each width has exactly one entry). The hook lives in this child so sidebar rows do not each subscribe. Conditional render, not `sm:hidden`: a display:none Radix item stays in the collection, so arrow keys and typeahead stop on an invisible item. */
function PhoneMenuItem({ icon, label, onActivate }: { icon: ReactNode; label: string; onActivate: () => void }) {
  const phone = useIsPhone();
  if (!phone) return null;
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onActivate();
      }}
    >
      {icon}
      {label}
    </DropdownMenuItem>
  );
}

/** Phones only show the bubble while scrolling and screen readers cannot reach it, so the menu has an entry too. Renders only below 768px when the note has headings and is not in version preview; sidebar rows sit outside `OutlineMenuContext` (default: no entry). */
function OutlineMenuItem({ onActivate }: { onActivate: (open: OutlineMenuValue["open"]) => void }) {
  const { t } = useTranslation();
  const compact = useIsOutlineCompact();
  const { available, open } = useOutlineMenu();
  if (!compact || !available) return null;
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onActivate(open);
      }}
    >
      <ListTree className="mr-2 h-4 w-4" />
      {t("note.outline.label")}
    </DropdownMenuItem>
  );
}

/** `aria-disabled` + no-op select, not `disabled`: keyboard open focuses the first enabled item and `disabled` would leave focus on the second. `useFavoriteStatus` is called inside the content so rows do not subscribe while closed. Inert until the status is ready and while a toggle is pending; since the item stays enabled for focus, focus is not moved once it becomes active. */
function FavoriteMenuItem({ noteId, onAdd, onRemove }: { noteId: string; onAdd: () => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const { ready, favorite, pending } = useFavoriteStatus(noteId);
  const unavailable = !ready || pending;
  return (
    <DropdownMenuItem
      aria-disabled={unavailable ? true : undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onSelect={(event) => {
        event.preventDefault();
        if (unavailable) return;
        if (favorite) onRemove();
        else onAdd();
      }}
    >
      <Star className="mr-2 h-4 w-4" fill={favorite ? "currentColor" : "none"} />
      {favorite ? t("note.menu.removeFavorite") : t("note.menu.addFavorite")}
    </DropdownMenuItem>
  );
}

function NoteMenuCore({ note, trigger, onOpenEdits, onPresent, page, triggerRef: externalTriggerRef, widthItems, onAddTag, onOpenComments }: NoteMenuCoreProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deleteNote = useDeleteNote();
  const addFavorite = useAddFavorite();
  const removeFavorite = useRemoveFavorite();
  const versions = useVersions();
  const phone = useIsPhone();

  // Read the latest value in the catch branch (stale closure).
  const stateRef = useRef(page?.state);
  stateRef.current = page?.state;

  const [menuOpen, setMenuOpen] = useState(false);
  /** No DialogTrigger, so Radix would drop focus to body: this ref returns focus to the ⋮ trigger after the move/copy dialog closes. */
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? ownTriggerRef;
  /** Skip returning focus to the trigger on close: it is about to be inside the inert AppShell (the presentation layer focuses its own root). */
  const enteringPresentationRef = useRef(false);
  /** Same, for the tag input: it takes focus itself, so it must not be pulled back to ⋮. */
  const addingTagRef = useRef(false);
  const [transfer, setTransfer] = useState<GroupTransferPick | null>(null);
  const [groupExpanded, setGroupExpanded] = useState<GroupTransferKind | null>(null);
  const [paths, setPaths] = useState<DestPaths>(EMPTY_DEST_PATHS);
  const [widthExpanded, setWidthExpanded] = useState(false);
  const resetMenu = () => {
    setGroupExpanded(null);
    setPaths(EMPTY_DEST_PATHS);
    setWidthExpanded(false);
  };
  // Programmatic close does not call `onOpenChange(false)`, so reset here.
  const closeAndReset = () => {
    setMenuOpen(false);
    resetMenu();
  };
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RemoveContext | null>(null);

  async function handleAddFavorite(): Promise<void> {
    setMenuOpen(false);
    try {
      await addFavorite.mutateAsync({ noteId: note.id });
      toast({ title: t("note.favorite.added") });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  /** Close/toast/focus happen after the await: in the favourites tab the row (and this dialog) unmounts after the 204, so a `mutate` onSuccess would not fire. */
  async function handleConfirmRemove(ctx: RemoveContext): Promise<void> {
    try {
      await removeFavorite.mutateAsync({ noteId: note.id });
      setRemoving(null);
      toast({ title: t("note.favorite.removed") });
    } catch (err) {
      setRemoving(null);
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
    focusAfterRemoveLater(ctx);
  }

  function handlePick(pick: DestinationPick): void {
    setGroupExpanded(null);
    setPaths(EMPTY_DEST_PATHS);
    setMenuOpen(false);
    // The menu is already closed here so the confirm dialog's FocusScope doesn't fight it.
    const target = transferTargetOf(note, pick, t);
    if (target !== null) {
      setTransfer({ kind: pick.kind, target });
      return;
    }
    if (!isSameSpaceMove(note, pick) || pick.target.kind !== "place") return;
    const { folder } = pick.target;
    void placeNoteWithUndo({
      noteId: note.id,
      from: note.folderId,
      to: { folderId: folder?.id ?? null, name: destinationShortLabel(folder, t) },
      index: pick.index,
      queryClient,
      t,
    });
  }

  async function handleCopyLink(): Promise<void> {
    const url = `${window.location.origin}${canonicalNotePath(note)}`;
    const copied = await copyText(url);
    setMenuOpen(false);
    if (copied) {
      toast({ title: t("share.linkCopied") });
      return;
    }
    setManualCopyUrl(url);
  }

  async function handleTrash(): Promise<void> {
    if (page === null) {
      try {
        await deleteNote.mutateAsync(note.id);
        showTrashedToast({ notes: [note], queryClient, navigate, t, reopen: false });
      } catch (err) {
        toast({ title: errorMessage(t, err), variant: "destructive" });
      }
      return;
    }
    const { leavingRef } = page;
    leavingRef.current = true;
    try {
      await deleteNote.mutateAsync(note.id);
      showTrashedToast({ notes: [note], queryClient, navigate, t, reopen: true });
      void navigate("/", { replace: true });
    } catch (err) {
      const currentState = stateRef.current;
      if (currentState !== undefined && isTerminal(currentState)) {
        // The terminal effect is gated by `leavingRef` (set above) and will not fire again: reproduce its exit here.
        toast({
          title: currentState.phase === "kicked" ? t("note.accessRevoked") : t("note.deleted"),
          variant: "destructive",
        });
        void navigate("/", { replace: true });
        return;
      }
      leavingRef.current = false;
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <>
      <DropdownMenu
        phoneSheet
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          resetMenu();
        }}
      >
        <DropdownMenuTrigger asChild>
          {trigger === "header" ? (
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="icon"
              className={cn("shrink-0", HEADER_ICON_HIT)}
              aria-label={t("note.menu.label")}
              {...tourTarget("noteMenu")}
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          ) : (
            // Sidebar 24px exception (header of button.tsx); hover reveal, "+" and group ⋮ share ui/reveal.ts.
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("note.menu.labelFor", { title: note.title })}
              className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, hoverReveal("noterow"), NOTE_MENU_COLLAPSE)}
            >
              <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          )}
        </DropdownMenuTrigger>
        {/* bottom sheet on phones: title line is the note title, group name while drilled */}
        <DropdownMenuContent
          align="end"
          sheetTitle={groupExpanded === "move" ? t("note.menu.moveTo") : groupExpanded === "copy" ? t("note.menu.copyTo") : note.title}
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto"
          onEscapeKeyDown={(event) => {
            if (widthExpanded) {
              event.preventDefault();
              setWidthExpanded(false);
            } else if (groupExpanded !== null) {
              event.preventDefault();
              setGroupExpanded(null);
              setPaths(EMPTY_DEST_PATHS);
            }
          }}
          onCloseAutoFocus={(event) => {
            if (addingTagRef.current) {
              addingTagRef.current = false;
              event.preventDefault();
              return;
            }
            if (!enteringPresentationRef.current) return;
            enteringPresentationRef.current = false;
            event.preventDefault();
          }}
        >
          {/* drilled phone sheet shows only the submenu */}
          <DropdownMenuMainLevel drilled={groupExpanded !== null}>
            <FavoriteMenuItem
              noteId={note.id}
              onAdd={() => void handleAddFavorite()}
              onRemove={() => {
                setMenuOpen(false);
                setRemoving(captureRemoveContext(triggerRef.current));
              }}
            />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                void handleCopyLink();
              }}
            >
              <LinkIcon className="mr-2 h-4 w-4" />
              {t("share.copyLink")}
            </DropdownMenuItem>
            {onAddTag && (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  addingTagRef.current = true;
                  // Two steps inside this user event, because iOS only raises the keyboard for focus given within the gesture: the menu's focus trap lets go only once it has closed,
                  // and until then it would pull focus back from the input that mounts (and focuses itself) in the second step.
                  flushSync(() => setMenuOpen(false));
                  flushSync(() => onAddTag());
                }}
              >
                <Tag className="mr-2 h-4 w-4" />
                {t("tags.entry.menuItem")}
              </DropdownMenuItem>
            )}
            {/* onPresent requests fullscreen inside this user event (usePresentEntry) */}
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                enteringPresentationRef.current = true;
                setMenuOpen(false);
                onPresent();
              }}
            >
              <Presentation className="mr-2 h-4 w-4" />
              {t("note.menu.present")}
            </DropdownMenuItem>
            {/* no trigger button: focus returns to the ⋮ trigger on close */}
            {trigger === "header" && (
              <OutlineMenuItem
                onActivate={(open) => {
                  setMenuOpen(false);
                  open(triggerRef.current);
                }}
              />
            )}
            {/* header only, and not on phones (the article column is already full width) */}
            {trigger === "header" && !phone && widthItems?.({ expanded: widthExpanded, onExpandedChange: setWidthExpanded, onModeChange: closeAndReset })}
            {/* only in NotePage VersionsProvider; sidebar rows get the no-op default */}
            {versions.enabled && (
              <PhoneMenuItem
                icon={<History className="mr-2 h-4 w-4" />}
                label={t("note.menu.versions")}
                onActivate={() => {
                  setMenuOpen(false);
                  versions.open();
                }}
              />
            )}
            {onOpenComments && (
              <PhoneMenuItem
                icon={<MessageSquare className="mr-2 h-4 w-4" />}
                label={t("note.menu.comments")}
                onActivate={() => {
                  setMenuOpen(false);
                  onOpenComments();
                }}
              />
            )}
            {/* Keep `preventDefault` (focus-trap rule above); no test guards this line. */}
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                onOpenEdits();
              }}
            >
              <MessageCircle className="mr-2 h-4 w-4" />
              {t("note.menu.aiEdits")}
            </DropdownMenuItem>
          </DropdownMenuMainLevel>
          {/* wide: stacked Radix submenus; narrow/touch: in-place levels */}
          <GroupTransferMenuItems
            note={note}
            expanded={groupExpanded}
            onExpandedChange={setGroupExpanded}
            paths={paths}
            onPathChange={(kind, path) => setPaths((prev) => (prev[kind] === path ? prev : { ...prev, [kind]: path }))}
            onPick={handlePick}
            onModeChange={closeAndReset}
          />
          {/* `permissions.delete`, not `role`: a group note's role is never owner, and `can_delete` members must be able to delete. No confirmation: the toast offers undo (#181); undo lives in `lib/trash-undo.ts`, not this component, because the menu has usually unmounted by then. Disabled while deleting so it cannot be sent twice. */}
          {note.permissions.delete && (
            <DropdownMenuMainLevel drilled={groupExpanded !== null}>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={deleteNote.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  setMenuOpen(false);
                  void handleTrash();
                }}
              >
                <Trash className="mr-2 h-4 w-4" />
                {t("note.menu.delete")}
              </DropdownMenuItem>
            </DropdownMenuMainLevel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {removing !== null && (
        <FavoriteRemoveDialog
          title={note.title}
          open
          pending={removeFavorite.isPending}
          onConfirm={() => void handleConfirmRemove(removing)}
          onOpenChange={(open) => {
            if (open) return;
            setRemoving(null);
            focusAfterRemoveLater(removing);
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        />
      )}

      {transfer !== null && (
        <SidebarLazyBoundary chunk="transferDialog" fallback={null} errorClassName="p-2">
          <GroupTransferDialog note={note} pick={transfer} onClose={() => setTransfer(null)} returnFocusRef={triggerRef} />
        </SidebarLazyBoundary>
      )}

      {/* DialogTitle reuses share.copyLink (Radix requires a title) */}
      <Dialog open={manualCopyUrl !== null} onOpenChange={(open) => !open && setManualCopyUrl(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("share.copyLink")}</DialogTitle>
          </DialogHeader>
          {manualCopyUrl !== null && <ManualCopyField value={manualCopyUrl} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
