import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MIN_PASSWORD_LENGTH } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { completePasswordReset, inspectPasswordReset } from "@/api/passwordReset";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY, useSession, type UseSessionResult } from "@/auth/useSession";
import { RESET_TOKEN_KEY } from "@/auth/resetTokenStorage";
import { useOneTimeLinkToken } from "@/auth/useOneTimeLinkToken";

type InspectState =
  | { kind: "ok"; email: string; expiresAt: string }
  | { kind: "invalid" }
  | { kind: "loginOff" }
  | { kind: "error"; code: string | null };

/**
 * #286 §5.2 `/reset-password`：與 `/register` 同層、在 `RequireAuth` 之外。token 的處理（spec §3.2）：
 * 1. token 在 fragment（`#token=…`），不送到 server、不進 log 與 Referer；掛載時讀進 state；
 * 2. 立刻以 react-router 的 `navigate(…, { replace: true })` 清掉 fragment。不用 `history.replaceState`：router 的
 *    location 不會跟著更新，傳 `null` 還會清掉 router 放在 `history.state` 的 key／idx；
 * 3. 確定未登入時才寫進 sessionStorage（重新整理後還找得回來）；已登入時只放 state，鍵若存在就刪掉；
 * 4. 成功、410、頁面卸載都刪鍵（重新整理不跑 cleanup，所以不影響第 3 點）。整頁離開時由 `main.tsx` 清。
 * 1–4 的實作在共用 hook `useOneTimeLinkToken`（與 #285 邀請註冊同一份，兩頁行為不分岔）。
 *
 * 已登入（任何帳號）只顯示「請先登出」：避免管理員在自己的瀏覽器測連結時，把自己換成對方（spec §5.2-2）。
 * token 不進 TanStack Query 的 queryKey：快取在卸載後仍會保留到 gcTime。
 */
export default function ResetPasswordPage() {
  const session = useSession();
  const { token, forget } = useOneTimeLinkToken({ param: "token", storageKey: RESET_TOKEN_KEY, user: session.user });
  // 同一頁換成新 token（貼新連結）時以 key 重掛：舊的錯誤、輸入與晚到的回應不會帶進新連結。
  return <ResetPasswordContent key={token ?? ""} token={token} forget={forget} session={session} />;
}

function ResetPasswordContent({ token, forget, session }: { token: string | null; forget: () => void; session: UseSessionResult }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, query, logout } = session;

  const [inspected, setInspected] = useState<{ token: string; state: InspectState } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (user !== null || token === null) return;
    let cancelled = false;
    inspectPasswordReset(token).then(
      (res) => {
        if (!cancelled) setInspected({ token, state: { kind: "ok", email: res.email, expiresAt: res.expiresAt } });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiFail && err.status === 410) {
          forget();
          setInspected({ token, state: { kind: "invalid" } });
        } else if (err instanceof ApiFail && err.code === "password_login_disabled") {
          setInspected({ token, state: { kind: "loginOff" } });
        } else {
          setInspected({ token, state: { kind: "error", code: err instanceof ApiFail ? err.code : null } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user, token, forget]);

  const backToLogin = (
    <p className="text-center text-sm">
      <Link to="/login" className="underline underline-offset-4">
        {t("resetPassword.backToLogin")}
      </Link>
    </p>
  );
  const frame = (children: ReactNode) => (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("resetPassword.title")}</h1>
        {children}
      </div>
    </main>
  );
  const message = (text: string, role: "alert" | "status" = "alert") => (
    <p role={role} className="text-sm text-muted-foreground">
      {text}
    </p>
  );
  const errorText = (code: string | null) => (code === null ? t("errors.fallback") : t(`errors.${code}`, { defaultValue: t("errors.fallback") }));

  if (token === null) return frame(<>{message(t("errors.reset_link_invalid"))}{backToLogin}</>);

  if (query.isError && user === undefined) {
    return frame(
      <>
        {message(t("app.sessionError"))}
        <Button type="button" variant="brandSolid" className="w-full" onClick={() => void query.refetch()}>
          {t("app.retry")}
        </Button>
      </>,
    );
  }

  if (user === undefined) return frame(message(t("resetPassword.checking"), "status"));

  if (user) {
    return frame(
      <>
        {message(t("resetPassword.signedIn", { email: user.email }), "status")}
        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            setFormError(null);
            logout().catch((err: unknown) => setFormError(errorText(err instanceof ApiFail ? err.code : null)));
          }}
        >
          {t("resetPassword.signOut")}
        </Button>
      </>,
    );
  }

  const state = inspected?.token === token ? inspected.state : null;
  if (state === null) return frame(message(t("resetPassword.checking"), "status"));
  if (state.kind === "invalid") return frame(<>{message(t("errors.reset_link_invalid"))}{backToLogin}</>);
  if (state.kind === "loginOff") return frame(<>{message(t("resetPassword.passwordLoginOff"))}{backToLogin}</>);
  if (state.kind === "error") return frame(<>{message(errorText(state.code))}{backToLogin}</>);

  const validToken = token;
  const when = new Date(state.expiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFormError(t("errors.password_too_short"));
      return;
    }
    if (password !== confirm) {
      setFormError(t("register.mismatch"));
      return;
    }
    setSubmitting(true);
    try {
      const signedIn = await completePasswordReset(validToken, password);
      forget();
      queryClient.setQueryData(SESSION_QUERY_KEY, signedIn);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiFail && err.status === 410) {
        forget();
        setInspected({ token: validToken, state: { kind: "invalid" } });
      } else {
        setFormError(errorText(err instanceof ApiFail ? err.code : null));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return frame(
    <>
      <p className="text-sm">{t("resetPassword.forAccount", { email: state.email, when })}</p>
      <p className="text-sm text-muted-foreground">{t("resetPassword.notice")}</p>
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="reset-password-new" className="text-sm font-medium">
            {t("resetPassword.newPassword")}
          </label>
          <Input id="reset-password-new" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="reset-password-confirm" className="text-sm font-medium">
            {t("resetPassword.confirmPassword")}
          </label>
          <Input id="reset-password-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" variant="brandSolid" className="w-full" disabled={submitting}>
          {submitting ? t("resetPassword.submitting") : t("resetPassword.submit")}
        </Button>
      </form>
    </>,
  );
}
