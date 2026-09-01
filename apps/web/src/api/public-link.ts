import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api } from "./client";

/** `GET /api/notes/:id/public-link` 的回應形（server 端 routes/notes.ts）。 */
export interface PublicLinkDto {
  token: string | null;
}

/**
 * 公開連結狀態（owner-only）。與 `useShares` 同一套掛載時機慣例：`ShareDialog`
 * 只在開啟時掛載讀這支的元件，dialog 沒開就不打 API。**開啟即 GET** 是三態
 * derive 的前提（spec §4：latch 要兩個 query 首次都有資料才算初值）。
 */
export function usePublicLink(noteId: string): UseQueryResult<PublicLinkDto> {
  return useQuery({
    queryKey: ["public-link", noteId],
    queryFn: () => api<PublicLinkDto>(`/api/notes/${encodeURIComponent(noteId)}/public-link`),
    enabled: noteId.length > 0,
  });
}

/**
 * `PUT /api/notes/:id/public-link`——產生**或重生**（server 語意：每次都重生，
 * 非冪等；client 慣例是「選公開時 token 為 null 才 PUT」，重生鈕才是刻意再 PUT）。
 * onSuccess 直接把回應寫進快取（不 invalidate 重抓——省一趟，也讓 sticky 選擇態
 * 不經歷多餘的 refetch）。
 */
export function useCreatePublicLink(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<PublicLinkDto>(`/api/notes/${encodeURIComponent(noteId)}/public-link`, { method: "PUT" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["public-link", noteId], data);
    },
  });
}

/** `DELETE /api/notes/:id/public-link`——撤銷（既有連結立即失效）。 */
export function useDeletePublicLink(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/notes/${encodeURIComponent(noteId)}/public-link`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData(["public-link", noteId], { token: null } satisfies PublicLinkDto);
    },
  });
}
