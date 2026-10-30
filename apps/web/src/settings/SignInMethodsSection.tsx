import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { IdentityDto, ProviderIconDto } from "@knotebook/shared";
import { useIdentities, useStartLink, useUnlinkIdentity } from "@/api/account";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { authErrorMessage } from "./auth-error-message";
import { SettingsGroup } from "./SettingsLayout";
import { ProviderIcon } from "@/components/ProviderIcon";
import "@/i18n/management-strings";

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

/**
 * 解除連結（#247 §4.9：列尾紅垃圾桶 icon 鈕，確認框照舊）。不可解除時 softDisabled＋原因（spec 2026-10-13 settings-table §2.7：
 * 有理由要讓人看見的不可用），並以 `aria-describedby` 指向主欄副標裡看得見的同一段原因（`hintId`）。
 */
function UnlinkButton({ identity, names, hintId }: { identity: IdentityDto; names: string; hintId: string }) {
  const { t } = useTranslation();
  const unlink = useUnlinkIdentity();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await unlink.mutateAsync(identity.id);
      setOpen(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton
          label={t("settings.account.signInMethods.unlink")}
          tone="destructive"
          icon={<Trash className="h-4 w-4" aria-hidden="true" />}
          softDisabled={!identity.unlinkable}
          softDisabledReason={t("settings.account.signInMethods.lastMethodHint")}
          aria-describedby={identity.unlinkable ? undefined : hintId}
        />
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
  );
}

/**
 * #187 §8.5「登入方式」群組。解除鈕的可否由 server 的 `unlinkable` 決定（B24：web 不自己推 INV-7）。
 * 表格（spec 2026-10-13 settings-table §3 #10）：服務（圖示、名稱；副標＝提示行、`unknownProvider` 行）｜連結於｜最後使用｜操作（解除連結）。
 */
export function SignInMethodsSection() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const identities = useIdentities();
  const startLink = useStartLink();
  const baseId = useId();

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

  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language);
  const columns: SettingsTableColumn[] = [
    { id: "service", header: t("settings.account.signInMethods.tableService"), kind: "primary" },
    { id: "linkedOn", header: t("settings.account.signInMethods.tableLinkedOn"), kind: "fixed" },
    { id: "lastUsed", header: t("settings.account.signInMethods.tableLastUsed"), kind: "fixed" },
    { id: "actions", header: t("settings.account.signInMethods.tableActions"), kind: "actions", buttons: 1 },
  ];
  const rows: SettingsTableRow[] = (identities.data?.identities ?? []).map(identity => {
    const hintId = `${baseId}-${identity.id}-hint`;
    // provider 顯示名是管理員輸入：只進文字節點，不當 i18n 插值參數。對不到啟用中 provider：issuer host（§8.5）。
    const names = identity.providers.length > 0 ? identity.providers.map(p => p.displayName).join(" / ") : issuerHost(identity.issuer);
    // §5.4：多個時取第一個（server 已依 sort_order, created_at, id 排序，auth/sign-in-methods.ts）。
    // ⚠ 不得寫成 `identity.providers[0]?.icon ?? HOST_ROW_ICON`——`??` 會把「不顯示」（null）吞成通用圖示。
    const first = identity.providers[0];
    const rowIcon = first === undefined ? HOST_ROW_ICON : first.icon;
    const subtitles = [
      ...(!identity.unlinkable ? [<span id={hintId}>{t("settings.account.signInMethods.lastMethodHint")}</span>] : []),
      ...(identity.providers.length === 0 ? [t("settings.account.signInMethods.unknownProvider")] : []),
    ];
    return {
      id: identity.id,
      primary: { name: names, weight: "medium", icon: <ProviderIcon icon={rowIcon} />, subtitles },
      cells: {
        linkedOn: formatDate(identity.createdAt),
        lastUsed: identity.lastLoginAt === null ? t("settings.account.signInMethods.neverUsed") : formatDate(identity.lastLoginAt),
      },
      actions: <UnlinkButton identity={identity} names={names} hintId={hintId} />,
    };
  });

  return (
    <SettingsGroup title={t("settings.account.signInMethods.title")} description={t("settings.account.signInMethods.description")}>
      {identities.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : identities.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">{authErrorMessage(t, identities.error)}</p>
      ) : (
        <div className="space-y-3">
          <SettingsTable
            label={t("settings.account.signInMethods.title")}
            columns={columns}
            rows={rows}
            empty={t("settings.account.signInMethods.empty")}
          />
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
