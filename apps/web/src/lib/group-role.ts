import type { GroupRoleDto } from "@knotebook/shared";

/**
 * #175 §2.11／Q19：角色的顯示名。內建兩個走 i18n（`groups.role.admin`／`groups.role.member`——DB 裡內建角色 `name` 恆 NULL）；
 * 自訂角色用它自己的 `name`。**不得**寫成 `` t(`groups.role.${role}`) ``——`myRole` 是物件，樣板字串會渲染出
 * `groups.role.[object Object]`，tsc 與 lint 都逼不出來（gate r3 M-4；`SettingsGroupsSection.test.tsx` 的三形案守）。
 */
export function roleLabel(t: (key: string) => string, role: Pick<GroupRoleDto, "builtin" | "name">): string {
  if (role.builtin === "admin") return t("groups.role.admin");
  if (role.builtin === "member") return t("groups.role.member");
  return role.name ?? "";
}
