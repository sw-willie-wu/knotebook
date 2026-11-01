import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { FOLDER_DEPTH_MAX, type FolderDeleteResultDto, type FolderDto, type FolderListDto, type FolderSpaceDto, type NoteDto } from "@knotebook/shared";
import { api, ApiFail } from "./client";

/**
 * 資料夾的 client 資料層（資料夾 spec §5.11、§6.15）。`GET /api/folders` 一次回全部、不是樹序，樹在
 * `components/sidebar/folder-index.ts` 組。失效一律 fire-and-forget（不回傳 promise）。
 */

export const FOLDERS_QUERY_KEY = ["folders"] as const;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** GET /api/folders → `.folders`（不是樹序，見 folder-index）。`useFolders` 與還原後展開（`expandAfterRestore`）共用。 */
export async function fetchFolders(): Promise<FolderDto[]> {
  return (await api<FolderListDto>("/api/folders")).folders;
}

export function useFolders(): UseQueryResult<FolderDto[]> {
  return useQuery({ queryKey: FOLDERS_QUERY_KEY, queryFn: fetchFolders });
}

/** spec §6.15：資料夾 CRUD 之後；`trash: true` 給改名、刪資料夾（M14：垃圾桶項目的 folderPath 會變）。 */
export function invalidateFolderRelated(queryClient: QueryClient, opts: { trash?: boolean } = {}): void {
  void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  if (opts.trash === true) void queryClient.invalidateQueries({ queryKey: ["trash"] });
}

export type CreateFolderInput = { name: string; parentId: string } | { name: string; space: FolderSpaceDto };

/** POST /api/folders：子資料夾帶 `parentId`、根層帶 `space`（server body 二擇一、`.strict()`）。 */
export function createFolderRequest(input: CreateFolderInput): Promise<FolderDto> {
  return api<FolderDto>("/api/folders", { method: "POST", body: JSON.stringify(input) });
}

/** PATCH /api/folders/:id { name }。 */
export function renameFolderRequest(id: string, name: string): Promise<FolderDto> {
  return api<FolderDto>(`/api/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

/** PUT /api/notes/:id/folder { folderId }（null＝根層；只有這支收 null）。 */
export function placeNoteRequest(noteId: string, folderId: string | null): Promise<NoteDto> {
  return api<NoteDto>(`/api/notes/${encodeURIComponent(noteId)}/folder`, { method: "PUT", body: JSON.stringify({ folderId }) });
}

/** PATCH /api/folders/:id { parentId }（null＝根層）。 */
export function moveFolderRequest(id: string, parentId: string | null): Promise<FolderDto> {
  return api<FolderDto>(`/api/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ parentId }) });
}

/** 放置成功：寫 `["note", id]`，並失效 folders、notes（spec §6.15）。 */
export function applyPlacedNote(queryClient: QueryClient, note: NoteDto): void {
  queryClient.setQueryData(["note", note.id], note);
  invalidateFolderRelated(queryClient);
}

/** DELETE /api/folders/:id。opts 有給才帶 body {"onlyIfEmpty":true}（只刪空資料夾，spec §5.7.4）；不給照現行不帶 body。 */
export function deleteFolderRequest(id: string, opts?: { onlyIfEmpty: true }): Promise<FolderDeleteResultDto> {
  const url = `/api/folders/${encodeURIComponent(id)}`;
  if (opts === undefined) return api<FolderDeleteResultDto>(url, { method: "DELETE" });
  return api<FolderDeleteResultDto>(url, { method: "DELETE", body: JSON.stringify({ onlyIfEmpty: true }) });
}

export function useCreateFolder(): UseMutationResult<FolderDto, unknown, CreateFolderInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFolderInput) => createFolderRequest(input),
    onSettled: () => {
      invalidateFolderRelated(queryClient);
    },
  });
}

export function useRenameFolder(): UseMutationResult<FolderDto, unknown, { id: string; name: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameFolderRequest(id, name),
    onSettled: () => {
      invalidateFolderRelated(queryClient, { trash: true });
    },
  });
}

/** 成功時另失效每篇移入垃圾桶的 `["note", id]`（開著的那篇要進「在垃圾桶裡」）；不論成敗失效 `["backlinks"]`。 */
export function useDeleteFolder(): UseMutationResult<FolderDeleteResultDto, unknown, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFolderRequest(id),
    onSuccess: (result) => {
      for (const id of result.trashedNoteIds) void queryClient.invalidateQueries({ queryKey: ["note", id] });
    },
    onSettled: () => {
      invalidateFolderRelated(queryClient, { trash: true });
      void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
    },
  });
}

/** 404 `folder_not_found`：快取裡（或使用者剛選）的資料夾已不在（資料夾 spec §5.7.6 n6）。 */
export function isFolderNotFound(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "folder_not_found";
}

/** 409 `folder_not_empty`：`onlyIfEmpty` 的刪除遇到資料夾裡還有東西（spec §5.7.4）。 */
export function isFolderNotEmpty(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "folder_not_empty";
}

/** errors.<code>（帶 `max: FOLDER_DEPTH_MAX`，讀碼發現 1-③）；非 ApiFail → errors.fallback。 */
export function folderErrorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { max: FOLDER_DEPTH_MAX, defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}
