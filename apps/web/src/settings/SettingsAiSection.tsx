import { useTranslation } from "react-i18next";

/**
 * 設定 modal 的 AI 區（`/settings/ai`，admin only）——**本 task（Task 7）只建最小
 * stub**，只 render 區塊標題讓路由/導覽可測；Task 8 填實 provider／model／action
 * 三層 CRUD UI（spec §13.4「AI 區」）。**Task 8 是填實這個檔案，不是新建**，不得
 * 覆蓋 Task 7 建立的路由接線。
 */
export function SettingsAiSection() {
  const { t } = useTranslation();
  return <h1 className="text-lg font-semibold">{t("settings.nav.ai")}</h1>;
}
