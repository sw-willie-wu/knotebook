import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
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
    mutationFn: ({ id, ...patch }: { id: string; title?: string; slug?: string }) =>
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
