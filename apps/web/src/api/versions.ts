import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ApplyVersionBody,
  ApplyVersionResultDto,
  SavedVersionDto,
  VersionCurrentDto,
  VersionDto,
  VersionListDto,
  VersionSnapshotDto,
} from "@knotebook/shared";
import { api } from "./client";

/**
 * 版本歷史資料層（spec §6、§8.4）。
 *
 * **兩把前綴、刻意分開**：清單在 `['notes', id, 'versions']`——筆記清單的任何 `invalidateQueries(['notes'])`
 * （建立／改名／刪除／搬移，`api/notes.ts`、`api/note-move.ts`）都會順帶重抓它，這是要的（搬移會清空版本，spec §9）。
 * 快照在獨立前綴 `['note-versions', noteId, id]`：以 **`id`**（不是 seq）為鍵——§9 搬移清空後同一個 seq 會指向
 * 不同內容；同一個 id 的內容永不變，所以 `staleTime: Infinity`、也不被 `['notes']` 的 invalidate 掃到（spec §6.2、§8.4）。
 */
export const VERSIONS_PAGE_SIZE = 50;

export function versionsKey(noteId: string) {
  return ["notes", noteId, "versions"] as const;
}

/** 「目前狀態」的單發重抓（起草裁定 16）。掛在清單 key 之下，清單 invalidate 一併涵蓋。 */
export function versionCurrentKey(noteId: string) {
  return ["notes", noteId, "versions", "current"] as const;
}

export function versionSnapshotKey(noteId: string, id: string) {
  return ["note-versions", noteId, id] as const;
}

export type VersionTarget = { seq: number; id: string };

/** 快照回應的 `id` 與清單列不同（中途被 §9 清空重編）——丟棄、不進快取。 */
export class VersionSnapshotMismatch extends Error {
  constructor() {
    super("version snapshot id mismatch");
    this.name = "VersionSnapshotMismatch";
  }
}

const base = (noteId: string) => `/api/notes/${encodeURIComponent(noteId)}/versions`;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function fetchVersionList(noteId: string, opts: { before?: number; limit?: number } = {}): Promise<VersionListDto> {
  const params = new URLSearchParams();
  if (opts.before !== undefined) params.set("before", String(opts.before));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return api<VersionListDto>(qs ? `${base(noteId)}?${qs}` : base(noteId));
}

export async function fetchVersionSnapshot(noteId: string, target: VersionTarget): Promise<Uint8Array> {
  const res = await api<VersionSnapshotDto>(`${base(noteId)}/${target.seq}`);
  if (res.id !== target.id) throw new VersionSnapshotMismatch();
  return base64ToBytes(res.ydoc);
}

export function saveVersion(noteId: string, name: string | null): Promise<SavedVersionDto> {
  const trimmed = name?.trim() ?? "";
  return api<SavedVersionDto>(base(noteId), {
    method: "POST",
    body: JSON.stringify(trimmed === "" ? {} : { name: trimmed }),
  });
}

export function applyVersion(noteId: string, seq: number, body: ApplyVersionBody): Promise<ApplyVersionResultDto> {
  return api<ApplyVersionResultDto>(`${base(noteId)}/${seq}/apply`, { method: "POST", body: JSON.stringify(body) });
}

export function renameVersion(noteId: string, seq: number, name: string | null): Promise<VersionDto> {
  const trimmed = name?.trim() ?? "";
  return api<VersionDto>(`${base(noteId)}/${seq}`, {
    method: "PATCH",
    body: JSON.stringify({ name: trimmed === "" ? null : trimmed }),
  });
}

export function deleteVersion(noteId: string, seq: number): Promise<void> {
  return api<void>(`${base(noteId)}/${seq}`, { method: "DELETE" });
}

/** 按「套用」前一律重抓（spec §8.2 末段）：`staleTime: 0` 讓 fetchQuery 永遠真的打一次。 */
export function fetchCurrent(queryClient: QueryClient, noteId: string): Promise<VersionCurrentDto> {
  return queryClient.fetchQuery({
    queryKey: versionCurrentKey(noteId),
    queryFn: () => fetchVersionList(noteId, { limit: 1 }).then((r) => r.current),
    staleTime: 0,
  });
}

export function useVersionList(noteId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: versionsKey(noteId),
    queryFn: ({ pageParam }) => fetchVersionList(noteId, { before: pageParam, limit: VERSIONS_PAGE_SIZE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: enabled && noteId.length > 0,
  });
}

export function useVersionSnapshot(noteId: string, target: VersionTarget | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: versionSnapshotKey(noteId, target?.id ?? ""),
    queryFn: async () => {
      try {
        return await fetchVersionSnapshot(noteId, target!);
      } catch (err) {
        if (err instanceof VersionSnapshotMismatch) {
          void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) });
        }
        throw err;
      }
    },
    enabled: target !== null,
    staleTime: Infinity,
    retry: false,
  });
}

export function useSaveVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string | null) => saveVersion(noteId, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) }),
  });
}

export function useApplyVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, discardUnsaved }: { version: VersionDto; discardUnsaved: boolean }) =>
      applyVersion(noteId, version.seq, { versionId: version.id, discardUnsaved }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) });
      void queryClient.invalidateQueries({ queryKey: ["note", noteId] });
    },
  });
}

export function useRenameVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ seq, name }: { seq: number; name: string | null }) => renameVersion(noteId, seq, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) }),
  });
}

export function useDeleteVersion(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (seq: number) => deleteVersion(noteId, seq),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) }),
  });
}
