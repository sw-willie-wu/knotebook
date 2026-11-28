import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import {
  TRASH_BATCH_MAX,
  type NoteDto,
  type TrashListDto,
  type TrashPreviewDto,
  type TrashPurgeResultDto,
  type TrashRestoreResultDto,
  type TrashSettingsDto,
} from "@knotebook/shared";
import { expandAfterRestore } from "@/components/sidebar/folder-index";
import { api, ApiFail } from "./client";

export const TRASH_QUERY_KEY = ["trash"] as const;
export const TRASH_SETTINGS_QUERY_KEY = ["admin", "trash-settings"] as const;

/** Under `TRASH_QUERY_KEY` so `invalidateTrashRelated` also refetches open previews. */
export function trashPreviewKey(noteId: string) {
  return ["trash", "preview", noteId] as const;
}

export function useTrash(): UseQueryResult<TrashListDto> {
  return useQuery({ queryKey: TRASH_QUERY_KEY, queryFn: () => api<TrashListDto>("/api/trash") });
}

export function useTrashPreview(noteId: string, opts?: { enabled?: boolean }): UseQueryResult<TrashPreviewDto> {
  return useQuery({
    queryKey: trashPreviewKey(noteId),
    queryFn: () => api<TrashPreviewDto>(`/api/trash/${encodeURIComponent(noteId)}`),
    enabled: (opts?.enabled ?? true) && noteId.length > 0,
    retry: false,
  });
}

export function chunkIds(ids: readonly string[], size: number = TRASH_BATCH_MAX): string[][] {
  if (!(size >= 1)) throw new RangeError(`chunkIds: size must be ≥ 1 (got ${size})`);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export class TrashBatchError<T> extends Error {
  readonly cause: unknown;
  readonly partial: T;

  constructor(cause: unknown, partial: T) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TrashBatchError";
    this.cause = cause;
    this.partial = partial;
  }
}

async function postInBatches<T>(path: string, ids: readonly string[], empty: () => T, merge: (acc: T, next: T) => void): Promise<T> {
  const result = empty();
  for (const chunk of chunkIds(ids)) {
    let next: T;
    try {
      next = await api<T>(path, { method: "POST", body: JSON.stringify({ ids: chunk }) });
    } catch (err) {
      throw new TrashBatchError(err, result);
    }
    merge(result, next);
  }
  return result;
}

/** Plain functions, not hooks: the toast's undo runs after the note menu unmounts, when per-call `useMutation`
 * callbacks no longer fire. */
export function restoreTrashIds(ids: readonly string[]): Promise<TrashRestoreResultDto> {
  return postInBatches<TrashRestoreResultDto>(
    "/api/trash/restore",
    ids,
    () => ({ restored: [], skipped: [] }),
    (acc, next) => {
      acc.restored.push(...next.restored);
      acc.skipped.push(...next.skipped);
    },
  );
}

/** Emptying the trash purges only the listed ids, so notes trashed afterwards survive. */
export function purgeTrashIds(ids: readonly string[]): Promise<TrashPurgeResultDto> {
  return postInBatches<TrashPurgeResultDto>(
    "/api/trash/purge",
    ids,
    () => ({ purged: [], skipped: [] }),
    (acc, next) => {
      acc.purged.push(...next.purged);
      acc.skipped.push(...next.skipped);
    },
  );
}

/** Also clears the 404 error state the note query got when the note was trashed. */
export function seedRestoredNotes(queryClient: QueryClient, restored: readonly NoteDto[]): void {
  for (const note of restored) queryClient.setQueryData(["note", note.id], note);
}

export function partialRestored(err: unknown): NoteDto[] {
  return err instanceof TrashBatchError ? (err as TrashBatchError<TrashRestoreResultDto>).partial.restored : [];
}

export function trashErrorCause(err: unknown): unknown {
  return err instanceof TrashBatchError ? err.cause : err;
}

export function invalidateTrashRelated(queryClient: QueryClient, ids: readonly string[]): void {
  void queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  // Restore recreates folders on the original path.
  void queryClient.invalidateQueries({ queryKey: ["folders"] });
  // The server filters trashed notes out of favorites; invalidating `["notes"]` alone won't bring them back.
  void queryClient.invalidateQueries({ queryKey: ["favorites"] });
  void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
  for (const id of ids) void queryClient.invalidateQueries({ queryKey: ["note", id] });
  // Resolver keys too, so an open in-trash card refetches after a restore elsewhere.
  void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] });
  // Legacy `/notes/:ref` keys are `["note", ref]`, which a prefix can't reach; match queries stuck on
  // 404 in_trash for one of these ids instead (the server sends `noteId` lowercased).
  const idSet = new Set(ids);
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const err = query.state.error;
      return query.queryKey[0] === "note" && err instanceof ApiFail && err.code === "in_trash" && err.noteId !== undefined && idSet.has(err.noteId);
    },
  });
}

export function useRestoreTrash(): UseMutationResult<TrashRestoreResultDto, unknown, readonly string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[]) => restoreTrashIds(ids),
    onSuccess: (result) => seedRestoredNotes(queryClient, result.restored),
    onError: (err) => seedRestoredNotes(queryClient, partialRestored(err)),
    onSettled: (data, err, ids) => {
      invalidateTrashRelated(queryClient, ids);
      // Must run after the invalidation (see expandAfterRestore); also expands notes restored before a batch failed.
      void expandAfterRestore(queryClient, data?.restored ?? partialRestored(err));
    },
  });
}

export function usePurgeTrash(): UseMutationResult<TrashPurgeResultDto, unknown, readonly string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[]) => purgeTrashIds(ids),
    onSettled: (_data, _err, ids) => invalidateTrashRelated(queryClient, ids),
  });
}

export function useTrashSettings(): UseQueryResult<TrashSettingsDto> {
  return useQuery({ queryKey: TRASH_SETTINGS_QUERY_KEY, queryFn: () => api<TrashSettingsDto>("/api/admin/trash/settings") });
}

/** The trash list shows retentionDays (footer note), so this also invalidates ["trash"]. */
export function useUpdateTrashSettings(): UseMutationResult<TrashSettingsDto, unknown, TrashSettingsDto> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TrashSettingsDto) =>
      api<TrashSettingsDto>("/api/admin/trash/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(TRASH_SETTINGS_QUERY_KEY, updated);
      void queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
    },
  });
}
