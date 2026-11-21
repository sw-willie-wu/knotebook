import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { SEARCH_LIMIT_DEFAULT, type NoteSearchHitDto, type NoteSearchResultDto, type UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { bodySearchGate } from "@/components/sidebar/body-search-gate";
import { ApiFail, api } from "./client";

// Keep this module inside the lazy body-search chunk (imported via BodySearchResults, re-exported by BodySearchLazy);
// a static import from the main bundle would pull it back in.

export function fetchNoteSearch(
  q: string,
  opts: { limit: number; match: "all" | "body"; cursor?: string; tagIds?: readonly string[]; signal?: AbortSignal },
): Promise<NoteSearchResultDto> {
  const params = new URLSearchParams({ q, limit: String(opts.limit), match: opts.match });
  if (opts.tagIds !== undefined && opts.tagIds.length > 0) params.set("tags", opts.tagIds.join(","));
  if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
  return api<NoteSearchResultDto>(`/api/search?${params.toString()}`, opts.signal ? { signal: opts.signal } : {});
}

export type BodySearchState =
  /** First load, or the debounced text hasn't passed the gate. */
  | { kind: "pending" }
  | { kind: "error"; rateLimited: boolean; invalidTags: boolean }
  | {
      kind: "ready";
      /** Deduped by `note.id`: a rename between pages can repeat a note (the server's keyset only looks at values). */
      hits: NoteSearchHitDto[];
      /** Snippets and highlights use this, not the current query: an old batch has no hits for the new text. */
      forQuery: string;
      /** Showing the old query's results (debouncing, or the new query's first page is in flight). */
      stale: boolean;
      /** Includes `!stale`: while debouncing the key is still the old query, so a click would fetch (and count against the rate limit) its next page. */
      hasMore: boolean;
      loadingMore: boolean;
      moreError: null | { rateLimited: boolean };
      loadMore: () => void;
    };

type SearchPage = NoteSearchResultDto & { forQuery: string };

const NO_TAG_IDS: readonly string[] = [];

const isRateLimited = (err: unknown) => err instanceof ApiFail && err.status === 429;
const isInvalidTags = (err: unknown) => err instanceof ApiFail && err.code === "invalid_tags";

/** Debouncing is done by the caller (`SearchResults`), so remounts don't refire. Key includes the user id: logout doesn't
 * clear the cache. `retry: false`: the search rate limit (60/min, shared with MCP) would only be hit sooner. No focus/reconnect
 * refetch: an infinite query refetches every loaded page, each counting against the rate limit. Known cost: remounting the
 * same query after 30 s (or an invalidated key) still refetches every page. `keepPreviousData` keeps the last batch (marked
 * stale) while the query changes, so the list doesn't flash. */
export function useBodySearch({ query, debounced, tagIds = NO_TAG_IDS }: { query: string; debounced: string; tagIds?: readonly string[] }): BodySearchState {
  const userId = useQueryClient().getQueryData<UserDto | null>(SESSION_QUERY_KEY)?.id ?? null;
  const q = useInfiniteQuery({
    // The tag part is added only when tags are used, so the key of a plain search is the same as before.
    queryKey: [
      "noteSearch", userId, debounced, SEARCH_LIMIT_DEFAULT, "body",
      ...(tagIds.length === 0 ? [] : [[...tagIds].sort().join(",")]),
    ],
    queryFn: async ({ pageParam, signal }): Promise<SearchPage> => ({
      ...(await fetchNoteSearch(debounced, { limit: SEARCH_LIMIT_DEFAULT, match: "body", cursor: pageParam ?? undefined, tagIds, signal })),
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
    if (q.isError) return { kind: "error", rateLimited: isRateLimited(q.error), invalidTags: isInvalidTags(q.error) };
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
    // Only a failed load-more shows an error; a failed background refetch keeps showing the cached pages.
    moreError: q.isFetchNextPageError ? { rateLimited: isRateLimited(q.error) } : null,
    loadMore,
  };
}
