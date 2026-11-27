import { useTranslation } from "react-i18next";
import { formatBytes, STORAGE_KINDS, type ContentUsageDto, type StorageByKind } from "@knotebook/shared";
import { useAuthConfig } from "@/api/authConfig";
import { useStorageUsage } from "@/api/storage";
import { ApiFail } from "@/api/client";
import { useUpdateAutoVersions } from "@/api/versionSettings";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";
import { AutoVersionsSwitch } from "./AutoVersionsSwitch";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { StorageUsageGroup } from "./StorageUsageGroup";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * Percentages use the sum of the displayed rows, not `usedBytes`: the two come from separate server queries and can differ briefly during an upload.
 * Row spacing and dividers match the settings tables (spacing and borders only, not the table component).
 * "Other" shows only when nonzero. No rows while `byKind` is undefined (loading or error): `StorageUsageGroup` on the same page shows errors.
 */
export function StorageByKindGroup({ byKind, noteBytes, pending }: { byKind: StorageByKind | undefined; noteBytes: number | undefined; pending: boolean }) {
  const { t } = useTranslation();
  const rows =
    byKind === undefined
      ? []
      : [{ kind: "note", bytes: noteBytes ?? 0 }, ...STORAGE_KINDS.map((kind) => ({ kind, bytes: byKind[kind] }))].filter((row) => row.kind !== "other" || row.bytes > 0);
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  return (
    <SettingsGroup title={t("settings.storage.byKind")} description={t("settings.storage.byKindDescription")}>
      {pending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : byKind === undefined ? null : (
        <ul>
          {rows.map(({ kind, bytes }) => {
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

export function BackupBytesLine({ content, pending }: { content: ContentUsageDto | undefined; pending: boolean }) {
  const { t } = useTranslation();
  if (pending || content === undefined) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{t("settings.storage.currentBackups")}</span>
      <span data-testid="versions-backup-bytes" className="tabular-nums text-muted-foreground">{formatBytes(content.historyBytes)}</span>
    </div>
  );
}

/** The site switch counts as on until config loads. */
function AutoVersionsGroup({ content, pending }: { content: ContentUsageDto | undefined; pending: boolean }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const config = useAuthConfig();
  const update = useUpdateAutoVersions();
  return (
    <SettingsGroup title={t("settings.storage.versionsTitle")} description={t("settings.storage.versionsNote")}>
      <div className="space-y-4">
        <BackupBytesLine content={content} pending={pending} />
        <AutoVersionsSwitch
          id="account-auto-versions"
          title={t("settings.account.autoVersions.title")}
          description={t("settings.account.autoVersions.description")}
          checked={user?.autoVersions ?? true}
          siteOff={config.data?.autoVersionsEnabled === false}
          pending={update.isPending}
          onCheckedChange={(value) => update.mutate(value, { onError: (err) => toast({ title: errorMessage(t, err), variant: "destructive" }) })}
        />
      </div>
    </SettingsGroup>
  );
}

export function SettingsStorageUsageSection() {
  const { t } = useTranslation();
  const storage = useStorageUsage();
  return (
    <SettingsPage title={t("settings.nav.storage")} description={t("settings.storage.description")}>
      <StorageUsageGroup title={t("settings.storage.usageTitle")} query={storage} />
      <StorageByKindGroup byKind={storage.data?.byKind} noteBytes={storage.data?.content?.noteBytes} pending={storage.isPending} />
      <AutoVersionsGroup content={storage.data?.content} pending={storage.isPending} />
    </SettingsPage>
  );
}
