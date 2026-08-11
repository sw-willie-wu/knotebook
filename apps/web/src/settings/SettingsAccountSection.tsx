import { useTranslation } from "react-i18next";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { toast } from "@/components/ui/toast";

/**
 * 設定 modal 的帳號區（`/settings/account`，所有人可見；spec §13.4）——目前唯一
 * 內容是自助改密碼（`ChangePasswordForm` 共用元件）。成功後**只 toast、不導航**：
 * `navigate("/")` 會關掉 modal，甚至扯掉背景 `/notes/:ref` 的共編 provider，
 * 這裡刻意留在原地（對照 `ChangePasswordPage` 的強制模式 `onSuccess`）。
 */
export function SettingsAccountSection() {
  const { t } = useTranslation();

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
