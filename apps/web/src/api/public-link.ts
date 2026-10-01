import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api } from "./client";

/**
 * `GET/PUT /api/notes/:id/public-link` 的回應形（server 端 routes/notes.ts）。
 * #122 PR3 起帶 `slug`（公開別名）——GET/PUT 都回**全形**：mutation 的 onSuccess
 * 直寫回應進快取，server 少回任一鍵＝快取該鍵被抹成 undefined（公開連結列或
 * 別名列憑空消失），server 測試有釘全形。
 */
export interface PublicLinkDto {
  token: string | null;
  slug: string | null;
}

/**
 * 公開連結狀態。server 只回給 `permissions.managePublicLink` 為真的人（個人筆記＝owner；群組筆記＝角色能管理
 * 公開連結的成員，#175），其餘回 403／404——所以呼叫點只在有這個權限時才帶 noteId（`ShareDialog` 與
 * `GroupNoteShareSection` 沒有時傳空字串，讓 `enabled` 擋住不發；`AccessSection` 只對個人筆記 owner 掛載）。
 * `ShareDialog` 為了選觸發鈕圖示，在筆記頁載入時就發這支（不等 dialog 開啟，見該元件的 docblock）；個人筆記面板（`AccessSection`）的三態 derive 要它與 `useShares` 首次都有資料才算
 * latch 初值（spec §4）。
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

/**
 * `PUT /api/notes/:id/public-link/slug`——設定公開別名（#122 PR3）。server 回
 * `{token, slug}` **全形**，onSuccess 直寫（比照 useCreatePublicLink）——server
 * 若只回 `{slug}`，快取 token 會被抹成 undefined、公開連結列憑空消失（server
 * 測試釘了全形，這裡直寫是安全的）。
 */
export function useSetPublicSlug(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      api<PublicLinkDto>(`/api/notes/${encodeURIComponent(noteId)}/public-link/slug`, {
        method: "PUT",
        body: JSON.stringify({ slug }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["public-link", noteId], data);
    },
  });
}

/**
 * `DELETE /api/notes/:id/public-link/slug`——清別名（204 無 body）。**functional
 * setQueryData：只改 slug、保留 token**（plan gate r5-m1）——照抄下面撤公開的
 * `{token: null, slug: null}` 寫法就是 r4-M1 的同款故障（token 被抹→公開連結列
 * 消失、latch 誤述）。
 */
export function useClearPublicSlug(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/notes/${encodeURIComponent(noteId)}/public-link/slug`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<PublicLinkDto>(["public-link", noteId], (prev) =>
        prev ? { ...prev, slug: null } : prev,
      );
    },
  });
}

/** `DELETE /api/notes/:id/public-link`——撤銷（既有連結立即失效）。server 端同一支
 * UPDATE 連帶清掉公開別名（spec §4「DELETE 清兩者」），快取鏡像必須跟上——
 * 只寫 `{token: null}` 會讓別名殘留在畫面上。 */
export function useDeletePublicLink(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/api/notes/${encodeURIComponent(noteId)}/public-link`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData(["public-link", noteId], { token: null, slug: null } satisfies PublicLinkDto);
    },
  });
}
