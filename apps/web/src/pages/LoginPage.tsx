import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ERROR_CODES, safeNextPath, type AuthConfigDto, type UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/** SSO 入口的目的地。⚠ 測試刻意**另寫一份字面**而不是 import 這顆——那一族斷言的是
 * 本頁對 `GET /api/auth/oidc/login` 的產出契約，跟著實作的常數走就沒有牙齒了。 */
const OIDC_LOGIN_URL = "/api/auth/oidc/login";

/**
 * `POST /api/auth/login` 表單。成功 → 把回傳的 UserDto 直接寫進 `['me']` query
 * cache（不用等下一次 refetch）再導向 **`safeNextPath(?next=)` 或 `/`**（#131：
 * `useSessionGate` 把人踢來這裡時會帶上 `?next=<原本要去的頁>`；§11.3 的「login 成功
 * 導 `/`」現在是沒有合法 next 時的 fallback）。
 *
 * 429 `too_many_attempts`：ApiFail 上會附 `retryAfterMs`（見 client.ts），換算成
 * 秒數併入錯誤文案顯示，讓使用者知道還要等多久。其餘 ApiFail 一律用
 * `errors.<code>` 對映，查不到（理論上不會，i18n 測試已覆蓋 ERROR_CODES 全集）
 * 才退回 `errors.fallback`；非 ApiFail（網路失敗等，見 client.ts 說明）一律視為
 * `errors.fallback`，不能直接讀 `.code`（raw Error 沒有這個欄位）。
 *
 * OIDC（Plan 5 §14.4）：`['auth-config']` 讀 `GET /api/auth/config`（免認證），
 * `oidc.enabled` 決定要不要在表單下方多渲染一顆 SSO 入口。那顆入口是純
 * `<a href="/api/auth/oidc/login">`——**不**走 `api()`/`fetch`：`/api/auth/oidc/login`
 * 會 302 到 IdP，再 302 回 `/api/auth/oidc/callback`，整條鏈要由瀏覽器的頂層導航
 * 承載（`fetch` 的 redirect 語意與 cookie 寫入時機都不對，見 client.ts 的
 * `credentials:'include'`/manual redirect 說明），因此刻意繞過既有的 `api()` 入口。
 *
 * `?error=<code>`（OIDC 失敗時 callback route 會把使用者導回 `/login?error=<code>`）
 * 走既有的同一套 `errors.<code>` 對映機制，**直接餵進 `errorMessage` 這顆 state 的
 * 初始值**（`useState` 惰性初始化，只在第一次 render 採樣一次）——與登入表單提交
 * 失敗共用同一個狀態/UI（既有的 `role="alert"` 區），不另開一組 `queryErrorMessage`
 * 疊加渲染。這樣「送出表單」既有的 `setErrorMessage(null)`（`handleSubmit` 一開頭）
 * 就會自然把它蓋掉——不這樣做的話（改成另一個獨立的、每次 render 都從
 * `searchParams` 重算的 `queryErrorMessage`，用 `errorMessage ?? queryErrorMessage`
 * 疊加顯示），使用者重新送出表單、進入 `submitting` 等待回應那段空窗期
 * （`errorMessage` 已被清 `null`，新結果還沒回來）會讓這個舊的 OIDC 錯誤文案
 * 重新浮現，跟這次全新的提交無關，會誤導使用者（fix round 1 NIT-6）。
 *
 * **`code` 是任意 query string，不可信任**：餵進 `t()` 前先過 shared `ERROR_CODES`
 * 白名單，不在集合內一律視為 `fallback`——`t(\`errors.${arbitraryUserInput}\`)`
 * 直接把使用者輸入接進 i18next key 曾實測炸出兩種問題：`?error=__proto__` 命中
 * `Object.prototype` 繼承屬性、i18next 對非預期 key 型別的內部行為不可控；
 * `?error=constructor` 解析出 `errors` 物件的 `constructor`（`Object` function）
 * 當作翻譯結果，塞進 JSX 會是「Functions are not valid as a React child」執行期
 * 錯誤（fix round 1 MAJOR-1）。白名單擋下後，`code` 只可能是 `ERROR_CODES` 成員或
 * 字面 `"fallback"`，兩者都是 `errors.*` 底下貨真價實存在的字串 key。
 *
 * 消化完後立刻用 `setSearchParams(…, {replace:true})` 清掉 URL 上的 `error` 參數
 * （不留歷史紀錄）——訊息已經存進 `errorMessage` state，清 URL 純粹是避免這個一次性
 * 參數賴在網址列上（重新整理／加入書籤都會把舊錯誤帶回來）。
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // #131：`?next=` 是「登入完要回哪」——由 `useSessionGate` 在把人踢來這裡時寫上。
  // **一律先過 `safeNextPath`**（同一支函式 server 端也用）：不合法就當作沒有，落 `/`。
  // 這裡驗過之後 SSO 連結才轉交給 server，而 server（#131 Task 5 起）會**再驗一次**
  // ——那條路徑上使用者可以自己直接打 `/api/auth/oidc/login?next=…`，不經過這個頁面。
  //
  // 與上面 `?error=` 的惰性採樣**刻意相反**：`next` 不是一次性的（沒有「被新提交蓋掉」
  // 的語意、也不會被清掉），每次 render 重算、永遠反映當下網址即可。`safeNextPath`
  // 是純函式，不需要 useMemo。
  const nextPath = safeNextPath(searchParams.get("next"));

  // SSO 入口的 href：`next` 合法時把它轉交給 server。這個組法是本頁對
  // `GET /api/auth/oidc/login` 的產出契約，#131 Task 5 的 server 端要消費它。
  const ssoHref =
    nextPath === null ? OIDC_LOGIN_URL : `${OIDC_LOGIN_URL}?next=${encodeURIComponent(nextPath)}`;

  const authConfigQuery = useQuery({
    queryKey: ["auth-config"],
    queryFn: () => api<AuthConfigDto>("/api/auth/config"),
  });

  useEffect(() => {
    if (searchParams.has("error")) {
      // ⚠ #131：**只刪 `error` 這一個鍵**，其餘（尤其 `next`）必須原封不動留著——
      // 改成整個換掉 searchParams 的話，帶著 `?error=…&next=…` 回到登入頁的人登入完
      // 就回不去了。守衛：「清掉一次性的 ?error= 時不得順手清掉 next」那案（它同時
      // 斷言 error 真的消失、next 仍在）。變數刻意不叫 `next`：本檔的 `next` 專指
      // 那個 query 參數。
      const params = new URLSearchParams(searchParams);
      params.delete("error");
      setSearchParams(params, { replace: true });
    }
    // 只在掛載時跑一次——只清一次性帶進來的 `?error=`，不隨 searchParams/
    // setSearchParams 的 identity 變動重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    const rawQueryError = searchParams.get("error");
    if (!rawQueryError) return null;
    const code = (ERROR_CODES as readonly string[]).includes(rawQueryError) ? rawQueryError : "fallback";
    return t(`errors.${code}`, { defaultValue: t("errors.fallback") });
  });
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setRetryAfterSeconds(null);
    setSubmitting(true);

    try {
      const user = await api<UserDto>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      navigate(nextPath ?? "/", { replace: true });
      return;
    } catch (err) {
      if (err instanceof ApiFail) {
        if (err.code === "too_many_attempts" && typeof err.retryAfterMs === "number") {
          setRetryAfterSeconds(Math.ceil(err.retryAfterMs / 1000));
        }
        setErrorMessage(t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }));
      } else {
        setErrorMessage(t("errors.fallback"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={(e) => void handleSubmit(e)} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{t("login.title")}</h1>

        <div className="space-y-1">
          <label htmlFor="login-email" className="text-sm font-medium">
            {t("login.email")}
          </label>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="login-password" className="text-sm font-medium">
            {t("login.password")}
          </label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
            {retryAfterSeconds !== null && " " + t("login.retryAfter", { seconds: retryAfterSeconds })}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t("login.submitting") : t("login.submit")}
        </Button>

        {authConfigQuery.data?.oidc.enabled && (
          <>
            <div className="border-t" aria-hidden="true" />
            <Button asChild variant="outline" className="w-full">
              <a href={ssoHref}>{t("login.sso")}</a>
            </Button>
          </>
        )}
      </form>
    </main>
  );
}
