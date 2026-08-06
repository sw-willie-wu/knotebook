import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MIN_PASSWORD_LENGTH, type UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { SETUP_STATUS_QUERY_KEY } from "@/auth/guards";

/**
 * `POST /api/setup` 表單（第一個 admin 帳號）。密碼長度在送出前先做客戶端
 * pre-validation（`MIN_PASSWORD_LENGTH`，鏡射 server 端同名常數）——只是體驗優化，
 * server 一樣會再驗一次，不能省。
 *
 * 成功（201，cookie 已由 server 設好）→ 把回傳的 UserDto 寫進 `['me']` cache，
 * **並且**把 `SETUP_STATUS_QUERY_KEY` 直接種成 `{needed:false}`（`setQueryData`，
 * 不是 `invalidateQueries`）→ 再導向 `/`（§11.3 逐字：**setup 成功導 `/`**，不是
 * `/login`——cookie 已經是登入狀態）。
 *
 * 種 setup-status cache 這步不可省：`SetupGate` 是 layout route，`/setup → /`
 * 這次 navigate 不會讓它重新掛載，沒有任何東西會觸發 `['setup-status']` 的
 * refetch——沒種這筆 cache 的話 `needed` 會停留在 `true`，`SetupGate` 立刻把
 * 剛成功的使用者導回一個空白的 setup 表單（再送出會撞 409 already_setup）。
 */
export default function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(t("errors.password_too_short"));
      return;
    }

    setSubmitting(true);
    try {
      const user = await api<UserDto>("/api/setup", {
        method: "POST",
        body: JSON.stringify({ token, email, password, displayName }),
      });
      queryClient.setQueryData(SESSION_QUERY_KEY, user);
      queryClient.setQueryData(SETUP_STATUS_QUERY_KEY, { needed: false });
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
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

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={(e) => void handleSubmit(e)} className="w-full max-w-sm space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("setup.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("setup.description")}</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="setup-token" className="text-sm font-medium">
            {t("setup.token")}
          </label>
          <Input id="setup-token" name="token" required value={token} onChange={(e) => setToken(e.target.value)} />
        </div>

        <div className="space-y-1">
          <label htmlFor="setup-email" className="text-sm font-medium">
            {t("setup.email")}
          </label>
          <Input
            id="setup-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="setup-password" className="text-sm font-medium">
            {t("setup.password")}
          </label>
          <Input
            id="setup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("setup.passwordHint")}</p>
        </div>

        <div className="space-y-1">
          <label htmlFor="setup-display-name" className="text-sm font-medium">
            {t("setup.displayName")}
          </label>
          <Input
            id="setup-display-name"
            name="displayName"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t("setup.submitting") : t("setup.submit")}
        </Button>
      </form>
    </main>
  );
}
