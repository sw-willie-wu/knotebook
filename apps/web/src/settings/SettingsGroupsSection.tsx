import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, type Location } from "react-router";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { GroupMenu } from "@/components/groups/GroupMenu";
import { GroupNameDialog } from "@/components/groups/GroupNameDialog";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/** 設定 modal 內的路由 state 形（與 `SettingsModal` 同一把）。 */
interface SettingsLocationState {
  backgroundLocation?: Location;
}

/**
 * `/settings/groups`（所有登入者，spec §8.4）：我的群組列表（名稱→詳情頁、我的角色、
 * 列內 ⋮＝`GroupMenu`）＋頁首「新增群組」（本頁唯一實心鈕，`brandDeep`：modal 內的
 * 主動作，與 `CreateUserDialog` 的觸發鈕同階）。列表資料就是 `useGroups()`——與側欄同一份
 * 快取，建立／改名／刪除後兩處同步。
 */
export function SettingsGroupsSection() {
  const { t } = useTranslation();
  const location = useLocation();
  const backgroundLocation = (location.state as SettingsLocationState | null)?.backgroundLocation;
  const groupsQuery = useGroups();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <SettingsPage
      title={t("groups.settings.title")}
      description={t("groups.settings.description")}
      action={
        <>
          <Button type="button" variant="brandDeep" onClick={() => setCreateOpen(true)}>
            {t("groups.settings.newGroup")}
          </Button>
          {createOpen && <GroupNameDialog mode="create" open onOpenChange={setCreateOpen} />}
        </>
      }
    >
      <SettingsGroup>
        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : groupsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, groupsQuery.error)}
          </p>
        ) : groupsQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("groups.settings.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 font-medium">{t("groups.settings.tableName")}</th>
                <th className="py-2 font-medium">{t("groups.settings.tableRole")}</th>
                <th className="py-2 text-right font-medium">{t("groups.settings.tableActions")}</th>
              </tr>
            </thead>
            <tbody>
              {groupsQuery.data.map((group) => (
                <tr key={group.id} className="border-b border-border">
                  <td className="py-2">
                    <Link
                      to={`/settings/groups/${encodeURIComponent(group.id)}`}
                      state={backgroundLocation ? { backgroundLocation } : undefined}
                      className="underline-offset-4 hover:underline"
                    >
                      {group.name}
                    </Link>
                  </td>
                  <td className="py-2">{t(`groups.role.${group.myRole}`)}</td>
                  <td className="py-2">
                    <div className="flex justify-end">
                      <GroupMenu group={group} />
                    </div>
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
