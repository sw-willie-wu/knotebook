import { useTranslation } from "react-i18next";
import { ApiTokensSection } from "./ApiTokensSection";
import { SettingsPage } from "./SettingsLayout";

/**
 * 個人設定「授權」（`/settings/authorization`，#247 §5.3）：API token（含 OAuth 授權的 app，同一份清單）
 * ＋「用 MCP 連接 Claude」教學（Task 15 加入）。OAuth「已授權應用」列表本次不做，也不預留標題（§1.3）。
 * SSO-only 帳號同樣看得到——他們沒有密碼，更需要 token 這條路。
 */
export function SettingsAuthorizationSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("settings.nav.authorization")} description={t("settings.authorization.description")}>
      <ApiTokensSection />
    </SettingsPage>
  );
}
