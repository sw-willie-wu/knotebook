import { lazy, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { useActiveNote } from "@/lib/active-note";
import { useDebounced } from "@/lib/useDebounced";
import { cn } from "@/lib/utils";
import { BODY_SEARCH_DEBOUNCE_MS, bodySearchGate } from "@/components/sidebar/body-search-gate";
import { indexFolders } from "@/components/sidebar/folder-index";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { noteLocationLabel } from "@/components/sidebar/tree";

// 內文區（#93 PR2）整塊在 lazy chunk（D18）；唯一入口見 BodySearchLazy.tsx。
const BodySearchResults = lazy(() => import("@/components/sidebar/BodySearchLazy").then((m) => ({ default: m.BodySearchResults })));

/**
 * 標題裡第一個命中的子字串包 `<mark>`（spec §5.4）。`toLowerCase()` 會改變長度的標題
 * （如 `İ`→`i̇`）位置對不回原字串——此時不標、照原字顯示；找不到也照原字。
 */
export function highlightTitle(title: string, lowerQuery: string): ReactNode {
  const lower = title.toLowerCase();
  if (lower.length !== title.length) return title;
  const index = lower.indexOf(lowerQuery);
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

/** 搜尋視圖：標題小寫子字串、跨所有 tab 的扁平清單（server 順序），每列兩行（標題＋位置）。
 * 比對一律字面子字串（不經正規式）。
 *
 * #93 PR2：標題清單下面接「內文符合」區（lazy，`BodySearchLazy`），兩區共用同一個捲動容器；計數那行（`role="status"`）留在容器外。
 * 防抖與 gate 在這裡（首包）：本元件在搜尋字從空變非空時才掛載，那時通常只有 1 個字（tooShort，不發）；lazy 元件之後掛掛卸卸
 * 都只吃 `debounced` 這個 prop，不會一掛載就用當下的字發請求（plan gate r2 I2）。要不要掛 lazy 看**當下**的字，發不發看 `debounced`
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
  // 不等 ["folders"]：沒到時路徑行只缺資料夾段（讀碼發現 3）。
  const location = { groupIds, folders: folderIndex };

  return (
    <div data-testid="sidebar-search" className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {t("sidebar.titleMatches", { count: results.length })}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {results.length > 0 && (
          <ul className="space-y-0.5">
            {results.map((note) => {
              const active = activeNoteId === note.id;
              const label = noteLocationLabel(note, location, t);
              return (
                <li key={note.id} data-node-kind="note" data-node-id={note.id}>
                  <Link
                    to={canonicalNotePath(note)}
                    onClick={(event) => {
                      // 與 NoteRow 同一條規則：只有 plain left-click 才樂觀 set。
                      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                        setActiveNoteId(note.id);
                      }
                    }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block min-w-0 rounded-md px-2 py-1.5 hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
                      active && "bg-brand-soft text-brand-on-soft hover:bg-brand-soft-strong",
                    )}
                  >
                    {/* 兩行一律 <div>：可及名稱靠 UA 預設 block 之間補空白（jsdom 不載 Tailwind，span 會黏成「標題位置」）。 */}
                    <div className={cn("truncate text-[13px]", active && "font-medium")}>{highlightTitle(note.title, lowerQuery)}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={label}>
                      {label}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {gate !== "search" && results.length === 0 && <p className="px-2 py-2 text-sm text-muted-foreground">{t("sidebar.noMatch")}</p>}
        {gate === "tooShort" && <p className="px-2 py-2 text-[11px] text-muted-foreground">{t("sidebar.bodySearchTooShort")}</p>}
        {gate === "tooLong" && <p className="px-2 py-2 text-[11px] text-muted-foreground">{t("sidebar.bodySearchTooLong")}</p>}
        {gate === "search" && (
          <SidebarLazyBoundary
            chunk="bodySearch"
            fallback={<p className="px-2 pt-3 text-[11px] text-muted-foreground">{t("sidebar.bodySearching")}</p>}
          >
            <BodySearchResults query={trimmed} debounced={debounced} titleCount={results.length} notes={notesQuery.data} location={location} />
          </SidebarLazyBoundary>
        )}
      </div>
    </div>
  );
}
