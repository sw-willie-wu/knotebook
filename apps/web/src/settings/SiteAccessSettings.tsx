import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAdminAuthSettings, usePatchAdminAuthSettings, type PatchAdminAuthSettingsBody } from "@/api/adminAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { authErrorMessage } from "./auth-error-message";
import { SettingsGroup } from "./SettingsLayout";

/**
 * #187 §9.4／§9.5：`/admin/auth` 頂部的兩個立即生效開關。Switch 一律受控於 server 值——409（B19 的兩碼）時 server 值沒變，
 * Switch 自然維持原狀，只 toast。關閉帳密先過確認 dialog（顯示 usersWithoutSso）；開啟永遠直接送（server 永遠允許）。
 * 「關不了」的兩種原因（零個啟用服務、自己沒有可用 SSO）預先 disable 並以可見文字＋aria-describedby 說明；權威判斷在 PATCH。
 */
export function SiteAccessSettings() {
  const { t } = useTranslation();
  const settings = useAdminAuthSettings();
  const patch = usePatchAdminAuthSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reasonId = useId();

  async function save(body: PatchAdminAuthSettingsBody): Promise<boolean> {
    try {
      await patch.mutateAsync(body);
      return true;
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
      return false;
    }
  }

  // 確認 dialog 的人數要是「開 dialog 當下」的（shared DTO JSDoc）：打開時重抓，抓回前先顯示現有快照。
  function openConfirm(): void {
    void settings.refetch();
    setConfirmOpen(true);
  }

  if (settings.isPending) {
    return (
      <SettingsGroup title={t("admin.auth.access.title")}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  if (settings.isError) {
    return (
      <SettingsGroup title={t("admin.auth.access.title")}>
        <p role="alert" className="text-sm text-destructive">{authErrorMessage(t, settings.error)}</p>
      </SettingsGroup>
    );
  }
  const s = settings.data;
  const turnOffBlockedReason = !s.passwordLoginEnabled
    ? null
    : s.passwordLoginImpact.enabledProviders === 0
      ? t("admin.auth.access.needProvider")
      : !s.passwordLoginImpact.actingAdminHasSso
        ? t("admin.auth.access.needAdminLink")
        : null;

  return (
    <SettingsGroup title={t("admin.auth.access.title")}>
      <div className="space-y-4">
        {s.passwordLoginForced && (
          <p role="alert" className="text-sm text-destructive">{t("admin.auth.access.forced")}</p>
        )}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Switch
              id="site-registration"
              checked={s.registrationEnabled}
              onCheckedChange={checked => void save({ registrationEnabled: checked })}
              disabled={patch.isPending}
            />
            <label htmlFor="site-registration" className="text-sm font-medium">{t("admin.auth.access.registration")}</label>
          </div>
          <p className="max-w-prose text-xs text-muted-foreground">{t("admin.auth.access.registrationHelp")}</p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Switch
              id="site-password-login"
              checked={s.passwordLoginEnabled}
              onCheckedChange={checked => (checked ? void save({ passwordLoginEnabled: true }) : openConfirm())}
              disabled={patch.isPending || turnOffBlockedReason !== null}
              aria-describedby={turnOffBlockedReason !== null ? reasonId : undefined}
            />
            <label htmlFor="site-password-login" className="text-sm font-medium">{t("admin.auth.access.passwordLogin")}</label>
          </div>
          <p className="max-w-prose text-xs text-muted-foreground">{t("admin.auth.access.passwordLoginHelp")}</p>
          {turnOffBlockedReason !== null && (
            <p id={reasonId} className="text-xs text-muted-foreground">{turnOffBlockedReason}</p>
          )}
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.auth.access.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("admin.auth.access.passwordLoginHelp")}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">{t("admin.auth.access.usersWithoutSso", { number: s.passwordLoginImpact.usersWithoutSso })}</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("admin.auth.cancel")}</Button>
            </DialogClose>
            <Button
              type="button"
              variant="brandDeep"
              disabled={patch.isPending}
              onClick={() => void save({ passwordLoginEnabled: false }).then(() => setConfirmOpen(false))}
            >
              {t("admin.auth.access.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
