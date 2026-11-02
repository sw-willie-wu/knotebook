import { useId, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath, TOP_SECTION_ID, type NoteDto, type NoteSearchMatchDto } from "@knotebook/shared";
import { useBodySearch, type BodySearchState } from "@/api/search";
import { isPlainLeftClick, useWikilinkActivate } from "@/components/wikilink/useWikilinkClick";
import { useActiveNote } from "@/lib/active-note";
import { useCloseSidebarDrawer } from "@/lib/sidebar-drawer";
import { cn } from "@/lib/utils";
import { displaySnippet } from "./body-snippet";
import { highlightTitle } from "./SearchResults";
import { noteLocationLabel, type LocationContext } from "./tree";

/**
 * #93 PR2：側欄搜尋的「內文符合」區（lazy chunk 內，唯一入口 `BodySearchLazy.tsx`）。
 * 外殼 `BodySearchResults` 接 hook；`BodySearchView` 只吃 state（測試直接餵 state）。
 *
 * - **交叉比對**：只顯示 `notes`（`useNotes()` 的清單，`SearchResults` 已載入）裡有的 id；連結與位置行用清單裡那筆 `NoteDto`
 *   （查詢快取 30 s，期間改名、搬群組、移進垃圾桶都不會連到舊路徑）。計數是比對後實際顯示的篇數。
 * - 只顯示 `matchedOn` 為 `body`／`both` 的 hit（`match=body` 下 server 本來就不回 `title`，這裡仍要防）。
 * - 片段裁切與標亮用 state 的 `forQuery`（產出這批的字），不用當下的字。
 * - 點片段＝#269 段落錨點：`筆記網址#b-<sectionId>`（`_top` 不帶錨點），經 `useWikilinkActivate`（同篇只捲動、別篇 navigate）；
 *   點任何結果都主動關抽屜（點目前這一篇時 pathname 不變，AppShell 的「換頁關抽屜」不會觸發）。修飾鍵點擊交給瀏覽器。
 * - 計數／狀態行用 `aria-live="polite"`，**不是** `role="status"`：側欄只准一個 status（標題區那行；e2e 33 的 strict locator）。
 */
export interface BodySearchProps {
  /** 當下（trim 後）的搜尋字。 */
  query: string;
  /** 首包 `SearchResults` 算好的防抖後的字。 */
  debounced: string;
  /** 標題區的篇數（決定要不要由這裡顯示 noMatch）。 */
  titleCount: number;
  notes: NoteDto[];
  location: LocationContext;
}

export function BodySearchResults({ query, debounced, ...rest }: BodySearchProps) {
  const state = useBodySearch({ query, debounced });
  return <BodySearchView state={state} {...rest} />;
}

export function BodySearchView({
  state,
  titleCount,
  notes,
  location,
}: {
  state: BodySearchState;
  titleCount: number;
  notes: NoteDto[];
  location: LocationContext;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const { setActiveNoteId } = useActiveNote();
  const closeDrawer = useCloseSidebarDrawer();
  const activate = useWikilinkActivate();

  const byId = new Map(notes.map((n) => [n.id, n]));
  const rows =
    state.kind === "ready"
      ? state.hits.flatMap((h) => {
          if (h.matchedOn === "title") return [];
          const listNote = byId.get(h.note.id);
          return listNote ? [{ note: listNote, matches: h.matches }] : [];
        })
      : [];
  const lowerQuery = state.kind === "ready" ? state.forQuery.toLowerCase() : "";

  const statusText =
    state.kind === "pending"
      ? t("sidebar.bodySearching")
      : state.kind === "error"
        ? t(state.rateLimited ? "sidebar.bodySearchRateLimited" : "sidebar.bodySearchFailed")
        : t("sidebar.bodyMatchesCount", { count: rows.length });
  const noMatch = titleCount === 0 && state.kind === "ready" && !state.stale && rows.length === 0;

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
    activate({ href, targetNoteId: note.id, anchorBlockId: match.sectionId === TOP_SECTION_ID ? "" : match.sectionId, broken: false });
  };

  return (
    <section aria-labelledby={headingId} data-testid="sidebar-body-search" className="mt-3 pb-2">
      <h3 id={headingId} className="px-2 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {t("sidebar.bodyMatchesHeading")}
      </h3>
      <p aria-live="polite" className="px-2 pb-1 text-[11px] text-muted-foreground">
        {statusText}
      </p>
      {rows.length > 0 && (
        <ul className="space-y-0.5">
          {rows.map(({ note, matches }) => {
            const path = canonicalNotePath(note);
            const label = noteLocationLabel(note, location, t);
            return (
              <li key={note.id} data-testid="body-hit">
                <Link
                  to={path}
                  onClick={onTitleClick(note)}
                  className="block min-w-0 rounded-md px-2 py-1.5 hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong"
                >
                  {/* 兩行一律 <div>（理由同 SearchResults：jsdom 不載 Tailwind，span 會黏成「標題位置」）。 */}
                  <div className="truncate text-[13px]">{note.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={label}>
                    {label}
                  </div>
                </Link>
                {matches.length > 0 && (
                  <ul className="mb-1 ml-3 space-y-0.5 border-l border-border pl-1">
                    {matches.map((match) => {
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
                            <div className={cn("line-clamp-2 text-[12px] break-words")}>
                              {highlightTitle(displaySnippet(match.snippet, lowerQuery), lowerQuery)}
                            </div>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {state.kind === "ready" && state.moreError !== null && (
        <p className="px-2 py-1 text-[11px] text-destructive">
          {t(state.moreError.rateLimited ? "sidebar.bodySearchRateLimited" : "sidebar.bodySearchFailed")}
        </p>
      )}
      {state.kind === "ready" && state.hasMore && (
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
