import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { FavoriteDto } from "@knotebook/shared";
import { api } from "./client";

/**
 * #334 最愛的 client 資料層。`["favorites"]` 只存「哪幾篇、何時加的」，標題與位置由呼叫端從 `["notes"]` 取。
 * - 加入是樂觀的；移出等 204 才從快取濾掉（移出一律先確認，不需要即時反應）。
 * - 加入與移出共用一個 mutation key，讓「這一篇是否送出中」與「還有沒有別的切換在送」查得到。
 * - 錯誤由呼叫端出 toast：不同入口的文案不同。
 */

export const FAVORITES_QUERY_KEY = ["favorites"] as const;
const FAVORITE_SET_KEY = ["favorites", "set"] as const;

interface FavoriteVars {
  noteId: string;
}

// 不設 staleTime：與其他清單一樣靠預設的「切回視窗重抓」跟上別的分頁的變動。
export function useFavorites(options: { enabled?: boolean } = {}): UseQueryResult<FavoriteDto[]> {
  return useQuery({
    queryKey: FAVORITES_QUERY_KEY,
    queryFn: () => api<FavoriteDto[]>("/api/favorites"),
    enabled: options.enabled ?? true,
  });
}

/** 與 server 的清單同一個順序：加入時間新到舊，同一毫秒時 noteId 大的在前。 */
function sortFavorites(list: FavoriteDto[]): FavoriteDto[] {
  return list.sort((a, b) => {
    if (a.favoritedAt !== b.favoritedAt) return a.favoritedAt < b.favoritedAt ? 1 : -1;
    if (a.noteId === b.noteId) return 0;
    return a.noteId < b.noteId ? 1 : -1;
  });
}

function updateFavorites(queryClient: QueryClient, update: (list: FavoriteDto[]) => FavoriteDto[]): void {
  queryClient.setQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY, (old) => (old === undefined ? old : update(old)));
}

/**
 * 只在沒有別的最愛切換在送出中時重抓。settled 時自己仍算在送出中，所以條件是 1：
 * A 還在送、B 已完成時若重抓，回來的清單沒有 A，會把 A 的樂觀狀態蓋回去。
 */
function invalidateIfLast(queryClient: QueryClient): void {
  if (queryClient.isMutating({ mutationKey: FAVORITE_SET_KEY }) === 1) {
    void queryClient.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY });
  }
}

export function useAddFavorite(): UseMutationResult<FavoriteDto, unknown, FavoriteVars, { inserted: boolean }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: FAVORITE_SET_KEY,
    mutationFn: ({ noteId }: FavoriteVars) => api<FavoriteDto>(`/api/favorites/${encodeURIComponent(noteId)}`, { method: "PUT" }),
    onMutate: async ({ noteId }) => {
      // exact：只停清單自己的重抓，免得它回來蓋掉樂觀列。
      await queryClient.cancelQueries({ queryKey: FAVORITES_QUERY_KEY, exact: true });
      const before = queryClient.getQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY);
      const inserted = before !== undefined && !before.some((f) => f.noteId === noteId);
      if (inserted) {
        updateFavorites(queryClient, (list) => sortFavorites([...list, { noteId, favoritedAt: new Date().toISOString() }]));
      }
      return { inserted };
    },
    onError: (_err, { noteId }, context) => {
      // 只撤自己插入的那一篇，不整份還原：同時完成的移出若被蓋回來，那篇會重新出現。
      if (context?.inserted) updateFavorites(queryClient, (list) => list.filter((f) => f.noteId !== noteId));
    },
    onSuccess: (row) => {
      // upsert 而不是就地替換：送出中若有重抓蓋掉了樂觀列，這裡把它補回來。
      updateFavorites(queryClient, (list) => sortFavorites([...list.filter((f) => f.noteId !== row.noteId), row]));
    },
    onSettled: () => invalidateIfLast(queryClient),
  });
}

export function useRemoveFavorite(): UseMutationResult<void, unknown, FavoriteVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: FAVORITE_SET_KEY,
    mutationFn: ({ noteId }: FavoriteVars) => api<void>(`/api/favorites/${encodeURIComponent(noteId)}`, { method: "DELETE" }),
    onSuccess: (_data, { noteId }) => updateFavorites(queryClient, (list) => list.filter((f) => f.noteId !== noteId)),
    onSettled: () => invalidateIfLast(queryClient),
  });
}

/**
 * 一篇筆記的最愛狀態。`ready`＝清單查詢成功（還沒到或失敗時呼叫端停用入口）；
 * `pending`＝這一篇有加入或移出在送出中（重開選單也看得到，避免交錯送出）。
 */
export function useFavoriteStatus(noteId: string): { ready: boolean; favorite: boolean; pending: boolean } {
  const query = useFavorites();
  const pendingFor = useMutationState({
    filters: {
      mutationKey: FAVORITE_SET_KEY,
      status: "pending",
      predicate: (mutation) => (mutation.state.variables as FavoriteVars | undefined)?.noteId === noteId,
    },
    select: (mutation) => mutation.mutationId,
  });
  return {
    ready: query.isSuccess,
    // 跟著 ready：讀取失敗時快取裡雖然還有舊清單，入口要顯示成「加入最愛」、未按下。
    favorite: query.isSuccess && (query.data?.some((f) => f.noteId === noteId) ?? false),
    pending: pendingFor.length > 0,
  };
}
