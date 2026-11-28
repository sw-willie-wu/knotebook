import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavigationType, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { canEditNoteTags, canonicalNotePath, type NoteDto, type Role } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { GROUPS_QUERY_KEY, useGroups } from "@/api/groups";
import { invalidateNoteQueries, patchNotesListLastEdited, useNote, useNoteByGroupPath, useNoteByPath } from "@/api/notes";
import { SESSION_QUERY_KEY, useSession } from "@/auth/useSession";
import type { HashTagBatchInput } from "@/collab/hash-tag-input";
import { canEdit, isTerminal, stopsReconnect, type CollabState } from "@/collab/connection";
import { useActiveNote } from "@/lib/active-note";
import { createPrecheckCtxProvider } from "@/uploads/precheck";
import {
  canonicalizedFrom,
  useHistoryLocation,
  useHistoryLocationKey,
  useRealLocation,
  useRealNavigationType,
  withCanonicalizedFrom,
} from "@/lib/real-location";
import { NotePageControlsContext, type NotePageControls, type OpenEditsState } from "@/lib/note-page-controls";
import { useRegisterNotePage } from "@/lib/note-page-bridge";
import { useAppShellInert } from "@/lib/app-shell-inert";
import { isOverlayOpen, useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { CommentsProvider, useCommentsController } from "@/lib/comments-context";
import { CommentsLazyBoundary } from "@/components/comments/CommentsLazyBoundary";
import { createLinkSync, type LinkSync } from "@/collab/link-sync";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { useCollab } from "@/collab/useCollab";
import { BlockAnchorContext } from "@/hooks/block-anchor-context";
import { useMemberBlockAnchor } from "@/hooks/useBlockAnchor";
import { AiEditsDialog } from "@/components/AiEditsDialog";
import { createPortal } from "react-dom";
import { SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { NoteBrowseBar } from "@/components/NoteBrowseBar";
import { NoteLocation } from "@/components/NoteLocation";
import { useIsPhone } from "@/lib/layout-tiers";
import { BacklinksSection } from "@/components/BacklinksSection";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { FavoriteToggle } from "@/components/FavoriteToggle";
import { InTrashCard } from "@/components/InTrashCard";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { LastEditedLabel } from "@/components/LastEditedLabel";
import { NoteEditor } from "@/components/NoteEditor";
import { NoteTagRow } from "@/components/tags/NoteTagRow";
import { applyHashTags, currentNoteTagNames, preloadHashTagBatch } from "@/components/tags/hash-tag-apply";
import { openTagEntry, type TagEntryOptions } from "@/components/tags/tag-entry";
import { NoteMenu } from "@/components/NoteMenu";
import { NoteWidthMenuItems } from "@/components/NoteWidthMenuItems";
import { NoteWidthToggle } from "@/components/NoteWidthToggle";
import { OutdatedClientBanner } from "@/components/OutdatedClientBanner";
import { useAuthConfig } from "@/api/authConfig";
import { useNoteOverLimit } from "@/hooks/useNoteOverLimit";
import { useLocalPresenceField } from "@/components/presence/local-field";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";
import { ShareDialog } from "@/components/ShareDialog";
import { TitleInput } from "@/components/TitleInput";
import { VERSIONS_ERROR_FRAME, VersionsLazyBoundary } from "@/components/versions/VersionsLazyBoundary";
import { KnowledgeFieldsProvider } from "@/components/knowledge/fields-context";
import { toast } from "@/components/ui/toast";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { preloadableLazy } from "@/lib/preloadable-lazy";
import { exitOwnedFullscreen } from "@/present/fullscreen";
import { LazyPresentation } from "@/present/lazy";
import { PresentationShell, type PresentationShellStatus } from "@/present/PresentationShell";
import { exitFullscreenIfLeftPresentation, isPresentingSearch } from "@/present/present-url";

// The versions UI is referenced only through the lazy `VersionsLazy` entry; each mount point wraps its own `VersionsLazyBoundary`.
const PreviewBanner = lazy(() => import("@/components/versions/VersionsLazy").then((m) => ({ default: m.PreviewBanner })));
const VersionPreview = lazy(() => import("@/components/versions/VersionsLazy").then((m) => ({ default: m.VersionPreview })));
const VersionsDialogs = lazy(() => import("@/components/versions/VersionsLazy").then((m) => ({ default: m.VersionsDialogs })));
const VersionsSheet = preloadableLazy(() => import("@/components/versions/VersionsLazy").then((m) => m.VersionsSheet));
const CommentsSheet = preloadableLazy(() => import("@/components/comments/CommentsLazy").then((m) => m.CommentsSheet));

const COMMENT_PARAM = "comment";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TERMINAL_RECONCILE_INTERVAL_MS = 750;

/**
 * Server worst case (5 s) plus slack: `DELETE /api/notes/:id` (`trashNote`, apps/server/src/trash/service.ts) awaits `beforeNoteDeleted`
 * (unload polling, at most 20 x 250 ms = 5 s; see `apps/server/src/collab/hooks-impl.ts`) before the trash transaction, so the note can stay
 * listed for up to 5 s after NOTE_DELETED.
 */
const TERMINAL_RECONCILE_TIMEOUT_MS = 6_000;

/**
 * Bounded refetch polling after a terminal state (revoke/delete), not a single fetch: the server closes collab connections before running the
 * trash transaction (see `trashNote` in apps/server/src/trash/service.ts), so on NOTE_DELETED the note can still be listed for up to 5 s.
 * A one-shot refetch, immediate or delayed, can land before the commit, bring the note back and overwrite
 * the caller's synchronous fix (a successful refetch also clears the invalidated flag, leaving the sidebar stale until reload).
 * So: fetch, and while the note is still listed fetch again every `TERMINAL_RECONCILE_INTERVAL_MS`, until it's gone or
 * `TERMINAL_RECONCILE_TIMEOUT_MS` passes; never poll forever.
 * `refetchType: 'all'`: between page changes `['notes']` may have no observer, and the default 'active' would only mark it stale.
 * No cancellation on purpose: the caller navigates away (unmounting the page) right away, so cancelling would undo the whole point. `queryClient`
 * is app-level and outlives the page, invalidating it is safe and idempotent, and the polling has a hard deadline.
 */
export function scheduleTerminalReconcile(queryClient: QueryClient, noteId: string | undefined): void {
  const deadline = Date.now() + TERMINAL_RECONCILE_TIMEOUT_MS;

  // Also invalidate groups (#103): after removal from a group (or group deletion) the group itself may no longer be mine, and the sidebar's group
  // section comes from `useGroups()`, so it would keep an empty group section. One shot is enough, not polled: removing a member commits before
  // kicking, so the group list has no commit-after-kick race.
  void queryClient.invalidateQueries({ queryKey: ["groups"], refetchType: "all" });

  const stillListed = (): boolean =>
    queryClient.getQueryData<NoteDto[]>(["notes"])?.some((candidate) => candidate.id === noteId) ?? false;

  const tick = async (): Promise<void> => {
    try {
      await queryClient.invalidateQueries({ queryKey: ["notes"], refetchType: "all" });
    } catch {
      // A failed fetch (offline, 5xx) must not end reconciliation early.
    }
    if (!noteId || !stillListed() || Date.now() >= deadline) return;
    setTimeout(() => void tick(), TERMINAL_RECONCILE_INTERVAL_MS);
  };

  void tick();
}

const EDITING_SELECTOR = '[data-testid="note-editor"] [contenteditable="true"], [data-mobile-edit-toolbar]';
function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITING_SELECTOR) !== null;
}

