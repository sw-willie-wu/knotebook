import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, MAX_REGISTER_EMAIL_LENGTH, MIN_PASSWORD_LENGTH, safeNextPath, type UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY, useSession } from "@/auth/useSession";

/** SSO 入口前綴——與 LoginPage 同一個端點（B10：「透過 X 註冊」與「透過 X 登入」打同一處、同一結果）。 */
const OIDC_LOGIN_PREFIX = "/api/auth/oidc/login/";

/**
 * #187 §9.4 `/register`（S2）。與 `/login` 同層、在 `RequireAuth` 之外；已登入者導 `/`（r2-N7）。
 * - 「允許註冊」關 → 只顯示「目前不開放註冊」＋回登入（SSO 註冊鈕也隱藏：W21，關閉時 SSO 首登也不能建帳）；
 * - 帳密登入有效值關 → 隱藏帳密表單、只留 SSO 註冊鈕（B21）；
 * - 設定讀不到（載入中或失敗）→ 照常顯示表單（server 是最終裁決）。
 * 成功（201，B9 成功即登入）→ 寫 session 快取、導向 `safeNextPath(?next=)` 或 `/`。provider 顯示名只進文字節點（r1-M6）。
 */
export default function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const { user } = useSession();
  const config = useAuthConfig();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 已登入（含剛註冊成功、session 快取剛被寫入的那次 render）→ 導 `next` 或 `/`。目的地必須與 handleSubmit 的
  // navigate 一致，否則這行會以 `/` 蓋掉成功後要去的 next（實測：寫入快取後 user 立即為真）。
  if (user) return <Navigate to={nextPath ?? "/"} replace />;

  const ssoHref = (providerId: string): string => {
    const base = `${OIDC_LOGIN_PREFIX}${encodeURIComponent(providerId)}`;
    return nextPath === null ? base : `${base}?next=${encodeURIComponent(nextPath)}`;
  };
  const loginHref = nextPath === null ? "/login" : `/login?next=${encodeURIComponent(nextPath)}`;
  const registrationClosed = config.data?.registration.enabled === false;
  const passwordLoginEnabled = config.data?.passwordLogin.enabled !== false;
  const providers = config.data?.providers ?? [];

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    // 上限與 server 同一組常數（總管裁定疑點 4）：email 以 trim 後的 `.length` 計、顯示名以 code point 計。
    if (email.trim().length > MAX_REGISTER_EMAIL_LENGTH) {
      setErrorMessage(t("register.emailTooLong", { max: MAX_REGISTER_EMAIL_LENGTH }));
      return;
    }
    if ([...displayName.trim()].length > MAX_REGISTER_DISPLAY_NAME_LENGTH) {
      setErrorMessage(t("register.displayNameTooLong", { max: MAX_REGISTER_DISPLAY_NAME_LENGTH }));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(t("errors.password_too_short"));
      return;
    }
    if (password !== confirm) {
      setErrorMessage(t("register.mismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const body = displayName.trim() === "" ? { email, password } : { email, password, displayName };
      const created = await api<UserDto>("/api/auth/register", { method: "POST", body: JSON.stringify(body) });
      queryClient.setQueryData(SESSION_QUERY_KEY, created);
      navigate(nextPath ?? "/", { replace: true });
    } catch (err) {
      setErrorMessage(err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("register.title")}</h1>

        {registrationClosed ? (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              {t("register.closed")}
            </p>
            <p className="text-center text-sm">
              <Link to="/login" className="underline underline-offset-4">
                {t("register.backToLogin")}
              </Link>
            </p>
          </>
        ) : (
          <>
            {errorMessage && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
              </p>
            )}
            {passwordLoginEnabled && (
              <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="register-email" className="text-sm font-medium">{t("register.email")}</label>
                  <Input id="register-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="register-display-name" className="text-sm font-medium">{t("register.displayName")}</label>
                  <Input id="register-display-name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <label htmlFor="register-password" className="text-sm font-medium">{t("register.password")}</label>
                  <Input id="register-password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                  <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="register-confirm" className="text-sm font-medium">{t("register.confirmPassword")}</label>
                  <Input id="register-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
                <Button type="submit" variant="brandSolid" className="w-full" disabled={submitting}>
                  {submitting ? t("register.submitting") : t("register.submit")}
                </Button>
              </form>
            )}
            {providers.length > 0 && (
              <>
                {passwordLoginEnabled && <div className="border-t" aria-hidden="true" />}
                {providers.map((provider) => (
                  <Button key={provider.id} asChild variant="outline" className="w-full">
                    <a href={ssoHref(provider.id)}>{t("register.signUpWith", { name: provider.displayName })}</a>
                  </Button>
                ))}
              </>
            )}
            <p className="text-center text-sm">
              <Link to={loginHref} className="underline underline-offset-4">
                {t("register.haveAccount")}
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
