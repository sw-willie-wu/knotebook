/**
 * 資料夾權限。純函式。
 */
import type { FolderPermissionsDto } from "@knotebook/shared";
import type { FolderSpace } from "./space.js";

export interface FolderRoleFlags { canRead: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean }

/** null＝看不到。personal／shared：ownerId === userId 才看得到（flags 不看）；group：flags 為 null 或 !canRead → 看不到。 */
export function folderPermissions(space: FolderSpace, userId: string, flags: FolderRoleFlags | null): FolderPermissionsDto | null {
  switch (space.kind) {
    case "personal":
      return space.ownerId === userId ? { manage: true, deleteNotes: true, createNote: true } : null;
    case "shared":
      return space.ownerId === userId ? { manage: true, deleteNotes: true, createNote: false } : null;
    case "group":
      if (flags === null || !flags.canRead) return null;
      return { manage: flags.canEdit, deleteNotes: flags.canDelete, createNote: flags.canCreate && flags.canEdit };
  }
}
