import { SAFE_FRAME_PADDING } from "@/components/ui/safe-area";
import { lazy, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { NavigationType, useLocation, useNavigate, useNavigationType } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { canonicalNotePath, type FolderDto } from "@knotebook/shared";
import { FOLDERS_QUERY_KEY, folderErrorMessage, invalidateFolderRelated, isFolderNotFound } from "@/api/folders";
import { useCreateNote } from "@/api/notes";
import { expandFolderChain, indexFolders } from "@/components/sidebar/folder-index";
import { Button } from "@/components/ui/button";
import { FIELD_ICON_HIT, HEADER_ICON_HIT } from "@/components/ui/hit-area";
import { TagSearchInput } from "@/components/sidebar/TagSearchInput";
import { PanelLeft, X } from "@/components/ui/icons";
import { toast, toastViewportHostRef } from "@/components/ui/toast";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { OVERLAY_QUERY, isPhone, useIsPhone } from "@/lib/layout-tiers";
import { PhoneBrowseContext, PhoneListContext, isNoteRoutePath } from "@/lib/phone-list";
import { backTarget, clearListIdx, historyIdx, readListIdx, recordListIdx } from "@/lib/phone-nav";
import { PHONE_PAGE_SCROLL_ATTR, ROOT_FLAGS, useRootFlag } from "@/lib/page-scroll";
import { createPhoneScrollMemory, enterPhoneScreen, phoneScreenKey, rememberPhoneScroll, type PhoneScreen } from "@/lib/phone-scroll";
import { SidebarDrawerContext, useSidebarDrawer } from "@/lib/sidebar-drawer";
import { canonicalizedFrom, useRealNavigationType } from "@/lib/real-location";
import { isMacPlatform } from "@/lib/platform";
import { ShortcutsDialogContext, type ShortcutsDialogApi, type ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { isOverlayOpen } from "@/lib/versions-context";
import { openSettings } from "@/lib/open-settings";
import { SIDEBAR_SELECT_BUTTON } from "@/lib/sidebar-selection";
import { useSession } from "@/auth/useSession";
import { SidebarQueryContext, useSidebarQuery } from "@/lib/sidebar-query";
import { DEFAULT_SIDEBAR_TAB, SidebarTabProvider, useSidebarTabActions, useSidebarTabState, type SidebarTabActions } from "@/lib/sidebar-tab";
import { registerShellControls } from "@/lib/tour-bridge";
import { NoteList } from "@/components/NoteList";
import { SearchResults } from "@/components/sidebar/SearchResults";
import { clearSearchMark } from "@/hooks/search-mark";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import { PhoneListBar } from "@/components/sidebar/PhoneListBar";
import { PhoneListFabs } from "@/components/sidebar/PhoneListFabs";
import { PHONE_LIST_HEADER_STICKY, PHONE_LIST_SCROLLER, PHONE_TOP_BAR_STICKY } from "@/components/sidebar/phone-bar";
import { SidebarTabList, sidebarPanelId, sidebarTabId } from "@/components/sidebar/SidebarTabList";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { UserMenu } from "@/components/UserMenu";
import { ShortcutsDialog } from "@/components/shortcuts/ShortcutsDialog";
import { AvatarDisplayFiller } from "@/avatars/AvatarDisplayFiller";
import { useCardPage } from "@/theme";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
  readSidebarWidth,
  writeSidebarWidth,
} from "@/components/sidebar-width";
import { PaneResizeHandle } from "@/components/PaneResizeHandle";
import { tourTarget } from "@/lib/tour-targets";

const TrashPanel = lazy(() => import("@/components/sidebar/TrashLazy").then((m) => ({ default: m.TrashPanel })));

function TrashPanelFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex items-center gap-0.5 px-2 pt-3 pb-1", PHONE_LIST_HEADER_STICKY)}>
        <span className="flex h-6 min-w-0 flex-1 items-center px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
          <span className="truncate">{t("sidebar.trash")}</span>
        </span>
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-2", PHONE_LIST_SCROLLER)}>
        <p className="p-2 text-sm text-muted-foreground">{t("app.loading")}</p>
      </div>
    </div>
  );
}



export function SidebarDrawerButton() {
  const { t } = useTranslation();
  const { setOpen } = useSidebarDrawer();
  const phone = useIsPhone();
  if (phone) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("sidebar.openDrawer")}
      {...tourTarget("drawerButton")}
      onClick={() => setOpen(true)}
      className={cn("h-8 w-8 shrink-0 xl:hidden", HEADER_ICON_HIT)}
    >
      <PanelLeft aria-hidden="true" className="h-4 w-4" />
    </Button>
  );
}

