import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ShareDto, ShareRole } from "@knotebook/shared";
import { api } from "./client";

/**
 * 分享名單（owner-only：`GET /api/notes/:id/shares` 對非 owner 回 403/404，見
 * `routes/notes.ts`）。呼叫端（`ShareDialog`）只在 dialog 實際開啟時掛載讀這支
 * hook 的元件，藉由元件掛載/卸載自然達成「沒開 dialog 就不打這支 API」，不需要
 * 額外的 `enabled` 旗標。
 */
export function useShares(noteId: string): UseQueryResult<ShareDto[]> {
  return useQuery({
    queryKey: ["shares", noteId],
    queryFn: () => api<ShareDto[]>(`/api/notes/${encodeURIComponent(noteId)}/shares`),
    enabled: noteId.length > 0,
  });
}

/**
 * `PUT /api/notes/:id/shares`——新增分享與改角色共用同一支（upsert 語意，見
 * server 端 `onConflictDoUpdate`）。body 用 **email**，不是 userId（server 靠
 * email 查目標使用者；契約逐字見 task brief／routes/notes.ts 的
 * `putShareBodySchema`）。
 */
export function usePutShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: ShareRole }) =>
      api<ShareDto>(`/api/notes/${encodeURIComponent(noteId)}/shares`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["shares", noteId] });
    },
  });
}

/**
 * `DELETE /api/notes/:id/shares/:userId`——移除分享（撤權）。server 端會呼叫
 * `onShareChanged` 觸發 Task 13 的共編重驗；client 這裡除了打這支 API、
 * invalidate 分享名單快取之外不需要再做任何事——被撤權那位使用者的畫面反應
 * 是他自己那台 client 的 `useCollab` 狀態機負責的（見 NotePage 的終態處理）。
 */
export function useDeleteShare(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/notes/${encodeURIComponent(noteId)}/shares/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["shares", noteId] });
    },
  });
}
