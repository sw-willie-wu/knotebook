import { useTranslation } from "react-i18next";
import { GROUP_ROLE_FLAGS } from "@knotebook/shared";
import { useGroups } from "@/api/groups";
import { Pill } from "@/components/management/Pill";
import { roleLabel } from "@/lib/group-role";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

/**
 * 個人設定「群組」（`/settings/groups`，#247 §5.5）：**唯讀總覽**——我有幾個群組、在每個群組的角色與權限。
 * 沒有任何動作鈕、沒有 ⋮、群組名不是連結（W11：面板之間不互相連結；W26：建立與管理都從側欄）。
 * 資料就是 `useGroups()`（與側欄同一份快取）。
 *
 * `myRole` 型別可為 null（非成員的站台 admin，只出現在 `PATCH /api/groups/:id` 的回應，`useGroups()`
 * 實際碰不到）——型別上仍處理：角色欄「—」、只有「閱讀」pill。`roleLabel` 不收 null，所以先判。
 * 不可直接用 `myRole.name`：內建角色的 `name` 恆為 null（會顯示空白）。
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
    body = (
      <SettingsGroup title={t("settings.groups.count", { count: groups.data.length })}>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">{t("settings.groups.tableGroup")}</th>
              <th className="py-2 pr-4 font-medium">{t("settings.groups.tableRole")}</th>
              <th className="py-2 font-medium">{t("settings.groups.tablePermissions")}</th>
            </tr>
          </thead>
          <tbody>
            {groups.data.map((group) => (
              <tr key={group.id} className="border-t border-border align-top">
                <td className="py-2 pr-4">{group.name}</td>
                <td className="py-2 pr-4">{group.myRole === null ? "—" : roleLabel(t, group.myRole)}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    <Pill>{t("groups.roles.readPill")}</Pill>
                    {GROUP_ROLE_FLAGS.filter((flag) => group.myRole?.permissions[flag] === true).map((flag) => (
                      <Pill key={flag}>{t(`groups.roles.flags.${flag}.label`)}</Pill>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsGroup>
    );
  }

  return (
    <SettingsPage title={t("settings.nav.groups")} description={t("settings.groups.overview")}>
      {body}
    </SettingsPage>
  );
}
