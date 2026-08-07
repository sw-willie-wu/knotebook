import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MIN_PASSWORD_LENGTH } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY, useSession } from "@/auth/useSession";
import { toast } from "@/components/ui/toast";

/**
 * 改密碼頁（`/change-password`，登入後可達；spec rev 5.7）。打 `POST /api/auth/password`
 * ——currentPassword + newPassword，`confirmNewPassword` 只在 client 端比對，不送出。
 *
 * 新密碼長度在送出前先做 client 端 pre-validation（`MIN_PASSWORD_LENGTH`，鏡射 server
 * 端同名常數，與 `SetupPage`/`CreateUserDialog` 同一套模式）——只是體驗優化，server
 * 一樣會再驗一次（`password_too_short`），不能省。兩次新密碼不一致同樣在 client 端擋下，
 * 不送出請求（server 端沒有、也不需要對應的驗證——`confirmNewPassword` 本來就不在
 * `POST /api/auth/password` 的請求 body 裡）。
 *
 * 成功（204）：**`routes/auth.ts` 的 `POST /api/auth/password` 會替這次 request 重簽一顆
 * 新 session cookie**（帶 DB 端算出的新 tokenVersion），讓改密碼的本人不會被自己觸發的
 * tv++ 立即登出——這裡順著這個既有 server 行為走，不另外造一套「登出重登」的流程（曾經
 * 這樣做過，但 server／頁面／測試三邊對「成功後到底還算不算登入」各說各話，round 1
 * fix 時統一成這個版本）：`invalidateQueries(['me'])` 並等待這次 refetch 完成——新 cookie
 * 已經生效，refetch 拿到的是「新密碼已生效、`mustChangePassword:false`」的最新使用者物件
 * ——再導向 `/`。`ChangePasswordGate` 讀到新值後自然放行，不需要頁面自己判斷要不要跳過
 * gate。跳一則成功 toast，文案不提「請重新登入」（因為根本沒有登出）。
 */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { logout } = useSession();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(t("errors.password_too_short"));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setErrorMessage(t("changePassword.mismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await api<void>("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      // 等 refetch 完成才 navigate：`ChangePasswordGate` 在導航當下就要能讀到
      // `mustChangePassword:false`，不然會被它自己導回 `/change-password`。
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      toast({ title: t("changePassword.successMessage") });
      navigate("/", { replace: true });
      return;
    } catch (err) {
      if (err instanceof ApiFail) {
        setErrorMessage(t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }));
      } else {
        setErrorMessage(t("errors.fallback"));
      }
    } finally {
      setSubmitting(false);
    }
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

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">{t("changePassword.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("changePassword.description")}</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="change-password-current" className="text-sm font-medium">
              {t("changePassword.currentPassword")}
            </label>
            <Input
              id="change-password-current"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="change-password-new" className="text-sm font-medium">
              {t("changePassword.newPassword")}
            </label>
            <Input
              id="change-password-new"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint")}</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="change-password-confirm" className="text-sm font-medium">
              {t("changePassword.confirmNewPassword")}
            </label>
            <Input
              id="change-password-confirm"
              name="confirmNewPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
            />
          </div>

          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? t("changePassword.submitting") : t("changePassword.submit")}
          </Button>
        </form>
      </div>
    </main>
  );
}
