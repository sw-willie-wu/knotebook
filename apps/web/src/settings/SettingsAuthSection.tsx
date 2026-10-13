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
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
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
 * 刪除（W11）。刪除要先停用：啟用中時是 `aria-disabled`（`RowIconButton` 的 softDisabled），`title` 與明細列的可見文字都說明原因，
 * 並以 `aria-describedby`（`disabledHintId`，那段文字在明細列）連過去；server 另以 409 `provider_enabled` 把關。
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
 * 一個服務的測試連線狀態。按鈕在操作欄、結果在明細列，所以由 `SettingsAuthSection` 以服務 id 為鍵保存。
 * `configKey`＝測試當時的 issuer／client ID／secret：結果只對那組設定有效，三者任一變了，區塊根在 render 期間把這筆刪掉。
 */
interface ProviderTest {
  configKey: string;
  pending: boolean;
  state: TestState;
}

function configKeyOf(provider: AdminAuthProviderDto): string {
  return `${provider.issuerUrl}|${provider.clientId}|${provider.hasSecret}`;
}

/** 「已連結」欄（Q2 裁定：每列一支唯讀的 impact 查詢，不改 server）；`DisableProviderDialog` 共用同一把 key，開框時照舊重抓。 */
function LinkedCount({ providerId }: { providerId: string }) {
  const impact = useAuthProviderImpact(providerId, true);
  return <span className="tabular-nums">{impact.data ? impact.data.linkedUsers : "—"}</span>;
}

