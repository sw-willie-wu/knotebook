import { lazy, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { foldedIndexOf } from "@/lib/search-match";
import { useDebounced } from "@/lib/useDebounced";
import { cn } from "@/lib/utils";
import { BODY_SEARCH_DEBOUNCE_MS, bodySearchGate } from "@/components/sidebar/body-search-gate";
import { indexFolders } from "@/components/sidebar/folder-index";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { TagDots } from "@/components/sidebar/TagDots";
import { notesMatchingTokens, type SearchTagToken } from "@/components/sidebar/search-tags";
import { PHONE_LIST_SCROLLER } from "@/components/sidebar/phone-bar";
import { noteLocationLabel, type LocationContext } from "@/components/sidebar/tree";

const TagResultsExtras = lazy(() => import("@/components/sidebar/TagResultsExtras"));
const BodySearchResults = lazy(() => import("@/components/sidebar/BodySearchLazy").then((m) => ({ default: m.BodySearchResults })));

/** Lowercasing can change length (e.g. `İ` → `i̇`), so positions no longer map to the original title: then nothing is highlighted. */
export function highlightTitle(title: string, lowerQuery: string): ReactNode {
  if (lowerQuery === "") return title;
  const index = foldedIndexOf(title, lowerQuery);
  if (index < 0) return title;
  const end = index + lowerQuery.length;
  return [
    title.slice(0, index),
    <mark key="hit" className="rounded-sm bg-search-highlight text-inherit">
      {title.slice(index, end)}
    </mark>,
    title.slice(end),
  ];
}

/**
 * Active (`bg-brand-soft`) and hover rows switch to `text-brand-on-soft`: grey on brand-soft is only 4.17:1 (3.94:1 on the hover strong background), below AA 4.5:1; on-soft gives 6.3–6.6:1 light, 6.9–8.0:1 dark.
 * The `<a>`/Link must carry `group`.
 */
export function searchMetaLineClass(active: boolean): string {
  return cn("truncate text-[11px]", active ? "text-brand-on-soft" : "text-muted-foreground group-hover:text-brand-on-soft");
}

export function searchTitleLineClass(active: boolean): string {
  return cn(searchMetaLineClass(active), "font-semibold");
}

/** Both lines are <div>: the accessible name relies on the UA's block spacing (jsdom has no Tailwind, so spans would fuse into "titlelocation"). */
export function SearchRow({
  note,
  label,
  lowerQuery,
  active,
  onClick,
}: {
  note: NoteDto;
  label: string;
  lowerQuery: string;
  active: boolean;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <Link
      to={canonicalNotePath(note)}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group block min-w-0 rounded-md px-2 py-1.5 hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
        active && "bg-brand-soft text-brand-on-soft hover:bg-brand-soft-strong",
      )}
    >
      <SearchTitleLine note={note} lowerQuery={lowerQuery} active={active} />
      <div className={cn("mt-0.5", searchMetaLineClass(active))} title={label}>
        {label}
      </div>
    </Link>
  );
}

/** Without tags this is a single div; with tags the dots sit at the end of the line. */
export function SearchTitleLine({ note, lowerQuery, active }: { note: NoteDto; lowerQuery: string; active: boolean }) {
  const title = <div className={searchTitleLineClass(active)}>{highlightTitle(note.title, lowerQuery)}</div>;
  if ((note.tags ?? []).length === 0) return title;
  return (
    <div className="flex min-w-0 items-center">
      <div className="min-w-0 flex-1">{title}</div>
      <TagDots tags={note.tags ?? []} />
    </div>
  );
}

