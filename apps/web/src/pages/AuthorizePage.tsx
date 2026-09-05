import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiFail } from "@/api/client";
import { useOauthDecision, useOauthRequest } from "@/api/oauth";

/**
 * OAuth 同意頁（`/authorize?req=<id>`，spec §5.3.3）。獨立版面，比照 change-password。
 *
 * 頁面只認 `req` 這個 id，不認散裝的授權參數——參數在 server 端就已經驗過並封進
 * pending request。allow 與 deny 都會消費它（I6），所以按錯只能從 client 重新發起。
 */
export default function AuthorizePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const req = searchParams.get("req") || null; // `?req=` 空字串視同缺席
  const { user, logout } = useSession();
  const request = useOauthRequest(req);
  const decision = useOauthDecision();

  function submit(choice: "allow" | "deny"): void {
    if (req === null) return;
    decision.mutate(
      { req, decision: choice },
      {
        onSuccess: body => window.location.assign(body.redirectTo),
        onError: err => {
          // 409：pending request 已被消費（I6 在 I1 之前），撤銷完回不到這頁——文案要說清楚。
          // 410（連點兩下／過期）與載入端的 410 同一句。
          const code = err instanceof ApiFail ? err.code : undefined;
          const key =
            code === "token_limit"
              ? "authorize.errorTokenLimit"
              : code === "oauth_request_invalid"
                ? "authorize.errorInvalidRequest"
                : "authorize.errorGeneric";
          toast({ title: t(key), variant: "destructive" });
        },
      }
    );
  }

  const errorMessage = ((): string | null => {
    if (req === null) return t("authorize.errorMissingReq");
    if (!request.isError) return null;
    // 410 是最常見的一條（登入或 SSO 那段就可能吃掉 10 分鐘）。
    const invalid = request.error instanceof ApiFail && request.error.code === "oauth_request_invalid";
    return invalid ? t("authorize.errorInvalidRequest") : t("authorize.errorGeneric");
  })();

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4">
        {errorMessage !== null ? (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">{t("authorize.errorTitle")}</h1>
            <p className="text-sm text-muted-foreground" role="alert">
              {errorMessage}
            </p>
          </div>
        ) : request.data === undefined ? (
          <p className="text-muted-foreground">{t("authorize.loading")}</p>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold">
                {/* 名稱是 client 自述、未經驗證——**必須是獨立的 span** 才隔離得住，
                    否則 U+202E 之類的字元會把下面那行「未經驗證」旁註在視覺上推走。 */}
                <span dir="ltr" data-testid="authorize-client-name" className="break-words [unicode-bidi:isolate]">
                  {request.data.clientName}
                </span>
                {t("authorize.titleSuffix")}
              </h1>
              <p className="text-xs text-muted-foreground">{t("authorize.unverifiedName")}</p>
              {request.data.replacesExisting && (
                <p className="text-xs text-muted-foreground">{t("authorize.replacesExisting")}</p>
              )}
            </div>

            <div className="space-y-1 rounded-md border border-border p-3">
              <p className="text-sm font-medium">{t("authorize.redirectTo", { host: request.data.redirectHost })}</p>
              {/* v1 的 redirectHost 恆為 loopback（D10），所以無條件顯示。放寬 D10
                  時這行要改成依 host 判斷，否則會對遠端 host 亂噴。 */}
              <p className="text-xs text-muted-foreground">{t("authorize.loopbackWarning")}</p>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">{t("authorize.scopesTitle")}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {request.data.scopes.map(scope => (
                  <li key={scope}>{scope === "notes:write" ? t("authorize.scopeWrite") : t("authorize.scopeRead")}</li>
                ))}
              </ul>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("authorize.signedInAs", { handle: user?.handle ?? "" })}{" "}
              <button type="button" className="underline" onClick={() => void logout()}>
                {t("authorize.notYou")}
              </button>
            </p>

            <div className="flex gap-2">
              {/* isSuccess 也鎖住：assign 之後導頁還在飛，第二下必吃 410 */}
              <Button type="button" disabled={decision.isPending || decision.isSuccess} onClick={() => submit("allow")}>
                {t("authorize.allow")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={decision.isPending || decision.isSuccess}
                onClick={() => submit("deny")}
              >
                {t("authorize.deny")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("authorize.denyHint")}</p>
          </>
        )}
      </div>
    </main>
  );
}
