import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/useSession";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/**
 * 改密碼頁（`/change-password`，登入後可達；spec rev 5.7，共用表單抽出見 §13.4）。
 * 頁面本身只負責「強制模式外框」：標題/說明、忘記密碼的登出逃生口，以及
 * `ChangePasswordForm` 成功後的導向——`navigate("/", {replace:true})`（現行為，
 * `ChangePasswordGate` 讀到新的 `mustChangePassword:false` 後自然放行，不需要頁面
 * 自己判斷要不要跳過 gate）。跳一則成功 toast，文案不提「請重新登入」（因為根本
 * 沒有登出——見 `ChangePasswordForm` 內的 server 重簽說明）。
 */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useSession();

  function handleSuccess(): void {
    toast({ title: t("changePassword.successMessage") });
    navigate("/", { replace: true });
  }

  /**
   * 忘記目前密碼的使用者在這頁會被永久卡住（`ChangePasswordGate` 擋住其餘所有受保護
   * 路由，`/login` 本身不會清 cookie——直接打開它只會因為 session 仍有效又被導回這裡）。
   * 提供一個明確的登出出口：與 `UserMenu.handleLogout` 同一套（`useSession().logout()`
   * → `POST /api/auth/logout` + 清 `['me']` 快取），成功後導向 `/login` 讓使用者能重新
   * 走一般登入或請 admin 協助重設帳號。
   */
  async function handleLogout(): Promise<void> {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleLogout()}>
            {t("userMenu.logout")}
          </Button>
        </div>

        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("changePassword.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("changePassword.description")}</p>
        </div>

        <ChangePasswordForm onSuccess={handleSuccess} />
      </div>
    </main>
  );
}
