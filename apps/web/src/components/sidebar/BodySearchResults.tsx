import { useEffect, useState, type MouseEvent } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { canonicalNotePath, TOP_SECTION_ID, type NoteDto, type NoteSearchMatchDto } from "@knotebook/shared";
import { spaceTagsKey } from "@/api/tag-keys";
import { useBodySearch, type BodySearchState } from "@/api/search";
import { isPlainLeftClick, useWikilinkActivate } from "@/components/wikilink/useWikilinkClick";
import { useActiveNote } from "@/lib/active-note";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { cn } from "@/lib/utils";
import { displaySnippet } from "./body-snippet";
import { flattenRows, mergeSearchRows } from "./search-merge";
import { highlightTitle, searchMetaLineClass, SearchRow, SearchTitleLine } from "./SearchResults";
import type { FilterSpaceRef } from "./search-tags";
import { noteLocationLabel, type LocationContext } from "./tree";

/**
 * Merged list (lazy chunk; sole entry `BodySearchLazy.tsx`): one row per matching paragraph (the server returns only the first hit per paragraph, at most 3 per note), plus title-only rows.
 * Body hits show only ids present in `notes` (already loaded by `SearchResults`) and link via that `NoteDto`: the query cache lives 30 s, during which a rename, move or trash must not yield a stale path.
 * Snippet cropping and highlighting use `forQuery` (the query that produced the batch); title highlighting uses the current query (titles are filtered live on the client).
 * Every click closes the drawer: clicking the current note leaves the pathname unchanged, so AppShell's close-on-navigate doesn't fire.
 * The sidebar may hold only one `role="status"` (an e2e locates it with a strict locator), which lives in `SearchResults`; this component reports its row count via `onStatus`, and its own `aria-live` reads only pending/error.
 */
export interface BodySearchProps {
  query: string;
  debounced: string;
  titleNotes: NoteDto[];
  titleLowerQuery: string;
  notes: NoteDto[];
  location: LocationContext;
  onStatus?: (status: { count: number; more: boolean } | null) => void;
  /** Tag ids of the search tokens; all in one space. */
  tagIds?: readonly string[];
  /** Space of the tag ids; when the server says the tags don't exist (any more) for this user, the lists they came from are refreshed. */
  tagSpace?: FilterSpaceRef | null;
}

export function BodySearchResults({ query, debounced, tagIds, tagSpace, ...rest }: BodySearchProps) {
  const state = useBodySearch({ query, debounced, tagIds });
  const queryClient = useQueryClient();
  const invalid = state.kind === "error" && state.invalidTags;
  const tagKey = (tagIds ?? []).join(",");
  // Once per tag set: if the refetched lists still carry the tags the error stays visible instead of looping.
  const [refreshedFor, setRefreshedFor] = useState<string | null>(null);
  const refetching = useIsFetching({ predicate: (q) => q.queryKey[0] === "notes" || q.queryKey[0] === "tags" }) > 0;
  useEffect(() => {
    if (!invalid || refreshedFor === tagKey) return;
    setRefreshedFor(tagKey);
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    if (tagSpace != null) void queryClient.invalidateQueries({ queryKey: spaceTagsKey(tagSpace.kind === "personal" ? tagSpace : { kind: "group", groupId: tagSpace.groupId }) });
  }, [invalid, tagKey, tagSpace, queryClient, refreshedFor]);
  // While the lists are being refreshed the failure may already be out of date, so it is not shown yet.
  const shown: BodySearchState = invalid && (refreshedFor !== tagKey || refetching) ? { kind: "pending" } : state;
  return <BodySearchView state={shown} {...rest} />;
}

