import { lazy, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode, type RefObject, type SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type FavoriteDto, type FolderDto, type FolderSpaceDto, type GroupDto, type NoteDto, type NoteTagDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useFavoriteLookup } from "@/api/favorites";
import { folderErrorMessage, useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { GroupMenu } from "@/components/groups/GroupMenu";
import { SidebarNoteMenu } from "@/components/NoteMenu";
import { RowFavoriteStar } from "@/components/RowFavoriteStar";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT, ROW_ICON_ROW } from "@/components/ui/hit-area";
import { hoverReveal, type RevealScope } from "@/components/ui/reveal";
import { FolderPlus, Plus, SquareCheck, Star } from "@/components/ui/icons";
import { EmptyState } from "@/components/EmptyState";
import { indexFolders, liveNotesUnder } from "@/components/sidebar/folder-index";
import { FolderMenu } from "@/components/sidebar/FolderMenu";
import { IndexButton } from "@/components/sidebar/IndexButton";
import { knowledgeScopes, NO_KNOWLEDGE_SCOPES, type KnowledgeScopes } from "@/components/sidebar/knowledge-scopes";
import { useFolderSortOf } from "@/components/sidebar/folder-sort";
import { FolderRowButton } from "@/components/sidebar/FolderRowButton";
import { GroupRowButton } from "@/components/sidebar/GroupRowButton";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { PHONE_LIST_HEADER_STICKY, PHONE_LIST_SCROLLER } from "@/components/sidebar/phone-bar";
import { usePhoneListScroll } from "@/components/sidebar/phone-list-scroll";
import type { StackPreviewState } from "@/components/sidebar/drag-session";
import { StackPreview } from "@/components/sidebar/StackPreview";
import { tabSpec, type HeaderActionId } from "@/components/sidebar/tab-specs";
import { DROP_SCOPE_CLASS, useSidebarDrag } from "@/components/sidebar/useSidebarDrag";
import {
  buildTabNodes,
  countNoteNodes,
  hasSelectableNodes,
  noteLocationLabel,
  noteSpaceKey,
  partitionNotes,
  type LocationContext,
  type SidebarNode,
} from "@/components/sidebar/tree";
import { knowledgeIndexPath } from "@/lib/knowledge-index-path";
import { tourTarget, type TourTargetId } from "@/lib/tour-targets";
import { TagDots } from "@/components/sidebar/TagDots";
import { TagFilterBar } from "@/components/sidebar/TagFilterBar";
import { applyTagFilter, clearTagFilter, tagFilterView, toggleTagFilter, useSectionOpen, useTagFilter } from "@/components/sidebar/tag-filter";
import { TagFilterMenu } from "@/components/tags/TagFilterMenu";

// lazy-only entry (initial-bundle cap); both mount points share one chunk
const SelectHeader = lazy(() => import("@/components/sidebar/SelectLazy").then((m) => ({ default: m.SelectHeader })));
const SelectableTree = lazy(() => import("@/components/sidebar/SelectLazy").then((m) => ({ default: m.SelectableTree })));
const GroupNameDialog = lazy(() => import("@/components/groups/GroupNameDialog").then((m) => ({ default: m.GroupNameDialog })));
// lazy-only entry (initial-bundle cap)
const FolderDialogs = lazy(() => import("@/components/sidebar/FolderLazy").then((m) => ({ default: m.FolderDialogs })));

export interface StackRenameHooks {
  onClosed: (finalName: string) => void;
  focusTarget: () => HTMLElement | null;
}

export type FolderDialogRequest =
  | { kind: "create"; parent: { folderId: string } | { space: FolderSpaceDto } }
  | { kind: "rename"; folder: FolderDto; stack?: StackRenameHooks }
  | { kind: "delete"; folder: FolderDto };

const EMPTY_GROUPS: GroupDto[] = [];
const EMPTY_FOLDERS: FolderDto[] = [];
const EMPTY_NOTES: NoteDto[] = [];
const EMPTY_FAVORITES: FavoriteDto[] = [];
const EMPTY_NODES: SidebarNode[] = [];
const EMPTY_TAGS: NoteTagDto[] = [];

