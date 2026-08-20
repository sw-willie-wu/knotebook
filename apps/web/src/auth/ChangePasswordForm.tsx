import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MIN_PASSWORD_LENGTH } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

export interface ChangePasswordFormProps {
  /**
   * 成功（`POST /api/auth/password` 204 + `['me']` refetch 完成）後呼叫——
   * **導向完全由呼叫端決定**（spec §13.4）：強制頁（`ChangePasswordPage`）
   * `navigate("/", {replace:true})`；設定 modal（`SettingsAccountSection`）
   * 只 toast、不導航（`navigate("/")` 會關掉 modal，甚至扯掉背景 `/notes/:ref`
   * 的共編 provider——不可）。本元件自己不 toast、不 navigate，只負責欄位/
   * 驗證/送出/錯誤顯示＋成功後 `invalidateQueries(['me'])`（rev 5.7 的 server
   * 重簽對齊行為在此層——見下方 handleSubmit 內註解）。
   */
  onSuccess: () => void;
}

/**
 * 改密碼表單（自 `ChangePasswordPage` 抽出，rev 5.7 行為原封搬入；spec §13.4）。
 * 打 `POST /api/auth/password`——currentPassword + newPassword，
 * `confirmNewPassword` 只在 client 端比對，不送出。
 *
 * 新密碼長度在送出前先做 client 端 pre-validation（`MIN_PASSWORD_LENGTH`，鏡射
 * server 端同名常數，與 `CreateUserDialog` 同一套模式）——只是體驗
 * 優化，server 一樣會再驗一次（`password_too_short`），不能省。兩次新密碼不一致
 * 同樣在 client 端擋下，不送出請求。
 *
 * 成功（204）：`routes/auth.ts` 的 `POST /api/auth/password` 會替這次 request
 * 重簽一顆新 session cookie（帶 DB 端算出的新 tokenVersion），讓改密碼的本人
 * 不會被自己觸發的 tv++ 立即登出——這裡順著這個既有 server 行為走：
 * `invalidateQueries(['me'])` 並等待這次 refetch 完成，新 cookie 已經生效，
 * refetch 拿到的是「新密碼已生效、`mustChangePassword:false`」的最新使用者
 * 物件——再呼叫 `onSuccess()`，讓呼叫端決定接下來要導向哪裡／要不要提示。
 */
export function ChangePasswordForm({ onSuccess }: ChangePasswordFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

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
      // 等 refetch 完成才呼叫 onSuccess：呼叫端若要 navigate，導航當下就要能讀到
      // `mustChangePassword:false`（`ChangePasswordGate` 才不會把它導回改密碼頁）。
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      // 呼叫 onSuccess() 前先清空三個密碼欄位——強制頁那條路徑會立刻 navigate 卸載，
      // 這步無感；但設定 modal 那條路徑只 toast、表單留在原地（見 onSuccess 的 JSDoc），
      // 不清的話舊密碼明碼會留存在 DOM/state 裡。
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      onSuccess();
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

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
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
        <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
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
  );
}
