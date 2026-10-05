import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ERROR_CODES, type OidcRedirectDto, type PendingLinkConfirmDto, type PendingLinkDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/** `?error=` 白名單（#187 §9.4）：prove 回程會帶這些碼回來；其餘一律 fallback（任意 query 不得直接餵 i18next，Plan 5 MAJOR-1）。 */
const LINK_ERROR_CODES = new Set<string>([
  "oidc_link_proof_mismatch", "oidc_link_expired", "identity_taken", "identity_already_linked",
  "account_disabled", "oidc_exchange_failed", "oidc_unavailable", "oidc_state_mismatch", "oidc_claim_too_long",
]);

/** 回登入頁；code 是 `ERROR_CODES` 成員才帶（LoginPage 自己還會再過一次白名單）。 */
function loginLocation(code: string | null): string {
  return code !== null && (ERROR_CODES as readonly string[]).includes(code) ? `/login?error=${code}` : "/login";
}

/**
 * #187 §7.5「這個 email 已有帳號，要連結嗎？」。不掛在 RequireAuth 底下：它只看 pending-link cookie（HttpOnly，頁面讀不到，
 * 一律經 `GET /api/auth/oidc/pending`），與目前 session 無關——已登入他人的瀏覽器完成連結，server 簽出的 session 取代舊的。
 * pending 失效（401）→ 安靜回 `/login`，帶著當下的 `?error=`（r3-N6：prove 回程的 oidc_link_expired 要讓使用者看得到）。
 * 成功後只用 confirm 回應的 `next`，**不讀網址參數**（r2-M2）。provider 顯示名是管理員輸入：只進文字節點（r1-M6）。
 */
export default function LinkAccountPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // 惰性採樣一次（同 LoginPage）：之後會把 error 從網址清掉，但 401 轉登入頁時還要帶它。
  const [initialError] = useState<string | null>(() => searchParams.get("error"));
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    initialError === null ? null : t(`errors.${LINK_ERROR_CODES.has(initialError) ? initialError : "fallback"}`, { defaultValue: t("errors.fallback") }),
  );
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (searchParams.has("error")) {
      const params = new URLSearchParams(searchParams);
      params.delete("error");
      setSearchParams(params, { replace: true });
    }
    // 只在掛載時清一次性的 ?error=。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingQuery = useQuery({
    queryKey: ["oidc-pending"],
    queryFn: () => api<PendingLinkDto>("/api/auth/oidc/pending"),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    const fail = pendingQuery.error;
    if (!(fail instanceof ApiFail)) return;
    if (fail.status === 401) navigate(loginLocation(initialError), { replace: true });
    else if (fail.code === "oidc_link_expired") navigate(loginLocation("oidc_link_expired"), { replace: true });
  }, [pendingQuery.error, navigate, initialError]);

  function showFailure(err: unknown): void {
    if (!(err instanceof ApiFail)) {
      setErrorMessage(t("errors.fallback"));
      return;
    }
    if (err.status === 401 && err.code === "unauthorized") {
      navigate("/login", { replace: true });
      return;
    }
    if (err.code === "oidc_link_expired") {
      navigate(loginLocation("oidc_link_expired"), { replace: true });
      return;
    }
    if (err.code === "too_many_attempts" && typeof err.retryAfterMs === "number") setRetryAfterSeconds(Math.ceil(err.retryAfterMs / 1000));
    setErrorMessage(t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }));
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const pending = pendingQuery.data;
    if (pending === undefined) return;
    setErrorMessage(null);
    setRetryAfterSeconds(null);
    setBusy(true);
    try {
      const res = await api<PendingLinkConfirmDto>("/api/auth/oidc/pending/confirm", {
        method: "POST",
        body: JSON.stringify({ password, pendingId: pending.pendingId }),
      });
      queryClient.setQueryData(SESSION_QUERY_KEY, res.user);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      navigate(res.next, { replace: true });
    } catch (err) {
      showFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleProve(providerId: string): Promise<void> {
    const pending = pendingQuery.data;
    if (pending === undefined) return;
    setErrorMessage(null);
    // 前一次密碼送出的 429 倒數不得錯接到 prove 的錯誤上（fix r1 M-b）。
    setRetryAfterSeconds(null);
    setBusy(true);
    try {
      const res = await api<OidcRedirectDto>(`/api/auth/oidc/pending/prove/${encodeURIComponent(providerId)}`, {
        method: "POST",
        body: JSON.stringify({ pendingId: pending.pendingId }),
      });
      // 第二段 OIDC 往返由瀏覽器頂層導航承載（state cookie 已由這個 fetch 的 Set-Cookie 寫入）。
      window.location.assign(res.url);
    } catch (err) {
      showFailure(err);
      if (err instanceof ApiFail && err.code === "provider_not_found") void pendingQuery.refetch();
      setBusy(false);
    }
  }

  async function handleCancel(showNotice: boolean): Promise<void> {
    try {
      await api<void>("/api/auth/oidc/pending/cancel", { method: "POST" });
    } catch {
      // 清不掉也照樣離開：cookie 15 分鐘後自然過期。
    }
    if (showNotice) toast({ title: t("linkAccount.cancelled") });
    navigate("/login", { replace: true });
  }

  const loadError = pendingQuery.error;
  const noProofMethod = loadError instanceof ApiFail && loadError.code === "oidc_link_no_proof_method";
  // 401／oidc_link_expired 由上面的 effect 轉登入頁；其餘（500、網路失敗）給通用錯誤與出口，免得永遠停在 Loading（fix r1 M-c）。
  const loadFailed =
    loadError !== null &&
    !noProofMethod &&
    !(loadError instanceof ApiFail && (loadError.status === 401 || loadError.code === "oidc_link_expired"));
  const pending = pendingQuery.data;

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("linkAccount.title")}</h1>

        {noProofMethod && (
          <>
            <p>{t("errors.oidc_link_no_proof_method")}</p>
            <Button type="button" variant="outline" className="w-full" onClick={() => void handleCancel(false)}>
              {t("linkAccount.backToLogin")}
            </Button>
          </>
        )}

        {loadFailed && (
          <>
            <p role="alert" className="text-sm text-destructive">
              {t("errors.fallback")}
            </p>
            <Button type="button" variant="outline" className="w-full" onClick={() => void handleCancel(false)}>
              {t("linkAccount.backToLogin")}
            </Button>
          </>
        )}

        {pending === undefined && !noProofMethod && !loadFailed && <p className="text-sm text-muted-foreground">{t("linkAccount.loading")}</p>}

        {pending !== undefined && (
          <>
            <p>{t("linkAccount.body", { email: pending.email, provider: pending.providerDisplayName ?? t("linkAccount.unknownProvider") })}</p>

            {errorMessage && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
                {retryAfterSeconds !== null && " " + t("login.retryAfter", { seconds: retryAfterSeconds })}
              </p>
            )}

            {pending.methods.password && (
              <form onSubmit={e => void handleConfirm(e)} className="space-y-2">
                <label htmlFor="link-account-password" className="text-sm font-medium">
                  {t("linkAccount.passwordLabel")}
                </label>
                <Input id="link-account-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
                <Button type="submit" variant="brandSolid" className="w-full" disabled={busy}>
                  {busy ? t("linkAccount.confirming") : t("linkAccount.confirmWithPassword")}
                </Button>
              </form>
            )}

            {pending.methods.providers.map(provider => (
              <Button key={provider.id} type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void handleProve(provider.id)}>
                {t("linkAccount.proveWith", { name: provider.displayName })}
              </Button>
            ))}

            <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void handleCancel(true)}>
              {t("linkAccount.cancel")}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
