import type { QueryClient } from "@tanstack/react-query";
import type { FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import { fetchFolders, FOLDERS_QUERY_KEY } from "@/api/folders";
import { setCollapsed } from "./collapse";

/**
 * 資料夾索引（資料夾 spec §6.2）：`GET /api/folders` 一次回全部、不是樹序，client 依 `parentId` 組。
 * 首包模組：不 import 字串包、不 import `tree.ts`（排筆記與判筆記空間放 `tree.ts`，模組相依單向）。
 * 兜底：`parentId` 不在清單、或父子空間不同 → 當根層資料夾；成環（server 已防，壞資料才會有）→ 從環的入口斷開、那個資料夾當根層，
 * 環上的資料夾與筆記照樣看得到。樹、路徑行、展開鏈都查同一張 `parentOf`，三者一致；走訪另以 visited 防禦。
 */

/** 資料夾名稱排序與「名稱」排序共用（spec §6.2）。 */
export const FOLDER_COLLATOR = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });

export type FolderSpaceKey = "personal" | "shared" | `group:${string}`;

export function spaceKeyOf(space: FolderSpaceDto): FolderSpaceKey {
  return space.kind === "group" ? `group:${space.groupId}` : space.kind;
}

export interface FolderIndex {
  readonly byId: ReadonlyMap<string, FolderDto>;
  /** 某空間某父層（null＝根層）的子資料夾，依 FOLDER_COLLATOR 排好（同名依輸入序）。 */
  children(space: FolderSpaceKey, parentId: string | null): readonly FolderDto[];
  /** 兜底與斷環之後的父層（null＝根層；id 不在索引也回 null）。 */
  parentOf(folderId: string): string | null;
}

const NO_FOLDERS: readonly FolderDto[] = [];

/** 父層在索引裡且同空間才算數；其餘當根層（null）。 */
function effectiveParentId(byId: ReadonlyMap<string, FolderDto>, folder: FolderDto): string | null {
  if (folder.parentId === null) return null;
  const parent = byId.get(folder.parentId);
  return parent !== undefined && spaceKeyOf(parent.space) === spaceKeyOf(folder.space) ? parent.id : null;
}

/** parentId 不在清單、或父子空間不同 → 當根層（兜底，讀碼發現 4）；成環 → 在第一個重複的資料夾斷開、它當根層。 */
export function indexFolders(folders: readonly FolderDto[]): FolderIndex {
  const byId = new Map<string, FolderDto>(folders.map((folder) => [folder.id, folder]));
  const parents = new Map<string, string | null>();
  for (const folder of byId.values()) parents.set(folder.id, effectiveParentId(byId, folder));
  for (const folder of byId.values()) {
    const seen = new Set<string>();
    let id: string | null = folder.id;
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      id = parents.get(id) ?? null;
    }
    if (id !== null) parents.set(id, null);
  }
  const buckets = new Map<FolderSpaceKey, Map<string | null, FolderDto[]>>();
  for (const folder of folders) {
    const space = spaceKeyOf(folder.space);
    let bySpace = buckets.get(space);
    if (bySpace === undefined) {
      bySpace = new Map();
      buckets.set(space, bySpace);
    }
    const parentId = parents.get(folder.id) ?? null;
    const list = bySpace.get(parentId);
    if (list === undefined) bySpace.set(parentId, [folder]);
    else list.push(folder);
  }
  for (const bySpace of buckets.values()) {
    for (const list of bySpace.values()) list.sort((a, b) => FOLDER_COLLATOR.compare(a.name, b.name));
  }
  return {
    byId,
    children: (space, parentId) => buckets.get(space)?.get(parentId) ?? NO_FOLDERS,
    parentOf: (folderId) => parents.get(folderId) ?? null,
  };
}

export const EMPTY_FOLDER_INDEX: FolderIndex = indexFolders([]);

/** 根 → 葉的名稱；id 不在 → null；遇環停在第一次重複前（防禦）。 */
export function folderPath(index: FolderIndex, folderId: string): string[] | null {
  if (!index.byId.has(folderId)) return null;
  const names: string[] = [];
  const visited = new Set<string>();
  let current = index.byId.get(folderId);
  while (current !== undefined) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    names.push(current.name);
    const parentId = index.parentOf(current.id);
    current = parentId === null ? undefined : index.byId.get(parentId);
  }
  return names.reverse();
}

