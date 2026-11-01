/**
 * 資料夾的「空間」與結構鎖鍵（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.4）。純資料，沒有 DB 存取。
 */
import type { FolderSpaceDto } from "@knotebook/shared";

export type FolderSpace = { kind: "personal"; ownerId: string } | { kind: "shared"; ownerId: string } | { kind: "group"; groupId: string };

/** `knotebook.folders:<kind>:<id 小寫>`（§5.4 N2；前綴比照 `storage/space.ts` 的 `knotebook.storage:`，不共用 key 空間）。 */
export function folderSpaceLockKey(space: FolderSpace): string {
  const id = space.kind === "group" ? space.groupId : space.ownerId;
  return `knotebook.folders:${space.kind}:${id.toLowerCase()}`;
}

/** 去重、依鍵字串排序（取鎖順序）。 */
export function sortedSpaceLockKeys(spaces: readonly FolderSpace[]): string[] {
  return [...new Set(spaces.map(folderSpaceLockKey))].sort();
}

/** 資料夾列的空間；違反 `folders_space_chk` 的組合 → throw。 */
export function folderSpaceOfRow(row: { kind: string; ownerId: string | null; groupId: string | null }): FolderSpace {
  if (row.kind === "group" && row.groupId !== null && row.ownerId === null) return { kind: "group", groupId: row.groupId };
  if ((row.kind === "personal" || row.kind === "shared") && row.ownerId !== null && row.groupId === null) {
    return { kind: row.kind, ownerId: row.ownerId };
  }
  throw new Error(`folderSpaceOfRow: kind／owner_id／group_id 不一致（kind=${row.kind}）`);
}

/** 筆記所屬的資料夾空間：個人筆記 → personal（`notes_owner_xor_group_chk` 保證恰一個非 NULL）。 */
export function noteFolderSpace(note: { ownerId: string | null; groupId: string | null }): FolderSpace {
  if (note.groupId !== null) return { kind: "group", groupId: note.groupId };
  if (note.ownerId !== null) return { kind: "personal", ownerId: note.ownerId };
  throw new Error("noteFolderSpace: owner_id 與 group_id 皆為 NULL（違反 notes_owner_xor_group_chk）");
}

export function sameFolderSpace(a: FolderSpace, b: FolderSpace): boolean {
  return folderSpaceLockKey(a) === folderSpaceLockKey(b);
}

/** 建立／複製帶資料夾的空間一致性（spec §5.7.6 第 2 步）：群組資料夾要給同一個 groupId（比較前轉小寫）；個人資料夾不能帶 groupId；shared 一律不行。 */
export function newNoteFolderConsistent(space: FolderSpace, groupId: string | undefined): boolean {
  return space.kind === "group"
    ? groupId !== undefined && groupId.toLowerCase() === space.groupId
    : space.kind === "personal" && groupId === undefined;
}

/** 對外的空間形：personal／shared 不輸出 ownerId（只有本人看得到）。 */
export function toFolderSpaceDto(space: FolderSpace): FolderSpaceDto {
  return space.kind === "group" ? { kind: "group", groupId: space.groupId } : { kind: space.kind };
}
