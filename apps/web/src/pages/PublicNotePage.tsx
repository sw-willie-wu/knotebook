import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { PublicLinkDto, PublicNoteDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { decodePublicYdoc } from "@/collab/public-doc";
import { PublicNoteEditor } from "@/components/PublicNoteEditor";
import { HeadingAnchorButtons } from "@/components/editor/HeadingAnchorButtons";
import { NoteOutline } from "@/components/outline/NoteOutline";
import { canPinOutline } from "@/components/outline/outline-layout";
import { PhoneNoteOutline } from "@/components/outline/PhoneNoteOutline";
import { focusBackTo } from "@/components/outline/OutlineSheet";
import { useOutlinePinned, usePinMotionReady } from "@/components/outline/outline-pin";
import { useOutlineBox } from "@/components/outline/use-outline-box";
import { useOutlineHeadings, type OutlineEditorLike } from "@/components/outline/use-outline-headings";
import { useIsOutlineCompact } from "@/lib/layout-tiers";
import { MediaZoomProvider } from "@/components/media-zoom/MediaZoomProvider";
import { ImageZoomLayer } from "@/components/media-zoom/ImageZoomLayer";
import { FilePreviewLayer } from "@/components/file-preview/FilePreviewLayer";
import { PublicPageFrame } from "@/components/PublicNoteShell";
import { publicNoteApiPath, publicNoteQueryKey, publicRefIdentity, type PublicNoteRef } from "@/lib/public-note-ref";
import { BlockAnchorContext } from "@/hooks/block-anchor-context";
import { useBlockAnchor } from "@/hooks/useBlockAnchor";
import { ARTICLE_COLUMN_PADDING, articleColumn, articleColumnState } from "@/components/ui/article-column";
import { toNoteWidth } from "@/components/note-width";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Presentation } from "@/components/ui/icons";
import { HEADER_ICON_HIT } from "@/components/ui/hit-area";
import { exitOwnedFullscreen } from "@/present/fullscreen";
import { LazyPresentation } from "@/present/lazy";
import { PresentationErrorBoundary, PresentationShell, type PresentationShellStatus } from "@/present/PresentationShell";
import { exitFullscreenIfLeftPresentation, isPresentingSearch, searchWithoutPresent } from "@/present/present-url";
import { usePresentEntry } from "@/present/usePresentEntry";

/** Fallback when an older server omits `links` (#269). Module-level so the identity is stable and the editor's links Map isn't rebuilt every render. */
const NO_LINKS: readonly PublicLinkDto[] = [];

/**
 * Serves `/p/:token` and `/p/:handle/:slug` (#72, #122). Anonymous: both routes sit outside RequireAuth (App.tsx), so no auth dependency at
 * all: no `/api/auth/me`, no AppShell, no useCollab (the content is a snapshot lagging by a 2 s debounce, at most 10 s; see
 * docs/known-limitations.md).
 * The form comes from useParams (`handle` + `slug` = alias form, else token form); API path and query key branch by form
 * (`lib/public-note-ref.ts`), and the two forms must not share a key. Format checks and the uniform 404 are server-side (routes/public.ts).
 * Only a 404 shows the invalid-link card (revoked, renamed or cleared aliases are indistinguishable); other failures show `errors.<code>`
 * (a 429 can hit a live link, so it mustn't say the link is dead).
 */
