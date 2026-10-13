import { useTranslation } from "react-i18next";
import { formatBytes, STORAGE_KINDS, type StorageByKind } from "@knotebook/shared";
import { useAuthConfig } from "@/api/authConfig";
import { useStorageUsage } from "@/api/storage";
import { ApiFail } from "@/api/client";
import { useUpdateAutoVersions } from "@/api/versionSettings";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";
import { AutoVersionsSwitch } from "./AutoVersionsSwitch";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { StorageUsageGroup } from "./StorageUsageGroup";

/** 逐檔複製的既有慣例（無共用 helper）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 「依類型」區塊（#247 §5.4；Part 3 的群組儲存空間頁沿用）。**五列恆顯示**（W30，含 0 的列），
 * 順序＝`STORAGE_KINDS`。佔比的分母取五類之和、**不取 `usedBytes`**：兩者來自 server 上不同時點的
 * 兩句查詢，中間有上傳時可能瞬間不等（§9.1）；和為 0 時五條都是 0%。
 * ⚠ 現況上傳只收四種圖片，所以只有「影像」會非零——版面先為多類型留好（上傳放寬另開 issue）。
 * `byKind` 為 undefined（載入中或錯誤）時不渲染列：錯誤訊息由同頁的 `StorageUsageGroup` 負責。
 * 列距與列間框線同設定表格（spec 2026-10-13 settings-table §3：只統一列距與框線、不換元件）。
 */
export function StorageByKindGroup({ byKind, pending }: { byKind: StorageByKind | undefined; pending: boolean }) {
  const { t } = useTranslation();
  const total = byKind === undefined ? 0 : STORAGE_KINDS.reduce((sum, kind) => sum + byKind[kind], 0);
  return (
    <SettingsGroup title={t("settings.storage.byKind")} description={t("settings.storage.byKindDescription")}>
      {pending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : byKind === undefined ? null : (
        <ul>
          {STORAGE_KINDS.map((kind) => {
            const bytes = byKind[kind];
            const pct = total === 0 ? 0 : (bytes / total) * 100;
            return (
              <li key={kind} data-testid={`by-kind-${kind}`} className="grid grid-cols-[6rem_1fr_6rem] items-center gap-3 border-b border-border py-2.5 text-sm">
                <span>{t(`settings.storage.kinds.${kind}`)}</span>
                <div className="h-1.5 rounded-full bg-brand-soft">
                  <div data-testid={`by-kind-bar-${kind}`} className="h-1.5 rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-right tabular-nums text-muted-foreground">{formatBytes(bytes)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroup>
  );
}

/**
 * 個人空間的「自動儲存版本」開關（spec 2026-10 版本歷史 §6.8、§8.5；#247 從帳號頁搬來）：立即生效，只送
 * `{ autoVersions }`；站台總開關關閉時 disabled 並給看得見的說明。`config` 未載入時當作開。
 */
function AutoVersionsGroup() {
  const { t } = useTranslation();
  const { user } = useSession();
  const config = useAuthConfig();
  const update = useUpdateAutoVersions();
  return (
    <SettingsGroup title={t("settings.storage.versionsTitle")} description={t("settings.storage.versionsNote")}>
      <AutoVersionsSwitch
        id="account-auto-versions"
        title={t("settings.account.autoVersions.title")}
        description={t("settings.account.autoVersions.description")}
        checked={user?.autoVersions ?? true}
        siteOff={config.data?.autoVersionsEnabled === false}
        pending={update.isPending}
        onCheckedChange={(value) => update.mutate(value, { onError: (err) => toast({ title: errorMessage(t, err), variant: "destructive" }) })}
      />
    </SettingsGroup>
  );
}

/** 個人設定「儲存空間」（`/settings/storage`，#247 §5.4、W9）：用量／依類型／版本歷史。 */
export function SettingsStorageUsageSection() {
  const { t } = useTranslation();
  const storage = useStorageUsage();
  return (
    <SettingsPage title={t("settings.nav.storage")} description={t("settings.storage.description")}>
      <StorageUsageGroup title={t("settings.storage.usageTitle")} query={storage} />
      <StorageByKindGroup byKind={storage.data?.byKind} pending={storage.isPending} />
      <AutoVersionsGroup />
    </SettingsPage>
  );
}
