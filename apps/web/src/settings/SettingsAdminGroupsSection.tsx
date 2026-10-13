import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { useAdminGroups, useAdminStoragePlans, useAssignGroupPlan } from "@/api/adminStorage";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { PlanSelect, StorageCell } from "./StorageAdminCells";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 站台管理的群組列表（`/admin/groups`，spec §9.3、A9）：站上所有群組（`GET /api/admin/groups`，不論是不是成員）＋成員數、
 * 建立時間、儲存用量、方案下拉（即存）。**群組名一律純文字**（Willie 2026-10-08）：站台管理員在這裡管方案，不看群組成員與
 * 詳情——spec §9.3 M2 的「名稱連到 `/settings/groups/:id`」作廢。只經 `components/admin/AdminSections` 匯出（#247：站台管理 modal 的區塊 chunk）。
 * 表格（spec 2026-10-13 settings-table §3 #6）：名稱｜成員｜建立｜儲存（保留紅色）｜方案。群組名可重複：方案下拉以
 * `aria-describedby` 指到該列建立時間（id 依群組 id），同名的列才分得出來。
 */
export function SettingsAdminGroupsSection() {
  const { t, i18n } = useTranslation();
  const groupsQuery = useAdminGroups();
  const plansQuery = useAdminStoragePlans();
  const assignPlan = useAssignGroupPlan();

  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("admin.groups.tableName"), kind: "primary" },
    { id: "members", header: t("admin.groups.tableMembers"), kind: "fixed" },
    { id: "created", header: t("admin.groups.tableCreated"), kind: "fixed" },
    { id: "storage", header: t("admin.tableStorage"), kind: "fixed" },
    { id: "plan", header: t("admin.tablePlan"), kind: "control" },
  ];
  const rows: SettingsTableRow[] = (groupsQuery.data ?? []).map((row) => ({
    id: row.id,
    primary: { name: row.name },
    cells: {
      members: row.memberCount,
      created: <span id={`group-created-${row.id}`}>{new Date(row.createdAt).toLocaleDateString(i18n.language)}</span>,
      storage: <StorageCell storage={row.storage} />,
      plan: (
        <PlanSelect
          label={t("admin.groups.planFor", { name: row.name })}
          describedBy={`group-created-${row.id}`}
          planId={row.storage.planId}
          planName={row.storage.planName}
          plans={plansQuery.data?.plans}
          onAssign={(planId) => assignPlan.mutateAsync({ groupId: row.id, planId })}
        />
      ),
    },
  }));

  return (
    <SettingsPage title={t("admin.groups.title")} description={t("admin.groups.description")}>
      <SettingsGroup>
        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : groupsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">{errorMessage(t, groupsQuery.error)}</p>
        ) : (
          <SettingsTable label={t("admin.groups.title")} columns={columns} rows={rows} empty={t("admin.groups.empty")} />
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
