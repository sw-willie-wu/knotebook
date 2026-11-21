import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { NoteDto, NoteTagDto, NoteTagsDto, SpaceTagDto, TagColor } from "@knotebook/shared";
import { api } from "./client";
import { spaceTagsKey, type TagSpaceRef } from "./tag-keys";

export { spaceTagsKey, type TagSpaceRef };

const EMPTY_TAGS: NoteTagDto[] = [];

export function tagSpaceOfNote(note: Pick<NoteDto, "groupId">): TagSpaceRef {
  return note.groupId === null ? { kind: "personal" } : { kind: "group", groupId: note.groupId };
}

export function useSpaceTags(space: TagSpaceRef, options: { enabled?: boolean } = {}): UseQueryResult<SpaceTagDto[]> {
  return useQuery({
    queryKey: spaceTagsKey(space),
    queryFn: () =>
      api<SpaceTagDto[]>(space.kind === "personal" ? "/api/tags" : `/api/groups/${encodeURIComponent(space.groupId)}/tags`),
    enabled: options.enabled ?? true,
  });
}

/** Subscribes to `["notes"]` (the sidebar's list); undefined until it has loaded or when the note is not in it. */
export function useNoteTags(noteId: string): NoteTagDto[] | undefined {
  const query = useQuery({
    queryKey: ["notes"],
    queryFn: () => api<NoteDto[]>("/api/notes"),
    // This observer only reads rows out of a list that is already loaded; mounting it must not fetch the whole list again.
    refetchOnMount: false,
    select: (list: NoteDto[]) => {
      const row = list.find((n) => n.id === noteId);
      return row === undefined ? undefined : (row.tags ?? EMPTY_TAGS);
    },
  });
  return query.data;
}

/**
 * Cancels first: a list request issued before this write would otherwise land afterwards and overwrite the new tags.
 * The refetch afterwards starts after the write succeeded, so it returns the same tags and only picks up other changes.
 */
export async function patchNoteTagsInList(queryClient: QueryClient, noteId: string, tags: NoteTagDto[]): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ["notes"], exact: true });
  queryClient.setQueryData<NoteDto[]>(["notes"], (list) => list?.map((n) => (n.id === noteId ? { ...n, tags } : n)));
  void queryClient.invalidateQueries({ queryKey: ["notes"], exact: true });
}

export function useAddNoteTag(): UseMutationResult<NoteTagsDto, unknown, { noteId: string; name: string; space: TagSpaceRef }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, name }) =>
      api<NoteTagsDto>(`/api/notes/${encodeURIComponent(noteId)}/tags`, { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: async ({ tags }, { noteId, space }) => {
      await patchNoteTagsInList(queryClient, noteId, tags);
      void queryClient.invalidateQueries({ queryKey: spaceTagsKey(space) });
    },
  });
}

export function useRemoveNoteTag(): UseMutationResult<NoteTagsDto, unknown, { noteId: string; tagId: string; space: TagSpaceRef }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId, tagId }) =>
      api<NoteTagsDto>(`/api/notes/${encodeURIComponent(noteId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" }),
    onSuccess: async ({ tags }, { noteId, space }) => {
      await patchNoteTagsInList(queryClient, noteId, tags);
      void queryClient.invalidateQueries({ queryKey: spaceTagsKey(space) });
    },
  });
}

/** Renaming, recoloring, merging and deleting change every note that carries the tag, so the notes list is refetched too. */
function invalidateAfterManage(queryClient: QueryClient, space: TagSpaceRef): void {
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  void queryClient.invalidateQueries({ queryKey: spaceTagsKey(space) });
}

export function useUpdateTag(space: TagSpaceRef): UseMutationResult<SpaceTagDto, unknown, { tagId: string; name?: string; color?: TagColor }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, ...patch }) =>
      api<SpaceTagDto>(`/api/tags/${encodeURIComponent(tagId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => invalidateAfterManage(queryClient, space),
  });
}

export function useMergeTag(space: TagSpaceRef): UseMutationResult<SpaceTagDto, unknown, { tagId: string; into: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId, into }) =>
      api<SpaceTagDto>(`/api/tags/${encodeURIComponent(tagId)}/merge`, { method: "POST", body: JSON.stringify({ into }) }),
    onSuccess: () => invalidateAfterManage(queryClient, space),
  });
}

export function useDeleteTag(space: TagSpaceRef): UseMutationResult<void, unknown, { tagId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tagId }) => api<void>(`/api/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAfterManage(queryClient, space),
  });
}