/** 啟用開關（可及名稱「Enabled ＜顯示名＞」，由表格的 aria-labelledby 給）。關閉一律先過確認 dialog（顯示人數）；開關受控，取消時維持原狀。 */
function ProviderEnabledSwitch({ provider, labelledBy }: { provider: AdminAuthProviderDto; labelledBy: string }) {
  const { t } = useTranslation();
  const patch = usePatchAuthProvider();
  const [disableOpen, setDisableOpen] = useState(false);

  async function handleToggle(next: boolean): Promise<void> {
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

  return (
    <>
      <Switch
        aria-labelledby={labelledBy}
        checked={provider.enabled}
        onCheckedChange={(checked) => void handleToggle(checked)}
        disabled={patch.isPending}
      />
      <DisableProviderDialog provider={provider} open={disableOpen} onOpenChange={setDisableOpen} />
    </>
  );
}

/** 列尾操作鈕（spec §2.7 的順序：測試／次要 → 編輯 → 危險，即測試 → 圖示 → 編輯 → 刪除；spec §3 #4 同序）。測試的進行中與結果交給上層保存、在明細列顯示。 */
function ProviderActions({
  provider,
  deleteHintId,
  onTestStart,
  onTestDone,
}: {
  provider: AdminAuthProviderDto;
  deleteHintId: string;
  onTestStart: (configKey: string) => void;
  onTestDone: (configKey: string, state: TestState) => void;
}) {
  const { t } = useTranslation();
  const testProvider = useTestAuthProvider();

  async function handleTest(): Promise<void> {
    const configKey = configKeyOf(provider);
    onTestStart(configKey);
    try {
      onTestDone(configKey, { ok: true, result: await testProvider.mutateAsync(provider.id) });
    } catch (err) {
      onTestDone(configKey, { ok: false, message: authErrorMessage(t, err) });
    }
  }

  return (
    <>
      <RowIconButton
        label={t("admin.auth.test")}
        icon={<Plug className="h-4 w-4" />}
        onClick={() => void handleTest()}
        disabled={testProvider.isPending}
      />
      <ProviderIconDialog provider={provider} />
      <EditProviderDialog provider={provider} />
      <DeleteProviderDialog provider={provider} disabledHintId={deleteHintId} />
    </>
  );
}

/**
 * 明細列（spec §3 #4：現有內容全數保留）：刪除停用說明（`deleteDisabledHint`，刪除鈕的 aria-describedby 目標）、client ID、
 * 回呼網址與複製鈕、secret 已存／未存、未連線、不安全 issuer（紅色）、測試中狀態與結果。
 */
function ProviderDetail({
  provider,
  deleteHintId,
  test,
}: {
  provider: AdminAuthProviderDto;
  deleteHintId: string;
  test: ProviderTest | undefined;
}) {
  const { t } = useTranslation();
  const state = test?.state ?? null;

  function handleCopy(): void {
    void copyText(provider.callbackUrl).then((ok) =>
      toast(ok ? { title: t("admin.auth.callbackCopied") } : { title: t("admin.auth.callbackCopyFailed"), variant: "destructive" }),
    );
  }

  return (
    <div className="space-y-2 px-3 text-xs">
      {provider.enabled && (
        <p id={deleteHintId} className="text-muted-foreground">
          {t("admin.auth.deleteDisabledHint")}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
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
      {test?.pending === true && (
        <p role="status" className="text-muted-foreground">
          {t("admin.auth.testing")}
        </p>
      )}
      {state?.ok === true && (
        <div role="status" className="space-y-1">
          <p>{t("admin.auth.testOk", { issuer: state.result.issuer })}</p>
          {state.result.warnings.map((warning) => (
            <p key={warning} className="text-destructive">
              {t(`admin.auth.warnings.${warning}`)}
            </p>
          ))}
          <p className="text-muted-foreground">{t("admin.auth.testScope")}</p>
        </div>
      )}
      {state?.ok === false && (
        <p role="alert" className="text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}

/**
 * #187 §9.4：站台管理 → 登入（站台 modal 的 `/admin/login`；舊網址 `/admin/auth` 轉過來，#247 §7.0）。頂部是「允許註冊」與「允許帳密登入」（`SiteAccessSettings`），下面是登入服務管理。
 * 新增與編輯 dialog 在 `AuthProviderDialogs.tsx`。登入服務表（spec 2026-10-13 settings-table §3 #4）：服務（圖示、名稱；副標＝範本名＋legacy 標記）｜Issuer｜已連結｜操作｜啟用，
 * 其餘資訊在明細列。
 */
export function SettingsAuthSection() {
  const { t } = useTranslation();
  const providersQuery = useAdminAuthProviders();
  const baseId = useId();
  const [tests, setTests] = useState<Record<string, ProviderTest>>({});
  const providers = providersQuery.data ?? [];

  // 測試結果只對「當時的 issuer／client ID／secret」有效：任一變了就刪掉那一筆（render 期間重設，不重掛列，編輯 dialog 才不會被卸載）。
  const staleIds = providers
    .filter((provider) => {
      const test = tests[provider.id];
      return test !== undefined && test.configKey !== configKeyOf(provider);
    })
    .map((provider) => provider.id);
  if (staleIds.length > 0) {
    setTests((prev) => {
      const next = { ...prev };
      for (const id of staleIds) delete next[id];
      return next;
    });
  }

  const columns: SettingsTableColumn[] = [
    { id: "service", header: t("admin.auth.tableService"), kind: "primary" },
    { id: "issuer", header: t("admin.auth.tableIssuer"), kind: "url" },
    { id: "linked", header: t("admin.auth.tableLinked"), kind: "fixed" },
    { id: "actions", header: t("admin.auth.tableActions"), kind: "actions", buttons: 4 },
    { id: "enabled", header: t("admin.auth.tableEnabled"), kind: "enabled" },
  ];
  const rows: SettingsTableRow[] = providers.map((provider) => {
    const deleteHintId = `${baseId}-${provider.id}-delete-hint`;
    return {
      id: provider.id,
      primary: {
        name: provider.displayName,
        weight: "semibold",
        icon: <ProviderIcon icon={provider.icon} />,
        subtitles: [
          `${t(`admin.auth.template.${provider.template}`)}${provider.legacyCallback ? ` · ${t("admin.auth.legacyBadge")}` : ""}`,
        ],
      },
      cells: {
        issuer: provider.issuerUrl,
        linked: <LinkedCount providerId={provider.id} />,
      },
      actions: (
        <ProviderActions
          provider={provider}
          deleteHintId={deleteHintId}
          onTestStart={(configKey) => setTests((prev) => ({ ...prev, [provider.id]: { configKey, pending: true, state: null } }))}
          onTestDone={(configKey, state) => setTests((prev) => ({ ...prev, [provider.id]: { configKey, pending: false, state } }))}
        />
      ),
      enabled: (labelledBy) => <ProviderEnabledSwitch provider={provider} labelledBy={labelledBy} />,
      detail: <ProviderDetail provider={provider} deleteHintId={deleteHintId} test={tests[provider.id]} />,
    };
  });

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
        ) : (
          <SettingsTable label={t("admin.auth.providersHeading")} columns={columns} rows={rows} empty={t("admin.auth.empty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
