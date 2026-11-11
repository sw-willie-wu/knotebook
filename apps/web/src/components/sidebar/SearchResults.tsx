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
import { noteLocationLabel, type LocationContext } from "@/components/sidebar/tree";

// 內文區（#93）整塊在 lazy chunk；唯一入口見 BodySearchLazy.tsx。
const BodySearchResults = lazy(() => import("@/components/sidebar/BodySearchLazy").then((m) => ({ default: m.BodySearchResults })));

/**
 * 標題裡第一個命中的子字串包 `<mark>`。`toLowerCase()` 會改變長度的標題
 * （如 `İ`→`i̇`）位置對不回原字串——此時不標、照原字顯示；找不到也照原字。
 */
export function highlightTitle(title: string, lowerQuery: string): ReactNode {
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
 * 搜尋結果每項的「筆記標題」與「位置」兩行共用的樣式（第一行與第二行同一個 style，灰色小字）。
 * 目前開著的那一項（底色 `bg-brand-soft`）與 hover 時改用 `text-brand-on-soft`：灰字疊在 brand-soft 上只有 4.17:1（hover 的 strong 底 3.94:1），
 * 達不到 AA 的 4.5:1；on-soft 在亮色 6.3–6.6:1、暗色 6.9–8.0:1。所在的 `<a>`／Link 要帶 `group`。
 */
export function searchMetaLineClass(active: boolean): string {
  return cn("truncate text-[11px]", active ? "text-brand-on-soft" : "text-muted-foreground group-hover:text-brand-on-soft");
}

/** 標題行＝meta 行加粗（所有搜尋結果項的標題行粗體；位置行不粗，其餘 class 與位置行相同）。 */
export function searchTitleLineClass(active: boolean): string {
  return cn(searchMetaLineClass(active), "font-semibold");
}

/**
 * 一列搜尋結果的「標題＋位置」（連結）。標題列與合併列（`BodySearchResults`）共用。兩行一律 <div>：可及名稱靠 UA 預設 block 之間補空白
 * （jsdom 不載 Tailwind，span 會黏成「標題位置」）。
 */
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
      <div className={searchTitleLineClass(active)}>{highlightTitle(note.title, lowerQuery)}</div>
      <div className={cn("mt-0.5", searchMetaLineClass(active))} title={label}>
        {label}
      </div>
    </Link>
  );
}

/** 只有標題命中的清單（gate 不是 search、內文區 chunk 載入中時用）。 */
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
              // 與 NoteRow 同一條規則：只有 plain left-click 才樂觀 set。
              if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) onPick(note.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
}

/** 搜尋視圖：標題小寫子字串、跨所有 tab 的扁平清單（server 順序），標題命中的列兩行（標題＋位置）。
 * 比對一律字面子字串（不經正規式）。
 *
 * #93：gate 是 search 時，整個清單交給 lazy 的 `BodySearchLazy`（標題命中與內文命中合成一個列表，每個含查詢字的段落一項，
 * 每項三行：標題、位置、片段）；chunk 載入中先顯示標題命中的列。計數那行（`role="status"`）留在容器外：內文結果回來且不是 stale 時是列出的
 * 項數（「N results」），其餘（pending、stale、error、chunk 載入中）是標題命中的篇數（「N title matches」）；項數由內文區 `onStatus` 回報。
 * 防抖與 gate 在這裡（首包）：本元件在搜尋字從空變非空時才掛載，那時通常只有 1 個字（tooShort，不發）；lazy 元件之後掛掛卸卸
 * 都只吃 `debounced` 這個 prop，不會一掛載就用當下的字發請求。要不要掛 lazy 看**當下**的字，發不發看 `debounced`
 * ——chunk 下載與防抖同時進行。已知例外：整段字一次貼進空的搜尋框，掛載時 `debounced` 就是那段字，立刻發一次。
 * noMatch：gate 不是 search（只打空白、1 個字、太長）時只看標題；gate 是 search 時由內文區在「內文查詢已成功回空」後顯示。
 * `/api/notes` 載入中或失敗時（下面的提前 return）內文區也不出現——刻意的，內文區要用清單做交叉比對。 */
export function SearchResults({ query }: { query: string }) {
  const { t } = useTranslation();
  const notesQuery = useNotes();
  const groupsQuery = useGroups();
  const foldersQuery = useFolders();
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const { activeNoteId, setActiveNoteId } = useActiveNote();
  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, BODY_SEARCH_DEBOUNCE_MS);
  const gate = bodySearchGate(query);
  // 列出的項數由內文區（lazy）回報；它沒好（pending／error／stale／還在載入）時 null ＝ 只顯示標題命中的篇數。
  const [bodyStatus, setBodyStatus] = useState<{ count: number; more: boolean } | null>(null);

  // 三種狀態共用同一個 flex-1 容器（下方按鈕不跳位）；`role="status"` 在 pending／loaded 間不重生（空內容時先掛著）。
  if (notesQuery.isPending || notesQuery.isError) {
    const err = notesQuery.error;
    return (
      <div data-testid="sidebar-search" className="flex min-h-0 flex-1 flex-col">
        <p role="status" className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground" />
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
  const results = notesQuery.data.filter((note) => note.title.toLowerCase().includes(lowerQuery));
  const groupIds = new Set((groupsQuery.data ?? []).map((group) => group.id));
  // 不等 ["folders"]：沒到時路徑行只缺資料夾段。
  const location = { groupIds, folders: folderIndex };

  const statusText =
    gate === "search" && bodyStatus !== null
      ? t(bodyStatus.more ? "sidebar.matchesCountMore" : "sidebar.matchesCount", { count: bodyStatus.count })
      : t("sidebar.titleMatches", { count: results.length });
  const titleRows = (
    <TitleRows notes={results} location={location} lowerQuery={lowerQuery} activeNoteId={activeNoteId} onPick={setActiveNoteId} />
  );

  return (
    <div data-testid="sidebar-search" className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {statusText}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
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
              notes={notesQuery.data}
              location={location}
              onStatus={setBodyStatus}
            />
          </SidebarLazyBoundary>
        )}
      </div>
    </div>
  );
}
