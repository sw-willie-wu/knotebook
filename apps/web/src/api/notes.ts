import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { BacklinkDto, NoteDto } from "@knotebook/shared";
import { api } from "./client";

export function useNotes(): UseQueryResult<NoteDto[]> {
  return useQuery({
    queryKey: ["notes"],
    queryFn: () => api<NoteDto[]>("/api/notes"),
  });
}

/**
 * `GET /api/notes/:ref`。#122 起 NotePage 用它扮兩個角色（spec §3b）：
 * - **解析層**（ref＝路由參數，slug 或 uuid）：`enabled` 由呼叫端以 paramsKey 判斷
 *   控制——只在真導航（key 不等）時打，replaceState 不動 params 就不重解析；
 * - **常駐層**（ref＝解析出的 id）：key 以 id 為錨永不過時，refetch/invalidate 全清
 *   都安全。`ref.length > 0` 的守衛同時吃掉「尚未解析完成」的空字串（A11：不打
 *   `/api/notes/undefined`）。
 *
 * ⚠ **禁止加 `placeholderData`/`keepPreviousData`**（即使是為了消掉轉場的 loading
 * 閃爍）：NotePage 的 seed effect 依賴「`resolveQuery.data` 必屬當下這組 ref」——
 * 給了 placeholder，導航瞬間 data 會是**上一篇**的 note，seed 會寫出
 * `{key: 新, id: 舊}`，頁面停在錯的筆記上、網址卻是新的，而且沒有測試會紅（A4）。
 */
export function useNote(ref: string, options: { enabled?: boolean } = {}): UseQueryResult<NoteDto> {
  return useQuery({
    queryKey: ["note", ref],
    queryFn: () => api<NoteDto>(`/api/notes/${encodeURIComponent(ref)}`),
    enabled: (options.enabled ?? true) && ref.length > 0,
  });
}

/**
 * `GET /api/notes/by-path/:handle/:slug`——`/n/<handle>/<slug>` 新形網址的解析層
 * （#122 spec §3b）。query key 含 handle 與 slug（A4：data 必屬當下這組 params）；
 * `useNote` 的 placeholderData 禁令同樣適用於此（同一個 seed effect 消費）。
 */
export function useNoteByPath(
  handle: string,
  slug: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<NoteDto> {
  return useQuery({
    queryKey: ["note-by-path", handle, slug],
    queryFn: () => api<NoteDto>(`/api/notes/by-path/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`),
    enabled: (options.enabled ?? true) && handle.length > 0 && slug.length > 0,
  });
}

/**
 * 反向連結（Task 6a `GET /api/notes/:id/backlinks` → `{backlinks: BacklinkDto[]}`）。
 * `enabled: !!noteId`——與 `useNote` 的 `ref.length > 0` 同用意：`NotePage` 在 note
 * 還沒載完時 `noteId` 是 `undefined`，不該對 `/undefined/backlinks` 發請求。
 * React Query 預設 `refetchOnWindowFocus: true`（見 `main.tsx` 的 `new QueryClient()`
 * 未覆寫這個選項），已滿足「focus refetch」——不需要在這裡額外指定。
 */
export function useBacklinks(noteId: string | undefined): UseQueryResult<BacklinkDto[]> {
  return useQuery({
    queryKey: ["backlinks", noteId],
    queryFn: async () => {
      const { backlinks } = await api<{ backlinks: BacklinkDto[] }>(
        `/api/notes/${encodeURIComponent(noteId!)}/backlinks`,
      );
      return backlinks;
    },
    enabled: !!noteId,
  });
}

export function useCreateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: { title?: string }) =>
      api<NoteDto>("/api/notes", {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["note", id] });
    },
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; title?: string; slug?: string | null }) =>
      api<NoteDto>(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["note", variables.id] });
      if (data?.id && data.id !== variables.id) {
        void queryClient.invalidateQueries({ queryKey: ["note", data.id] });
      }
    },
  });
}
