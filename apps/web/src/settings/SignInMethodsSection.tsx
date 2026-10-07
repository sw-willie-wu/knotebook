import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { IdentityDto, ProviderIconDto } from "@knotebook/shared";
import { useIdentities, useStartLink, useUnlinkIdentity } from "@/api/account";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { authErrorMessage } from "./auth-error-message";
import { SettingsGroup } from "./SettingsLayout";
import { ProviderIcon } from "@/components/ProviderIcon";

/**
 * `?link_error=` 白名單（#187 §9.4）＋cookie 解開後 `failLocation` 會發的兩碼（`oidc_state_mismatch`、`oidc_claim_too_long`——
 * 同 PR1 對 `/link-account` 的 final review M2；plan spec 疑點 13）。白名單外一律 fallback（任意 query 不得直接餵 i18next）。
 */
const LINK_ERROR_CODES = new Set<string>([
  "identity_taken", "identity_already_linked", "oidc_link_session_mismatch", "account_disabled",
  "oidc_exchange_failed", "oidc_unavailable", "oidc_state_mismatch", "oidc_claim_too_long",
]);

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/** §5.4：以 host 標示的列（服務已刪或停用中）一律通用圖示。 */
const HOST_ROW_ICON: ProviderIconDto = { type: "builtin", name: "generic" };

function IdentityRow({ identity }: { identity: IdentityDto }) {
  const { t } = useTranslation();
  const nameId = useId();
  const hintId = useId();
  const unlink = useUnlinkIdentity();
  const [open, setOpen] = useState(false);
  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language);
  // provider 顯示名是管理員輸入：只進文字節點，不當 i18n 插值參數。對不到啟用中 provider：issuer host（§8.5）。
  const names = identity.providers.length > 0 ? identity.providers.map(p => p.displayName).join(" / ") : issuerHost(identity.issuer);

  // §5.4：多個時取第一個（server 已依 sort_order, created_at, id 排序，auth/sign-in-methods.ts）。
  // ⚠ 不得寫成 `identity.providers[0]?.icon ?? HOST_ROW_ICON`——`??` 會把「不顯示」（null）吞成通用圖示。
  const first = identity.providers[0];
  const rowIcon = first === undefined ? HOST_ROW_ICON : first.icon;

  async function handleConfirm(): Promise<void> {
    try {
      await unlink.mutateAsync(identity.id);
      setOpen(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li aria-labelledby={nameId} className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 space-y-0.5 text-sm">
        <div className="flex items-center gap-2">
          <ProviderIcon icon={rowIcon} />
          <p id={nameId} className="font-medium">{names}</p>
        </div>
        {identity.providers.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("settings.account.signInMethods.unknownProvider")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("settings.account.signInMethods.linkedOn", { when: formatDate(identity.createdAt) })}</p>
        <p className="text-xs text-muted-foreground">
          {identity.lastLoginAt === null
            ? t("settings.account.signInMethods.neverUsed")
            : t("settings.account.signInMethods.lastUsed", { when: formatDate(identity.lastLoginAt) })}
        </p>
        {!identity.unlinkable && (
          <p id={hintId} className="text-xs text-muted-foreground">
            {t("settings.account.signInMethods.lastMethodHint")}
          </p>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={!identity.unlinkable} aria-describedby={identity.unlinkable ? undefined : hintId}>
            {t("settings.account.signInMethods.unlink")}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.account.signInMethods.unlinkTitle")}</DialogTitle>
            <DialogDescription>{t("settings.account.signInMethods.unlinkDescription")}</DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium">{names}</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("settings.account.signInMethods.cancel")}</Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={unlink.isPending}>
              {t("settings.account.signInMethods.unlink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** #187 §8.5「登入方式」群組。解除鈕的可否由 server 的 `unlinkable` 決定（B24：web 不自己推 INV-7）。 */
export function SignInMethodsSection() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const identities = useIdentities();
  const startLink = useStartLink();

  useEffect(() => {
    const linked = searchParams.get("linked");
    const linkError = searchParams.get("link_error");
    if (linked === null && linkError === null) return;
    if (linked !== null) toast({ title: t("settings.account.signInMethods.linked") });
    if (linkError !== null) {
      const code = LINK_ERROR_CODES.has(linkError) ? linkError : "fallback";
      toast({ title: t(`errors.${code}`, { defaultValue: t("errors.fallback") }), variant: "destructive" });
    }
    // 只刪這兩個一次性鍵（§8.5），其餘參數原封不動。
    const params = new URLSearchParams(searchParams);
    params.delete("linked");
    params.delete("link_error");
    setSearchParams(params, { replace: true });
    // 只在掛載時處理一次（同 LoginPage 的 ?error= 慣例）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLink(providerId: string): Promise<void> {
    try {
      const { url } = await startLink.mutateAsync(providerId);
      window.location.assign(url);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <SettingsGroup title={t("settings.account.signInMethods.title")} description={t("settings.account.signInMethods.description")}>
      {identities.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : identities.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">{authErrorMessage(t, identities.error)}</p>
      ) : (
        <div className="space-y-3">
          {identities.data.identities.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.account.signInMethods.empty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {identities.data.identities.map(identity => <IdentityRow key={identity.id} identity={identity} />)}
            </ul>
          )}
          {identities.data.linkable.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {identities.data.linkable.map(p => (
                <Button key={p.providerId} type="button" variant="outline" size="sm" onClick={() => void handleLink(p.providerId)} disabled={startLink.isPending}>
                  <ProviderIcon icon={p.icon} />{t("settings.account.signInMethods.link")} {p.displayName}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