function effectiveRole(state: CollabState, note: NoteDto): Role {
  return state.phase === "connected" ? state.role : note.role;
}

/** Same format and precedence as `paramsKey` and `canonicalNotePath`; null where `canonicalNotePath` would throw. */
function notePathKey(note: NoteDto): string | null {
  if (typeof note.groupId === "string") return `g:${note.groupId}/${note.slug}`;
  if (typeof note.ownerHandle === "string") return `n:${note.ownerHandle}/${note.slug}`;
  return null;
}

/**
 * The legacy `/notes/:ref` route (legacy slug, `<vanity>-<uuid>` or bare uuid; resolved server-side) is kept permanently alongside
 * `/n/:handle/:slug` (#122) and `/g/:groupId/:slug` (#175).
 * Two data layers: a resolve layer keyed by params (its 404 means "invalid link") and a resident layer keyed by id, which never goes stale on rename or invalidate, so its 404 means real deletion. `note` comes only from the resident layer.
 * The canonical-URL effect is the only URL writer.
 * Whether a note is the open one always goes through ActiveNoteContext's note.id (see `@/lib/active-note`).
 * A downgrade to viewer is not terminal: the connection stays; `editable` turns false and a toast announces it.
 */
export default function NotePage() {
  const params = useParams<{ ref?: string; handle?: string; groupId?: string; slug?: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const phone = useIsPhone();
  // Phone: focus inside the editor or the edit toolbar means editing, and the bottom floating buttons make way; the header title and blank page
  // areas don't count.
  const [editingFocus, setEditingFocus] = useState(false);
  // An editor unmounting while focused (wikilink navigation, placeholder swapped for the editor) fires no blur, so recheck after every commit.
  // No deps on purpose: unmounting doesn't change editingFocus, so only a recheck after every commit catches it. It only sets state when the
  // flag is true and focus has left, so it can't loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editingFocus && !isEditingTarget(document.activeElement)) setEditingFocus(false);
  });

  // Three forms: `n:` (/n/:handle/:slug), `g:` (/g/:groupId/:slug), `ref:` (/notes/:ref). The prefixes are defensive (a `ref` can't contain `/`,
  // so content alone tells the forms apart); don't credit them for cross-pattern inequality, no test guards that. The three routes share this
  // component and explicitly don't rely on a remount.
  // Never derive this from window.location.pathname: with the settings modal open it is `/settings/*` (the main tree uses the background location), and the background page would be resolved as another note.
  const form: "group" | "user" | "ref" =
    params.groupId !== undefined && params.slug !== undefined
      ? "group"
      : params.handle !== undefined && params.slug !== undefined
        ? "user"
        : "ref";
  const paramsKey =
    form === "group"
      ? `g:${params.groupId}/${params.slug}`
      : form === "user"
        ? `n:${params.handle}/${params.slug}`
        : `ref:${params.ref ?? ""}`;
  // `knownKeys`: paramsKeys known to belong to this note during this mount (the resolve key plus every canonical params followed). Reset when the resident note changes.
  const [resolvedFor, setResolvedFor] = useState<{ key: string; id: string; knownKeys: readonly string[] } | null>(
    null,
  );

  // Resident layer (see `note` below). Declared before needsResolve, which reads its data to tell whether params point at this note's canonical.
  const noteQuery = useNote(resolvedFor?.id ?? "");
  // Params equal to the resident note's current canonical count as resolved: the convergence effect navigates through the router, which changes params, and treating that as a real navigation would gate note/noteId to undefined, drop collab and remount the editor.
  // By our latest data that URL is this note: another note's canonical can't be the same.
  const residentKey = noteQuery.data && resolvedFor ? notePathKey(noteQuery.data) : null;
  // Params this note passed through (`knownKeys`) don't re-resolve either, but only on POP. Case: open settings, close, rename (converging to a
  // new URL), then Back into `/settings/*`: that entry's backgroundLocation holds the pre-rename URL, which is neither resolvedFor.key nor the
  // canonical, and re-resolving would reconnect collab and remount the editor (or, if the old slug no longer resolves, report an invalid link
  // and go home). Old slugs aren't kept otherwise: after A is renamed foo -> bar, a new note B may get foo, and a PUSH (link, sidebar) to
  // /n/<me>/foo must re-resolve to B, not stay on A.
  // Real navigationType comes from AppRoutes: `useNavigationType()` in the main tree is always POP.
  const localNavigationType = useNavigationType();
  const navigationType = useRealNavigationType() ?? localNavigationType;
  const needsResolve =
    resolvedFor === null ||
    (resolvedFor.key !== paramsKey &&
      residentKey !== paramsKey &&
      !(navigationType === NavigationType.Pop && resolvedFor.knownKeys.includes(paramsKey)));
  // Follow `resolvedFor.key` to a canonical params and record it: otherwise the render after a title change (data first, URL later) matches neither the old key nor the new canonical and looks like a real navigation.
  useEffect(() => {
    if (needsResolve || !resolvedFor || resolvedFor.key === paramsKey) return;
    setResolvedFor({
      key: paramsKey,
      id: resolvedFor.id,
      knownKeys: resolvedFor.knownKeys.includes(paramsKey) ? resolvedFor.knownKeys : [...resolvedFor.knownKeys, paramsKey],
    });
  }, [needsResolve, paramsKey, resolvedFor]);

  // Only the matching resolve query is enabled; its key includes its params, so data always belongs to the current URL, provided useNote/useNoteByPath/useNoteByGroupPath never use placeholderData/keepPreviousData.
  // The two disabled queries never send a request.
  // 404 `in_trash` isn't retried: the result won't change and the default backoff (1+2+4 s) would delay the trash card by about 7 s. Other errors use the QueryClient defaults (global settings untouched).
  const resolveRetry = useMemo(() => {
    const base = queryClient.getDefaultOptions().queries?.retry ?? 3;
    return (failureCount: number, error: Error) => {
      if (error instanceof ApiFail && error.code === "in_trash") return false;
      if (typeof base === "function") return base(failureCount, error);
      return typeof base === "number" ? failureCount < base : base;
    };
  }, [queryClient]);
  const resolveByRef = useNote(params.ref ?? "", { enabled: needsResolve && form === "ref", retry: resolveRetry });
  const resolveByPath = useNoteByPath(params.handle ?? "", params.slug ?? "", {
    enabled: needsResolve && form === "user",
    retry: resolveRetry,
  });
  const resolveByGroupPath = useNoteByGroupPath(params.groupId ?? "", params.slug ?? "", {
    enabled: needsResolve && form === "group",
    retry: resolveRetry,
  });
  const resolveQuery = form === "group" ? resolveByGroupPath : form === "user" ? resolveByPath : resolveByRef;
  useEffect(() => {
    if (!needsResolve || !resolveQuery.data) return;
    // Seed the resident layer (`GET /api/notes/:ref` and `GET /api/notes/:id` share toNoteDto; server tests pin the shape). Not just to save a
    // blocking wait: link-sync's mount effect reads canEditRef only on the frame `[noteId, doc, provider]` changes, and without the seed `note`
    // is still undefined there, canEdit is false, and link-sync never starts. A background refetch still fires once; acceptable.
    // Known: reopening a note from another note via a dead old slug within the gc window (default 5 minutes) hits the stale resolve cache,
    // seeds and switches to that note (the background refetch then fixes the content), so the dead link doesn't reach linkInvalid within the
    // window. Accepted cache semantics, not a bug.
    // If the resolve cache points at the resident note but is older and refetching, wait: after A was renamed and B took the old slug, a PUSH to that slug would otherwise stay on A. The refetch decides (B: switch; A: seed; 404: linkInvalid). If the refetch fails or offline, react-query keeps the old data and isFetching drops to false, so seed anyway (possibly staying on A); the guarded cache write below keeps it from reverting the resident layer to the pre-rename DTO.
    if (
      resolveQuery.isFetching &&
      resolveQuery.data.id === resolvedFor?.id &&
      resolveQuery.dataUpdatedAt < noteQuery.dataUpdatedAt
    ) {
      return;
    }
    const id = resolveQuery.data.id;
    // Don't write when the resident layer has newer data (e.g. a renamed DTO): a stale resolve cache (kept by react-query after a failed
    // refetch, offline, or a 404) would overwrite it and the convergence effect would navigate back to the old URL.
    const residentUpdatedAt = queryClient.getQueryState(["note", id])?.dataUpdatedAt ?? 0;
    if (residentUpdatedAt <= resolveQuery.dataUpdatedAt) {
      queryClient.setQueryData(["note", id], resolveQuery.data);
    }
    // Accumulate when resolving to the same note; reset for another note.
    setResolvedFor((previous) => ({
      key: paramsKey,
      id,
      knownKeys:
        previous?.id === id
          ? previous.knownKeys.includes(paramsKey)
            ? previous.knownKeys
            : [...previous.knownKeys, paramsKey]
          : [paramsKey],
    }));
  }, [
    needsResolve,
    noteQuery.dataUpdatedAt,
    paramsKey,
    queryClient,
    resolveQuery.data,
    resolveQuery.dataUpdatedAt,
    resolveQuery.isFetching,
    resolvedFor?.id,
  ]);

  // Resident layer. During a transition (needsResolve) it still subscribes to the old id only to keep the cache fed; `note`/`noteId` are
  // undefined, which tears down collab, and the render gate hides the old content.
  const note = needsResolve ? undefined : noteQuery.data;
  const noteId = needsResolve ? undefined : resolvedFor?.id;

  // Final correction of the sidebar highlight (#122; NoteList sets it optimistically, reasons in the lib/active-note.tsx header). A direct
  // URL or bookmark highlights only after resolve: the late frame is an accepted trade-off.
  // Cleanup is conditional (only if current is this page): on a page change the new page's set may run first.
  const { setActiveNoteId, clearActiveNoteId } = useActiveNote();
  useEffect(() => {
    if (!noteId) return;
    setActiveNoteId(noteId);
    return () => clearActiveNoteId(noteId);
  }, [noteId, setActiveNoteId, clearActiveNoteId]);

  // 401 means the session is gone (not a revoke): clear ['me'] and go to login, the same end point as UserMenu's logout, minus the server round-trip.
  const handleUnauthorized = useCallback(() => {
    exitOwnedFullscreen(); // exit the fullscreen we own before navigating (#229)
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    void navigate("/login", { replace: true });
  }, [navigate, queryClient]);

  // AI edits dialog state (#106) lives here, not on a trigger, because several open it: the menu item and the header `LastEditedLabel`
  // (the sidebar note row menu is a third, via NotePageControlsContext).
  const [editsOpen, setEditsOpen] = useState(false);
  const openEdits = useCallback(() => setEditsOpen(true), []);

  // Sidebar menu on another note navigates here with `{openEdits:true}`: open on the first commit (the dialog waits for the note) and replace the state, or reload/back would reopen it (history.state.usr is read back). This is always during needsResolve, before the convergence effect writes the URL, so replacing with the router pathname is safe.
  const location = useLocation();
  // Presentation mode (#229) reads this page's own useLocation() (main tree, same source as the convergence effect).
  const presenting = isPresentingSearch(location.search);
  const openEditsRequested = (location.state as Partial<OpenEditsState> | null)?.openEdits === true;
  useEffect(() => {
    if (!openEditsRequested) return;
    setEditsOpen(true);
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [openEditsRequested, location.pathname, location.search, location.hash, navigate]);

  /**
   * After this note's document changes (others, human or AI, or own typing), align the note query with the server: `lastEdited` lives on
   * `NoteDto` and the header `LastEditedLabel` reads it, so reacting only to others would leave the label stale after own edits until reload.
   * `ref` is the resolve key's second segment (`params.ref` on the legacy route); the path and group routes have no such layer, so pass
   * `note.id` to make `invalidateNoteQueries` skip it (it picks the resolve layer for those two forms by `note.groupId`).
   */
  const onDocUpdate = useCallback(() => {
    if (!note) return;
    invalidateNoteQueries(queryClient, note, params.ref ?? note.id);
  }, [note, params.ref, queryClient]);

  // When the note query gets a new lastEdited (same moment as the header's last-edited), feed it into the list cache so the Recent tab keeps up.
  const listNoteId = note?.id;
  const leAt = note?.lastEdited?.at;
  const leBy = note?.lastEdited?.byHandle;
  const leAgent = note?.lastEdited?.agentLabel;
  useEffect(() => {
    if (listNoteId === undefined) return;
    patchNotesListLastEdited(
      queryClient,
      listNoteId,
      leAt === undefined ? null : { at: leAt, byHandle: leBy ?? "", agentLabel: leAgent ?? null },
    );
  }, [queryClient, listNoteId, leAt, leBy, leAgent]);

  const { state, doc, provider, synced, syncedFor } = useCollab({
    noteId,
    onUnauthorized: handleUnauthorized,
    onDocUpdate,
  });
  // Note size limit (server `NOTE_MAX_BYTES`): the editor itself blocks paste, drop and in-app AI apply (`lib/note-size-guard.ts`); an
  // already-oversized note gets a non-blocking notice (computed once after sync, then throttled).
  const authConfigData = useAuthConfig().data;
  const noteMaxBytes = authConfigData?.noteMaxBytes;
  const overLimit = useNoteOverLimit(doc, noteMaxBytes, noteId !== undefined && syncedFor === noteId);

  // Held in a ref: functions can't go into setState; the avatar row reads it only on click.
  const cursorScrollerRef = useRef<CursorScroller | null>(null);
  const handleCursorScroller = useCallback((scroller: CursorScroller | null) => {
    cursorScrollerRef.current = scroller;
  }, []);
  // Avatars send only { id, v }: an image not yet generated 404s for others and falls back to the initial, so no pending flag is needed.
  useLocalPresenceField({
    provider,
    role: state.phase === "connected" ? state.role : null,
    name: user?.displayName ?? null,
    avatar: user?.avatar ? { id: user.avatar.id, v: user.avatar.v } : null,
  });

  const [anchorRoot, setAnchorRoot] = useState<HTMLElement | null>(null);
  const blockAnchor = useMemberBlockAnchor({ noteId, collab: { synced, syncedFor }, root: anchorRoot, presenting });

  // Link index committer (client side), mounted here rather than in NoteEditor because `noteId` and useCollab's `doc`/`provider` live here.
  // `canEditRef` is written during render (same as `onUnauthorizedRef` in useCollab) because the mount effect's deps must stay `[noteId, doc, provider]`: with `state`/`note` there, a role change would resubscribe and the provider's one-time `synced` edge could be missed, so the connection would never commit. canEdit is therefore read once as a snapshot when the effect starts.
  const canEditRef = useRef(false);
  canEditRef.current = note ? canEdit(effectiveRole(state, note)) : false;
  const linkSyncRef = useRef<LinkSync | null>(null);

  // Same canEdit criterion as title/share (REST role, non-terminal); synced is ignored because the versions API is REST.
  const versionsEnabled = note !== undefined && !stopsReconnect(state) && canEdit(effectiveRole(state, note));
  const canChangeTags = versionsEnabled && canEditNoteTags(note);
  useEffect(() => {
    if (canChangeTags) preloadHashTagBatch();
  }, [canChangeTags]);
  // Only one right-hand panel at a time: each controller closes the other before it opens. The comments one is created second, so the
  // version history reaches it through a ref.
  const closeCommentsRef = useRef<() => void>(() => {});
  const closeComments = useCallback(() => closeCommentsRef.current(), []);
  const versions = useVersionsController({
    noteId: noteId ?? null,
    enabled: versionsEnabled,
    // After a successful apply the whole note query group is invalidated (id key, legacy ref key, path resolve layer): exactly onDocUpdate.
    onApplied: onDocUpdate,
    onOpen: closeComments,
  });
  // Anyone who can read the note, viewers included; not after the connection ended or while the tab is outdated.
  const commentsEnabled = note !== undefined && !stopsReconnect(state) && effectiveRole(state, note) !== "none";
  const comments = useCommentsController({
    noteId: noteId ?? null,
    enabled: commentsEnabled,
    provider,
    onOpen: versions.close,
  });
  closeCommentsRef.current = comments.close;
  const sheetOpen = versions.mode === "sheet" || comments.mode === "sheet";
  const bothPanels = versions.enabled && comments.enabled;
  useEffect(() => {
    if (!sheetOpen || !bothPanels) return;
    // The sheet's switch opens the other sheet: unloaded, the note would show between the two while its chunk loads.
    VersionsSheet.preload();
    CommentsSheet.preload();
  }, [sheetOpen, bothPanels]);

  // `?comment=<id>` (a notification's link) opens the thread at that comment; the parameter is then dropped so a reload doesn't reopen it.
  const commentParam = new URLSearchParams(location.search).get(COMMENT_PARAM);
  const { open: openComments } = comments;
  useEffect(() => {
    if (commentParam === null || !commentsEnabled) return;
    if (UUID_RE.test(commentParam)) openComments({ commentId: commentParam });
    const search = new URLSearchParams(location.search);
    search.delete(COMMENT_PARAM);
    const rest = search.toString();
    void navigate(
      { pathname: location.pathname, search: rest === "" ? "" : `?${rest}`, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [commentParam, commentsEnabled, openComments, location.pathname, location.search, location.hash, location.state, navigate]);

  // Ctrl/Cmd+S saves a version: plain window keydown (not capture, like AppShell's Ctrl+K), intercepted only with canEdit, no presentation and no open dialog/menu; BlockNote doesn't bind Mod+S.
  // While our own save dialog is open it still preventDefaults (no browser save-page) without opening a second one.
  const { enabled: vEnabled, openSave, preview: vPreview, stopPreview } = versions;
  const saveDialogOpen = versions.dialog?.kind === "save";
  useEffect(() => {
    if (!vEnabled || presenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "s") return;
      if (saveDialogOpen) {
        event.preventDefault();
        return;
      }
      if (isOverlayOpen()) return;
      event.preventDefault();
      openSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vEnabled, presenting, saveDialogOpen, openSave]);

  // Esc exits preview (the banner has no close button); open dialogs/menus handle their own Esc.
  // Main check is `event.defaultPrevented`: Radix's DismissableLayer handles Esc in document capture and always calls preventDefault before
  // onDismiss. Real key events get a microtask checkpoint between listeners, so React 19's SyncLane unmounts the overlay before the event
  // reaches window, and checking overlay DOM (isOverlayOpen) reads false in real browsers. It stays as a second check for overlays that don't
  // preventDefault. jsdom's fireEvent doesn't flush microtasks, so the two checks can't be told apart there; e2e/tests/22-versions.spec.ts covers the real keyboard.
  useEffect(() => {
    if (vPreview === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isOverlayOpen()) return;
      event.preventDefault(); // this Esc closes only the preview (the search-mark Esc listener yields on defaultPrevented)
      stopPreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vPreview, stopPreview]);

  useEffect(() => {
    if (!noteId || !doc || !provider) return;

    const linkSync = createLinkSync({ noteId, doc, api });
    linkSyncRef.current = linkSync;
    if (canEditRef.current) linkSync.start();

    // Check `provider.synced` right after subscribing: if the provider synced before this effect attached (StrictMode remount, slow mount) the false→true event already fired, and without this the connection would never commit.
    const handleSynced = () => linkSync.onSynced();
    provider.on("synced", handleSynced);
    if (provider.synced) handleSynced();

    return () => {
      provider.off("synced", handleSynced);
      linkSync.stop();
      linkSyncRef.current = null;
    };
  }, [noteId, doc, provider]);

  // Own effect so its deps can include `state` without touching the subscription effect's deps restriction.
  useEffect(() => {
    linkSyncRef.current?.onCollabState(state);
  }, [state]);

  // The only URL writer. A stale `note` can't write during a re-resolve because `needsResolve` gates it to undefined; `note.id === resolvedFor.id` is just a backstop (unreachable today).
  // Uses router `navigate({ replace })` so the router location matches the address bar (`history.replaceState` left the settings modal's backgroundLocation on the old URL); compares against the router location (the background one while a modal is open), not window.location.
  // Normal: replace with the canonical path, keeping state plus a `canonicalizedFrom` marker (so AppShell doesn't treat it as a page change and close drawers).
  // Settings modal open (entry state has backgroundLocation): do nothing. Writing a note URL would close the modal, and rewriting backgroundLocation would make Back inside the modal mismatch resolvedFor.key and re-resolve. resolvedFor.key stays the old URL, so closing the modal doesn't re-resolve and then converges normally.
  // Search and hash are preserved (#229); only pathname is replaced and compared. Only writes when it differs, so history isn't touched every render.
  const realLocation = useRealLocation();
  const readHistoryKey = useHistoryLocationKey();
  // Last written (location.key, canonical): never write the same pair twice, or a navigate that doesn't take effect (blocked, router lagging) would loop.
  const lastWriteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!note || note.id !== resolvedFor?.id) return;
    const canonical = canonicalNotePath(note);
    // Decode before comparing: canonicalNotePath returns unencoded text but real pathnames are percent-encoded for non-ASCII slugs, so "same, skip" would never match (a wasted replace per note change, no loop). try/catch: decodeURIComponent throws on malformed % sequences; browser pathnames never are, it only keeps the defensive comparison from throwing.
    let currentPath = location.pathname;
    try {
      currentPath = decodeURIComponent(currentPath);
    } catch {
      // compare the raw path; worst case is one extra replace
    }
    if (currentPath === canonical) return;
    if ((realLocation?.state as { backgroundLocation?: unknown } | null | undefined)?.backgroundLocation) return;
    // Skip while a navigation is in flight (history already moved, router location lagging; see useHistoryLocationKey): replacing now would clobber the new entry. The effect reruns once location changes.
    const historyKey = readHistoryKey();
    if (historyKey !== undefined && historyKey !== (realLocation ?? location).key) return;
    const write = `${location.key}\n${canonical}`;
    if (lastWriteRef.current === write) return;
    lastWriteRef.current = write;
    // Search and hash are URL state (`?present` for presentation, `#/<slide id>` for the current slide): when opening `/notes/:ref` directly or
    // renaming while presenting, only the pathname changes.
    void navigate(
      { pathname: canonical, search: location.search, hash: location.hash },
      { replace: true, state: withCanonicalizedFrom(location.state, location.pathname) },
    );
  }, [location, navigate, note, readHistoryKey, realLocation, resolvedFor]);

  // Gap when history has moved to another URL but this page isn't swapped yet: title input text would be saved to the old note. Same-note navigation doesn't count: own slug convergence (REPLACE with the marker equal to the current pathname; old entries reached by Back/Forward
  // don't count) or a search/hash-only change.
  const readHistoryLocation = useHistoryLocation();
  const isNavigatingAway = useCallback((): boolean => {
    const pending = readHistoryLocation();
    const rendered = realLocation ?? location;
    if (pending === undefined || pending.key === rendered.key) return false;
    if (pending.action === NavigationType.Replace && canonicalizedFrom(pending.state) === rendered.pathname) return false;
    return pending.pathname !== rendered.pathname;
  }, [location, readHistoryLocation, realLocation]);

  // One gate for two independent exit paths that can both hold (collab terminal and API 404 arrive back to back on delete), else a duplicate toast and double navigation. Needed, not just a safeguard: the component renders again after navigate.
  const leavingRef = useRef(false);
  /** Focus fallback when the pre-open element (menu item) was unmounted by closing the full-page versions view. */
  const noteMenuTriggerRef = useRef<HTMLButtonElement>(null);
  // After restoring from the trash card (card unmounts, focus falls to body), focus the title input when the header mounts: same DOM position as the card, and screen readers announce the result (no success toast). Not the editor, to avoid typing into the body.
  // The flag holds the restored note's id and is consumed on each header mount: if the restore never landed, another note's header just clears it without taking focus.
  const focusTitleAfterRestoreRef = useRef<string | null>(null);
  const noteHeaderRef = useCallback(
    (header: HTMLElement | null) => {
      if (!header) return;
      const target = focusTitleAfterRestoreRef.current;
      focusTitleAfterRestoreRef.current = null;
      if (target === null || target !== noteId) return;
      // Input only; read-only renders an h1, which isn't moved.
      header.querySelector<HTMLInputElement>("input[data-note-title-input]")?.focus();
    },
    [noteId],
  );

  // Only set once noteId is resolved. A sidebar delete of this note must share `leavingRef` (or it toasts "deleted" a second time); AI edit history opens this page's dialog without navigating.
  const controls = useMemo<NotePageControls | null>(
    () => (noteId ? { noteId, state, leavingRef, openEdits } : null),
    [noteId, state, openEdits],
  );
  // The sidebar lives outside the page (AppShellLayout): register this page's controls and anchor API with it; the shell is inert while presenting.
  useRegisterNotePage(controls, blockAnchor);
  useAppShellInert(presenting);

  // Three 404 exits with distinct copy (#122). Resolve-layer 404 = invalid link (slug renamed or never existed) -> `note.linkInvalid`. Reset
  // active before leaving: this page never set it and the unmount cleanup matches by id, so NoteList's optimistic set can only be cleared here.
  // Resolve-layer `in_trash` (with `noteId`; only people with trash rights get it) = card, no navigation or toast; without `noteId` it can't be restored, so treat it as an invalid link.
  // Resident-layer 404 = real deletion (`noteGone` below). `in_trash` isn't split there: it only happens when the note is trashed while open, collab kicks with the `deleted` terminal at the same time, and a card would fight the terminal effect for the exit; recovery is via the trash tab.
  const inTrashId =
    needsResolve &&
    resolveQuery.isError &&
    resolveQuery.error instanceof ApiFail &&
    resolveQuery.error.status === 404 &&
    resolveQuery.error.code === "in_trash"
      ? (resolveQuery.error.noteId ?? null)
      : null;
  // A restore POST landing after switching notes belongs to a card no longer on screen.
  const shownInTrashIdRef = useRef<string | null>(null);
  useEffect(() => {
    shownInTrashIdRef.current = inTrashId;
  }, [inTrashId]);
  const linkInvalid =
    needsResolve &&
    resolveQuery.isError &&
    resolveQuery.error instanceof ApiFail &&
    resolveQuery.error.status === 404 &&
    inTrashId === null;
  useEffect(() => {
    if (!linkInvalid || leavingRef.current) return;
    leavingRef.current = true;
    exitOwnedFullscreen(); // exit the fullscreen we own before navigating (#229)
    setActiveNoteId(null);
    toast({ title: t("note.linkInvalid"), variant: "destructive" });
    void navigate("/", { replace: true });
  }, [linkInvalid, navigate, setActiveNoteId, t]);

  // Resident-layer 404 = real deletion (id-keyed, so rename/invalidate never trip it, unlike the old slug key, which mistook a live note for deleted on a focus refetch). Same exit as the collab `deleted` terminal; set(null) is an idempotent backstop (cleanup also clears).
  const noteGone =
    !needsResolve && noteQuery.isError && noteQuery.error instanceof ApiFail && noteQuery.error.status === 404;
  useEffect(() => {
    if (!noteGone || leavingRef.current) return;
    leavingRef.current = true;
    exitOwnedFullscreen(); // exit the fullscreen we own before navigating (#229)
    setActiveNoteId(null);
    toast({ title: t("note.deleted"), variant: "destructive" });
    void navigate("/", { replace: true });
  }, [navigate, noteGone, setActiveNoteId, t]);

  useEffect(() => {
    if (!isTerminal(state) || leavingRef.current) return;
    leavingRef.current = true;
    exitOwnedFullscreen(); // exit the fullscreen we own before navigating (#229)
    toast({
      title: state.phase === "kicked" ? t("note.accessRevoked") : t("note.deleted"),
      variant: "destructive",
    });
    // Both terminal states mean the note is gone for me: drop it from the sidebar (clicking it would only get kicked again). First filter `['notes']` synchronously, then run the bounded reconcile.
    // The filter alone isn't enough: after navigate NoteList remounts and refetches (staleTime 0), possibly before the server commits the delete, bringing a ghost row back; the reconcile clears it. The filter stays so the screen is right while refetches are pending.
    queryClient.setQueryData<NoteDto[]>(["notes"], (previous) =>
      previous?.filter((candidate) => candidate.id !== noteId),
    );
    scheduleTerminalReconcile(queryClient, noteId);
    void navigate("/", { replace: true });
  }, [navigate, noteId, queryClient, state, t]);

  // Fallback (#229): if the whole page unmounts and the URL no longer has present, exit the fullscreen we own.
  useEffect(() => () => exitFullscreenIfLeftPresentation(), []);

  // Role changes during a connection (revoke downgrade to viewer, access restored) are announced; recovery has no server notice, it arrives
  // with the role of the next token round-trip (see useCollab).
  // Baseline per connection (`{ provider, role }`): when the provider changes (new note's connection) the first connected only records. The page doesn't remount on note change, so a role-only baseline would take the previous note's role (editable -> read-only note reports a false downgrade, the reverse a
  // false recovery, and the #182 invalidation runs for nothing).
  // Keyed by provider, not noteId: after a switch useCollab resets state in an effect, so for a few renders `state` is still the previous note's connected while noteId is already new; noteId alone can't catch that. Provider and state change together (useCollab sets INITIAL and the new provider in one effect, effective in the same render; cleanup already
  // set the session to null), so a stale connected only pairs with the old provider or null. Within one note the provider is constant (one per connection effect; reconnecting-once and reconnects reuse it), so the second revoke hit and role changes after reconnect still compare.
  // WeakRef: a strong reference to a destroyed provider would retain the previous Y.Doc; a collected ref reads undefined and counts as a new connection.
  const previousRoleRef = useRef<{ provider: WeakRef<NonNullable<typeof provider>>; role: Role } | null>(null);
  const noteGroupId = note?.groupId ?? null;
  // Usage numbers ("this space has … left") only for the people who see them elsewhere: the owner of a personal note and a
  // group's managers, though any member may read the group's usage.
  const groups = useGroups().data;
  const canViewUsage =
    note !== undefined &&
    (noteGroupId === null ? note.ownerId === user?.id : groups?.find((g) => g.id === noteGroupId)?.canManageGroup === true);
  const precheckCtx = useMemo(
    () => createPrecheckCtxProvider(queryClient, { groupId: noteGroupId, canViewUsage }),
    [queryClient, noteGroupId, canViewUsage],
  );
  useEffect(() => {
    if (state.phase !== "connected" || !provider) return;
    const previous = previousRoleRef.current?.provider.deref() === provider ? previousRoleRef.current.role : null;
    previousRoleRef.current = { provider: new WeakRef(provider), role: state.role };
    if (previous === null || previous === state.role) return;
    // Role changed but access remains (#182; on a group note usually a group role change): invalidate `['groups']`, since the sidebar group row's
    // "+" reads myRole.permissions there and would stay stale until reload. 'none' is the first half of a revoke, whose kicked terminal invalidates groups.
    // Also invalidate this note's `['note', id]` (header menu/share read `note.permissions`) and `['notes']` (the sidebar row menu reads each
    // note's `permissions`): the same role change leaves those stale too.
    if (noteGroupId !== null && state.role !== "none") {
      void queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      if (noteId) void queryClient.invalidateQueries({ queryKey: ["note", noteId] });
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    }
    // Toast only a real change to viewer: 'none' is the first half of revocation (the server then sends a REVOKED close), and toasting it would show a contradictory "now viewer" then "access lost".
    if (state.role === "viewer" && canEdit(previous)) {
      toast({ title: t("note.downgradedToViewer") });
    } else if (canEdit(state.role) && !canEdit(previous)) {
      toast({ title: t("note.restoredEditAccess") });
    }
  }, [noteGroupId, noteId, provider, queryClient, state, t]);

  // Loading/error/not-ready always render a placeholder body card without header/footer slots (headerSlot only exists once NoteEditor mounts). The extra `flex min-h-0 flex-1` body row is shared with the real NoteEditor branch (mutually exclusive); other callers put the card directly in AppShell's main.
  // The card (`cardSurface overflow-y-auto`) shares its look with HomePage, NotePageFallback and NoteRouteErrorFallback.
  const placeholderCard = (content: ReactNode) => (
    <div className="flex min-h-0 flex-1">
      <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]")}>
        {/* The placeholder has no headerSlot (so no header sidebar button) (#115): below xl the static sidebar is hidden, and without this a stuck
            error state (note deleted, no permission) would be one red line with no way out on phones. */}
        <NarrowTopBar />
        {content}
      </div>
    </div>
  );

  const loadingCard = () => placeholderCard(<p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>);
  const errorText = (err: unknown) =>
    err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
  const errorCard = (err: unknown) =>
    placeholderCard(
      <p role="alert" className="p-6 text-sm text-destructive">
        {errorText(err)}
      </p>,
    );

  let body;
  if (needsResolve && inTrashId !== null) {
    // The in_trash card renders inside AppShell children (its "go to trash" needs the actions context). After a restore, refetch the resolve layer: success seeds as usual; if permanently deleted it falls to the invalid-link exit.
    body = placeholderCard(
      <InTrashCard
        noteId={inTrashId}
        onRestored={() => {
          // Card no longer on screen: set no focus flag and don't refetch (the resolve layer in this closure isn't the current note).
          if (shownInTrashIdRef.current !== inTrashId) return;
          focusTitleAfterRestoreRef.current = inTrashId;
          void resolveQuery.refetch();
        }}
      />,
    );
  } else if (needsResolve) {
    // Don't render the old note's NoteEditor/TitleInput/ShareDialog in a transition (gated to undefined above). A resolve-layer 404 also lands here: keep the placeholder while leavingRef navigates.
    body = resolveQuery.isError && !linkInvalid ? errorCard(resolveQuery.error) : loadingCard();
  } else if (noteQuery.isError) {
    // noteGone's exit is navigating: placeholder for this render.
    body = noteGone ? loadingCard() : errorCard(noteQuery.error);
  } else if (noteQuery.isPending || !note) {
    body = loadingCard();
  } else if (!doc || !provider || !user) {
    // useCollab sets the session synchronously in its mount effect, so this gap is one frame (barely visible); still render a placeholder rather than flash blank.
    body = placeholderCard(<p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>);
  } else {
    const role = effectiveRole(state, note);
    // canEdit by role only (ignores the connection): for REST operations like title and share. Outdated (stale tab gate, #269) and terminal
    // states are read-only too: editor, title, versions and the presentation edit entry.
    const roleCanEdit = !stopsReconnect(state) && canEdit(role);
    // Y.Doc edits also require a first sync (#48): before it the local doc is empty and typed text would vanish on reload (no y-indexeddb). After the first sync `synced` stays true, so offline editing continues (merged back on reconnect) and the badge escalates.
    // The title is exempt: REST last-write-wins, not Yjs (see the `TitleInput` header), value from a successful `GET /api/notes/:ref`, so
    // renaming is safe and survives reload even when collab can't connect while REST works; gating it on synced would be a regression.
    const editable = roleCanEdit && synced;
    const presenceAvatars = (
      <PresenceAvatars provider={provider} connected={state.phase === "connected"} myUserId={user.id} scrollerRef={cursorScrollerRef} />
    );
    // `roleCanEdit` already folds in the connection and a stale tab; `canEditNoteTags` is what keeps edit shares out.
    const tagEntry =
      roleCanEdit && canEditNoteTags(note)
        ? {
            open: (options?: TagEntryOptions) => openTagEntry(note.id, options),
            applyHash: (input: HashTagBatchInput) => applyHashTags({ queryClient, note, t }, input),
            currentTagNames: () => currentNoteTagNames(queryClient, note.id),
            notifyOverLimit: (max: number) => void import("@/components/tags/hash-tag-batch").then((m) => m.notifyHashTagOverLimit(t, max)),
          }
        : undefined;
    const noteMenu = (
      <NoteMenu
        note={note}
        // The tag row is hidden along with the editor while a version is previewed, so there is nothing to focus.
        onAddTag={tagEntry && versions.preview === null ? () => tagEntry.open({ returnFocus: () => noteMenuTriggerRef.current?.focus() }) : undefined}
        state={state}
        leavingRef={leavingRef}
        onOpenEdits={openEdits}
        triggerRef={noteMenuTriggerRef}
        widthItems={(control) => <NoteWidthMenuItems noteId={note.id} {...control} />}
        onOpenComments={comments.enabled ? () => comments.open() : undefined}
      />
    );
    body = (
      <VersionsProvider value={versions}>
      <CommentsProvider value={comments}>
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex min-h-0 flex-1"
            onFocus={(event) => setEditingFocus(isEditingTarget(event.target))}
            onBlur={(event) => setEditingFocus(isEditingTarget(event.relatedTarget))}
          >
            <NoteEditor
              doc={doc}
              provider={provider}
              editable={editable}
              mobileToolbar={phone && editable && editingFocus}
              fabClearance={phone && !(editable && editingFocus)}
              user={{ id: user.id, name: user.displayName }}
              noteId={noteId!}
              onScrollRoot={setAnchorRoot}
              onCursorScroller={handleCursorScroller}
              notePath={canonicalNotePath(note)}
              noteMaxBytes={noteMaxBytes}
              precheckCtx={precheckCtx}
              // When focus isn't in the editor, page-level Ctrl+Z also undoes this note (#430); not while presenting.
              pageUndoShortcut={!presenting}
              headerSlot={
                // The header spans the full card width (#115): a single-row header is itself the content row, title left, controls right;
                // `px-5` (20px) lines up with the body's left edge below md. Don't put the article column back on the header;
                // ui/article-column.guard.test.ts (d) and (e) pin both.
                <>
                  {state.phase === "outdated" && <OutdatedClientBanner />}
                  {overLimit && (
                    <p role="status" className="border-b border-border bg-muted px-5 py-2 text-sm">
                      {t("note.overSizeLimit")}
                    </p>
                  )}
                  {/* The header is itself a container, so container queries can't size its own gap: phone gap uses viewport width (max-sm). */}
                  <header
                    ref={noteHeaderRef}
                    className={
                      phone
                        ? "@container flex flex-col border-b border-border px-5 pt-3 pb-1"
                        : "@container flex items-center gap-3 max-sm:gap-2 border-b border-border px-5 py-3"
                    }
                  >
                    {/* Narrow-width entry points (#115; phone back button to the list, floating sidebar button below xl), each rendered only at its own width. The loaded state has no NarrowTopBar since this header has both; placeholder cards have no header, so they carry it. */}
                    {phone ? (
                      <>
                        {/* Phone: title and its sub-row are one block, and the buttons center on the whole block. Connection state, presence and last-edited render only here (not hidden by CSS elsewhere). */}
                        <div data-testid="note-header-title-row" className="flex items-center gap-2">
                          <BackToListButton />
                          <div data-testid="note-header-block" className="flex min-w-0 flex-1 flex-col">
                            <TitleInput note={note} readOnly={!roleCanEdit} isNavigatingAway={isNavigatingAway} />
                            <div data-testid="note-header-subline" className="flex items-center gap-2">
                              {/* Location first so its left edge aligns with the title; the connection dot follows the location text (when the path is too
                                  long only the path is truncated), and presence sits on the right. */}
                              <NoteLocation note={note} trailing={<ConnectionBadge state={state} synced={synced} canEdit={roleCanEdit} />} />
                              {presenceAvatars}
                              <LastEditedLabel note={note} onOpenEdits={openEdits} />
                            </div>
                          </div>
                          <FavoriteToggle note={note} />
                          <ShareDialog note={note} />
                          {noteMenu}
                        </div>
                      </>
                    ) : (
                      <>
                        <BackToListButton />
                        <SidebarDrawerButton />
                        <TitleInput note={note} readOnly={!roleCanEdit} isNavigatingAway={isNavigatingAway} />
                        <ConnectionBadge state={state} synced={synced} canEdit={roleCanEdit} />
                        {presenceAvatars}
                        <LastEditedLabel note={note} onOpenEdits={openEdits} />
                        <FavoriteToggle note={note} />
                        <ShareDialog note={note} />
                        {/* Width icon only when the header is wide enough (#297; @container, see NoteWidthToggle). */}
                        <NoteWidthToggle noteId={noteId!} />
                        {noteMenu}
                      </>
                    )}
                  </header>
                  {/* Version preview banner below the header in wide preview; sheet mode draws its own. */}
                  {versions.preview !== null && versions.mode !== "sheet" && (
                    <VersionsLazyBoundary noteId={noteId ?? null} errorClassName={VERSIONS_ERROR_FRAME.inline}>
                      <PreviewBanner />
                    </VersionsLazyBoundary>
                  )}
                </>
              }
              contentTopSlot={<NoteTagRow key={note.id} note={note} canEdit={tagEntry !== undefined} />}
              tagEntry={tagEntry}
              footerSlot={<BacklinksSection noteId={noteId} />}
              previewSlot={
                versions.preview !== null && versions.mode !== "sheet" ? (
                  <VersionsLazyBoundary
                    noteId={noteId ?? null}
                    errorClassName={VERSIONS_ERROR_FRAME.inline}
                    fallback={<p className="p-6 text-sm text-muted-foreground">{t("versions.preview.loading")}</p>}
                  >
                    <VersionPreview doc={doc} />
                  </VersionsLazyBoundary>
                ) : undefined
              }
            />
            {/* Outside the header: its state lives on this page, shared by both triggers. */}
            <AiEditsDialog note={note} open={editsOpen} onOpenChange={setEditsOpen} />
            {/* Narrow-width full page. It always opens before the dialog (a modal dialog blocks the menu), and both are z-50 portals to body with the later mount on top, so the dialog always overlays the page.
                As the editor's sibling it is outside the editor's field settings, and the cards in its preview need their own. */}
            {versions.mode === "sheet" && (
              <KnowledgeFieldsProvider noteId={noteId!}>
                <VersionsLazyBoundary noteId={noteId ?? null} errorClassName={VERSIONS_ERROR_FRAME.floating}>
                  <VersionsSheet doc={doc} lastEdited={note.lastEdited} returnFocusRef={noteMenuTriggerRef} />
                </VersionsLazyBoundary>
              </KnowledgeFieldsProvider>
            )}
            {versions.dialog !== null && (
              <VersionsLazyBoundary noteId={noteId ?? null} errorClassName={VERSIONS_ERROR_FRAME.floating}>
                <VersionsDialogs returnFocusRef={noteMenuTriggerRef} />
              </VersionsLazyBoundary>
            )}
            {comments.mode === "sheet" && (
              <CommentsLazyBoundary noteId={noteId ?? null} errorClassName={VERSIONS_ERROR_FRAME.floating}>
                <CommentsSheet doc={doc} returnFocusRef={noteMenuTriggerRef} />
              </CommentsLazyBoundary>
            )}
          </div>
          {phone && !(editable && editingFocus) && <NoteBrowseBar note={note} />}
        </div>
      </CommentsProvider>
      </VersionsProvider>
    );
  }

  // The shell mounts whenever presenting (not once leavingRef is set). The overlay needs resident data, doc/provider and the first synced, and deliberately ignores the body branch, so a transient resident error doesn't affect it. Resolve-layer `in_trash` shows `errors.in_trash` (same as no permission).
  const presentFailure: unknown = needsResolve
    ? resolveQuery.isError && !linkInvalid
      ? resolveQuery.error
      : null
    : noteQuery.isError && !noteQuery.data && !noteGone
      ? noteQuery.error
      : null;
  const overlayReady = !needsResolve && note !== undefined && doc !== null && provider !== null && synced;
  const presentStatus: PresentationShellStatus = presentFailure !== null ? "error" : overlayReady ? "ready" : "loading";
  const presentRoleCanEdit = note ? !stopsReconnect(state) && canEdit(effectiveRole(state, note)) : false;
  const shellMounted = presenting && !leavingRef.current;

  return (
    <NotePageControlsContext.Provider value={controls}>
      <BlockAnchorContext.Provider value={blockAnchor}>
        {body}
        {/* Mounted on body: NotePage sits inside the sidebar shell, which is inert while presenting. */}
        {shellMounted &&
          createPortal(
            <PresentationShell
              title={note?.title ?? ""}
              status={presentStatus}
              errorMessage={presentFailure !== null ? errorText(presentFailure) : undefined}
              toolbarExtra={
                note && (state.phase !== "connected" || !synced) ? (
                  <ConnectionBadge state={state} synced={synced} canEdit={presentRoleCanEdit} />
                ) : null
              }
            >
              {overlayReady && doc !== null && note !== undefined && (
                <LazyRouteErrorBoundary resetKey={paramsKey} chunk="present" frame="inline">
                  <Suspense fallback={<LazyRouteLoading frame="inline" />}>
                    <LazyPresentation variant="member" doc={doc} title={note.title} />
                    <ChunkLoadBeacon chunk="present" />
                  </Suspense>
                </LazyRouteErrorBoundary>
              )}
            </PresentationShell>,
            document.body,
          )}
      </BlockAnchorContext.Provider>
    </NotePageControlsContext.Provider>
  );
}