function TitleRows({
  notes,
  location,
  lowerQuery,
  activeNoteId,
  onPick,
}: {
  notes: NoteDto[];
  location: LocationContext;
  lowerQuery: string;
  activeNoteId: string | null;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {notes.map((note) => (
        <li key={note.id} data-node-kind="note" data-node-id={note.id}>
          <SearchRow
            note={note}
            label={noteLocationLabel(note, location, t)}
            lowerQuery={lowerQuery}
            active={activeNoteId === note.id}
            onClick={(event) => {
              // Same rule as NoteRow: only a plain left-click sets optimistically.
              if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) onPick(note.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Debounce and gate live here (first bundle): this mounts when the query goes from empty to non-empty, usually a single character (tooShort, no request);
 * the lazy component then reads only `debounced`, so it never fires with the current text on mount. Whether to mount depends on the current text, whether to send on `debounced`.
 * Known exception: pasting a whole query into an empty box makes `debounced` that text on mount, so one request fires immediately.
 * The body section is also absent while `/api/notes` is loading or failed (early return below): intended, it cross-checks against that list.
 * The count line (`role="status"`) is outside the container: with body results loaded and not stale it is the listed row count, otherwise the title-match count.
 */
const NO_TOKENS: SearchTagToken[] = [];
const STATUS_CLASS = "px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground";

export function SearchResults({
  query,
  tagTokens = NO_TOKENS,
  onTagTokensChange,
}: {
  query: string;
  tagTokens?: readonly SearchTagToken[];
  onTagTokensChange?: (tokens: SearchTagToken[]) => void;
}) {
  const { t } = useTranslation();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const tokenSpace = tagTokens[0]?.space ?? null;
  const foldersQuery = useFolders();
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const { activeNoteId, setActiveNoteId } = useActiveNote();
  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, BODY_SEARCH_DEBOUNCE_MS);
  const gate = bodySearchGate(query);
  // Row count reported by the lazy body section; null (not ready: pending/error/stale/loading) = show the title-match count only.
  const [bodyStatus, setBodyStatus] = useState<{ count: number; more: boolean } | null>(null);

  // All three states share one flex-1 container (buttons below don't jump); `role="status"` isn't re-created between pending and loaded (mounted even when empty).
  if (notesQuery.isPending || notesQuery.isError) {
    const err = notesQuery.error;
    return (
      <div data-testid="sidebar-search" className="flex min-h-0 flex-1 flex-col">
        <p role="status" className={STATUS_CLASS} />
        {notesQuery.isPending ? (
          <p className="p-2 text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : (
          <p role="alert" className="p-2 text-sm text-destructive">
            {err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback")}
          </p>
        )}
      </div>
    );
  }

  const lowerQuery = query.toLowerCase();
  const groupIds = new Set((groupsQuery.data ?? []).map((group) => group.id));
  const pool = tagTokens.length === 0 ? notesQuery.data : notesMatchingTokens(notesQuery.data, tagTokens, groupIds);
  const results = pool.filter((note) => note.title.toLowerCase().includes(lowerQuery));
  // Not waiting on ["folders"]: until it arrives the path row just lacks the folder segment.
  const location = { groupIds, folders: folderIndex };

  const bodyReady = gate === "search" && bodyStatus !== null;
  const plainStatus = bodyReady
    ? t(bodyStatus.more ? "sidebar.matchesCountMore" : "sidebar.matchesCount", { count: bodyStatus.count })
    : t("sidebar.titleMatches", { count: results.length });
  const plainRow = (
    <p role="status" className={STATUS_CLASS}>
      {plainStatus}
    </p>
  );
  const titleRows = (
    <TitleRows notes={results} location={location} lowerQuery={lowerQuery} activeNoteId={activeNoteId} onPick={setActiveNoteId} />
  );

  return (
    <div data-testid="sidebar-search" className="flex min-h-0 flex-1 flex-col">
      {tokenSpace === null ? (
        plainRow
      ) : (
        <SidebarLazyBoundary
          chunk="tagResults"
          fallback={plainRow}
          errorClassName="px-4 pb-1.5 text-xs"
        >
          <TagResultsExtras
            tagTokens={tagTokens}
            onTagTokensChange={onTagTokensChange}
            plainStatus={plainStatus}
            gateOff={gate === "off"}
            titleCount={results.length}
            body={bodyReady ? bodyStatus : null}
          />
        </SidebarLazyBoundary>
      )}
      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2", PHONE_LIST_SCROLLER)}>
        {gate !== "search" && titleRows}
        {gate !== "search" && results.length === 0 && <p className="px-2 py-2 text-sm text-muted-foreground">{t("sidebar.noMatch")}</p>}
        {gate === "tooShort" && <p className="px-2 py-2 text-[11px] text-muted-foreground">{t("sidebar.bodySearchTooShort")}</p>}
        {gate === "tooLong" && <p className="px-2 py-2 text-[11px] text-muted-foreground">{t("sidebar.bodySearchTooLong")}</p>}
        {gate === "search" && (
          <SidebarLazyBoundary
            chunk="bodySearch"
            fallback={
              <>
                {titleRows}
                <p className="px-2 pt-3 text-[11px] text-muted-foreground">{t("sidebar.bodySearching")}</p>
              </>
            }
          >
            <BodySearchResults
              query={trimmed}
              debounced={debounced}
              titleNotes={results}
              titleLowerQuery={lowerQuery}
              notes={pool}
              location={location}
              onStatus={setBodyStatus}
              tagIds={tagTokens.map((token) => token.id)}
              tagSpace={tokenSpace}
            />
          </SidebarLazyBoundary>
        )}
      </div>
    </div>
  );
}
