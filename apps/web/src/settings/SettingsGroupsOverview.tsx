import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
import { GROUP_ROLE_FLAGS } from "@knotebook/shared";
import { useGroups } from "@/api/groups";
import { Pill } from "@/components/management/Pill";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { roleLabel } from "@/lib/group-role";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

/**
 * Read-only overview: no action buttons, no menu, and group names aren't links (panels don't link to each other; creating and managing
 * happen in the sidebar). Data is `useGroups()`, the sidebar's cache.
 * `myRole` is null only for a non-member site admin (only in `PATCH /api/groups/:id` responses, never reached via `useGroups()`); the type is
 * still handled (role column shows a dash, only the read pill), and `roleLabel` doesn't accept null, so check first.
 * Don't use `myRole.name`: built-in roles have a null `name`.
 */
export function SettingsGroupsOverview() {
  const { t } = useTranslation();
  const groups = useGroups();

  let body;
  if (groups.isPending) {
    body = (
      <SettingsGroup>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  } else if (groups.isError) {
    body = (
      <SettingsGroup>
        <p role="alert" className="text-sm text-destructive">
          {t("errors.fallback")}
        </p>
      </SettingsGroup>
    );
  } else if (groups.data.length === 0) {
    body = (
      <SettingsGroup>
        <p className="text-sm text-muted-foreground">{t("settings.groups.empty")}</p>
      </SettingsGroup>
    );
  } else {
    const columns: SettingsTableColumn[] = [
      { id: "group", header: t("settings.groups.tableGroup"), kind: "primary" },
      { id: "role", header: t("settings.groups.tableRole"), kind: "fixed" },
      { id: "permissions", header: t("settings.groups.tablePermissions"), kind: "text" },
    ];
    const rows: SettingsTableRow[] = groups.data.map((group) => ({
      id: group.id,
      primary: { name: group.name },
      cells: {
        role: group.myRole === null ? "—" : roleLabel(t, group.myRole),
        permissions: (
          <div className="flex flex-wrap gap-1">
            <Pill>{t("groups.roles.readPill")}</Pill>
            {GROUP_ROLE_FLAGS.filter((flag) => group.myRole?.permissions[flag] === true).map((flag) => (
              <Pill key={flag}>{t(`groups.roles.flags.${flag}.label`)}</Pill>
            ))}
          </div>
        ),
      },
    }));
    body = (
      <SettingsGroup title={t("settings.groups.count", { count: groups.data.length })}>
        <SettingsTable label={t("settings.nav.groups")} columns={columns} rows={rows} />
      </SettingsGroup>
    );
  }

  return (
    <SettingsPage title={t("settings.nav.groups")} description={t("settings.groups.overview")}>
      {body}
    </SettingsPage>
  );
}