export default function PublicNotePage() {
  const params = useParams<{ token?: string; handle?: string; slug?: string }>();
  const { t } = useTranslation();

  // Presentation mode (#229) reads this page's own useLocation().
  const location = useLocation();
  const navigate = useNavigate();
  const presenting = isPresentingSearch(location.search);
  const { presentHere } = usePresentEntry();

  // Same criterion as NotePage's user form (`handle` + `slug` both present).
  const isPathForm = params.handle !== undefined && params.slug !== undefined;
  const publicRef: PublicNoteRef = useMemo(
    () =>
      isPathForm
        ? { kind: "path", handle: params.handle!, slug: params.slug! }
        : { kind: "token", token: params.token ?? "" },
    [isPathForm, params.token, params.handle, params.slug],
  );
  const enabled = publicRef.kind === "path" || publicRef.token.length > 0;

  const query = useQuery({
    queryKey: publicNoteQueryKey(publicRef),
    queryFn: () => api<PublicNoteDto>(publicNoteApiPath(publicRef)),
    enabled,
    // No retry: 404 is the common legitimate result, and default retries burn throttle budget (miss limiter keyed by ip) and delay the invalid card by seconds.
    retry: false,
  });

  // Decode in render so a corrupt payload throws to PublicNoteErrorBoundary instead of becoming a query error mislabeled as a link problem.
  const doc = useMemo(() => (query.data ? decodePublicYdoc(query.data.ydoc) : null), [query.data]);

  // Paragraph anchors (#269): noteKey is the public ref identity (shared with PublicNoteEditor via publicRefIdentity); ready once the doc decodes.
  const [anchorRoot, setAnchorRoot] = useState<HTMLElement | null>(null);
  const publicKey = publicRefIdentity(publicRef);
  const blockAnchor = useBlockAnchor({ noteKey: publicKey, ready: doc !== null, root: anchorRoot, ignoreInitialAnchor: presenting, currentNoteId: null });
  // The title "#" button overlays the article column wrapper (`relative`).
  const [columnEl, setColumnEl] = useState<HTMLElement | null>(null);
  // Right-side heading outline (#465; desktop and tablet, phones have their own entry). No version bubbles on the public page; while
  // presenting the presentation layer covers the page, so it isn't mounted. Layout is measured only when the outline can show (as on the note page).
  const [publicEditor, setPublicEditor] = useState<OutlineEditorLike | null>(null);
  const outlineHeadings = useOutlineHeadings(publicEditor);
  const compact = useIsOutlineCompact();
  const outlineCanShow = !compact && !presenting && outlineHeadings.length > 0;
  const outlineBox = useOutlineBox(outlineCanShow ? anchorRoot : null, outlineCanShow ? columnEl : null);
  const showOutline = outlineCanShow && outlineBox !== null;
  // Same pin rule as the note page; width comes from the public endpoint (missing or unknown = standard), and only standard width can pin.
  const noteWidth = toNoteWidth(query.data?.width);
  const [outlinePinPref, setOutlinePinPref] = useOutlinePinned();
  const outlinePinAvailable = noteWidth === "standard" && outlineBox !== null && canPinOutline(outlineBox.width);
  const outlinePinned = showOutline && outlinePinPref && outlinePinAvailable;
  const pinMotionReady = usePinMotionReady(showOutline);
  // Phone: only the scroll position bubble (no menu on the public page); tapping it opens the bottom sheet. The public page isn't inside the
  // frame where the document scrolls on its behalf, so on phones the scroller itself still scrolls.
  const phoneOutline = compact && !presenting && outlineHeadings.length > 0;
  const [outlineSheetOpen, setOutlineSheetOpen] = useState(false);
  useEffect(() => {
    if (!phoneOutline) setOutlineSheetOpen(false);
  }, [phoneOutline]);
  const scrollerTop = useCallback(() => anchorRoot?.getBoundingClientRect().top ?? 0, [anchorRoot]);
  // No trigger button: opened from the bubble by keyboard or screen reader, focus returns to it on close; a touch tap (the bubble takes no focus) leaves focus alone.
  const [outlineReturnTo, setOutlineReturnTo] = useState<HTMLElement | null>(null);
  const openOutlineSheet = useCallback((returnFocusTo: HTMLElement | null) => {
    setOutlineReturnTo(returnFocusTo);
    setOutlineSheetOpen(true);
  }, []);
  const outlineRestoreFocus = useMemo(() => focusBackTo(outlineReturnTo), [outlineReturnTo]);

  // Background refetch failures (react-query refetches on focus/reconnect): a 404 flips to the invalid card even with content (revocation reaches
  // an open tab on refocus); another failure with data keeps the snapshot (query.data survives a failed refetch), since a transient network error
  // shouldn't replace half-read content, and the next successful refetch heals it.
  const notFound = query.isError && query.error instanceof ApiFail && query.error.status === 404;

  // A refetch hit 404 (revoked): the page switches to the invalid card and the shell unmounts, so leave owned fullscreen first (#229).
  useEffect(() => {
    if (notFound) exitOwnedFullscreen();
  }, [notFound]);
  // The invalid card must not keep ?present or the slide hash (#234): replace (no new history entry), keeping other query params; deps include location because a ?present URL can be reached after the 404.
  useEffect(() => {
    if (notFound && isPresentingSearch(location.search)) {
      void navigate({ pathname: location.pathname, search: searchWithoutPresent(location.search), hash: "" }, { replace: true });
    }
  }, [notFound, location.pathname, location.search, navigate]);
  // Unmount-time call (reads the real URL).
  useEffect(() => () => exitFullscreenIfLeftPresentation(), []);

  let body: ReactNode;
  if (query.isPending) {
    body = <p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>;
  } else if (notFound) {
    body = (
      <p role="alert" className="p-6 text-sm text-muted-foreground">
        {t("public.invalidLink")}
      </p>
    );
  } else if (query.isError && !query.data) {
    body = (
      <p role="alert" className="p-6 text-sm text-destructive">
        {query.error instanceof ApiFail
          ? t(`errors.${query.error.code}`, { defaultValue: t("errors.fallback") })
          : t("errors.fallback")}
      </p>
    );
  } else {
    // data is always set here (pending, notFound and error-without-data are excluded above), but TS can't narrow custom branches.
    const data = query.data!;
    body = (
      <>
        {/* Title, read-only badge and the Knotebook wordmark linking to /; anonymous clicks land on /login via RequireAuth, which is the
            point of the link: the way from a shared page to the product. */}
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{data.title}</h1>
          <Button type="button" variant="ghost" size="sm" className={cn("shrink-0", HEADER_ICON_HIT)} onClick={presentHere}>
            <Presentation className="h-4 w-4" />
            <span className="max-sm:sr-only">{t("note.menu.present")}</span>
          </Button>
          {/* Phone: badge collapses to a dot, text for screen readers only; from sm up it is the bordered label. */}
          <span className="inline-flex shrink-0 items-center text-xs text-muted-foreground sm:rounded sm:border sm:border-border sm:px-1.5 sm:py-0.5">
            <span data-readonly-dot="" aria-hidden="true" className="h-2 w-2 rounded-full bg-muted-foreground sm:hidden" />
            <span className="max-sm:sr-only">{t("public.readonly")}</span>
          </span>
          <Link to="/" className="shrink-0 text-sm font-semibold text-brand">
            Knotebook
          </Link>
        </header>
        {/* Zero-height anchor outside the scroller, at its top edge (as in NoteEditor). */}
        {showOutline && (
          <NoteOutline
            headings={outlineHeadings}
            scrollEl={anchorRoot}
            box={outlineBox}
            bubbleShown={false}
            pinned={outlinePinned}
            pinAvailable={outlinePinAvailable}
            onPinnedChange={setOutlinePinPref}
          />
        )}
        {phoneOutline && (
          <PhoneNoteOutline
            headings={outlineHeadings}
            root={anchorRoot}
            scrollTarget={anchorRoot}
            topEdge={scrollerTop}
            placement="anchor"
            sheetOpen={outlineSheetOpen}
            onSheetOpenChange={setOutlineSheetOpen}
            onOpenSheet={openOutlineSheet}
            restoreFocus={outlineRestoreFocus}
          />
        )}
        {/* Scrollbar space is always reserved so the container width, which decides outline pinning, doesn't flip near the threshold. */}
        <div ref={setAnchorRoot} className="min-h-0 min-w-0 flex-1 overflow-y-auto sm:[scrollbar-gutter:stable]">
          {/* Follows NoteEditor's article column (text inset 70px -> 20px below md; the breakpoint lives in article-column.ts/index.css). `width` comes from
              the public endpoint (#297; set by whoever manages the public link); missing or unknown means standard (older servers). */}
          <div
            ref={setColumnEl}
            data-testid="article-column"
            className={cn(articleColumn(articleColumnState(noteWidth, outlinePinned), { pinMotion: pinMotionReady }), ARTICLE_COLUMN_PADDING, "relative flex min-h-full flex-col py-6")}
          >
            <MediaZoomProvider>
              <PublicNoteEditor doc={doc!} publicRef={publicRef} links={data.links ?? NO_LINKS} onEditor={setPublicEditor} />
              <HeadingAnchorButtons container={columnEl} />
              <ImageZoomLayer container={columnEl} editable={false} />
            </MediaZoomProvider>
            <FilePreviewLayer container={columnEl} />
          </div>
        </div>
      </>
    );
  }

  // The shell mounts while presenting unless 404; a non-404 failure with data keeps rendering the snapshot and leaves the shell and
  // presentation layer alone.
  const shellMounted = presenting && !notFound;
  const presentStatus: PresentationShellStatus = query.isPending ? "loading" : query.isError && !query.data ? "error" : "ready";
  const presentError =
    query.isError && !query.data
      ? query.error instanceof ApiFail
        ? t(`errors.${query.error.code}`, { defaultValue: t("errors.fallback") })
        : t("errors.fallback")
      : undefined;

  return (
    <BlockAnchorContext.Provider value={blockAnchor}>
      <PublicPageFrame inert={shellMounted}>{body}</PublicPageFrame>
      {shellMounted && (
        <PresentationShell title={query.data?.title ?? ""} status={presentStatus} errorMessage={presentError}>
          {query.data && doc && (
            <PresentationErrorBoundary>
              <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">{t("app.loading")}</p>}>
                <LazyPresentation variant="public" doc={doc} title={query.data.title} publicRef={publicRef} />
              </Suspense>
            </PresentationErrorBoundary>
          )}
        </PresentationShell>
      )}
    </BlockAnchorContext.Provider>
  );
}
