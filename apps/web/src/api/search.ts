import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { SEARCH_LIMIT_DEFAULT, type NoteSearchHitDto, type NoteSearchResultDto, type UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { bodySearchGate } from "@/components/sidebar/body-search-gate";
import { ApiFail, api } from "./client";

/**
 * #93 PR2：`GET /api/search`。**只被內文區的 lazy chunk import**（`components/sidebar/BodySearchLazy.tsx`）。
 * `URLSearchParams` 組參數（`q` 可能含 `&`、`#`、`%`）。
 */
export function fetchNoteSearch(
  q: string,
  opts: { limit: number; match: "all" | "body"; cursor?: string; signal?: AbortSignal },
): Promise<NoteSearchResultDto> {
  const params = new URLSearchParams({ q, limit: String(opts.limit), match: opts.match });
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  return api<NoteSearchResultDto>(`/api/search?${params.toString()}`, opts.signal ? { signal: opts.signal } : {});
}

export type BodySearchState =
  /** 沒有任何一批可顯示（第一次載入中，或 `debounced` 還沒過 gate）。 */
  | { kind: "pending" }
  /** 第一頁失敗。 */
  | { kind: "error"; rateLimited: boolean }
  | {
      kind: "ready";
      /** 所有已載入頁攤平、以 `note.id` 保留第一次出現（翻頁間改名會讓一篇重出，server 的 keyset 只看值）。 */
      hits: NoteSearchHitDto[];
      /** 產出這一批的搜尋字。片段裁切與標亮用它，不用當下的字（舊批用新字找不到命中，片段會忽長忽短）。 */
      forQuery: string;
      /** 顯示的是舊字的結果（防抖中，或新字的第一頁還在路上）。 */
      stale: boolean;
      /** 已併入 `!stale`：防抖中 key 還是舊的，按下去抓的是舊字的下一頁、照樣扣桶。 */
      hasMore: boolean;
      loadingMore: boolean;
      moreError: null | { rateLimited: boolean };
      /** `moreError` 時再按就是重試。 */
      loadMore: () => void;
    };

type SearchPage = NoteSearchResultDto & { forQuery: string };

const isRateLimited = (err: unknown) => err instanceof ApiFail && err.status === 429;

/**
 * 內文區的查詢。`query`＝當下（trim 後）的搜尋字、`debounced`＝防抖後的字——防抖在首包的 `SearchResults`（plan gate r2 I2），
 * 這裡只吃 prop，元件掛掛卸卸不會重發。
 * - key 帶目前使用者的 id（同 `api/users.ts`：登出不清快取，換人登入不會讀到上一個人的結果）；id 直接讀 session 快取、不訂閱。
 * - `retry: false`：失敗就顯示一行錯誤；search 桶與 MCP 共用每分 60 次，自動重試只會更快撞到 429。
 * - `refetchOnWindowFocus`／`refetchOnReconnect` 關掉：兩者預設開，而無限查詢 refetch 會**逐頁重打**，載入了 N 頁就扣 N 次桶。
 *   已知代價（接受）：同一個字在 30 s 後重新掛載（或 key 失效）時仍會逐頁重抓——同一字 30 s 後重搜不常見。
 * - `placeholderData: keepPreviousData`：換字時沿用上一批（標成 stale），清單不閃。
 */
export function useBodySearch({ query, debounced }: { query: string; debounced: string }): BodySearchState {
  const userId = useQueryClient().getQueryData<UserDto | null>(SESSION_QUERY_KEY)?.id ?? null;
  const q = useInfiniteQuery({
    queryKey: ["noteSearch", userId, debounced, SEARCH_LIMIT_DEFAULT, "body"],
    queryFn: async ({ pageParam, signal }): Promise<SearchPage> => ({
      ...(await fetchNoteSearch(debounced, { limit: SEARCH_LIMIT_DEFAULT, match: "body", cursor: pageParam ?? undefined, signal })),
      forQuery: debounced,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: bodySearchGate(debounced) === "search",
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  });
  const pages = q.data?.pages;
  const hits = useMemo(() => {
    const seen = new Set<string>();
    const out: NoteSearchHitDto[] = [];
    for (const p of pages ?? []) {
      for (const h of p.hits) {
        if (seen.has(h.note.id)) continue;
        seen.add(h.note.id);
        out.push(h);
      }
    }
    return out;
  }, [pages]);
  const { fetchNextPage } = q;
  const loadMore = useMemo(() => () => void fetchNextPage(), [fetchNextPage]);

  if (pages === undefined || pages.length === 0) {
    if (q.isError) return { kind: "error", rateLimited: isRateLimited(q.error) };
    return { kind: "pending" };
  }
  const stale = query !== debounced || q.isPlaceholderData;
  return {
    kind: "ready",
    hits,
    forQuery: pages[0]!.forQuery,
    stale,
    hasMore: q.hasNextPage && !stale,
    loadingMore: q.isFetchingNextPage,
    // 只看「載入更多」那一發的失敗。背景重抓（同一個字 30 s 後重新掛載時逐頁重抓）失敗時不顯示錯誤句、照舊顯示快取的那一批——
    // 接受的代價：畫面上的結果仍是同一個字的，只是可能舊一點。
    moreError: q.isFetchNextPageError ? { rateLimited: isRateLimited(q.error) } : null,
    loadMore,
  };
}
