/**
 * 站台管理 modal 五個區塊的**聚合 lazy 模組**（#247 §7.1）：`App.tsx` 的五個 `lazy()` 都 import 這一個模組
 * （`.then(m => ({ default: m.X }))`），Rollup 只產出一個 `AdminSections-<hash>.js`——`scripts/check-bundle-size.mjs`
 * 的 `ADMINSECTIONS_RE` 釘住它存在。
 *
 * 取代 #201 的做法（`pages/AdminPage.tsx` 內的 descendant `<Routes>`）：外殼 `AdminModal` 現在是首包裡的 layout route，
 * 區塊是它 `<Outlet/>` 裡的 lazy element——與 `SettingsModal` 同形（外殼掛上後內容區才 lazy），錯誤走
 * `LazyRouteErrorBoundary`（inline frame，`chunk="admin"`）。同一份額度內沒有「只在另一個 lazy 掛載後才 render 的 lazy」
 * （memory knotebook-lazy-pages 的收斂前提）：五個區塊是同一個 chunk。
 *
 * ⚠ 下列元件**不得被任何首包模組靜態 import**——否則 Rollup 把它們併回 entry、這個 chunk 消失。
 * 儲存方案頁就是 `SettingsStorageSection`，它自己在方案表之後渲染站台版本設定（`SiteVersionsGroups`，§7.0）。
 */
export { SettingsUsersSection as AdminUsersSection } from "@/settings/SettingsUsersSection";
export { SettingsAdminGroupsSection as AdminGroupsSection } from "@/settings/SettingsAdminGroupsSection";
export { SettingsAuthSection as AdminLoginSection } from "@/settings/SettingsAuthSection";
export { SettingsStorageSection as AdminStorageSection } from "@/settings/SettingsStorageSection";
export { SettingsAiSection as AdminAiSection } from "@/settings/SettingsAiSection";