/** same mapping as LoginPage */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

type RowVariant = "plain" | "group" | "recent";

interface NoteRowProps {
  note: NoteDto;
  variant: RowVariant;
  location: LocationContext;
  /** `null` = favourites not loaded or failed: state unknown, no star. */
  favorite: boolean | null;
  favoritePending: boolean;
}

/** Not a button: shown only on touch/no-hover devices (a mouse uses the star button) and takes no clicks; add and remove through ⋮. Sits left of ⋮ so every row ⋮ lines up: 14px star about 8px from ⋮, `ms-2` from the text. */
function FavoriteMarker() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("note.favorite.label")}
      data-favorite-marker=""
      className="pointer-events-none ms-2 hidden h-6 w-3.5 shrink-0 items-center justify-center text-brand [@media(hover:none)]:flex [@media(pointer:coarse)]:flex"
    >
      <Star aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="currentColor" />
    </span>
  );
}

/** Static card and drawer each render a NoteList, so a row can exist twice in the DOM: tests must scope with `within(...)`. DOM order equals visual order; the star's hover reveal relies on the `group/noterow` class on the `li`. */
function NoteRow({ note, variant, location, favorite, favoritePending }: NoteRowProps) {
  const { t } = useTranslation();
  const { activeNoteId, setActiveNoteId } = useActiveNote();
  // #122: active comes from context note.id (see `lib/active-note.tsx`), not route params: slug is recomputed from the title and the URL changes after the save returns.
  const active = activeNoteId === note.id;
  return (
    <li
      data-node-kind="note"
      data-node-id={note.id}
      className={cn(
        "group/noterow flex items-center gap-1 rounded-md pr-0.75 text-[13px] max-sm:text-[15px] hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
        variant === "recent" ? "pl-2" : "h-11 pointer-fine:h-7",
        variant === "plain" && "pl-2",
        variant === "group" && "pl-3",
        // #247: the active row's hover is one shade darker; the four row states match the admin left card. twMerge treats the `hover:bg-*` group as exclusive, so the active hover override must go through `cn(...)`.
        active && "bg-brand-soft text-brand-on-soft font-medium hover:bg-brand-soft-strong",
      )}
    >
      {/* `<Link>` + computed active, not `<NavLink>`: NavLink matches location, which fails for non-canonical URLs (old `/notes/:ref`, prev_slug). Since #179 location matches the address bar, but id is still the only stable criterion. */}
      <Link
        to={canonicalNotePath(note)}
        onClick={(event) => {
          // Optimistic set only for a plain left-click: modified clicks open a new tab and would leave the highlight on a note that did not open. Middle-click fires auxclick, not click, so it never reaches here; alt+click (download) is a known gap.
          if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
            setActiveNoteId(note.id);
          }
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 self-stretch",
          variant === "recent" ? "flex-col justify-center py-1.5" : "items-center truncate",
        )}
      >
        {variant === "recent" ? (
          // Both lines are `<div>` so the accessible name has a space between blocks (spans would run together as "TitleLocation"; the space comes from the UA block display; jsdom has no Tailwind).
          <>
            <div className="truncate text-[13px] max-sm:text-[15px]">{note.title}</div>
            <LocationLine label={noteLocationLabel(note, location, t)} />
          </>
        ) : (
          note.title
        )}
      </Link>
      {favorite === true && <FavoriteMarker />}
      <SidebarNoteMenu note={note} />
      {favorite !== null && <RowFavoriteStar note={note} favorite={favorite} pending={favoritePending} />}
      {/* Reserved on every row, tagged or not, so ⋮ and the star line up and the dots end at the same x; 19px = three overlapping 7px dots. The two-line row puts the dots level with the title line. */}
      <span className={cn("flex w-[19px] shrink-0 justify-end", variant === "recent" && "self-start mt-3 max-sm:mt-3.5")}>
        <TagDots tags={note.tags ?? EMPTY_TAGS} className="pl-0" />
      </span>
    </li>
  );
}