interface SidebarContentProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Text and tag tokens together; Escape, the clear button and Cancel use it. */
  onClearSearch: () => void;
  /** Each instance needs its own ref object: a shared one is cleared to null when the drawer unmounts and Ctrl+K silently dies. */
  searchRef: RefObject<HTMLInputElement | null>;
  onCreateNote: (groupId?: string, folderId?: string) => void;
  newNotePending: boolean;
  shortcutBadge: string;
  layout?: "classic" | "phone";
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /** Called on a tab change in the phone layout only (not on first mount): phone documents scroll, so a new tab list must start at top. */
  onPhoneTabChange?: () => void;
}

/** Both wrappers must provide a `flex flex-col` context or the list `min-h-0 flex-1 overflow-y-auto` loses its constraint. */
function SidebarContent({
  query,
  onQueryChange,
  onClearSearch,
  searchRef,
  onCreateNote,
  newNotePending,
  shortcutBadge,
  layout = "classic",
  searchOpen = false,
  onSearchOpenChange,
  onPhoneTabChange,
}: SidebarContentProps) {
  const { t } = useTranslation();
  // separate `useId` per instance so tab/tabpanel ids do not collide
  const idBase = useId();
  const { tab, selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  // Whitespace-only counts as searching (deliberate).
  const { tagTokens, setTagTokens } = useSidebarQuery();
  const searching = query.length > 0 || tagTokens.length > 0;
  const phoneLayout = layout === "phone";
  const searchLayer = phoneLayout && searchOpen;
  const showSearchView = phoneLayout ? searchLayer : searching;
  // both instances run it; idempotent
  useEffect(() => {
    if (searching) updateSelection({ type: "end" });
  }, [searching, updateSelection]);
  // layout effect: scroll before the new tab first paints, otherwise one frame of the new list is painted at the old position
  const seenTabRef = useRef(tab);
  useLayoutEffect(() => {
    if (seenTabRef.current === tab) return;
    seenTabRef.current = tab;
    if (phoneLayout) onPhoneTabChange?.();
  }, [tab, phoneLayout, onPhoneTabChange]);
  return (
    <>
      {phoneLayout ? (
        <div data-phone-top-bar="" className={cn("shrink-0 pt-[env(safe-area-inset-top)]", PHONE_TOP_BAR_STICKY)}>
          {/* edges align with list rows: title text and avatar visual right edge sit 16px from the screen edge (avatar 32 visual / 44 hit area, hence pr-2.5) */}
          <div className="flex h-12 items-center justify-between pl-4 pr-2.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="text-2xl font-bold italic text-brand"
                style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
              >
                K
              </span>
              <span className="text-sm font-semibold">Knotebook</span>
            </div>
            <UserMenu variant="avatar" />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 pt-3">
          <span
            aria-hidden="true"
            className="text-2xl font-bold italic text-brand"
            style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
          >
            K
          </span>
          <span className="text-sm font-semibold">Knotebook</span>
        </div>
      )}

      {!phoneLayout && (
      <TagSearchInput
        query={query}
        onQueryChange={onQueryChange}
        searchRef={searchRef}
        size="desktop"
        className="mx-2 mt-2"
        onEscape={(event) => {
          onClearSearch();
          event.currentTarget.blur();
        }}
        inputProps={{ "aria-label": t("sidebar.searchLabel"), placeholder: t("sidebar.searchPlaceholder"), ...tourTarget("search") }}
        trailing={
          query.length > 0 || tagTokens.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("sidebar.clearSearch")}
              title={t("sidebar.clearSearch")}
              className={cn("absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2", FIELD_ICON_HIT)}
              onClick={() => {
                onClearSearch();
                searchRef.current?.focus();
              }}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <kbd
              aria-hidden="true"
              className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 pointer-coarse:hidden rounded border border-border px-1 text-[10px] text-muted-foreground"
            >
              {shortcutBadge}
            </kbd>
          )
        }
      />
      )}

      {showSearchView ? (
        searching ? (
          <SearchResults query={query} tagTokens={tagTokens} onTagTokensChange={setTagTokens} />
        ) : (
          <p data-testid="phone-search-hint" className="px-4 py-6 text-sm text-muted-foreground">
            {t("sidebar.searchHint")}
          </p>
        )
      ) : (
        <>
          <SidebarTabList idBase={idBase} />

          <div
            role="tabpanel"
            id={sidebarPanelId(idBase)}
            aria-labelledby={sidebarTabId(idBase, tab)}
            // APG: Tab must be able to stop on a panel whose first content element is not focusable.
            tabIndex={0}
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {tab === "trash" ? (
              <SidebarLazyBoundary chunk="trash" fallback={<TrashPanelFallback />} errorClassName="p-3">
                <TrashPanel />
              </SidebarLazyBoundary>
            ) : (
              <NoteList onCreateNote={onCreateNote} createNotePending={newNotePending} />
            )}
          </div>
        </>
      )}

      {phoneLayout ? (
        <>
          {!searchLayer && <SidebarFooter phone searching={searching} onCreateNote={() => onCreateNote()} newNotePending={newNotePending} />}
          {searchLayer ? (
            <PhoneListBar
              query={query}
              onQueryChange={onQueryChange}
              onClearSearch={onClearSearch}
              searchRef={searchRef}
              onOpen={() => onSearchOpenChange?.(true)}
              onClose={() => onSearchOpenChange?.(false)}
            />
          ) : (
            !selection.active && (
              <PhoneListFabs
                onSearch={() => {
                  // Mount the search box (flushSync) and focus it within the same tap: iOS only shows the keyboard inside a user gesture.
                  flushSync(() => onSearchOpenChange?.(true));
                  searchRef.current?.focus();
                }}
                showNewNote={tab !== "trash"}
                onCreateNote={() => onCreateNote()}
                newNotePending={newNotePending}
              />
            )
          )}
        </>
      ) : (
        <>
          <SidebarFooter searching={searching} onCreateNote={() => onCreateNote()} newNotePending={newNotePending} />

          <div className="border-t border-border p-2">
            <UserMenu />
          </div>
        </>
      )}
    </>
  );
}

