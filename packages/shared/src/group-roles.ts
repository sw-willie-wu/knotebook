/**
 * #175 PR3：群組角色的共用規則——server 的端點驗證、web 角色頁、web 的 i18n 守衛吃同一份。
 * **閱讀恆真**（Willie 2026-10-01 裁決）：每個角色都能讀群組筆記，使用者看不到也改不了；角色端點只收下面六個旗標，
 * server 寫入時 `can_read` 一律 true。六個旗標**彼此不蘊含、不連動**（Willie 2026-10-01 裁決拿掉「新建 ⇒ 編輯」，
 * migration 0013）：怎麼組合由建角色的管理者決定。
 */
import type { GroupRolePermissions } from "./index.js";

export const GROUP_ROLE_FLAGS = [
  "create", "edit", "delete", "managePublicLink", "manageMembers", "manageGroup",
] as const satisfies ReadonlyArray<keyof GroupRolePermissions>;
export type GroupRoleFlag = (typeof GROUP_ROLE_FLAGS)[number];
/** 角色端點 body 的 `permissions`：六個可設旗標（沒有 `read`）。 */
export type GroupRoleFlags = Pick<GroupRolePermissions, GroupRoleFlag>;

/** 自訂角色名稱上限（code point，與 DB `group_roles_name_len_chk` 的 `length()` 同單位）。 */
export const GROUP_ROLE_NAME_MAX = 40;

/**
 * 內建角色在各語系的顯示名（spec §4.1）：自訂角色的名稱正規化＋`toLowerCase` 後不得等於其中任一個（409 `role_name_taken`）。
 * ⚠ 必須逐字等於 web `groups.role.admin`／`groups.role.member` 的 en／zh-TW 值——`apps/web/src/i18n/index.test.ts` 守；
 * 新增語系時要同步（spec §15 第 7 條）。
 */
export const BUILTIN_ROLE_DISPLAY_NAMES: readonly string[] = ["Admin", "Member", "管理員", "一般成員"];

/** spec §4.1：trim → NFC。不擋字元（NUL／落單代理由 server 的 `hasUnstorableChar` 先擋）。 */
export function normalizeRoleName(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** `normalized` 已過 `normalizeRoleName`。 */
export function isReservedRoleName(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return BUILTIN_ROLE_DISPLAY_NAMES.some(name => name.normalize("NFC").toLowerCase() === lower);
}
