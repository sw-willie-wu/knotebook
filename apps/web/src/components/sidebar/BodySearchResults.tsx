import { useEffect, useId, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { canonicalNotePath, TOP_SECTION_ID, type NoteDto, type NoteSearchMatchDto } from "@knotebook/shared";
import { useBodySearch, type BodySearchState } from "@/api/search";
import { isPlainLeftClick, useWikilinkActivate } from "@/components/wikilink/useWikilinkClick";
import { useActiveNote } from "@/lib/active-note";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { displaySnippet } from "./body-snippet";
import { mergeSearchRows, type MergedRow } from "./search-merge";
import { highlightTitle, SearchRow } from "./SearchResults";
import { noteLocationLabel, type LocationContext } from "./tree";

/**
 * #93 PR2：側欄搜尋的合併結果列表（lazy chunk 內，唯一入口 `BodySearchLazy.tsx`）。標題命中（`titleNotes`，client 對清單算的）與內文命中
 * （server）合成**一個列表**、一篇一列（`mergeSearchRows`）：標題、位置，加**第一個**片段；其餘片段（server 每篇最多回 3 個）收在「顯示另外 N 處」，
 * 點了展開。N 是 server 回來的剩餘片段數，不是總命中數。外殼 `BodySearchResults` 接 hook；`BodySearchView` 只吃 state（測試直接餵 state）。
 *
 * - **交叉比對**：內文 hit 只顯示 `notes`（`useNotes()` 的清單，`SearchResults` 已載入）裡有的 id；連結與位置行用清單裡那筆 `NoteDto`
 *   （查詢快取 30 s，期間改名、搬群組、移進垃圾桶都不會連到舊路徑）。
 * - pending／error 時照樣顯示標題命中的列（只缺片段），狀態句在列表上方。
 * - 片段裁切與標亮用 state 的 `forQuery`（產出這批的字），不用當下的字；標題標亮用當下的字（標題清單是 client 即時算的）。
 * - 點片段＝#269 段落錨點：`筆記網址#b-<sectionId>`（`_top` 不帶錨點），經 `useWikilinkActivate`（同篇只捲動、別篇 navigate），並帶
 *   `findText: forQuery`——筆記開好後在那一段的範圍內找第一個含查詢字的 block 捲過去、高亮（`hooks/block-find.ts`；比對規則與標亮同一支
 *   `lib/search-match.ts`）。點任何結果都主動關抽屜（點目前這一篇時 pathname 不變，AppShell 的「換頁關抽屜」不會觸發）。修飾鍵點擊交給瀏覽器。
 * - 篇數行（唯一的 `role="status"`）在 `SearchResults`（側欄只准一個 status：e2e 33 的 strict locator）；這裡用 `onStatus` 把合併後的篇數回報給它。
 *   本元件自己的 `aria-live="polite"` 只念 pending／error 句。
 */
export interface BodySearchProps {
  /** 當下（trim 後）的搜尋字。 */
  query: string;
  /** 首包 `SearchResults` 算好的防抖後的字。 */
  debounced: string;
  /** 標題命中的筆記（`SearchResults` 對清單算的，清單順序）與標題標亮用的小寫字。 */
  titleNotes: NoteDto[];
  titleLowerQuery: string;
  notes: NoteDto[];
  location: LocationContext;
  onStatus?: (status: { count: number; more: boolean } | null) => void;
}

export function BodySearchResults({ query, debounced, ...rest }: BodySearchProps) {
  const state = useBodySearch({ query, debounced });
  return <BodySearchView state={state} {...rest} />;
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
  const rows = mergeSearchRows(titleNotes, ready ? state.hits : [], notes);
  const forQuery = ready ? state.forQuery : "";
  const lowerQuery = forQuery.toLowerCase();
  const more = ready && state.hasMore;
  // stale（防抖中或新字還在路上）時內文結果是舊字的：不回報，篇數行只顯示標題命中的篇數，不把舊查詢的內文命中算進「找到 N 篇」。
  const reportable = ready && !state.stale;

  const count = rows.length;
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
  const noMatch = ready && !state.stale && rows.length === 0;

  const onTitleClick = (note: NoteDto) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (isPlainLeftClick(event)) setActiveNoteId(note.id);
    closeDrawer();
  };
  const onMatchClick = (note: NoteDto, match: NoteSearchMatchDto, href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    setActiveNoteId(note.id);
    closeDrawer();
    // broken 恆 false：hit 已與側欄清單交叉比對，連得到。
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
      {rows.length > 0 && (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <MergedItem
              key={row.note.id}
              row={row}
              label={noteLocationLabel(row.note, location, t)}
              titleLowerQuery={titleLowerQuery}
              lowerQuery={lowerQuery}
              active={activeNoteId === row.note.id}
              onTitleClick={onTitleClick(row.note)}
              onMatchClick={onMatchClick}
            />
          ))}
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

function MergedItem({
  row,
  label,
  titleLowerQuery,
  lowerQuery,
  active,
  onTitleClick,
  onMatchClick,
}: {
  row: MergedRow;
  label: string;
  titleLowerQuery: string;
  lowerQuery: string;
  active: boolean;
  onTitleClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  onMatchClick: (note: NoteDto, match: NoteSearchMatchDto, href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { note, matches } = row;
  const path = canonicalNotePath(note);
  const shown = expanded ? matches : matches.slice(0, 1);
  const extra = matches.length - 1;
  return (
    <li data-node-kind="note" data-node-id={note.id} data-testid="search-hit">
      <SearchRow note={note} label={label} lowerQuery={titleLowerQuery} active={active} onClick={onTitleClick} />
      {matches.length > 0 && (
        <ul id={listId} className="mb-1 ml-3 space-y-0.5 border-l border-border pl-1">
          {shown.map((match) => {
            const href = match.sectionId === TOP_SECTION_ID ? path : `${path}#b-${match.sectionId}`;
            return (
              <li key={match.sectionId}>
                <a
                  href={href}
                  data-testid="body-match"
                  onClick={onMatchClick(note, match, href)}
                  className="block min-w-0 rounded-md px-2 py-1 hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong"
                >
                  {match.heading !== "" && <div className="truncate text-[11px] font-medium text-muted-foreground">{match.heading}</div>}
                  <div className="line-clamp-2 text-[12px] break-words">{highlightTitle(displaySnippet(match.snippet, lowerQuery), lowerQuery)}</div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {extra > 0 && (
        <button
          type="button"
          data-testid="body-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          className="mb-1 ml-4 rounded-md px-2 py-0.5 text-[11px] text-brand hover:bg-brand-soft"
        >
          {expanded ? t("sidebar.lessSnippets") : t("sidebar.moreSnippets", { count: extra })}
          <span aria-hidden="true"> {expanded ? "▴" : "▾"}</span>
        </button>
      )}
    </li>
  );
}
