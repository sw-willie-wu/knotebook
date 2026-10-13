import { useTranslation } from "react-i18next";
import { STORAGE_KINDS, formatBytes, type GroupDto, type GroupStorageUsageDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useGroupStorageUsage } from "@/api/storage";
import { useUpdateGroupAutoVersions } from "@/api/versionSettings";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { AutoVersionsSwitch } from "@/settings/AutoVersionsSwitch";
import { SettingsGroup, SettingsPage } from "@/settings/SettingsLayout";
import { StorageByKindGroup } from "@/settings/SettingsStorageUsageSection";
import { StorageUsageGroup } from "@/settings/StorageUsageGroup";
import { useGroupOutlet } from "./group-outlet";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 「依成員」（#247 §6.4、§9.2 rev 11）：每個人佔用了這個群組多少空間——server 依 `uploads.charged_to_id`（佔用者）分組：
 * 在群組筆記裡直接上傳＝上傳者；把筆記移入或複製進群組＝執行的人（移入含該篇全部附件；複製只含隨副本複製的附件）。佔用者帳號已刪除者彙總成
 * `userId: null` 一列。只列 `bytes > 0`；沒有任何列時一句說明。佔比分母同「依類型」：`byKind` 五值之和。
 * 列距與列間框線同設定表格（spec 2026-10-13 settings-table §3：只統一列距與框線、不換元件，保留進度條 grid）。
 */
function ByMemberGroup({ usage }: { usage: GroupStorageUsageDto }) {
  const { t } = useTranslation();
  const total = STORAGE_KINDS.reduce((sum, kind) => sum + usage.byKind[kind], 0);
  const rows = usage.byMember.filter((row) => row.bytes > 0);
  return (
    <SettingsGroup title={t("groups.storage.byMember")} description={t("groups.storage.byMemberDescription")}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("groups.storage.byMemberEmpty")}</p>
      ) : (
        <ul>
          {rows.map((row) => {
            const deleted = row.userId === null;
            return (
              <li key={row.userId ?? "deleted"} data-testid="by-member-row" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border py-2.5 text-sm">
                <div className="min-w-0">
                  <p className={cn("truncate", deleted && "text-muted-foreground")}>
                    {deleted ? t("groups.storage.deletedUser") : (row.displayName ?? row.handle ?? "")}
                  </p>
                  {!deleted && row.handle !== null && <p className="truncate text-xs text-muted-foreground">@{row.handle}</p>}
                </div>
                <span className="tabular-nums text-muted-foreground">{formatBytes(row.bytes)}</span>
                <div className="col-span-2 h-1.5 rounded-full bg-brand-soft">
                  <div
                    data-testid="by-member-bar"
                    className="h-1.5 rounded-full bg-brand"
                    style={{ width: `${total === 0 ? 0 : (row.bytes / total) * 100}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroup>
  );
}

/**
 * 群組的「自動儲存版本」開關（#175 §6.8、§8.5；#247 §6.4 搬到儲存空間頁）：**對所有成員渲染**；非 `canManageGroup` 時
 * disabled 並說明誰能改；站台總開關關閉時 disabled 並說明站台已關（`AutoVersionsSwitch` 以 siteOff 優先）。
 * 說明加一句「版本不佔額度」（§5.4，`settings.storage.versionsNote`）。
 */
function GroupAutoVersionsGroup({ group }: { group: GroupDto }) {
  const { t } = useTranslation();
  const config = useAuthConfig();
  const update = useUpdateGroupAutoVersions();
  return (
    <SettingsGroup title={t("settings.storage.versionsTitle")}>
      <AutoVersionsSwitch
        id={`group-auto-versions-${group.id}`}
        title={t("groups.autoVersions.title")}
        description={`${t("groups.autoVersions.description")} ${t("settings.storage.versionsNote")}`}
        checked={group.autoVersions}
        siteOff={config.data?.autoVersionsEnabled === false}
        disabledReason={group.canManageGroup ? undefined : t("groups.autoVersions.managersOnly")}
        pending={update.isPending}
        onCheckedChange={(value) =>
          update.mutate({ groupId: group.id, autoVersions: value }, { onError: (err) => toast({ title: errorMessage(t, err), variant: "destructive" }) })
        }
      />
    </SettingsGroup>
  );
}

/**
 * 群組 modal「儲存空間」（`/groups/:id/storage`，#247 §6.4、W12）：用量／配額／方案、依類型（五列恆顯示）、依成員、版本歷史開關。
 * **所有成員**都看得到（§9.2 把 `GET /api/groups/:id/storage` 放寬為成員可讀；唯讀）。
 * ⚠ SCOPE：上傳目前只收四種圖片，實際只有「影像」會非零（§5.4）。
 */
export function GroupStorageSection() {
  const { t } = useTranslation();
  const group = useGroupOutlet();
  const query = useGroupStorageUsage(group.id);
  return (
    <SettingsPage title={t("groups.nav.storage")}>
      <StorageUsageGroup title={t("settings.storage.usageTitle")} query={query} />
      <StorageByKindGroup byKind={query.data?.byKind} pending={query.isPending} />
      {query.data && <ByMemberGroup usage={query.data} />}
      <GroupAutoVersionsGroup group={group} />
    </SettingsPage>
  );
}