interface AppShellProps {
  children: ReactNode;
  inert?: boolean;
}

/**
 * Both the static card and the drawer are in the DOM while the drawer is open (static one `hidden`); jsdom has no CSS, so tests scope with `within(drawer)`.
 * Search state is owned above the sidebar (App-level `useSidebarQuery`) so Ctrl/Cmd+K can focus across components, `SearchResults` gets the query, and both search boxes show one value.
 * Ctrl/Cmd+K: `preventDefault` only when there is something to do (phone layout, narrow, or the static search box is mounted; on narrow the static box is `display:none`); gives up when any non-drawer `[role="dialog"]` is open (do not fight Radix focus trap; the ⋮ menu is `role="menu"` and still fires, and the menu closes: accepted). Strict `event.key === "k"` because Shift gives "K", which excludes Ctrl+Shift+K (pinned in `AppShell.test.tsx`). Yields when `event.defaultPrevented`: BlockNote create-link binds Ctrl/Cmd+K natively without stopPropagation, so without yielding its popup would never open.
 * Drawer is a direct Radix Dialog (the `ui/dialog.tsx` content hardcodes centring and a top-right X); the focus trap arms only once focus lands in the container (see `onOpenAutoFocus`). Esc in selection mode ends selection first and keeps the drawer open (see `onEscapeKeyDown`).
 * Sidebar width: `<aside style={{ width }}>`, 200-480 default 320 in localStorage (`sidebar-width.ts`); 200 keeps ~3 CJK characters in group rows; 480 is not viewport-relative (a narrow window gets squeezed; double-click on the handle resets to 320). The handle is an `absolute left-full w-3` child overlapping the root `gap-3`, so gap and `main` are untouched; it disappears with the `hidden` aside below `xl`. The drawer uses the same width (4rem cap is insurance).
 */
