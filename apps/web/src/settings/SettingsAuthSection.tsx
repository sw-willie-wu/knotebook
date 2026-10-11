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
import { ProviderIcon } from "@/components/ProviderIcon";
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
import { Copy, Plug, Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { authErrorMessage } from "./auth-error-message";
import { CreateProviderDialog, EditProviderDialog } from "./AuthProviderDialogs";
import { ProviderIconDialog } from "./ProviderIconDialog";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { SiteAccessSettings } from "./SiteAccessSettings";

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
        {/* 列上的「已連結」欄與這裡共用同一把 query key：開框時快取裡已有列載入時的舊人數（isPending=false），
            重抓完成前一律顯示載入中，才維持「開框當下的快照」、不先閃過期人數（#247 §7.0）。 */}
        {impact.isPending || impact.isFetching ? (
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
 * 刪除（W11）。刪除要先停用：啟用中時是 `aria-disabled`（`RowIconButton` 的 softDisabled），`title` 與明細區的可見文字都說明原因，
 * 並以 `aria-describedby`（`disabledHintId`）連過去；server 另以 409 `provider_enabled` 把關。
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
        <RowIconButton
          label={t("admin.auth.delete")}
          tone="destructive"
          icon={<Trash className="h-4 w-4" />}
          softDisabled={provider.enabled}
          softDisabledReason={t("admin.auth.deleteDisabledHint")}
          aria-describedby={provider.enabled ? disabledHintId : undefined}
        />
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

/**
 * 登入服務表的欄（#247 §7.0）：服務｜Issuer｜已連結｜列尾動作｜啟用。表頭與每一列共用同一個 grid 模板才對得齊。
 * 格線只在 `md` 以上：固定寬（4rem＋四顆鈕＋3.5rem＋四道間距≈296px）在 390px 視窗（列內可用≈302px）只剩約 6px 給服務與 Issuer。
 * `<md` 時列改成 flex：服務（佔滿）＋已連結＋啟用 switch＋列尾鈕（`order-last`，放不下就換行）；Issuer 欄隱藏，由明細區 `md:hidden` 那一行補上。
 */
const PROVIDER_COLS = "md:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_4rem_auto_3.5rem]";
const PROVIDER_ROW = `flex flex-wrap items-center gap-x-3 gap-y-1 md:grid ${PROVIDER_COLS}`;

function ProviderTableHeader({ enabledHeaderId }: { enabledHeaderId: string }) {
  const { t } = useTranslation();
  return (
    // 每一列是以顯示名為名的 region（測試與 e2e 以它定位），欄名對輔助科技另以每格的 sr-only 前綴補上；這一列只給眼睛看。
    // 保留 aria-hidden：「Enabled」欄頭仍可被各列 switch 的 aria-labelledby 引用（accname 走 labelledby 時會納入 hidden 節點）。
    <div
      aria-hidden="true"
      data-testid="auth-provider-table-header"
      className={`hidden items-center gap-x-3 md:grid ${PROVIDER_COLS} border-b border-border px-3 py-2 text-left text-sm text-muted-foreground`}
    >
      <span>{t("admin.auth.tableService")}</span>
      <span>{t("admin.auth.tableIssuer")}</span>
      <span>{t("admin.auth.tableLinked")}</span>
      <span className="sr-only">{t("admin.auth.tableActions")}</span>
      <span id={enabledHeaderId}>{t("admin.auth.tableEnabled")}</span>
    </div>
  );
}

/**
 * 一個登入服務＝一列（#247 §7.0）：第一行是對齊表頭的格線列，其餘資訊（client ID、回呼網址、secret、未連線／http 警示、測試結果）
 * 留在下方明細區（Q3 裁定：採預設）。`<section aria-labelledby>`＝以顯示名為可及名稱的 region（測試以它定位）。
 */
function ProviderCard({ provider, enabledHeaderId }: { provider: AdminAuthProviderDto; enabledHeaderId: string }) {
  const { t } = useTranslation();
  const headingId = useId();
  const deleteHintId = useId();
  // 已連結人數（Q2 裁定：每列一支唯讀的 impact 查詢，不改 server）；`DisableProviderDialog` 共用同一把 key，開框時照舊重抓。
  const impact = useAuthProviderImpact(provider.id, true);
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
    <section aria-labelledby={headingId} className="border-b border-border px-3 py-3">
      <div data-testid="auth-provider-row" className={PROVIDER_ROW}>
        {/* 窄視窗：`grow basis-32`＝服務名至少留 8rem，放不下時列尾鈕整組換到第二行（而不是把名稱壓到 0）。 */}
        <div className="min-w-0 grow basis-32">
          <div className="flex items-center gap-2">
            <ProviderIcon icon={provider.icon} />
            <h3 id={headingId} className="min-w-0 truncate text-sm font-semibold">
              {provider.displayName}
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(`admin.auth.template.${provider.template}`)}
            {provider.legacyCallback && ` · ${t("admin.auth.legacyBadge")}`}
          </p>
        </div>
        <p className="hidden min-w-0 break-all text-sm md:block">
          <span className="sr-only">{t("admin.auth.tableIssuer")}: </span>
          {provider.issuerUrl}
        </p>
        <p className="text-sm tabular-nums">
          <span className="sr-only">{t("admin.auth.tableLinked")}: </span>
          {impact.data ? impact.data.linkedUsers : "—"}
        </p>
        <div className="order-last flex shrink-0 items-center md:order-none">
          <RowIconButton
            label={t("admin.auth.test")}
            icon={<Plug className="h-4 w-4" />}
            onClick={() => void handleTest()}
            disabled={testProvider.isPending}
          />
          <EditProviderDialog provider={provider} />
          <ProviderIconDialog provider={provider} />
          <DeleteProviderDialog provider={provider} disabledHintId={deleteHintId} />
        </div>
        {/* 可及名稱＝「Enabled」欄頭＋該列顯示名（對齊站台使用者表，Task 7）。 */}
        <Switch
          aria-labelledby={`${enabledHeaderId} ${headingId}`}
          checked={provider.enabled}
          onCheckedChange={checked => void handleToggle(checked)}
          disabled={patch.isPending}
        />
      </div>

      <div className="mt-2 space-y-2 pl-6 text-xs">
        {provider.enabled && (
          <p id={deleteHintId} className="text-muted-foreground">
            {t("admin.auth.deleteDisabledHint")}
          </p>
        )}
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
          {/* 窄視窗補回被隱藏的 Issuer 欄（md 以上已在格線列，不重複）。 */}
          <dt className="text-muted-foreground md:hidden">{t("admin.auth.tableIssuer")}</dt>
          <dd className="break-all md:hidden">{provider.issuerUrl}</dd>
          <dt className="text-muted-foreground">{t("admin.auth.clientIdLabel")}</dt>
          <dd className="break-all">{provider.clientId}</dd>
          <dt className="text-muted-foreground">{t("admin.auth.callbackLabel")}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="min-w-0 break-all">{provider.callbackUrl}</code>
            <RowIconButton label={t("admin.auth.copyCallback")} icon={<Copy className="h-4 w-4" />} onClick={handleCopy} />
          </dd>
        </dl>
        <p className="text-muted-foreground">{provider.hasSecret ? t("admin.auth.secretSaved") : t("admin.auth.secretMissing")}</p>
        {!provider.issuerResolved && (
          <p role="status" className="text-muted-foreground">
            {t("admin.auth.notConnected")}
          </p>
        )}
        {provider.insecureIssuer && <p className="text-destructive">{t("admin.auth.insecureIssuer")}</p>}
        {testProvider.isPending && (
          <p role="status" className="text-muted-foreground">
            {t("admin.auth.testing")}
          </p>
        )}
        {testState?.ok === true && (
          <div role="status" className="space-y-1">
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
          <p role="alert" className="text-destructive">
            {testState.message}
          </p>
        )}
      </div>

      <DisableProviderDialog provider={provider} open={disableOpen} onOpenChange={setDisableOpen} />
    </section>
  );
}

/**
 * #187 §9.4：站台管理 → 登入（站台 modal 的 `/admin/login`；舊網址 `/admin/auth` 轉過來，#247 §7.0）。頂部是「允許註冊」與「允許帳密登入」（`SiteAccessSettings`），下面是登入服務管理。
 * 新增與編輯 dialog 在 `AuthProviderDialogs.tsx`。
 */
export function SettingsAuthSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAuthProviders();
  const enabledHeaderId = useId();

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
          <div>
            <ProviderTableHeader enabledHeaderId={enabledHeaderId} />
            {providersQuery.data.map(provider => (
              <ProviderCard key={provider.id} provider={provider} enabledHeaderId={enabledHeaderId} />
            ))}
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
