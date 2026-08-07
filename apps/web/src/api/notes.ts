import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { BacklinkDto, NoteDto } from "@knotebook/shared";
import { api } from "./client";

export function useNotes(): UseQueryResult<NoteDto[]> {
  return useQuery({
    queryKey: ["notes"],
    queryFn: () => api<NoteDto[]>("/api/notes"),
  });
}

export function useNote(ref: string): UseQueryResult<NoteDto> {
  return useQuery({
    queryKey: ["note", ref],
    queryFn: () => api<NoteDto>(`/api/notes/${encodeURIComponent(ref)}`),
    enabled: ref.length > 0,
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
