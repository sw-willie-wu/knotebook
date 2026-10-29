import { useTranslation } from "react-i18next";
import { DOCS_URL, LICENSE_URL, REPO_URL } from "./about-links";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

const LINK_CLASS = "text-brand-on-soft underline-offset-4 hover:underline";

/**
 * 個人設定「關於」（`/settings/about`，#247 §5.6）：版本＋三個外部連結。
 * 不放「檢查更新」、不打任何網路請求。版本號是 build 時注入的 `__APP_VERSION__`（§9.7）。
 */
export function SettingsAboutSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("settings.nav.about")} description={t("settings.about.description")}>
      <SettingsGroup>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t("settings.about.version")}</dt>
          <dd>{`v${__APP_VERSION__}`}</dd>
          <dt className="text-muted-foreground">{t("settings.about.source")}</dt>
          <dd>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {REPO_URL.replace(/^https:\/\//, "")}
            </a>
          </dd>
          <dt className="text-muted-foreground">{t("settings.about.docs")}</dt>
          <dd>
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t("settings.about.docsLink")}
            </a>
          </dd>
          <dt className="text-muted-foreground">{t("settings.about.license")}</dt>
          <dd>
            <a href={LICENSE_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              LICENSE
            </a>
          </dd>
        </dl>
      </SettingsGroup>
    </SettingsPage>
  );
}