function LocationLine({ label }: { label: string }) {
  return (
    <div className="mt-0.5 truncate text-[11px] text-muted-foreground max-sm:text-xs" title={label}>
      {label}
    </div>
  );
}

/** 24px icon button. Group-row variant (`reveal="grouprow"`) shows on row hover or `:focus-visible` inside, so keyboard users always see it; focus left by a mouse click does not count (not focus-within). Without `reveal` (title-row variant) it is always shown. */
function HeaderActionButton({
  label,
  onClick,
  disabled = false,
  buttonRef,
  reveal,
  icon: Icon = Plus,
  tourTargetId,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  reveal?: RevealScope;
  icon?: (props: SVGProps<SVGSVGElement>) => ReactElement;
  tourTargetId?: TourTargetId;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      {...(tourTargetId === undefined ? {} : tourTarget(tourTargetId))}
      onClick={onClick}
      disabled={disabled}
      className={cn("h-6 w-6 shrink-0", ROW_ICON_HIT, reveal && hoverReveal(reveal))}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
    </Button>
  );
}

interface NodeContext {
  tab: ReturnType<typeof useSidebarTabState>["tab"];
  location: LocationContext;
  onCreateNote?: (groupId?: string, folderId?: string) => void;
  createNotePending: boolean;
  openFolderDialog: (request: FolderDialogRequest, opener: HTMLElement | null) => void;
  /** Used to block deleting a folder whose subtree has live notes. */
  notes: readonly NoteDto[];
  /** `null` = favourites not loaded or failed: no star. */
  favoriteIds: ReadonlySet<string> | null;
  favoritePendingIds: ReadonlySet<string>;
  dropScope: string | null;
  stack: { state: StackPreviewState; creating: boolean } | null;
  /** Tag filtering is on: folders and groups with something to show start open, and toggling them doesn't touch the saved collapse state. */
  filtering: boolean;
  /** Where the viewer has knowledge: only those rows get an index entry. */
  knowledge: KnowledgeScopes;
}

/** Collapse state is the shared store in `sidebar/collapse.ts`; the guide line aligns with the icon slot centre (px-2 8 + 14/2 = 15px). */
function GroupNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "group" }>; ctx: NodeContext }) {
  const { t } = useTranslation();
  const { group } = node;
  const [open, toggle] = useSectionOpen(`group:${group.id}`, ctx.filtering, node.children.length > 0);
  const dropScoped = ctx.dropScope === `group:${group.id}`;
  const indexPath = ctx.knowledge.groups.has(group.id) ? knowledgeIndexPath({ kind: "group", groupId: group.id }) : undefined;
  return (
    <li
      data-node-kind="group"
      data-node-id={group.id}
      data-drop-scope={dropScoped ? "" : undefined}
      className={cn("flex flex-col gap-0.5", dropScoped && DROP_SCOPE_CLASS)}
    >
      <div className={cn("group/grouprow flex h-11 items-center gap-0.5 pr-0.75 pointer-fine:h-7 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong", ROW_ICON_ROW)}>
        <GroupRowButton name={group.name} open={open} onToggle={toggle} />
        {indexPath !== undefined && <IndexButton to={indexPath} name={group.name} reveal="grouprow" />}
        {/* New folder: group notes need edit rights to create a folder; placed before "+" */}
        {group.myRole?.permissions.edit && (
          <HeaderActionButton
            reveal="grouprow"
            icon={FolderPlus}
            label={t("sidebar.newFolderIn", { group: group.name })}
            onClick={(event) => ctx.openFolderDialog({ kind: "create", parent: { space: { kind: "group", groupId: group.id } } }, event.currentTarget)}
          />
        )}
        {/* #175: "+" only when the role can create and edit (create-only would make notes the user cannot edit) */}
        {group.myRole?.permissions.create && group.myRole.permissions.edit && (
          <HeaderActionButton
            reveal="grouprow"
            label={t("sidebar.newNoteIn", { name: group.name })}
            onClick={() => ctx.onCreateNote?.(group.id)}
            disabled={ctx.createNotePending}
          />
        )}
        <GroupMenu group={group} size="sidebar" indexPath={indexPath} />
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          <SidebarNodeList nodes={node.children} ctx={ctx} inGroup />
        </div>
      )}
    </li>
  );
}

