import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, MAX_REGISTER_EMAIL_LENGTH, MIN_PASSWORD_LENGTH, safeNextPath, type UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { acceptInvite, inspectInvite } from "@/api/invites";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY, useSession } from "@/auth/useSession";
import { INVITE_TOKEN_KEY } from "@/auth/resetTokenStorage";
import { useOneTimeLinkToken } from "@/auth/useOneTimeLinkToken";
import { ProviderIcon } from "@/components/ProviderIcon";

/** SSO 入口前綴——與 LoginPage 同一個端點（B10：「透過 X 註冊」與「透過 X 登入」打同一處、同一結果）。 */
const OIDC_LOGIN_PREFIX = "/api/auth/oidc/login/";

/**
 * #187 §9.4 `/register`（S2）。與 `/login` 同層、在 `RequireAuth` 之外；已登入者導 `next`（經 safeNextPath）或 `/`（r2-N7）。
 * 入口照 PR-C §3.8：
 * - 帳密自助註冊不可用、也沒有會建帳的服務 → 只顯示「目前不開放註冊」＋回登入；
 * - 帳密表單只在帳密自助註冊可用（`registration.enabled` 且帳密有效值開）時顯示（B21）；
 * - 「透過 X 註冊」只列 `registration.providerIds` 裡的服務；
 * - 設定讀不到（載入中或失敗）→ 照常顯示表單（server 是最終裁決）。
 * 成功（201，B9 成功即登入）→ 寫 session 快取、導向 `safeNextPath(?next=)` 或 `/`。provider 顯示名只進文字節點（r1-M6）。
 *
 * #285 邀請模式：網址帶 `#invite=…`（或同分頁重新整理後 sessionStorage 還有）時進 `InviteRegistration`，在
 * `OpenRegistration` 的 `if (user) return <Navigate …>` 之前分流，不看上面的 PR-C §3.8 入口條件、不受影響。
 * 邀請模式的 token 處理（同步取得、fragment 由 router 清、只在未登入時寫 storage、成功／無效／卸載刪鍵、
 * 啟動清理在 `auth/resetTokenStorage.ts` 的表）全在共用 hook `useOneTimeLinkToken`。
 * 已登入要先登出（spec §8-6）：避免管理員在自己的瀏覽器測連結時，被換成新帳號。
 */
export default function RegisterPage() {
  const { user, query, logout } = useSession();
  const { token, forget } = useOneTimeLinkToken({ param: "invite", storageKey: INVITE_TOKEN_KEY, user });
  return token !== null ? <InviteRegistration key={token} token={token} forget={forget} user={user} sessionError={query.isError ? { code: query.error instanceof ApiFail ? query.error.code : null } : null} refetch={() => void query.refetch()} logout={logout} /> : <OpenRegistration />;
}

/** email／顯示名上限與密碼檢查，一般註冊與邀請註冊共用；回錯誤文字或 null。 */
function validateRegistration(t: TFunction, v: { email: string; displayName: string; password: string; confirm: string }): string | null {
  // 上限與 server 同一組常數（總管裁定疑點 4）：email 以 trim 後的 `.length` 計、顯示名以 code point 計。
  if (v.email.trim().length > MAX_REGISTER_EMAIL_LENGTH) return t("register.emailTooLong", { max: MAX_REGISTER_EMAIL_LENGTH });
  if ([...v.displayName.trim()].length > MAX_REGISTER_DISPLAY_NAME_LENGTH) return t("register.displayNameTooLong", { max: MAX_REGISTER_DISPLAY_NAME_LENGTH });
  if (v.password.length < MIN_PASSWORD_LENGTH) return t("errors.password_too_short");
  if (v.password !== v.confirm) return t("register.mismatch");
  return null;
}

