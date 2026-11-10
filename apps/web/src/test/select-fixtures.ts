import type { GroupDto, NoteDto } from "@knotebook/shared";
import { EDITOR_PERMS, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";

/**
 * #181 一般 tab 選取模式的筆記 fixture（各測試共用）。
 * 權限物件一律以 `@/test/fixtures` 的三件組展開再覆寫。
 */

/** 唯一的 NoteDto 底稿（feat/folders 合流時 folderId／sizeBytes 只加在這裡）。預設是個人筆記（role owner）。 */
export function baseNote(o: { id: string; title: string } & Partial<NoteDto>): NoteDto {
  return {
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `note-${o.id}`,
    ownerHandle: "tester",
    groupId: null,
    slugIsCustom: false,
    prevSlug: null,
    lastEdited: null,
    group: null,
    permissions: { ...OWNER_PERMS },
    folderId: null,
    ...o,
  };
}

/** 我的個人筆記：role owner、OWNER_PERMS。 */
export function personalNote(o: { id: string; title: string } & Partial<NoteDto>): NoteDto {
  return baseNote({ role: "owner", permissions: { ...OWNER_PERMS }, ...o });
}

/** 逐人分享給我的個人筆記：editor（預設）→ EDITOR_PERMS、viewer → VIEWER_PERMS。 */
export function sharedNote(o: { id: string; title: string; role?: "editor" | "viewer" } & Partial<NoteDto>): NoteDto {
  const role = o.role ?? "editor";
  return baseNote({
    ownerId: "u9",
    ownerHandle: "someone",
    permissions: { ...(role === "viewer" ? VIEWER_PERMS : EDITOR_PERMS) },
    ...o,
    role,
  });
}

/**
 * 群組筆記：沒有個人 owner；`edit`／`delete` 預設皆 true（角色旗標推得），`edit === false` 時 role 為 viewer。
 * `manageShares`／`moveToGroup` 恆 false（#175），測試要分辨時自己覆寫 `permissions`。
 */
export function groupNote(o: { id: string; title: string; group: GroupDto; edit?: boolean; delete?: boolean } & Partial<NoteDto>): NoteDto {
  const { group, edit = true, delete: canDelete = true, ...rest } = o;
  return baseNote({
    ownerId: null,
    ownerHandle: null,
    role: edit ? "editor" : "viewer",
    groupId: group.id,
    group: { id: group.id, name: group.name },
    permissions: { ...VIEWER_PERMS, edit, delete: canDelete },
    ...rest,
  });
}
