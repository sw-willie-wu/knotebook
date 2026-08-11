import { useTranslation } from "react-i18next";

/**
 * 設定 modal 的使用者區（`/settings/users`，admin only）——**本 task（Task 7）只建
 * 最小 stub**，只 render 區塊標題讓路由/導覽可測；Task 8 把 `AdminUsersPage` 的內容
 * （表格/建立使用者/停用啟用/升級管理員，邏輯零改動）遷進來、拔掉現有 `<AppShell>`
 * 外殼（modal 內不能再包一層 app shell）。**Task 8 是填實這個檔案，不是新建**，
 * 不得覆蓋 Task 7 建立的路由接線（`App.tsx` 兩棵 Routes 樹／`SettingsModal` 外殼）。
 */
export function SettingsUsersSection() {
  const { t } = useTranslation();
  return <h1 className="text-lg font-semibold">{t("settings.nav.users")}</h1>;
}
