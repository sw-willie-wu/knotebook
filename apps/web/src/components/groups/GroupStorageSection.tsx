import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
import { STORAGE_KINDS, formatBytes, type ContentUsageDto, type GroupDto, type GroupStorageUsageDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { useGroupStorageUsage } from "@/api/storage";
import { useUpdateGroupAutoVersions } from "@/api/versionSettings";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { AutoVersionsSwitch } from "@/settings/AutoVersionsSwitch";
import { SettingsGroup, SettingsPage } from "@/settings/SettingsLayout";
import { BackupBytesLine, StorageByKindGroup } from "@/settings/SettingsStorageUsageSection";
import { StorageUsageGroup } from "@/settings/StorageUsageGroup";
import { useGroupOutlet } from "./group-outlet";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * The server groups by `uploads.charged_to_id` (who is charged): an upload into a group note charges the uploader;
 * moving or copying a note in charges whoever did it (a move includes all its attachments, a copy only those copied).
 * Deleted accounts collapse into one `userId: null` row. The percentage
 * denominator is the sum of the five file kinds in `byKind`, without notes: member bytes are charged uploads, which note content never is.
 * Row spacing and borders match the settings table without switching to it, to keep the progress-bar grid.
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

/** `AutoVersionsSwitch` gives `siteOff` priority over `disabledReason`. */
function GroupAutoVersionsGroup({ group, content, pending }: { group: GroupDto; content: ContentUsageDto | undefined; pending: boolean }) {
  const { t } = useTranslation();
  const config = useAuthConfig();
  const update = useUpdateGroupAutoVersions();
  return (
    <SettingsGroup title={t("settings.storage.versionsTitle")}>
      <div className="space-y-4">
        <BackupBytesLine content={content} pending={pending} />
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
      </div>
    </SettingsGroup>
  );
}

/** Read-only; shown to every member, since `GET …/storage` is readable by any member or site admin. */
export function GroupStorageSection() {
  const { t } = useTranslation();
  const group = useGroupOutlet();
  const query = useGroupStorageUsage(group.id);
  return (
    <SettingsPage title={t("groups.nav.storage")}>
      <StorageUsageGroup title={t("settings.storage.usageTitle")} query={query} />
      <StorageByKindGroup byKind={query.data?.byKind} noteBytes={query.data?.content?.noteBytes} pending={query.isPending} />
      {query.data && <ByMemberGroup usage={query.data} />}
      <GroupAutoVersionsGroup group={group} content={query.data?.content} pending={query.isPending} />
    </SettingsPage>
  );
}
