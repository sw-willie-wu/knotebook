import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/**
 * `POST /api/auth/login` 表單。成功 → 把回傳的 UserDto 直接寫進 `['me']` query
 * cache（不用等下一次 refetch）再導向 `/`（§11.3：login 成功導 `/`）。
 *
 * 429 `too_many_attempts`：ApiFail 上會附 `retryAfterMs`（見 client.ts），換算成
 * 秒數併入錯誤文案顯示，讓使用者知道還要等多久。其餘 ApiFail 一律用
 * `errors.<code>` 對映，查不到（理論上不會，i18n 測試已覆蓋 ERROR_CODES 全集）
 * 才退回 `errors.fallback`；非 ApiFail（網路失敗等，見 client.ts 說明）一律視為
 * `errors.fallback`，不能直接讀 `.code`（raw Error 沒有這個欄位）。
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
      navigate("/", { replace: true });
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
      </form>
    </main>
  );
}