export function BodySearchView({
  state,
  titleNotes,
  titleLowerQuery,
  notes,
  location,
  onStatus,
}: {
  state: BodySearchState;
  titleNotes: NoteDto[];
  titleLowerQuery: string;
  notes: NoteDto[];
  location: LocationContext;
  onStatus?: BodySearchProps["onStatus"];
}) {
  const { t } = useTranslation();
  const { setActiveNoteId, activeNoteId } = useActiveNote();
  const closeDrawer = useCloseSidebarDrawer();
  const activate = useWikilinkActivate();

  const ready = state.kind === "ready";
  const items = flattenRows(mergeSearchRows(titleNotes, ready ? state.hits : [], notes));
  const forQuery = ready ? state.forQuery : "";
  const lowerQuery = forQuery.toLowerCase();
  const more = ready && state.hasMore;
  // Stale (debouncing or a new query in flight): don't report, or old body hits would be counted in "N results".
  const reportable = ready && !state.stale;

  const currentSeen = new Set<string>();
  const count = items.length;
  useEffect(() => {
    onStatus?.(reportable ? { count, more } : null);
    return () => onStatus?.(null);
  }, [onStatus, reportable, count, more]);

  const statusText =
    state.kind === "pending"
      ? t("sidebar.bodySearching")
      : state.kind === "error"
        ? t(state.rateLimited ? "sidebar.bodySearchRateLimited" : "sidebar.bodySearchFailed")
        : "";
  const noMatch = ready && !state.stale && items.length === 0;

  const onTitleClick = (note: NoteDto) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (isPlainLeftClick(event)) setActiveNoteId(note.id);
    closeDrawer();
  };
  const onMatchClick = (note: NoteDto, match: NoteSearchMatchDto, href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    setActiveNoteId(note.id);
    closeDrawer();
    // broken is always false: hits are cross-checked against the sidebar list, so they resolve.
    activate({
      href,
      targetNoteId: note.id,
      anchorBlockId: match.sectionId === TOP_SECTION_ID ? "" : match.sectionId,
      broken: false,
      findText: forQuery,
    });
  };

  return (
    <section aria-label={t("sidebar.resultsRegion")} data-testid="sidebar-search-results" className="pb-2">
      <p aria-live="polite" className={statusText === "" ? "sr-only" : "px-2 py-1 text-[11px] text-muted-foreground"}>
        {statusText}
      </p>
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((item) => {
            const label = noteLocationLabel(item.note, location, t);
            const active = activeNoteId === item.note.id;
            // Only the first row of a note gets aria-current="page": screen readers shouldn't read several "current page".
            const current = active && !currentSeen.has(item.note.id);
            if (active) currentSeen.add(item.note.id);
            return item.kind === "title" ? (
              <TitleOnlyItem
                key={`${item.note.id}:title`}
                note={item.note}
                label={label}
                titleLowerQuery={titleLowerQuery}
                active={active}
                onClick={onTitleClick(item.note)}
              />
            ) : (
              <MatchItem
                key={`${item.note.id}:${item.match.sectionId}`}
                note={item.note}
                match={item.match}
                label={label}
                titleLowerQuery={titleLowerQuery}
                lowerQuery={lowerQuery}
                active={active}
                current={current}
                onMatchClick={onMatchClick}
              />
            );
          })}
        </ul>
      )}
      {ready && state.moreError !== null && (
        <p className="px-2 py-1 text-[11px] text-destructive">
          {t(state.moreError.rateLimited ? "sidebar.bodySearchRateLimited" : "sidebar.bodySearchFailed")}
        </p>
      )}
      {ready && state.hasMore && (
        <button
          type="button"
          onClick={state.loadMore}
          disabled={state.loadingMore}
          className="mx-2 mt-1 rounded-md px-2 py-1 text-[12px] text-brand hover:bg-brand-soft disabled:opacity-60"
        >
          {t(state.loadingMore ? "sidebar.bodyLoadingMore" : "sidebar.bodyLoadMore")}
        </button>
      )}
      {noMatch && <p className="px-2 py-2 text-sm text-muted-foreground">{t("sidebar.noMatch")}</p>}
    </section>
  );
}

function TitleOnlyItem({
  note,
  label,
  titleLowerQuery,
  active,
  onClick,
}: {
  note: NoteDto;
  label: string;
  titleLowerQuery: string;
  active: boolean;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <li data-node-kind="note" data-node-id={note.id} data-testid="search-hit">
      <SearchRow note={note} label={label} lowerQuery={titleLowerQuery} active={active} onClick={onClick} />
    </li>
  );
}

function MatchItem({
  note,
  match,
  label,
  titleLowerQuery,
  lowerQuery,
  active,
  current,
  onMatchClick,
}: {
  note: NoteDto;
  match: NoteSearchMatchDto;
  label: string;
  titleLowerQuery: string;
  lowerQuery: string;
  active: boolean;
  current: boolean;
  onMatchClick: (note: NoteDto, match: NoteSearchMatchDto, href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const path = canonicalNotePath(note);
  const href = match.sectionId === TOP_SECTION_ID ? path : `${path}#b-${match.sectionId}`;
  return (
    <li data-node-kind="note" data-node-id={note.id} data-testid="search-hit">
      <a
        href={href}
        data-testid="body-match"
        data-section-id={match.sectionId}
        onClick={onMatchClick(note, match, href)}
        aria-current={current ? "page" : undefined}
        className={cn(
          "group block min-w-0 rounded-md px-2 py-1.5 hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
          active && "bg-brand-soft text-brand-on-soft hover:bg-brand-soft-strong",
        )}
      >
        <SearchTitleLine note={note} lowerQuery={titleLowerQuery} active={active} />
        <div className={cn("mt-0.5", searchMetaLineClass(active))} title={label}>
          {label}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12px] break-words">{highlightTitle(displaySnippet(match.snippet, lowerQuery), lowerQuery)}</div>
      </a>
    </li>
  );
}
