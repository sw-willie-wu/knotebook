import {
  useInfiniteQuery,
  type InfiniteData,
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
  VersionKind,
  VersionListDto,
  VersionSnapshotDto,
} from "@knotebook/shared";
import { api } from "./client";

/**
 * 版本歷史資料層（spec §6、§8.4）。
 *
 * **兩把前綴、刻意分開**：清單在 `['notes', id, 'versions', 'list', 篩選]`（前綴 `['notes', id, 'versions']`）——筆記清單的任何 `invalidateQueries(['notes'])`
 * （建立／改名／刪除／搬移，`api/notes.ts`、`api/note-move.ts`）都會順帶重抓它，這是要的（搬移會清空版本，spec §9）。
 * 快照在獨立前綴 `['note-versions', noteId, id]`：以 **`id`**（不是 seq）為鍵——§9 搬移清空後同一個 seq 會指向
 * 不同內容；同一個 id 的內容永不變，所以 `staleTime: Infinity`、也不被 `['notes']` 的 invalidate 掃到（spec §6.2、§8.4）。
 */
export const VERSIONS_PAGE_SIZE = 50;

/** 清單的篩選：「全部」或「僅手動」（#258）。伺服器的 `kind` 參數另收 `"auto"`，UI 不提供。 */
export type VersionKindFilter = "all" | "manual";

/** 這一篇所有版本查詢的**前綴**（`invalidateQueries` 用它一次刷到所有篩選與「目前狀態」）。清單本身的鍵看 `versionListKey`。 */
export function versionsKey(noteId: string) {
  return ["notes", noteId, "versions"] as const;
}

/** 清單查詢的鍵：`versionsKey` 之後接 `"list"` 與篩選，兩種篩選各自一份快取；以前綴 invalidate 就會同時標記兩份。 */
export function versionListKey(noteId: string, kind: VersionKindFilter) {
  return [...versionsKey(noteId), "list", kind] as const;
}

/** 「目前狀態」的單發重抓（起草裁定 16）。掛在清單 key 之下，清單 invalidate 一併涵蓋。 */
export function versionCurrentKey(noteId: string) {
  return ["notes", noteId, "versions", "current"] as const;
}

export function versionSnapshotKey(noteId: string, id: string) {
  return ["note-versions", noteId, id] as const;
}

/** 預覽／比較對象。`seq` 拿快照、`id` 防搬移後同號不同版；`name` 是選取當下的名稱（清單裡沒有它時顯示用，#272 §10.3）。 */
export type VersionTarget = { seq: number; id: string; name: string | null };

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

export function fetchVersionList(noteId: string, opts: { before?: number; limit?: number; kind?: VersionKind } = {}): Promise<VersionListDto> {
  const params = new URLSearchParams();
  if (opts.kind !== undefined) params.set("kind", opts.kind);
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

/** `filter` 由呼叫端從 `useVersions().kindFilter` 帶入（面板、整頁、比較下拉共用同一份，所以共用同一份快取）。 */
export function useVersionList(noteId: string, enabled: boolean, filter: VersionKindFilter = "all") {
  return useInfiniteQuery({
    queryKey: versionListKey(noteId, filter),
    queryFn: ({ pageParam }) =>
      fetchVersionList(noteId, { before: pageParam, limit: VERSIONS_PAGE_SIZE, ...(filter === "manual" ? { kind: "manual" as const } : {}) }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: enabled && noteId.length > 0,
  });
}

/**
 * 「目前狀態」（`current`）：先讀自己這份篩選的清單；切篩選的瞬間新鍵還沒有資料，退回讀**另一個篩選已快取**的同一篇資料
 * （`current` 與篩選無關），免得副標消失、「儲存當前版本」鈕閃一下 disabled。不用 `keepPreviousData`（那會短暫顯示另一種篩選的列）。
 * 渲染時讀快取、不訂閱另一個鍵：自己的清單一到就以自己的為準；自己的查詢 error 時不退回（見下）。
 */
export function useVersionCurrent(
  noteId: string,
  list: { data: InfiniteData<VersionListDto> | undefined; isError: boolean },
  filter: VersionKindFilter,
): VersionCurrentDto | undefined {
  const queryClient = useQueryClient();
  const own = list.data?.pages[0]?.current;
  if (own !== undefined) return own;
  // 自己這份「尚無資料且不是 error」才退回另一份：自己的查詢失敗時不沿用另一份可能已過期的（副標消失、儲存鈕 disabled，與沒有快取時一致）。
  if (list.isError) return undefined;
  const other: VersionKindFilter = filter === "all" ? "manual" : "all";
  return queryClient.getQueryData<InfiniteData<VersionListDto>>(versionListKey(noteId, other))?.pages[0]?.current;
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
