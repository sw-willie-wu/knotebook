import { useTranslation } from "react-i18next";
import { useIdentities } from "@/api/account";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { useSession } from "@/auth/useSession";
import { toast } from "@/components/ui/toast";
import { SetPasswordForm } from "./SetPasswordForm";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { SignInMethodsSection } from "./SignInMethodsSection";
import "@/i18n/management-strings";

/**
 * 個人設定「登入」（`/settings/login`，#247 §5.2）：已連結登入方式＋密碼三分支（邏輯自
 * `SettingsAccountSection` 逐字搬來，#187 §8.5）。
 *
 * `SignInMethodsSection` 讀 `?linked=`／`?link_error=` 回程參數、toast 後清掉——server 的 OIDC 連結回程
 * 固定導到本頁（§9.9），所以它**必須**在這一頁；搬走就沒有 toast（`SignInMethodsSection.test.tsx` 的
 * AppRoutes 案守著）。
 *
 * 密碼群組三形：
 * - `hasPassword === false`＋帳密登入有效值開 → 「加上密碼」表單；不渲染改密碼表單。
 * - `hasPassword === false`＋有效值關（B22）→ 只有說明、沒有表單。
 * - 有密碼 → 改密碼表單；有效值關時多一句說明。
 * `hasPassword` 用 `=== false` 明確比對：query 未就緒（undefined）時預設落在改密碼分支，不誤閃加密碼表單；
 * `passwordLoginEnabled` 同理以 `!== false` 預設為開。改密成功**只 toast、不導航**（`navigate("/")` 會關掉
 * modal、扯掉背景筆記的共編）。兩張表單都包在 `max-w-sm` 裡：面板右卡很寬，輸入框滿寬不好讀。
 */
export function SettingsLoginSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const identities = useIdentities();
  const passwordLoginEnabled = identities.data?.passwordLoginEnabled !== false;

  return (
    <SettingsPage title={t("settings.nav.login")} description={t("settings.login.description")}>
      <SignInMethodsSection />
      {user?.hasPassword === false ? (
        passwordLoginEnabled ? (
          <SettingsGroup title={t("settings.account.setPassword.title")} description={t("settings.account.setPassword.description")}>
            <div className="max-w-sm">
              <SetPasswordForm onSuccess={() => toast({ title: t("settings.account.setPassword.success") })} />
            </div>
          </SettingsGroup>
        ) : (
          // B22：有效值關時不給加密碼表單。
          <SettingsGroup>
            <p className="text-sm text-muted-foreground">{t("settings.account.setPassword.ssoOnlyNotice")}</p>
          </SettingsGroup>
        )
      ) : (
        <SettingsGroup title={t("changePassword.title")} description={t("changePassword.description")}>
          {!passwordLoginEnabled && <p className="mb-3 text-sm text-muted-foreground">{t("settings.account.passwordLoginOffNote")}</p>}
          <div className="max-w-sm">
            {/* 面板右卡不放實心鈕（#247 §4.8）：tone="outline"。/change-password 整頁仍用預設 "page"。 */}
            <ChangePasswordForm tone="outline" onSuccess={() => toast({ title: t("changePassword.successMessage") })} />
          </div>
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
