import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import {
  TRASH_BATCH_MAX,
  type NoteDto,
  type TrashListDto,
  type TrashPurgeResultDto,
  type TrashRestoreResultDto,
  type TrashSettingsDto,
} from "@knotebook/shared";
import { api, ApiFail } from "./client";

/**
 * #181 垃圾桶（spec 2026-10-21 §6.3.4–§6.3.5、§6.7、§6.10）的 client 資料層。
 * - 還原／永久刪除用純函式（`restoreTrashIds`／`purgeTrashIds`），hook 只是包一層：toast 的「復原」在筆記選單卸載之後才會被按，
 *   卸載後 `useMutation` 的 per-call 回呼不跑，所以呼叫端拿建立 toast 時捕捉的 `queryClient` 直接呼叫純函式（讀碼發現 5）。
 * - 清空＝把清單上全部 id 送 purge（spec §6.3.4-5）：只刪使用者看到的那批，之後才移入的不受影響。
 * - 每批 ≤ `TRASH_BATCH_MAX`、依序送；任一批失敗就停（409 `server_busy` 照一般錯誤處理），丟 `TrashBatchError` 帶已完成的部分。
 */

export const TRASH_QUERY_KEY = ["trash"] as const;
export const TRASH_SETTINGS_QUERY_KEY = ["admin", "trash-settings"] as const;

export function useTrash(): UseQueryResult<TrashListDto> {
  return useQuery({ queryKey: TRASH_QUERY_KEY, queryFn: () => api<TrashListDto>("/api/trash") });
}

export function chunkIds(ids: readonly string[], size: number = TRASH_BATCH_MAX): string[][] {
  if (!(size >= 1)) throw new RangeError(`chunkIds: size must be ≥ 1 (got ${size})`);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** 分批送出中途失敗：`cause` 是那一批的錯誤，`partial` 是之前已成功各批的串接結果。 */
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

/** 讀碼發現 27：還原成功的每篇蓋回常駐層（setQueryData(["note", id], note)），清掉移入時留下的 404 error 態。 */
export function seedRestoredNotes(queryClient: QueryClient, restored: readonly NoteDto[]): void {
  for (const note of restored) queryClient.setQueryData(["note", note.id], note);
}

/** 錯誤 → toast 標題；TrashBatchError 取 cause。 */
export function trashErrorCause(err: unknown): unknown {
  return err instanceof TrashBatchError ? err.cause : err;
}

/** 移入／還原／永久刪除之後（不論成敗）要失效的 key（spec §6.10.1）。解析層前綴讓開著的「在垃圾桶裡」卡片在別處還原後重抓。 */
export function invalidateTrashRelated(queryClient: QueryClient, ids: readonly string[]): void {
  void queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  // 資料夾 spec §6.12：還原會照原路徑重建資料夾
  void queryClient.invalidateQueries({ queryKey: ["folders"] });
  void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
  for (const id of ids) void queryClient.invalidateQueries({ queryKey: ["note", id] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-path"] });
  void queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] });
  // 舊形 `/notes/:ref`（slug 或 `<vanity>-<uuid>`）的解析層 key 是 `["note", ref]`，前綴比對涵蓋不到；
  // 改認「停在 404 in_trash、noteId 是這批之一」的那幾支（noteId 由 server 給、小寫）。
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
    onError: (err) => {
      if (err instanceof TrashBatchError) seedRestoredNotes(queryClient, (err as TrashBatchError<TrashRestoreResultDto>).partial.restored);
    },
    onSettled: (_data, _err, ids) => invalidateTrashRelated(queryClient, ids),
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

/** PATCH 站台保留天數（requireAdmin）；清單的 `retentionDays`（底部說明）跟著變，所以失效 `["trash"]`。 */
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
