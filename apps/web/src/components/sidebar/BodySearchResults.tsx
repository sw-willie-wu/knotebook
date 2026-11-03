import { useEffect, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { canonicalNotePath, TOP_SECTION_ID, type NoteDto, type NoteSearchMatchDto } from "@knotebook/shared";
import { useBodySearch, type BodySearchState } from "@/api/search";
import { isPlainLeftClick, useWikilinkActivate } from "@/components/wikilink/useWikilinkClick";
import { useActiveNote } from "@/lib/active-note";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { cn } from "@/lib/utils";
import { displaySnippet } from "./body-snippet";
import { flattenRows, mergeSearchRows } from "./search-merge";
import { highlightTitle, searchMetaLineClass, searchTitleLineClass, SearchRow } from "./SearchResults";
import { noteLocationLabel, type LocationContext } from "./tree";

/**
 * #93 PR2：側欄搜尋的合併結果列表（lazy chunk 內，唯一入口 `BodySearchLazy.tsx`）。標題命中（`titleNotes`，client 對清單算的）與內文命中
 * （server）合成**一個列表**，**每個含查詢字的段落各列一項**（server 每個段落只回第一個命中，所以一項＝一個段落、不是每一次出現；
 * 一個段落裡出現好幾次還是一項，點了跳到第一個；server 每篇最多回 3 個段落。`mergeSearchRows` 去重後 `flattenRows` 攤平；一篇 3 個段落就 3 項，每項重複標題與路徑）：
 * 三行＝筆記標題、資料夾路徑、命中片段；只有標題命中的篇是兩行（標題、路徑）、點了開筆記不帶查詢字。外殼 `BodySearchResults` 接 hook；`BodySearchView` 只吃 state（測試直接餵 state）。
 *
 * - **交叉比對**：內文 hit 只顯示 `notes`（`useNotes()` 的清單，`SearchResults` 已載入）裡有的 id；連結與位置行用清單裡那筆 `NoteDto`
 *   （查詢快取 30 s，期間改名、搬群組、移進垃圾桶都不會連到舊路徑）。
 * - pending／error 時照樣顯示標題命中的列（只缺片段），狀態句在列表上方。
 * - 片段裁切與標亮用 state 的 `forQuery`（產出這批的字），不用當下的字；標題標亮用當下的字（標題清單是 client 即時算的）。
 * - 點片段＝#269 段落錨點：`筆記網址#b-<sectionId>`（`_top` 不帶錨點），經 `useWikilinkActivate`（同篇只捲動、別篇 navigate），並帶
 *   `findText: forQuery`——筆記開好後在那一段的範圍內找第一個含查詢字的 block 捲過去、高亮（`hooks/block-find.ts`；比對規則與標亮同一支
 *   `lib/search-match.ts`）。點任何結果都主動關抽屜（點目前這一篇時 pathname 不變，AppShell 的「換頁關抽屜」不會觸發）。修飾鍵點擊交給瀏覽器。
 * - 篇數行（唯一的 `role="status"`）在 `SearchResults`（側欄只准一個 status：e2e 33 的 strict locator）；這裡用 `onStatus` 把合併後的項數回報給它。
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
  const items = flattenRows(mergeSearchRows(titleNotes, ready ? state.hits : [], notes));
  const forQuery = ready ? state.forQuery : "";
  const lowerQuery = forQuery.toLowerCase();
  const more = ready && state.hasMore;
  // stale（防抖中或新字還在路上）時內文結果是舊字的：不回報，篇數行只顯示標題命中的篇數，不把舊查詢的內文命中算進「N 筆結果」。
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
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((item) => {
            const label = noteLocationLabel(item.note, location, t);
            const active = activeNoteId === item.note.id;
            // 同一篇有多項時，只有第一項帶 aria-current="page"（其餘只有視覺上的底色）：讀屏不要唸好幾個「目前頁面」。
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

/** 只有標題命中的一項：兩行（標題、路徑），點了開筆記、不帶查詢字。 */
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

/**
 * 一處內文命中＝一項、一個可點的 link（鍵盤與 a11y：單一 `<a>`，焦點樣式沿用全站預設）。三行：筆記標題（命中字標亮）、
 * 資料夾路徑（`noteLocationLabel`，不顯示段落標題）、命中片段（照舊裁切與標亮）。三行一律 <div>（理由同 `SearchRow`）。
 */
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
  /** 這一項帶 `aria-current="page"`（同一篇多項時只有第一項）。 */
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
        <div className={searchTitleLineClass(active)}>{highlightTitle(note.title, titleLowerQuery)}</div>
        <div className={cn("mt-0.5", searchMetaLineClass(active))} title={label}>
          {label}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12px] break-words">{highlightTitle(displaySnippet(match.snippet, lowerQuery), lowerQuery)}</div>
      </a>
    </li>
  );
}