function groupIdOf(folder: FolderDto): string | undefined {
  return folder.space.kind === "group" ? folder.space.groupId : undefined;
}

/** "No notes" only when there are no children at all (not when only subfolders exist). */
function FolderNode({ node, ctx }: { node: Extract<SidebarNode, { kind: "folder" }>; ctx: NodeContext }) {
  const { t } = useTranslation();
  const { folder } = node;
  const [open, toggle] = useSectionOpen(`folder:${folder.id}`, ctx.filtering, node.children.length > 0);
  const dropScoped = ctx.dropScope === `folder:${folder.id}`;
  const indexPath = ctx.knowledge.folders.has(folder.id) ? knowledgeIndexPath({ kind: "folder", folderId: folder.id }) : undefined;
  return (
    <li
      data-node-kind="folder"
      data-node-id={folder.id}
      data-drop-scope={dropScoped ? "" : undefined}
      className={cn("flex flex-col gap-0.5", dropScoped && DROP_SCOPE_CLASS)}
    >
      <div className={cn("group/folderrow flex h-11 items-center gap-0.5 pr-0.75 rounded-md hover:bg-brand-soft active:bg-brand-soft-strong pointer-fine:h-7", ROW_ICON_ROW)}>
        <FolderRowButton name={folder.name} open={open} onToggle={toggle} />
        {indexPath !== undefined && <IndexButton to={indexPath} name={folder.name} reveal="folderrow" />}
        {folder.permissions.createNote && (
          <HeaderActionButton
            reveal="folderrow"
            label={t("sidebar.newNoteIn", { name: folder.name })}
            onClick={() => ctx.onCreateNote?.(groupIdOf(folder), folder.id)}
            disabled={ctx.createNotePending}
          />
        )}
        <FolderMenu
          folder={folder}
          indexPath={indexPath}
          depth={node.depth}
          hasLiveNotes={() => liveNotesUnder(ctx.location.folders, folder.id, ctx.notes, (note) => noteSpaceKey(note, ctx.location.groupIds)).length > 0}
          onCreateNote={() => ctx.onCreateNote?.(groupIdOf(folder), folder.id)}
          createNotePending={ctx.createNotePending}
          onRequest={ctx.openFolderDialog}
        />
      </div>
      {open && (
        <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
          {node.children.length === 0 ? (
            <p className="flex h-11 items-center pl-3 text-[11px] text-muted-foreground pointer-fine:h-7">{t("sidebar.folderEmpty")}</p>
          ) : (
            <SidebarNodeList nodes={node.children} ctx={ctx} inGroup />
          )}
        </div>
      )}
    </li>
  );
}

function SidebarNodeList({ nodes, ctx, inGroup = false }: { nodes: SidebarNode[]; ctx: NodeContext; inGroup?: boolean }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) =>
        node.kind === "group" ? (
          <GroupNode key={node.id} node={node} ctx={ctx} />
        ) : node.kind === "folder" ? (
          <FolderNode key={node.id} node={node} ctx={ctx} />
        ) : ctx.stack !== null && ctx.stack.state.anchorNoteId === node.id ? (
          <StackPreview
            key={node.id}
            name={ctx.stack.state.name}
            anchorTitle={node.note.title}
            sourceTitle={ctx.stack.state.sourceTitle}
            creating={ctx.stack.creating}
            variant={inGroup ? "group" : "plain"}
          />
        ) : (
          <NoteRow
            key={node.id}
            note={node.note}
            variant={inGroup ? "group" : ctx.tab === "recent" || ctx.tab === "favorites" ? "recent" : "plain"}
            location={ctx.location}
            favorite={ctx.favoriteIds === null ? null : ctx.favoriteIds.has(node.note.id)}
            favoritePending={ctx.favoritePendingIds.has(node.note.id)}
          />
        ),
      )}
    </ul>
  );
}