export function AppShell({ children, inert }: AppShellProps) {
  const { t } = useTranslation();
  useCardPage();
  const navigate = useNavigate();
  const location = useLocation();
  const createNote = useCreateNote();
  const queryClient = useQueryClient();
  // Lives at App level so the search text survives shell remounts.
  const sidebarQuery = useSidebarQuery();
  const { query, setQuery, clearSearch, claim } = sidebarQuery;
  const { user: sessionUser } = useSession();
  const sessionUserId = sessionUser?.id;
  useEffect(() => {
    if (sessionUserId !== undefined) claim(sessionUserId); // a different user signed in: clear the previous user's search text
  }, [sessionUserId, claim]);
  // Clear the search-jump marker only on the non-empty to empty transition (a remount starts from the current text); closing the drawer on narrow screens is not closing the search.
  const prevQueryRef = useRef(query);
  useEffect(() => {
    if (prevQueryRef.current !== "" && query === "") clearSearchMark();
    prevQueryRef.current = query;
  }, [query]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const handleSidebarWidth = (px: number, commit: boolean) => {
    setSidebarWidth(px);
    if (commit) writeSidebarWidth(px);
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Different object from `searchInputRef`. */
  const drawerSearchRef = useRef<HTMLInputElement>(null);
  const drawerContentRef = useRef<HTMLDivElement>(null);
  /** Dialog has no Trigger: return focus by hand. */
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  /** A sidebar-button open must not focus the search box (touch keyboard would cover half the drawer). */
  const openedByShortcutRef = useRef(false);
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  const tabActionsRef = useRef<SidebarTabActions | null>(null);

  // Read via ref: the child `SidebarTabProvider` writes it during render. On a shell swap the last mounted registers; unmount withdraws only its own.
  useEffect(
    () =>
      registerShellControls({
        showTab: (tab, options) => tabActionsRef.current?.showTab(tab, options),
        endSelectionIfActive: () => tabActionsRef.current?.endSelectionIfActive() ?? false,
        closeDrawer: () => setDrawerOpen(false),
        getTab: () => tabActionsRef.current?.getTab() ?? DEFAULT_SIDEBAR_TAB,
      }),
    [],
  );

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutsPage, setShortcutsPage] = useState<ShortcutsStartPage>("global");
  const shortcutsOpenRef = useRef(shortcutsOpen);
  shortcutsOpenRef.current = shortcutsOpen;
  const shortcutsReturnFocusRef = useRef<HTMLElement | null>(null);
  const shortcutsReopenMenuRef = useRef<(() => void) | null>(null);
  const shortcutsApi = useMemo<ShortcutsDialogApi>(
    () => ({
      open: (returnFocusTo, page = "global", reopenMenu) => {
        shortcutsReturnFocusRef.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setShortcutsPage(page);
        shortcutsReopenMenuRef.current = reopenMenu ?? null;
        setShortcutsOpen(true);
      },
    }),
    [],
  );

  // Ctrl/Cmd+/: Shift is not excluded (`/` needs Shift on some layouts); `!alt` like NotePage Ctrl+S. With another dialog (the sidebar drawer excepted) or a menu open it gives up without preventDefault: Radix menu and Dialog share FocusScope (unlike Ctrl+K, where the menu still fires). Empty deps: the handler reads only refs and DOM.
  useEffect(() => {
    function handleShortcutsKey(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key !== "/") return;
      if (event.repeat || event.defaultPrevented) return;
      if (shortcutsOpenRef.current) {
        event.preventDefault();
        setShortcutsOpen(false);
        return;
      }
      if (isOverlayOpen()) return;
      event.preventDefault();
      shortcutsReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setShortcutsPage("global");
      setShortcutsOpen(true);
    }
    window.addEventListener("keydown", handleShortcutsKey);
    return () => window.removeEventListener("keydown", handleShortcutsKey);
  }, []);

  // Ctrl/Cmd+,: same guards as Ctrl+/ plus `!shift`, but no toggle: with any dialog or menu open (settings, the shortcuts dialog, the presentation layer) it does nothing. Opens via `openSettings`, the same path as the user-menu item. Mac Safari treats ⌘, as native Preferences, so the page may never receive it. The handler reads a ref because navigate/location change every render.
  const settingsRouteRef = useRef({ navigate, location });
  settingsRouteRef.current = { navigate, location };

  const phone = useIsPhone();
  const onList = !isNoteRoutePath(location.pathname);
  const listVisible = phone && onList;
  const backFromKeyRef = useRef<string | null>(null);
  const phoneState = useMemo(
    () => ({
      backToList: () => {
        const { navigate: go, location: here } = settingsRouteRef.current;
        if (!isNoteRoutePath(here.pathname)) return;
        // Rapid clicks: the second must not step back again before popstate arrives.
        if (backFromKeyRef.current === here.key) return;
        backFromKeyRef.current = here.key;
        // If the list entry is still in history go back to it (system back and ‹ share one history); otherwise replace this entry with the list instead of adding one, so back does not return to the note just left.
        const target = backTarget({ listIdx: readListIdx(), currentIdx: historyIdx() });
        if (target.kind === "go") go(target.delta);
        else go("/", { replace: true });
      },
    }),
    [],
  );
  // Blur does not close the search layer (tapping a result or dismissing the keyboard blurs).
  const [phoneSearchOpen, setPhoneSearchOpen] = useState(false);
  const searchOpen = phone && phoneSearchOpen;
  const asideShown = onList || searchOpen;
  const asideShownRef = useRef(asideShown);
  asideShownRef.current = asideShown;
  useRootFlag(ROOT_FLAGS.pageScroll, true);
  useRootFlag(ROOT_FLAGS.listShown, asideShown);
  // layout effect: restore before first paint; remove the old listener synchronously so a clamped scroll is not recorded as the old position. Browser scroll restoration is off so it does not scroll first on back.
  const phoneScreen: PhoneScreen | null = !phone ? null : searchOpen ? { kind: "search" } : onList ? { kind: "list" } : { kind: "note", path: location.pathname };
  const phoneScreenNowRef = useRef(phoneScreen);
  phoneScreenNowRef.current = phoneScreen;
  const phoneScreenRef = useRef<PhoneScreen | null>(null);
  const scrollMemoryRef = useRef(createPhoneScrollMemory());
  const screenKey = phoneScreenKey(phoneScreen);
  useLayoutEffect(() => {
    const prev = phoneScreenRef.current;
    const next = phoneScreenNowRef.current;
    phoneScreenRef.current = next;
    if (next === null) return;
    const memory = scrollMemoryRef.current;
    const target = enterPhoneScreen(memory, prev, next, canonicalizedFrom(settingsRouteRef.current.location.state) ?? null);
    if (target !== null) window.scrollTo(0, target);
    // Right after crossing 640 the document is clamped to 0 and fires scroll: not a user position (handled by `useTierScrollAnchor`).
    const record = () => {
      if (isPhone()) rememberPhoneScroll(memory, next, window.scrollY);
    };
    record();
    window.addEventListener("scroll", record, { passive: true });
    return () => window.removeEventListener("scroll", record);
  }, [screenKey]);
  useEffect(() => {
    if (!("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);
  const handlePhoneTabChange = () => {
    scrollMemoryRef.current.list = 0;
    if (phoneScreenNowRef.current?.kind === "list") window.scrollTo(0, 0);
  };
  useEffect(() => {
    backFromKeyRef.current = null;
    if (listVisible) {
      recordListIdx();
      return;
    }
    const recorded = readListIdx();
    const current = historyIdx();
    if (recorded !== null && current !== null && current <= recorded) clearListIdx();
  }, [listVisible, location.key]);
  // Only a PUSH from the list plays the slide: deep links, reloads and back/forward do not.
  const realNavigationType = useRealNavigationType();
  const localNavigationType = useNavigationType();
  const navigationType = realNavigationType ?? localNavigationType;
  const wasOnListRef = useRef(onList);
  const [enterNote, setEnterNote] = useState(false);
  // layout effect: the class must be set before first paint.
  useLayoutEffect(() => {
    setEnterNote(phone && !onList && wasOnListRef.current && navigationType === NavigationType.Push);
    wasOnListRef.current = onList;
  }, [phone, onList, location.key, navigationType]);
  // Give focus back to the tapped row (the list was display:none), else the tabpanel.
  const lastRowHrefRef = useRef<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const wasOnListForFocusRef = useRef(onList);
  useEffect(() => {
    const returned = phone && onList && !wasOnListForFocusRef.current;
    wasOnListForFocusRef.current = onList;
    const root = asideRef.current;
    if (!returned || root === null || isOverlayOpen()) return;
    const href = lastRowHrefRef.current;
    const row = href === null ? null : [...root.querySelectorAll<HTMLElement>("a[href]")].find((a) => a.getAttribute("href") === href);
    (row ?? root.querySelector<HTMLElement>('[role="tabpanel"]'))?.focus({ preventScroll: true });
  }, [phone, onList]);
  const pendingSearchFocusRef = useRef(false);
  useEffect(() => {
    if (phone) return;
    setPhoneSearchOpen(false);
    pendingSearchFocusRef.current = false;
  }, [phone]);
  // Close the search layer and blur its input on every navigation (`location.key` change, including tapping the current note or system back), except a same-note canonical convergence (#179). The Ctrl+K note-to-list flow reopens and focuses the layer in later effects, so this effect must stay above them.
  const searchSeenRef = useRef({ key: location.key, pathname: location.pathname });
  useEffect(() => {
    const seen = searchSeenRef.current;
    if (seen.key === location.key) return;
    searchSeenRef.current = { key: location.key, pathname: location.pathname };
    if (canonicalizedFrom(location.state) === seen.pathname) return;
    searchInputRef.current?.blur();
    setPhoneSearchOpen(false);
  }, [location.key, location.pathname, location.state]);
  const searchOpenedKeyRef = useRef<string | null>(null);
  const wasSearchOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasSearchOpenRef.current;
    wasSearchOpenRef.current = searchOpen;
    if (searchOpen) {
      if (!wasOpen) searchOpenedKeyRef.current = location.key;
      return;
    }
    if (!wasOpen || searchOpenedKeyRef.current !== location.key) return;
    if (onList) {
      asideRef.current?.querySelector<HTMLElement>('[data-phone-fab="search"]')?.focus({ preventScroll: true });
      return;
    }
    document.querySelector<HTMLElement>('[data-phone-fab-slot] [data-phone-fab="search"]')?.focus({ preventScroll: true });
  }, [searchOpen, onList, location.key]);
  const focusSearchWhenOpenRef = useRef(false);
  useEffect(() => {
    if (!listVisible || !pendingSearchFocusRef.current) return;
    pendingSearchFocusRef.current = false;
    focusSearchWhenOpenRef.current = true;
    setPhoneSearchOpen(true);
  }, [listVisible]);
  useEffect(() => {
    if (!searchOpen || !focusSearchWhenOpenRef.current) return;
    focusSearchWhenOpenRef.current = false;
    searchInputRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    function handleSettingsKey(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== ",") return;
      if (event.repeat || event.defaultPrevented) return;
      if (isOverlayOpen()) return;
      event.preventDefault();
      openSettings(settingsRouteRef.current.navigate, settingsRouteRef.current.location);
    }
    window.addEventListener("keydown", handleSettingsKey);
    return () => window.removeEventListener("keydown", handleSettingsKey);
  }, []);

  // deps only `phoneState`: the handler reads stable refs
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "k") return;
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]:not([data-sidebar-drawer])')) return;
      if (isPhone()) {
        event.preventDefault();
        // Search box mounts only while the layer is open: end selection and open it first, then focus.
        if (asideShownRef.current) {
          flushSync(() => {
            tabActionsRef.current?.endSelectionIfActive();
            setPhoneSearchOpen(true);
          });
          searchInputRef.current?.focus();
        } else {
          tabActionsRef.current?.endSelectionIfActive();
          pendingSearchFocusRef.current = true;
          phoneState.backToList();
        }
      } else if (window.matchMedia(OVERLAY_QUERY).matches) {
        event.preventDefault();
        if (!drawerOpenRef.current) {
          openedByShortcutRef.current = true;
          setDrawerOpen(true);
        } else {
          // Already open: Ctrl+K means focus search, so move focus into the drawer search box (when opened by the sidebar button, focus is on the Content container, not the search box).
          drawerSearchRef.current?.focus();
        }
      } else if (searchInputRef.current) {
        event.preventDefault();
        searchInputRef.current.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [phoneState]);

  // #179: a canonical convergence of the same note changes pathname but must not close the drawer; it is recognised by the new entry `canonicalizedFrom` equalling the previous pathname (only that step).
  const previousPathnameRef = useRef(location.pathname);
  useEffect(() => {
    const previous = previousPathnameRef.current;
    previousPathnameRef.current = location.pathname;
    if (previous === location.pathname) return;
    if (canonicalizedFrom(location.state) === previous) return;
    setDrawerOpen(false);
  }, [location.pathname, location.state]);

  // Clear the flag if the drawer closed before `onOpenAutoFocus` consumed it, otherwise the next sidebar-button open wrongly focuses the search box.
  useEffect(() => {
    if (!drawerOpen) openedByShortcutRef.current = false;
  }, [drawerOpen]);

  // The phone list is the full-bleed sidebar and must not be covered by the drawer.
  useEffect(() => {
    if (phone) setDrawerOpen(false);
  }, [phone]);

  // jsdom matchMedia stub addEventListener is a no-op, so the test dispatches change by hand (AppShell.test).
  useEffect(() => {
    // Close the drawer when the viewport crosses into the wide tier; otherwise the static sidebar and the drawer would show together under a full-screen overlay.
    const mql = window.matchMedia(OVERLAY_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setDrawerOpen(false);
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  /** `groupId` for the group "+" (#103; the server defaults the creator to editor); a group folder sends both `groupId` and `folderId`; each goes into the body only when given. On success the folder chain is expanded. Every failure toasts (incl. group_not_found); folder errors carry `max`; `folder_not_found` refetches folders. */
  async function handleNewNote(groupId?: string, folderId?: string): Promise<void> {
    const body = {
      ...(groupId === undefined ? {} : { groupId }),
      ...(folderId === undefined ? {} : { folderId }),
    };
    try {
      const note = await createNote.mutateAsync(groupId === undefined && folderId === undefined ? undefined : body);
      if (folderId !== undefined) expandFolderChain(indexFolders(queryClient.getQueryData<FolderDto[]>(FOLDERS_QUERY_KEY) ?? []), folderId);
      navigate(canonicalNotePath(note));
    } catch (err) {
      if (isFolderNotFound(err)) invalidateFolderRelated(queryClient);
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    }
  }

  const shortcutBadge = isMacPlatform() ? "⌘K" : "Ctrl K";

  // For the floating buttons on the note page: open the search layer (end selection first so the box can mount) and create a note. Creation goes through a ref; the object changes only when the search layer opens or closes.
  const handleNewNoteRef = useRef(handleNewNote);
  handleNewNoteRef.current = handleNewNote;
  // Portalled slot outside the main area: the main area slides, and a fixed button inside it would be positioned against the whole note.
  const [fabSlot, setFabSlot] = useState<HTMLElement | null>(null);
  const browseState = useMemo(
    () => ({
      openSearch: () => {
        flushSync(() => {
          tabActionsRef.current?.endSelectionIfActive();
          setPhoneSearchOpen(true);
        });
        searchInputRef.current?.focus();
      },
      createNote: (groupId?: string, folderId?: string) => handleNewNoteRef.current(groupId, folderId),
      searchOpen: phoneSearchOpen,
      fabSlot,
    }),
    [phoneSearchOpen, fabSlot],
  );

  const sidebarProps = {
    query,
    onQueryChange: setQuery,
    onClearSearch: clearSearch,
    onCreateNote: (groupId?: string, folderId?: string) => void handleNewNote(groupId, folderId),
    newNotePending: createNote.isPending,
    shortcutBadge,
  };

  return (
    // `h-dvh` + `overflow-hidden` lock the viewport (100vh is taller than the visible area when the mobile address bar shows); `min-h-screen` would let long content grow `main` and force document scroll so card `overflow-y-auto` never clips. `min-w-0` on `main` is explicit (no overflow, so the width chain relies on it). Phones invert this: the document scrolls (Safari only collapses its toolbar then, and content scrolls behind the translucent bottom bar), `overflow-x-clip` not `hidden` (hidden would make the vertical axis a scroll container and break sticky headers; clip also prevents horizontal scroll from the slide-in).
    <SidebarQueryContext.Provider value={sidebarQuery}>
    <SidebarDrawerContext.Provider value={{ setOpen: setDrawerOpen }}>
      <PhoneListContext.Provider value={phoneState}>
      <PhoneBrowseContext.Provider value={browseState}>
      <ShortcutsDialogContext.Provider value={shortcutsApi}>
        <SidebarTabProvider actionsRef={tabActionsRef}>
          {/* phone: content hugs the screen edge; safe area comes from the edge elements (note header top, floating buttons bottom, `main` left/right) */}
          <div
            inert={inert}
            {...{ [PHONE_PAGE_SCROLL_ATTR]: "" }}
            className={cn(
              "flex h-dvh gap-3 overflow-hidden bg-background max-sm:h-auto max-sm:overflow-x-clip max-sm:overflow-y-visible max-sm:bg-card max-sm:p-0",
              SAFE_FRAME_PADDING,
            )}
          >
            {/* SidebarContent returns a fragment; the Trash action bar finds the Select button of the same instance through this attribute */}
            <aside
              ref={asideRef}
              onClickCapture={(event) => {
                if (phone && event.target instanceof Element) lastRowHrefRef.current = event.target.closest("a[href]")?.getAttribute("href") ?? null;
              }}
              data-sidebar-instance=""
              // `index.css` uses this to block pull-to-refresh
              data-phone-list-shown={asideShown ? "" : undefined}
              className={cn(
                cardSurface,
                "relative hidden shrink-0 xl:flex xl:flex-col",
                // At least one viewport tall so bottom bars sit at the viewport bottom; `svh` (not dvh) so the height does not change with toolbar expansion and cause scroll jumps
                asideShown && "max-sm:flex max-sm:min-h-svh max-sm:w-full max-sm:flex-col max-sm:rounded-none max-sm:border-0",
                asideShown && "max-sm:pl-[env(safe-area-inset-left)] max-sm:pr-[env(safe-area-inset-right)]",
              )}
              style={phone ? undefined : { width: sidebarWidth }}
              inert={phone && !asideShown}
            >
              <SidebarContent
                {...sidebarProps}
                searchRef={searchInputRef}
                layout={phone ? "phone" : "classic"}
                searchOpen={searchOpen}
                onSearchOpenChange={setPhoneSearchOpen}
                onPhoneTabChange={handlePhoneTabChange}
              />
              {!phone && (
                <PaneResizeHandle
                  width={sidebarWidth}
                  onChange={handleSidebarWidth}
                  min={SIDEBAR_WIDTH_MIN}
                  max={SIDEBAR_WIDTH_MAX}
                  defaultWidth={SIDEBAR_WIDTH_DEFAULT}
                  step={SIDEBAR_WIDTH_STEP}
                  edge="right"
                  label={t("sidebar.resize")}
                  placementClassName="left-full"
                />
              )}
            </aside>

            <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
                <DialogPrimitive.Content
                  ref={drawerContentRef}
                  data-sidebar-drawer=""
                  data-sidebar-instance=""
                  // Background and flex-col are both required (overlay black shows through; list loses its constraint). No cardSurface rounding: the drawer is not a card.
                  className="fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-card pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] outline-none"
                  // The 4rem cap is insurance (the drawer only exists from 640px and width is at most 480) so the note area stays tappable to close; the drawer has no resize handle.
                  style={{ width: `min(${sidebarWidth}px, calc(100vw - 4rem))` }}
                  // In selection mode this handler ends selection and keeps the drawer open. Radix handles Esc first in capture, so React's `onKeyDown` never runs (the checkboxes have already unmounted): move focus to the drawer Select button here (flushSync so it exists in this task).
                  onEscapeKeyDown={(event) => {
                    // The completion list closes on this same Esc (the search box handles it next); the drawer stays.
                    if (event.target instanceof Element && event.target.closest('[role="combobox"][aria-expanded="true"]') !== null) {
                      event.preventDefault();
                      return;
                    }
                    let ended = false;
                    flushSync(() => {
                      ended = tabActionsRef.current?.endSelectionIfActive() ?? false;
                    });
                    if (!ended) return;
                    event.preventDefault();
                    drawerContentRef.current?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
                  }}
                  onCloseAutoFocus={(event) => {
                    const opener = drawerOpenerRef.current;
                    drawerOpenerRef.current = null;
                    if (opener?.isConnected !== true) return;
                    event.preventDefault();
                    opener.focus({ preventScroll: true });
                  }}
                  onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    drawerOpenerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
                    if (openedByShortcutRef.current && drawerSearchRef.current) {
                      drawerSearchRef.current.focus();
                      openedByShortcutRef.current = false;
                    } else {
                      openedByShortcutRef.current = false;
                      // preventDefault: Radix would focus the search box (touch keyboard). Focus must still land in the drawer or its focus trap never arms and Tab escapes into the aria-hidden background.
                      drawerContentRef.current?.focus();
                    }
                  }}
                >
                  {/* without a Title the dialog has no accessible name, and the pinned Radix gives no console warning */}
                  <DialogPrimitive.Title className="sr-only">{t("sidebar.drawerTitle")}</DialogPrimitive.Title>
                  <SidebarContent {...sidebarProps} searchRef={drawerSearchRef} />
                  {/* toast viewport moves into the drawer: everything outside is aria-hidden and focus is trapped; it is fixed-positioned, so the drawer content must not get transform/filter; z-50 portalled layers may cover the toast (accepted) */}
                  <div ref={toastViewportHostRef} />
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>

            {/* hidden while the list or search layer is shown (not unmounted): only one of list or main may grow the scrolling document, and on Cancel the scroll memory restores the position */}
            <main
              inert={searchOpen && !onList}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col max-sm:pl-[env(safe-area-inset-left)] max-sm:pr-[env(safe-area-inset-right)]",
                asideShown && "max-sm:hidden",
                enterNote && "kb-phone-enter",
              )}
            >
              {children}
            </main>
          </div>
          {/* outside the frame so the wrapper is not a flex item eating the gap; inert in presentation like the frame */}
          <div ref={setFabSlot} data-phone-fab-slot="" inert={inert} />
          {/* it portals to body anyway; kept outside the inert div so readers needn't reason about inert */}
          <ShortcutsDialog
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
            returnFocusRef={shortcutsReturnFocusRef}
            reopenMenuRef={shortcutsReopenMenuRef}
            page={shortcutsPage}
          />
          <AvatarDisplayFiller />
        </SidebarTabProvider>
      </ShortcutsDialogContext.Provider>
      </PhoneBrowseContext.Provider>
      </PhoneListContext.Provider>
    </SidebarDrawerContext.Provider>
    </SidebarQueryContext.Provider>
  );
}
