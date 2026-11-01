import type { FolderDto, FolderListDto, FolderPermissionsDto, FolderSpaceDto } from "@knotebook/shared";

/** 資料夾 fixture（資料夾 PR-3b）。permissions 依 space 給 PR-3a 交付的值（personal 全真；shared 不能建筆記、刪＝只移除）。 */

export const FOLDER_LIST_EMPTY: FolderListDto = { folders: [] };

const PERSONAL: FolderSpaceDto = { kind: "personal" };

function defaultPermissions(space: FolderSpaceDto): FolderPermissionsDto {
  if (space.kind === "shared") return { manage: true, deleteNotes: true, createNote: false };
  return { manage: true, deleteNotes: true, createNote: true };
}

export function folderDto(o: { id: string; name: string; parentId?: string | null; space?: FolderSpaceDto } & Partial<FolderDto>): FolderDto {
  const space = o.space ?? PERSONAL;
  return {
    parentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    permissions: defaultPermissions(space),
    ...o,
    space,
  };
}

/** 群組資料夾：manage＝edit、deleteNotes＝delete、createNote＝create ∧ edit（皆預設 true）。 */
export function groupFolder(o: {
  id: string;
  name: string;
  groupId: string;
  parentId?: string | null;
  edit?: boolean;
  delete?: boolean;
  create?: boolean;
}): FolderDto {
  const { groupId, edit = true, delete: canDelete = true, create = true, ...rest } = o;
  return folderDto({
    ...rest,
    space: { kind: "group", groupId },
    permissions: { manage: edit, deleteNotes: canDelete, createNote: create && edit },
  });
}

export function sharedFolder(o: { id: string; name: string; parentId?: string | null }): FolderDto {
  return folderDto({ ...o, space: { kind: "shared" } });
}

/** 一條鏈：depth 個資料夾 `${prefix}1` ⊃ `${prefix}2` ⊃ …（深度與寬度案）。名稱同 id。 */
export function folderChain(prefix: string, depth: number, space: FolderSpaceDto = PERSONAL): FolderDto[] {
  return Array.from({ length: depth }, (_, i) =>
    folderDto({ id: `${prefix}${i + 1}`, name: `${prefix}${i + 1}`, parentId: i === 0 ? null : `${prefix}${i}`, space }),
  );
}
