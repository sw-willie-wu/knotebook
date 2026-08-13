import { useTranslation } from "react-i18next";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";

/**
 * 設定 modal 的帳號區（`/settings/account`，所有人可見；spec §13.4）——目前唯一
 * 內容是自助改密碼（`ChangePasswordForm` 共用元件）。成功後**只 toast、不導航**：
 * `navigate("/")` 會關掉 modal，甚至扯掉背景 `/notes/:ref` 的共編 provider，
 * 這裡刻意留在原地（對照 `ChangePasswordPage` 的強制模式 `onSuccess`）。
 *
 * `user.hasPassword === false`（OIDC 自動建帳、從未設過密碼；spec §14.4）→
 * 不渲染改密碼表單（打了也一定 `invalid_credentials`，沒有意義），改渲染
 * `settings.account.ssoOnly` 提示。本區掛在 `<RequireAuth>`/`<ChangePasswordGate>`
 * 底下（見 App.tsx），render 到這裡時 `useSession().user` 理論上已確定非
 * null/undefined；仍用 `=== false` 明確比對（而非 `!user.hasPassword`），
 * 讓「query 尚未就緒」（`undefined`）預設落在渲染表單這條分支，不誤閃 SSO 提示。
 *
 * `changePassword.title`/`.description`（「Change your password」…）這組標題**只在
 * 有改密碼表單那個分支渲染**——原本放在分支外時，SSO-only 使用者會同時看到「Change
 * your password」標題與「此帳號透過 SSO 登入」提示，自相矛盾（fix round 1
 * MINOR-2）。SSO-only 分支不另掛標題：左側導覽（`SettingsModal`）的「Account」
 * 高亮項已提供區塊脈絡，不需要在內容區重複一次。
 */
export function SettingsAccountSection() {
  const { t } = useTranslation();
  const { user } = useSession();

  if (user?.hasPassword === false) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{t("settings.account.ssoOnly")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("changePassword.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("changePassword.description")}</p>
      </div>
      <ChangePasswordForm onSuccess={() => toast({ title: t("changePassword.successMessage") })} />
    </div>
  );
}