function OpenRegistration() {
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
  // PR-C §3.8：`?? []` 防回滾窗期新版分頁打到舊 server（N6）。
  const data = config.data;
  const loaded = data !== undefined;
  const passwordSignup = loaded && data.registration.enabled && data.passwordLogin.enabled;
  const signupProviders = loaded ? data.providers.filter((p) => (data.registration.providerIds ?? []).includes(p.id)) : [];
  const registrationClosed = loaded && !passwordSignup && signupProviders.length === 0;
  const showPasswordForm = !loaded || passwordSignup; // 未載入時顯示（server 最終裁決，同現行）

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    const invalid = validateRegistration(t, { email, displayName, password, confirm });
    if (invalid !== null) {
      setErrorMessage(invalid);
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
            {showPasswordForm && (
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
            {signupProviders.length > 0 && (
              <>
                {showPasswordForm && <div className="border-t" aria-hidden="true" />}
                {signupProviders.map((provider) => (
                  <Button key={provider.id} asChild variant="outline" className="w-full">
                    <a href={ssoHref(provider.id)}>
                      <ProviderIcon icon={provider.icon} />
                      {t("register.signUpWith", { name: provider.displayName })}
                    </a>
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

type InviteState =
  | { kind: "ok"; expiresAt: string }
  | { kind: "invalid" }
  | { kind: "loginOff" }
  | { kind: "tooMany" }
  | { kind: "error"; code: string | null };

interface InviteRegistrationProps {
  token: string;
  forget: () => void;
  user: UserDto | null | undefined;
  sessionError: { code: string | null } | null;
  refetch: () => void;
  logout: () => Promise<void>;
}

/** #285 §6.2 邀請模式。inspect／accept 的 token 只走 POST body，不進 queryKey。 */
function InviteRegistration({ token, forget, user, sessionError, refetch, logout }: InviteRegistrationProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const [inspected, setInspected] = useState<{ token: string; state: InviteState } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user !== null) return;
    let cancelled = false;
    inspectInvite(token).then(
      (res) => {
        if (!cancelled) setInspected({ token, state: { kind: "ok", expiresAt: res.expiresAt } });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiFail && err.status === 410) {
          forget();
          setInspected({ token, state: { kind: "invalid" } });
        } else if (err instanceof ApiFail && err.code === "password_login_disabled") {
          setInspected({ token, state: { kind: "loginOff" } });
        } else if (err instanceof ApiFail && err.status === 429) {
          setInspected({ token, state: { kind: "tooMany" } });
        } else {
          setInspected({ token, state: { kind: "error", code: err instanceof ApiFail ? err.code : null } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user, token, forget]);

  const errorText = (code: string | null) => (code === null ? t("errors.fallback") : t(`errors.${code}`, { defaultValue: t("errors.fallback") }));
  const frame = (children: ReactNode) => (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("register.title")}</h1>
        {children}
      </div>
    </main>
  );
  const message = (text: string, role: "alert" | "status" = "alert") => (
    <p role={role} className="text-sm text-muted-foreground">
      {text}
    </p>
  );
  const backToLogin = (
    <p className="text-center text-sm">
      <Link to="/login" className="underline underline-offset-4">
        {t("register.backToLogin")}
      </Link>
    </p>
  );

  // 成功後 accepted 先於 session 快取更新：不會閃出「你已登入」，也不理 `?next`（N-7）。
  if (accepted) return <Navigate to="/" replace />;

  if (sessionError !== null && user === undefined) {
    return frame(
      <>
        {message(errorText(sessionError.code))}
        <Button type="button" variant="outline" className="w-full" onClick={refetch}>
          {t("app.retry")}
        </Button>
      </>,
    );
  }

  if (user === undefined) return frame(message(t("register.invite.checking"), "status"));

  if (user) {
    return frame(
      <>
        {message(t("register.invite.signedIn", { email: user.email }), "status")}
        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            setErrorMessage(null);
            logout().catch((err: unknown) => setErrorMessage(errorText(err instanceof ApiFail ? err.code : null)));
          }}
        >
          {t("register.invite.signOut")}
        </Button>
      </>,
    );
  }

  const state = inspected?.token === token ? inspected.state : null;
  if (state === null) return frame(message(t("register.invite.checking"), "status"));
  if (state.kind === "invalid") return frame(<>{message(t("errors.invite_invalid"))}{backToLogin}</>);
  if (state.kind === "loginOff") return frame(<>{message(t("register.invite.passwordLoginOff"))}{backToLogin}</>);
  if (state.kind === "tooMany") return frame(<>{message(t("errors.too_many_requests"))}{backToLogin}</>);
  if (state.kind === "error") return frame(<>{message(errorText(state.code))}{backToLogin}</>);

  const when = new Date(state.expiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    const invalid = validateRegistration(t, { email, displayName, password, confirm });
    if (invalid !== null) {
      setErrorMessage(invalid);
      return;
    }
    setSubmitting(true);
    try {
      const created = await acceptInvite(displayName.trim() === "" ? { token, email, password } : { token, email, password, displayName });
      setAccepted(true);
      forget();
      queryClient.setQueryData(SESSION_QUERY_KEY, created);
    } catch (err) {
      if (err instanceof ApiFail && err.status === 410) {
        forget();
        setInspected({ token, state: { kind: "invalid" } });
      } else {
        setErrorMessage(errorText(err instanceof ApiFail ? err.code : null));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return frame(
    <>
      <p className="text-sm text-muted-foreground">{t("register.invite.notice", { when })}</p>
      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
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
    </>,
  );
}