/** 含自己；遇環不重複。 */
export function subtreeFolderIds(index: FolderIndex, folderId: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    out.push(id);
    const folder = index.byId.get(id);
    if (folder === undefined) return;
    for (const child of index.children(spaceKeyOf(folder.space), id)) walk(child.id);
  };
  walk(folderId);
  return out;
}

/**
 * 快取裡 folderId 落在子樹（含自己）、而且筆記空間與資料夾空間相符的筆記（呼叫者視角；空間不符的與樹一樣算根層、不算進來）。
 * 刪除確認篇數、⋮ 擋下判斷、「開著的那篇在不在裡面」用。`spaceOf` 由呼叫端給（`tree.ts` 的 `noteSpaceKey`；本模組不 import `tree.ts`）。
 */
export function liveNotesUnder(
  index: FolderIndex,
  folderId: string,
  notes: readonly NoteDto[],
  spaceOf: (note: NoteDto) => FolderSpaceKey,
): NoteDto[] {
  const ids = new Set(subtreeFolderIds(index, folderId));
  return notes.filter((note) => {
    if (note.folderId === null || !ids.has(note.folderId)) return false;
    const folder = index.byId.get(note.folderId);
    return folder !== undefined && spaceKeyOf(folder.space) === spaceOf(note);
  });
}

/** 自己與祖先寫成展開（setCollapsed(`folder:<id>`, false)，spec §6.8）。id 不在索引 → 只展開自己。 */
export function expandFolderChain(index: FolderIndex, folderId: string): void {
  const visited = new Set<string>();
  let id: string | null = folderId;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    setCollapsed(`folder:${id}`, false);
    id = index.parentOf(id);
  }
}

/**
 * 還原後展開（資料夾 spec §6.8；總管裁定 2026-10-29 I4、I-A）：還原照原路徑重建資料夾，被還原那幾篇所在的資料夾與祖先寫成展開。
 * - 沒有任何非 null 的 `folderId` → 不發請求。
 * - 一律 `fetchQuery`（staleTime 0）拿新清單：垃圾桶 tab 時 `["folders"]` 沒有 observer，`invalidateQueries` 不會重抓、快取裡沒有
 *   新重建的資料夾。呼叫端必須放在 `invalidateTrashRelated` **之後**：有 observer 時那邊已觸發 refetch，這一發併進同一個請求（只打一次）。
 * - 整段吞掉所有錯誤（含取消）：展開是附帶效果，不丟出、不出 toast。
 */
export async function expandAfterRestore(queryClient: QueryClient, restored: readonly NoteDto[]): Promise<void> {
  try {
    const folderIds = restored.flatMap((note) => (note.folderId === null ? [] : [note.folderId]));
    if (folderIds.length === 0) return;
    const folders = await queryClient.fetchQuery({ queryKey: FOLDERS_QUERY_KEY, queryFn: fetchFolders, staleTime: 0 });
    const index = indexFolders(folders);
    for (const folderId of folderIds) expandFolderChain(index, folderId);
  } catch {
    // 展開失敗不影響還原本身；下次載入資料夾時照常顯示。
  }
}

/** 根層資料夾＝1；id 不在索引＝0；遇環停（防禦）。 */
export function folderDepth(index: FolderIndex, folderId: string): number {
  if (!index.byId.has(folderId)) return 0;
  const visited = new Set<string>();
  let depth = 0;
  let id: string | null = folderId;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    depth += 1;
    id = index.parentOf(id);
  }
  return depth;
}

/** 葉＝1；遇環不重算；不在索引＝1（當成葉）。 */
export function subtreeHeight(index: FolderIndex, folderId: string): number {
  const visited = new Set<string>();
  const height = (id: string): number => {
    visited.add(id);
    const folder = index.byId.get(id);
    if (folder === undefined) return 1;
    let deepest = 0;
    for (const child of index.children(spaceKeyOf(folder.space), id)) {
      if (!visited.has(child.id)) deepest = Math.max(deepest, height(child.id));
    }
    return deepest + 1;
  };
  return height(folderId);
}

/** candidateId 是 ancestorId 自己或其子孫。 */
export function isInSubtree(index: FolderIndex, ancestorId: string, candidateId: string): boolean {
  const visited = new Set<string>();
  let id: string | null = candidateId;
  while (id !== null && !visited.has(id)) {
    if (id === ancestorId) return true;
    visited.add(id);
    id = index.parentOf(id);
  }
  return false;
}
