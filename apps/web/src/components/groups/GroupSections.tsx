/**
 * 群組 modal 四個區塊的**聚合 lazy 模組**（#247 §6.1）：`App.tsx` 的四個 `lazy()` 都 import 這一個模組
 * （`.then(m => ({ default: m.X }))`），Rollup 因此只產出一個 `GroupSections-<hash>.js`。
 * ⚠ 這裡重新匯出的元件**不得被任何首包模組靜態 import**——否則它們會被併回 entry（同 `AdminSections.tsx`）。
 * 外殼 `GroupModal` 在首包；錯誤邊界別名 `chunk="group"`。
 */
export { GroupMembersSection } from "./GroupMembersSection";
export { SettingsGroupRolesSection as GroupRolesSection } from "@/settings/SettingsGroupRolesSection";
