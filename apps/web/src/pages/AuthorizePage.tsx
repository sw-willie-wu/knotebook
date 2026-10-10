import { useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { narrowerScope, type OauthRequestDto } from "@knotebook/shared";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiFail } from "@/api/client";
import { useOauthDecision, useOauthRequest } from "@/api/oauth";
import { checksFromScope, scopeFromChecks, type ScopeChecks } from "@/lib/token-scope";
import { ScopeChecksField } from "@/settings/ScopeChecksField";

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
  const request = useOauthRequest(req);

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
        ) : request.data === undefined || req === null ? (
          <p className="text-muted-foreground">{t("authorize.loading")}</p>
        ) : (
          <ConsentBody req={req} data={request.data} />
        )}
      </div>
    </main>
  );
}

/**
 * 載入完成後的同意內容。抽成元件是為了讓勾選 state 的初值在**資料到手時**才算（W8：
 * 依 `existingScope` 預設勾選）——掛在外層的話 `useState` 初值會在資料還沒來時就定死。
 */
function ConsentBody({ req, data }: { req: string; data: OauthRequestDto }) {
  const { t } = useTranslation();
  const { user, logout } = useSession();
  const decision = useOauthDecision();
  const scopesTitleId = useId();
  // #239 W4'／W8：第一次授權全不勾；重新授權沿用既有權限，但不超過本次要求。
  const [checks, setChecks] = useState<ScopeChecks>(() =>
    data.existingScope === null
      ? { write: false, move: false }
      : checksFromScope(narrowerScope(data.existingScope, data.scope))
  );
  // 依 `scopes` 逐項判斷，未知值不渲染（spec §9.2）。
  const offersWrite = data.scopes.includes("notes:write");
  const offersMove = data.scopes.includes("notes:move");
  // 既有權限比本次要求寬：按 Allow 會靜默降權，要說出來（spec §9.2【作者補】）。
  const wider = data.existingScope !== null && narrowerScope(data.existingScope, data.scope) !== data.existingScope;

  function submit(choice: "allow" | "deny"): void {
    // deny 只送 `{req, decision}`（spec §9.2）；allow 依勾選帶 scope，沒出現的框一律當未勾。
    const body =
      choice === "allow"
        ? {
            req,
            decision: "allow" as const,
            scope: scopeFromChecks(checks.write && offersWrite, checks.move && offersMove),
          }
        : { req, decision: "deny" as const };
    decision.mutate(body, {
      onSuccess: res => window.location.assign(res.redirectTo),
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
    });
  }

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">
          {/* 名稱是 client 自述、未經驗證——**必須是獨立的 span** 才隔離得住，
              否則 U+202E 之類的字元會把下面那行「未經驗證」旁註在視覺上推走。 */}
          <span dir="ltr" data-testid="authorize-client-name" className="break-words [unicode-bidi:isolate]">
            {data.clientName}
          </span>
          {t("authorize.titleSuffix")}
        </h1>
        <p className="text-xs text-muted-foreground">{t("authorize.unverifiedName")}</p>
        {data.replacesExisting && <p className="text-xs text-muted-foreground">{t("authorize.replacesExisting")}</p>}
      </div>

      <div className="space-y-1 rounded-md border border-border p-3">
        <p className="text-sm font-medium">{t("authorize.redirectTo", { host: data.redirectHost })}</p>
        {/* v1 的 redirectHost 恆為 loopback（D10），所以無條件顯示。放寬 D10
            時這行要改成依 host 判斷，否則會對遠端 host 亂噴。 */}
        <p className="text-xs text-muted-foreground">{t("authorize.loopbackWarning")}</p>
      </div>

      {/* 勾選組以標題命名（比照建立 token 對話框的 fieldset）；preflight 已清掉 fieldset 的預設框線與內距。 */}
      <fieldset aria-labelledby={scopesTitleId} className="space-y-2">
        <p id={scopesTitleId} className="text-sm font-medium">
          {offersWrite || offersMove ? t("authorize.scopesTitleChoose") : t("authorize.scopesTitle")}
        </p>
        <p className="text-sm">{t("authorize.scopeRead")}</p>
        <ScopeChecksField
          value={checks}
          onChange={setChecks}
          showWrite={offersWrite}
          showMove={offersMove}
          granted={data.existingScope ? checksFromScope(data.existingScope) : undefined}
        />
        {wider && (
          <p className="text-xs text-muted-foreground">
            {offersWrite ? t("authorize.replacesWithLess") : t("authorize.replacesWithLessReadOnly")}
          </p>
        )}
      </fieldset>

      <p className="text-xs text-muted-foreground">
        {t("authorize.signedInAs", { handle: user?.handle ?? "" })}{" "}
        <button type="button" className="underline" onClick={() => void logout()}>
          {t("authorize.notYou")}
        </button>
      </p>

      <div className="flex gap-2">
        {/* isSuccess 也鎖住：assign 之後導頁還在飛，第二下必吃 410 */}
        <Button
          type="button"
          variant="brandSolid"
          disabled={decision.isPending || decision.isSuccess}
          onClick={() => submit("allow")}
        >
          {t("authorize.allow")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={decision.isPending || decision.isSuccess}
          onClick={() => submit("deny")}
        >
          {t("authorize.deny")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("authorize.denyHint")}</p>
    </>
  );
}
