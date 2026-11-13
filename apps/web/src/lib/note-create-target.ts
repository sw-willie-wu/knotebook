import type { GroupDto, NoteDto } from "@knotebook/shared";
import type { FolderIndex } from "@/components/sidebar/folder-index";
import { noteBucket } from "@/components/sidebar/tree";
import { canCreateAndEdit } from "@/lib/group-role";

/** `handleNewNote(groupId, folderId)` 的參數形：都沒有＝建在個人根層。 */
export interface CreateTarget {
  groupId?: string;
  folderId?: string;
}

/**
 * 手機筆記頁底部「New note」要建在哪：跟這篇筆記同一個空間、同一個資料夾。
 * 回 null＝不顯示按鈕：共享給我的筆記；群組不在清單或角色不能同時建與編；筆記所在的資料夾不在索引
 * （剛被刪、清單還沒重抓）或資料夾不許建——這幾種都不退回根層，免得建到使用者沒預期的地方。
 */
export function createTargetFor(note: NoteDto, ctx: { groups: readonly GroupDto[]; folders: FolderIndex }): CreateTarget | null {
  const bucket = noteBucket(note, new Set(ctx.groups.map((group) => group.id)));
  if (bucket.kind === "shared") return null;
  let target: CreateTarget = {};
  if (bucket.kind === "group") {
    const group = ctx.groups.find((item) => item.id === bucket.groupId);
    if (group === undefined || !canCreateAndEdit(group)) return null;
    target = { groupId: bucket.groupId };
  }
  if (note.folderId === null) return target;
  const folder = ctx.folders.byId.get(note.folderId);
  if (folder === undefined || !folder.permissions.createNote) return null;
  return { ...target, folderId: folder.id };
}