export interface NoteListProps {
  onCreateNote?: (groupId?: string, folderId?: string) => void;
  createNotePending?: boolean;
}

const MESSAGE_CLASS = "p-2 text-sm text-muted-foreground";

/** GET /api/groups pending/error only affects the Groups tab (and the zero-notes empty check); until then group notes fall back to Shared-with-me rows. The tabpanel `tabIndex={0}` is in `AppShell` (APG: Tab must stop on a panel whose first content is not focusable). Selection mode swaps in lazy `SelectHeader`/`SelectableTree`; the scroll container `[data-sidebar-list]` is not swapped so scroll does not jump. Focus moves only in the initiating instance (`focusAfterRef`). Rendered as a flex-col child of `AppShell`'s tabpanel; Esc in selection mode is handled by `SelectHeader`. The Favourites tab is the intersection of favourites and `["notes"]`, in favourite order (newest first), and does not wait for folders. */
export function NoteList({ onCreateNote, createNotePending = false }: NoteListProps) {
  const { t } = useTranslation();
  const { tab, selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const favorites = useFavoriteLookup();
  const favoritesQuery = favorites.query;
  const sortOf = useFolderSortOf();
  const [createOpen, setCreateOpen] = useState(false);
  const addGroupRef = useRef<HTMLButtonElement>(null);
  const [folderRequest, setFolderRequest] = useState<FolderDialogRequest | null>(null);
  const folderOpenerRef = useRef<HTMLElement | null>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const tagFilterButtonRef = useRef<HTMLButtonElement>(null);
  /** Only the instance that initiated selection sets it (static card and drawer are both in the DOM). */
  const focusAfterRef = useRef<"done" | "select" | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  usePhoneListScroll(listRef, headerRef);

  const spec = tabSpec(tab);
  const groups = groupsQuery.data ?? EMPTY_GROUPS;
  // Without memo every tick would change `nodes`/`groupIds` and re-render all rows.
  const groupIds = useMemo<ReadonlySet<string>>(() => new Set((groupsQuery.data ?? EMPTY_GROUPS).map((group) => group.id)), [groupsQuery.data]);
  // My notes/Groups/Shared wait for `["folders"]` so the list does not render flat and then jump; if it failed with no old data: empty index (notes at root) plus an error row. Recent/Favourites are flat and do not wait for folders.
  const waitFolders = tab !== "recent" && tab !== "favorites" && tab !== "trash";
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? EMPTY_FOLDERS), [foldersQuery.data]);
  const location = useMemo<LocationContext>(() => ({ groupIds, folders: folderIndex }), [groupIds, folderIndex]);
  const knowledge = useMemo(
    () => (notesQuery.data === undefined ? NO_KNOWLEDGE_SCOPES : knowledgeScopes(notesQuery.data, folderIndex, groupIds)),
    [notesQuery.data, folderIndex, groupIds],
  );
  const foldersPending = waitFolders && foldersQuery.isPending;
  // `data`, not `isSuccess`: after a failed background refetch the old list is still shown.
  const favoritesReady = tab !== "favorites" || favoritesQuery.data !== undefined;
  const nodes = useMemo(
    () =>
      notesQuery.isSuccess && (tab !== "workspace" || groupsQuery.data !== undefined) && favoritesReady && !foldersPending
        ? buildTabNodes(tab, notesQuery.data, groupsQuery.data ?? EMPTY_GROUPS, folderIndex, sortOf, favoritesQuery.data ?? EMPTY_FAVORITES)
        : null,
    [tab, notesQuery.isSuccess, notesQuery.data, groupsQuery.data, favoritesReady, favoritesQuery.data, foldersPending, folderIndex, sortOf],
  );
  const tagFilter = useTagFilter();
  const partition = useMemo(() => (notesQuery.data === undefined ? null : partitionNotes(notesQuery.data, groups)), [notesQuery.data, groups]);
  const filterView = useMemo(() => tagFilterView(tab, tagFilter, partition, groups), [tab, tagFilter, partition, groups]);
  const filterActive = filterView !== null && filterView.selected.length > 0;
  const viewNodes = useMemo(() => (nodes === null ? null : applyTagFilter(tab, nodes, filterView)), [nodes, filterView, tab]);
  const matchCount = viewNodes === null ? 0 : countNoteNodes(viewNodes);
  const selectable = viewNodes !== null && hasSelectableNodes(viewNodes);
  // A disabled button cannot keep focus (falls to body): hand it to the tabpanel. Chromium moves focus and blurs synchronously on disabled commit (React dispatches no event), Firefox/WebKit later: native focusout, checked in a microtask.
  useEffect(() => {
    const onFocusOut = (event: FocusEvent) => {
      const button = selectButtonRef.current;
      if (button === null || event.target !== button || event.relatedTarget !== null) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (button.disabled && (active === null || active === document.body)) button.closest<HTMLElement>('[role="tabpanel"]')?.focus();
      });
    };
    document.addEventListener("focusout", onFocusOut, true);
    return () => document.removeEventListener("focusout", onFocusOut, true);
  }, []);
  const openFolderDialog = (request: FolderDialogRequest, opener: HTMLElement | null) => {
    folderOpenerRef.current = opener;
    setFolderRequest(request);
  };
  const drag = useSidebarDrag({ tab, nodes, groupIds, folderIndex, openFolderDialog });
  const listDropScoped = drag.view.scope === "list";
  const stackState = drag.view.creating ?? drag.view.preview;
  const ctx: NodeContext = {
    tab,
    location,
    onCreateNote,
    createNotePending,
    openFolderDialog,
    notes: notesQuery.data ?? EMPTY_NOTES,
    favoriteIds: favorites.ready ? favorites.ids : null,
    favoritePendingIds: favorites.pendingIds,
    dropScope: drag.view.scope,
    stack: stackState === null ? null : { state: stackState, creating: drag.view.creating !== null },
    filtering: filterActive,
    knowledge,
  };

  useEffect(() => {
    if (selection.active) return;
    const target = focusAfterRef.current;
    focusAfterRef.current = null;
    if (target === "select") selectButtonRef.current?.focus();
  }, [selection.active]);
  const groupsAlert = groupsQuery.isError ? (
    <p role="alert" className="p-2 text-sm text-destructive">
      {errorMessage(t, groupsQuery.error)}
    </p>
  ) : null;
  const foldersAlert =
    waitFolders && foldersQuery.isError && foldersQuery.data === undefined ? (
      <p role="alert" className="p-2 text-sm text-destructive">
        {folderErrorMessage(t, foldersQuery.error)}
      </p>
    ) : null;

  function renderBody(): ReactNode {
    const body = renderList();
    if (foldersAlert === null || body === null || !notesQuery.isSuccess) return body;
    return (
      <>
        {foldersAlert}
        {body}
      </>
    );
  }

  function renderList(): ReactNode {
    if (notesQuery.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    if (notesQuery.isError) {
      return (
        <p role="alert" className="p-2 text-sm text-destructive">
          {errorMessage(t, notesQuery.error)}
        </p>
      );
    }
    const notes = notesQuery.data;
    const emptyState = <EmptyState title={t("home.empty")} description={t("home.emptyDescription")} />;

    if (tab === "workspace") {
      if (groupsQuery.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
      if (groupsQuery.isError && groupsQuery.data === undefined) return groupsAlert;
      // no "New group" button here: creating goes through the title row "+" (avoids two same-named buttons)
      if (groups.length === 0) {
        return (
          <>
            {groupsAlert}
            <p className={MESSAGE_CLASS}>{t("sidebar.emptyWorkspace")}</p>
          </>
        );
      }
    }

    if (tab === "favorites" && favoritesQuery.data === undefined) {
      if (favoritesQuery.isError) {
        return (
          <p role="alert" className="p-2 text-sm text-destructive">
            {errorMessage(t, favoritesQuery.error)}
          </p>
        );
      }
      return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    }

    if (foldersPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
    if (nodes === null || viewNodes === null) return null;
    if (filterActive && matchCount === 0) return <p className={MESSAGE_CLASS}>{t("tags.filter.empty")}</p>;
    if (nodes.length === 0) {
      if (tab === "recent") return emptyState;
      // Intersection, not `favorites`: records may exist while none of those notes is in `["notes"]`.
      if (tab === "favorites") return <p className={MESSAGE_CLASS}>{t("sidebar.emptyFavorites")}</p>;
      if (tab === "shared") return <p className={MESSAGE_CLASS}>{t("sidebar.emptyShared")}</p>;
      if (tab === "myNotes") {
        // Wait for groups to know EmptyState vs "has groups"; avoids a one-frame flash.
        if (notes.length === 0 && groupsQuery.isPending) return <p className={MESSAGE_CLASS}>{t("app.loading")}</p>;
        if (notes.length === 0 && groupsQuery.isSuccess && groups.length === 0) return emptyState;
        return <p className={MESSAGE_CLASS}>{t("sidebar.emptyMyNotes")}</p>;
      }
    }
    return (
      <>
        {tab === "workspace" && groupsAlert}
        <SidebarNodeList nodes={viewNodes} ctx={ctx} />
        {filterActive && tab === "workspace" && nodes.length > 1 && (
          <p data-tag-filter-hint="" className="px-2 py-2 text-[11px] text-muted-foreground">
            {t("tags.filter.hiddenGroups", { group: filterView?.activeGroupName ?? "" })}
          </p>
        )}
      </>
    );
  }

  function onTagFilterChange(ids: string[]) {
    if (filterView === null || (tab !== "myNotes" && tab !== "workspace")) return;
    if (ids.length === 0) {
      clearTagFilter(tab);
      return;
    }
    const changed = ids.find((id) => !filterView.selected.includes(id)) ?? filterView.selected.find((id) => !ids.includes(id));
    if (changed === undefined) return;
    if (tab === "myNotes") toggleTagFilter("myNotes", changed);
    else {
      const groupId = filterView.groups.find((section) => section.tags.some((tag) => tag.id === changed))?.id;
      if (groupId !== undefined) toggleTagFilter("workspace", changed, groupId);
    }
  }

  function renderAction(action: HeaderActionId): ReactNode {
    switch (action) {
      case "openIndex":
        return knowledge.personal ? <IndexButton key={action} to={knowledgeIndexPath({ kind: "personal" })} name={t("sidebar.myNotes")} reveal="tabheader" /> : null;
      case "tagFilter":
        if (filterView === null) return null;
        return (
          <TagFilterMenu
            key={action}
            groups={filterView.groups}
            selected={filterView.selected}
            activeGroupId={filterView.activeGroupId}
            onChange={onTagFilterChange}
            triggerRef={tagFilterButtonRef}
            title={t("tags.filter.menuTitle", { space: t(spec.labelKey) })}
            footnote={t(tab === "workspace" ? "tags.filter.oneGroup" : "tags.filter.allMatch")}
          />
        );
      case "newPersonalNote":
        return (
          <HeaderActionButton
            key={action}
            label={t("sidebar.newPersonalNote")}
            onClick={() => onCreateNote?.(undefined)}
            disabled={createNotePending}
          />
        );
      case "newFolder":
        return (
          <HeaderActionButton
            key={action}
            icon={FolderPlus}
            label={t("sidebar.newFolder")}
            tourTargetId="newFolder"
            onClick={(event) =>
              openFolderDialog({ kind: "create", parent: { space: { kind: tab === "shared" ? "shared" : "personal" } } }, event.currentTarget)
            }
          />
        );
      case "newGroup":
        return (
          <HeaderActionButton
            key={action}
            buttonRef={addGroupRef}
            label={t("sidebar.newGroup")}
            onClick={() => setCreateOpen(true)}
          />
        );
      case "selectMode":
        // Same as `TrashPanel` (24px exception, see the `ui/button.tsx` header); label reuses `trash.select` from the initial bundle, so renaming the key means editing both locales.
        return (
          <Button
            key={action}
            ref={selectButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("trash.select")}
            title={t("trash.select")}
            disabled={!selectable}
            // Focus returns here after selection mode ends (queried via SIDEBAR_SELECT_BUTTON).
            data-sidebar-select=""
            // start would clear the ticked items
            onClick={() => {
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
        return null;
      default: {
        // exhaustiveness check
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  const tabLabel = (
    <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
      <span className="truncate">{t(spec.labelKey)}</span>
    </span>
  );

  return (
    <>
      <div ref={headerRef} data-sidebar-header="" className={PHONE_LIST_HEADER_STICKY}>
        <div className={cn("group/tabheader flex items-center gap-0.5 pl-2 pr-2.75 pt-3 pb-1 pointer-coarse:pb-2.5", ROW_ICON_ROW)}>
          {selection.active ? (
            <SidebarLazyBoundary chunk="select" fallback={tabLabel} errorClassName="hidden">
              <SelectHeader
                nodes={viewNodes ?? EMPTY_NODES}
                filtered={filterActive}
                onMounted={(done) => {
                  if (focusAfterRef.current !== "done") return;
                  focusAfterRef.current = null;
                  done?.focus();
                }}
                onDone={() => {
                  focusAfterRef.current = "select";
                  updateSelection({ type: "end" });
                }}
              />
            </SidebarLazyBoundary>
          ) : (
            <>
              {tabLabel}
              {spec.actions.map(renderAction)}
            </>
          )}
        </div>
        {filterView !== null && filterActive && (
          <TagFilterBar
            groupLabel={tab === "workspace" ? filterView.activeGroupName : null}
            tags={filterView.selectedTags}
            count={matchCount}
            onRemove={(tagId) => {
              onTagFilterChange(filterView.selected.filter((id) => id !== tagId));
              // The chip being pressed disappears; keep focus in the header instead of dropping it to the page.
              tagFilterButtonRef.current?.focus();
            }}
            onClear={() => {
              clearTagFilter(tab === "workspace" ? "workspace" : "myNotes");
              tagFilterButtonRef.current?.focus();
            }}
          />
        )}
      </div>
      {/* `key={tab}` resets scroll on tab switch; toggling selection mode keeps the element (no scroll jump); phones scroll the document and reset via AppShell. */}
      {/* Clip on the inner wrapper: an `overflow-y-auto` list computes the other axis to `hidden`, which is still scrollable. */}
      {/* Drag events are delegated here; the wrapper is `min-h-full` so blank space below counts as root. */}
      <div key={tab} ref={listRef} data-sidebar-list="" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-contain", PHONE_LIST_SCROLLER)} {...drag.containerProps}>
        <div
          data-drop-scope={listDropScoped ? "" : undefined}
          className={cn(
            "min-h-full overflow-x-clip px-2",
            // Floating buttons (56px + 16px + safe area) cover the list bottom. Kept in selection mode so scroll range does not change.
            "max-sm:pb-[calc(5rem+env(safe-area-inset-bottom))]",
            listDropScoped && DROP_SCOPE_CLASS,
          )}
        >
          {selection.active && viewNodes !== null && viewNodes.length > 0 && tab !== "trash" ? (
            <SidebarLazyBoundary chunk="select" fallback={<SidebarNodeList nodes={viewNodes} ctx={ctx} />} errorClassName="p-2">
              <SelectableTree nodes={viewNodes} tab={tab} location={location} filtered={filterActive} />
            </SidebarLazyBoundary>
          ) : (
            renderBody()
          )}
        </div>
      </div>
      {/* mounted only while open */}
      {createOpen && (
        <SidebarLazyBoundary chunk="groupDialog" fallback={null} errorClassName="p-2">
          <GroupNameDialog mode="create" open onOpenChange={setCreateOpen} returnFocusRef={addGroupRef} />
        </SidebarLazyBoundary>
      )}
      {/* Inline error on chunk failure (not hidden, which would leave dead buttons). */}
      {folderRequest && (
        <SidebarLazyBoundary chunk="folder" fallback={null} errorClassName="p-2">
          <FolderDialogs request={folderRequest} returnFocusRef={folderOpenerRef} onClose={() => setFolderRequest(null)} />
        </SidebarLazyBoundary>
      )}
    </>
  );
}
