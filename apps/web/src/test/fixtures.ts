import type { GroupDto, GroupRoleDto, NotePermissions } from "@knotebook/shared";

/**
 * #175 PR1：web 測試 fixture 的共用形（plan Task 11 Step 3）。`NoteDto.permissions` 與
 * `GroupDto.myRole`（物件）是 #175 新增／改形的欄位，逐檔手抄容易抄錯形——集中在這裡。
 *
 * 各 permissions 形對應 server `notes/service.ts` 的三件組（owner／逐人分享 editor／viewer）；
 * 群組筆記的 permissions 由群組角色旗標推得，測試要什麼組合就自己展開覆寫。
 */
export const OWNER_PERMS: NotePermissions = {
  read: true,
  edit: true,
  delete: true,
  manageShares: true,
  managePublicLink: true,
  changeSlug: true,
  moveToGroup: true,
};

/** 逐人分享 editor：只有 read／edit。 */
export const EDITOR_PERMS: NotePermissions = {
  read: true,
  edit: true,
  delete: false,
  manageShares: false,
  managePublicLink: false,
  changeSlug: false,
  moveToGroup: false,
};

/** 逐人分享 viewer：只有 read。 */
export const VIEWER_PERMS: NotePermissions = { ...EDITOR_PERMS, edit: false };

/** 內建管理員角色（七旗標全真）。`memberCount`＝掛這個角色的人數。 */
export function adminRole(overrides: Partial<GroupRoleDto> = {}): GroupRoleDto {
  return {
    id: "r-admin",
    builtin: "admin",
    name: null,
    permissions: {
      read: true,
      create: true,
      edit: true,
      delete: true,
      managePublicLink: true,
      manageMembers: true,
      manageGroup: true,
    },
    memberCount: 1,
    ...overrides,
  };
}

/** 內建一般成員角色（read／create／edit 為真，其餘假——與 0012 種的內建角色同形）。 */
export function memberRole(overrides: Partial<GroupRoleDto> = {}): GroupRoleDto {
  return {
    id: "r-member",
    builtin: "member",
    name: null,
    permissions: {
      read: true,
      create: true,
      edit: true,
      delete: false,
      managePublicLink: false,
      manageMembers: false,
      manageGroup: false,
    },
    memberCount: 1,
    ...overrides,
  };
}

/**
 * 以角色組出 `GroupDto`：兩個 `canManage*` 取角色旗標（非成員站台 admin 的 OR 不在這裡模擬——要測那形就覆寫）。
 */
export function groupDto(base: { id: string; name: string; createdAt?: string }, role: GroupRoleDto | null): GroupDto {
  return {
    id: base.id,
    name: base.name,
    myRole: role,
    canManageMembers: role?.permissions.manageMembers ?? false,
    canManageGroup: role?.permissions.manageGroup ?? false,
    createdAt: base.createdAt ?? "2026-09-01T00:00:00.000Z",
  };
}

/** #175 PR3：自訂角色（預設六個可設旗標全關＝只能閱讀、沒人掛）。 */
export function customRole(overrides: Partial<GroupRoleDto> = {}): GroupRoleDto {
  return {
    id: "r-custom",
    builtin: null,
    name: "Reader",
    permissions: {
      read: true,
      create: false,
      edit: false,
      delete: false,
      managePublicLink: false,
      manageMembers: false,
      manageGroup: false,
    },
    memberCount: 0,
    ...overrides,
  };
}
