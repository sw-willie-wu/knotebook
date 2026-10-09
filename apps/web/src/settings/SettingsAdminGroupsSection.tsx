import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { useAdminGroups, useAdminStoragePlans, useAssignGroupPlan } from "@/api/adminStorage";
import { PlanSelect, StorageCell } from "./StorageAdminCells";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 欄寬規則同使用者表（`SettingsUsersSection.tsx`）。 */
const LAYOUT = { text: "min-w-[14ch] wrap-anywhere", fixed: "whitespace-nowrap" } as const;

/**
 * 站台管理的群組列表（`/admin/groups`，spec §9.3、A9）：站上所有群組（`GET /api/admin/groups`，不論是不是成員）＋成員數、
 * 建立時間、儲存用量、方案下拉（即存）。**群組名一律純文字**（Willie 2026-10-08）：站台管理員在這裡管方案，不看群組成員與
 * 詳情——spec §9.3 M2 的「名稱連到 `/settings/groups/:id`」作廢。只被 `pages/AdminPage.tsx` import（#201：同一個 chunk）。
 */
export function SettingsAdminGroupsSection() {
  const { t, i18n } = useTranslation();
  const groupsQuery = useAdminGroups();
  const plansQuery = useAdminStoragePlans();
  const assignPlan = useAssignGroupPlan();

  return (
    <SettingsPage title={t("admin.groups.title")} description={t("admin.groups.description")}>
      <SettingsGroup>
        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : groupsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">{errorMessage(t, groupsQuery.error)}</p>
        ) : groupsQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin.groups.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t("admin.groups.tableName")}</th>
                <th className={`py-2 pr-3 font-medium ${LAYOUT.fixed}`}>{t("admin.groups.tableMembers")}</th>
                <th className={`py-2 pr-3 font-medium ${LAYOUT.fixed}`}>{t("admin.groups.tableCreated")}</th>
                <th className={`py-2 pr-3 font-medium ${LAYOUT.fixed}`}>{t("admin.tableStorage")}</th>
                <th className="py-2 font-medium">{t("admin.tablePlan")}</th>
              </tr>
            </thead>
            <tbody>
              {groupsQuery.data.map((row) => (
                <tr key={row.id} className="border-b border-border">
                  <td className={`py-2 pr-3 ${LAYOUT.text}`}>{row.name}</td>
                  <td className={`py-2 pr-3 ${LAYOUT.fixed}`}>{row.memberCount}</td>
                  <td id={`group-created-${row.id}`} className={`py-2 pr-3 ${LAYOUT.fixed}`}>{new Date(row.createdAt).toLocaleDateString(i18n.language)}</td>
                  <td className={`py-2 pr-3 ${LAYOUT.fixed}`}><StorageCell storage={row.storage} /></td>
                  <td className="py-2">
                    <PlanSelect
                      label={t("admin.groups.planFor", { name: row.name })}
                      describedBy={`group-created-${row.id}`}
                      planId={row.storage.planId}
                      planName={row.storage.planName}
                      plans={plansQuery.data?.plans}
                      onAssign={(planId) => assignPlan.mutateAsync({ groupId: row.id, planId })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
