import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdminAuthProbeResultDto, AdminAuthProviderDto } from "@knotebook/shared";
import {
  useAdminAuthProviders,
  useAuthProviderImpact,
  useDeleteAuthProvider,
  usePatchAuthProvider,
  useTestAuthProvider,
} from "@/api/adminAuth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { authErrorMessage } from "./auth-error-message";
import { CreateProviderDialog, EditProviderDialog } from "./AuthProviderDialogs";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { SiteAccessSettings } from "./SiteAccessSettings";
import { ProviderIcon } from "@/components/ProviderIcon";

/** 停用前確認（W11：停用前提示受影響人數）。人數是開 dialog 當下的快照（§9.3）。 */
function DisableProviderDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: AdminAuthProviderDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const impact = useAuthProviderImpact(provider.id, open);
  const patch = usePatchAuthProvider();

  async function handleConfirm(): Promise<void> {
    try {
      await patch.mutateAsync({ id: provider.id, body: { enabled: false } });
      onOpenChange(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.disableTitle")}</DialogTitle>
          <DialogDescription>{t("admin.auth.disableDescription")}</DialogDescription>
        </DialogHeader>
        {/* 顯示名是管理員輸入：獨立文字節點，不進 t() 插值（Global Constraints）。 */}
        <p className="text-sm font-medium">{provider.displayName}</p>
        {impact.isPending ? (
          <p className="text-sm text-muted-foreground">{t("admin.auth.impactLoading")}</p>
        ) : impact.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authErrorMessage(t, impact.error)}
          </p>
        ) : (
          <div className="space-y-1 text-sm">
            <p>{t("admin.auth.impactLinked", { number: impact.data.linkedUsers })}</p>
            <p>{t("admin.auth.impactLockedOut", { number: impact.data.lockedOutUsers })}</p>
            {!impact.data.issuerResolved && <p className="text-muted-foreground">{t("admin.auth.impactUnresolved")}</p>}
            {impact.data.actingAdminLockedOut && <p className="text-destructive">{t("admin.auth.impactActingAdminLockedOut")}</p>}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("admin.auth.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="brandDeep" onClick={() => void handleConfirm()} disabled={patch.isPending}>
            {t("admin.auth.disableConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 刪除（W11：刪除要先停用——啟用中時觸發鈕 disabled；server 另以 409 `provider_enabled` 把關）。
 * 停用原因不用 `title`：disabled 的鈕帶 `pointer-events-none`，滑鼠、鍵盤、觸控都碰不到它的 tooltip——改由卡片渲染可見文字，
 * 這裡以 `aria-describedby`（`disabledHintId`）連過去。
 */
function DeleteProviderDialog({ provider, disabledHintId }: { provider: AdminAuthProviderDto; disabledHintId: string }) {
  const { t } = useTranslation();
  const deleteProvider = useDeleteAuthProvider();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await deleteProvider.mutateAsync(provider.id);
      setOpen(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={provider.enabled}
          aria-describedby={provider.enabled ? disabledHintId : undefined}
        >
          {t("admin.auth.delete")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.auth.deleteTitle")}</DialogTitle>
          <DialogDescription>{t("admin.auth.deleteDescription")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{provider.displayName}</p>
        {provider.legacyCallback && <p className="text-sm text-muted-foreground">{t("admin.auth.deleteLegacyNote")}</p>}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("admin.auth.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={deleteProvider.isPending}>
            {t("admin.auth.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TestState = { ok: true; result: AdminAuthProbeResultDto } | { ok: false; message: string } | null;

/** 一個登入服務的卡片（§9.4）。`<section aria-labelledby>`＝以顯示名為可及名稱的 region（測試以它定位）。 */
function ProviderCard({ provider }: { provider: AdminAuthProviderDto }) {
  const { t } = useTranslation();
  const headingId = useId();
  const deleteHintId = useId();
  const patch = usePatchAuthProvider();
  const testProvider = useTestAuthProvider();
  const [disableOpen, setDisableOpen] = useState(false);
  const [testState, setTestState] = useState<TestState>(null);
  // 測試結果只對「當時的 issuer／client ID／secret」有效：這三者任一變了就清掉（render 期間重設，不重掛卡片，編輯 dialog 才不會被卸載）。
  const configKey = `${provider.issuerUrl}|${provider.clientId}|${provider.hasSecret}`;
  const [testedConfigKey, setTestedConfigKey] = useState(configKey);
  if (testedConfigKey !== configKey) {
    setTestedConfigKey(configKey);
    setTestState(null);
  }

  async function handleToggle(next: boolean): Promise<void> {
    // 關閉一律先過確認 dialog（顯示人數）；開關本身是受控的，dialog 取消時維持原狀。
    if (!next) {
      setDisableOpen(true);
      return;
    }
    try {
      await patch.mutateAsync({ id: provider.id, body: { enabled: true } });
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleTest(): Promise<void> {
    setTestState(null);
    try {
      setTestState({ ok: true, result: await testProvider.mutateAsync(provider.id) });
    } catch (err) {
      setTestState({ ok: false, message: authErrorMessage(t, err) });
    }
  }

  function handleCopy(): void {
    void copyText(provider.callbackUrl).then(ok =>
      toast(ok ? { title: t("admin.auth.callbackCopied") } : { title: t("admin.auth.callbackCopyFailed"), variant: "destructive" }),
    );
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ProviderIcon icon={provider.icon} />
            <h3 id={headingId} className="text-sm font-semibold">
              {provider.displayName}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(`admin.auth.template.${provider.template}`)}
            {provider.legacyCallback && ` · ${t("admin.auth.legacyBadge")}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <EditProviderDialog provider={provider} />
          <DeleteProviderDialog provider={provider} disabledHintId={deleteHintId} />
        </div>
      </div>
      {provider.enabled && (
        <p id={deleteHintId} className="text-right text-xs text-muted-foreground">
          {t("admin.auth.deleteDisabledHint")}
        </p>
      )}

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("admin.auth.issuerLabel")}</dt>
        <dd className="break-all">{provider.issuerUrl}</dd>
        <dt className="text-muted-foreground">{t("admin.auth.clientIdLabel")}</dt>
        <dd className="break-all">{provider.clientId}</dd>
        <dt className="text-muted-foreground">{t("admin.auth.callbackLabel")}</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 break-all">{provider.callbackUrl}</code>
          <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
            {t("admin.auth.copyCallback")}
          </Button>
        </dd>
      </dl>

      <p className="text-xs text-muted-foreground">{provider.hasSecret ? t("admin.auth.secretSaved") : t("admin.auth.secretMissing")}</p>
      {!provider.issuerResolved && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("admin.auth.notConnected")}
        </p>
      )}
      {provider.insecureIssuer && <p className="text-xs text-destructive">{t("admin.auth.insecureIssuer")}</p>}

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`auth-provider-enabled-${provider.id}`}
            checked={provider.enabled}
            onCheckedChange={checked => void handleToggle(checked)}
            disabled={patch.isPending}
          />
          <label htmlFor={`auth-provider-enabled-${provider.id}`} className="text-xs font-medium">
            {t("admin.auth.enabled")}
          </label>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => void handleTest()} disabled={testProvider.isPending}>
          {testProvider.isPending ? t("admin.auth.testing") : t("admin.auth.test")}
        </Button>
      </div>

      {testState?.ok === true && (
        <div role="status" className="space-y-1 text-xs">
          <p>{t("admin.auth.testOk", { issuer: testState.result.issuer })}</p>
          {testState.result.warnings.map(warning => (
            <p key={warning} className="text-destructive">
              {t(`admin.auth.warnings.${warning}`)}
            </p>
          ))}
          <p className="text-muted-foreground">{t("admin.auth.testScope")}</p>
        </div>
      )}
      {testState?.ok === false && (
        <p role="alert" className="text-xs text-destructive">
          {testState.message}
        </p>
      )}

      <DisableProviderDialog provider={provider} open={disableOpen} onOpenChange={setDisableOpen} />
    </section>
  );
}

/**
 * #187 §9.4：站台管理 → 登入（`/admin/auth`）。頂部是「允許註冊」與「允許帳密登入」（`SiteAccessSettings`），下面是登入服務管理。
 * 新增與編輯 dialog 在 `AuthProviderDialogs.tsx`。
 */
export function SettingsAuthSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAuthProviders();

  return (
    <SettingsPage title={t("admin.auth.title")} description={t("admin.auth.description")}>
      <SiteAccessSettings />
      <SettingsGroup title={t("admin.auth.providersHeading")} action={<CreateProviderDialog />}>
        {providersQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : providersQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authErrorMessage(t, providersQuery.error)}
          </p>
        ) : providersQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin.auth.empty")}</p>
        ) : (
          <div className="space-y-3">
            {providersQuery.data.map(provider => (
              <ProviderCard key={provider.id} provider={provider} />
            ))}
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
