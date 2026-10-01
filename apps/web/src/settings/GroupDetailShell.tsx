import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation, useParams, type Location } from "react-router";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { cn } from "@/lib/utils";
import { SettingsPage } from "./SettingsLayout";

interface SettingsLocationState {
  backgroundLocation?: Location;
}

const TAB_CLASS = "-mb-px border-b-2 px-3 py-2 text-sm transition-colors";

/**
 * `/settings/groups/:id` 與 `/settings/groups/:id/roles` 共用的外框（#175 spec §8.5「群組詳情頁內加『成員』『角色』兩個分頁連結」）：
 * 返回列表的連結、群組名標題、兩個分頁，以及「不是我的群組」三形（載入中／錯誤／`errors.not_found`——S4：非成員、不存在、
 * id 不合法 UI 不分辨）。**兩個連結都轉傳 `backgroundLocation`**：不轉傳的話，在分頁之間切換後關掉設定 modal 會回不到
 * 開啟前的頁面（GroupMenu 的 gate r1 I3 同一個雷）。資料就是 `useGroups()`，與側欄同一份快取。
 */
export function GroupDetailShell({
  action,
  children,
}: {
  action?: (group: GroupDto) => ReactNode;
  children: (group: GroupDto, backgroundLocation: Location | undefined) => ReactNode;
}) {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const location = useLocation();
  const backgroundLocation = (location.state as SettingsLocationState | null)?.backgroundLocation;
  const groupsQuery = useGroups();

  if (groupsQuery.isPending) return <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  if (groupsQuery.isError) {
    const err = groupsQuery.error;
    return (
      <p role="alert" className="text-sm text-destructive">
        {err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback")}
      </p>
    );
  }
  const group = groupsQuery.data.find((candidate) => candidate.id === id);
  if (!group) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("errors.not_found")}
      </p>
    );
  }
  const state = backgroundLocation ? { backgroundLocation } : undefined;
  const base = `/settings/groups/${encodeURIComponent(group.id)}`;
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    cn(TAB_CLASS, isActive ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground");
  const headerAction = action?.(group);

  return (
    <div className="space-y-4">
      <Link to="/settings/groups" state={state} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← {t("groups.detail.back")}
      </Link>
      <SettingsPage title={group.name} action={headerAction ?? undefined}>
        {/* 分頁列是 `SettingsPage` 子層（`divide-y`）的第一個子節點：Tailwind v4 的 `divide-y` 對「非最後一個」子節點畫
            border-bottom，與這裡的 `border-b` 是同一條 1px 底線；其後第一個 `SettingsGroup` 不再是 first child，
            `first:pt-0` 不作用、保有 `pt-8` 與分頁列隔開。 */}
        <nav aria-label={t("groups.detail.tabsLabel")} className="flex gap-1 border-b border-border">
          <NavLink end to={base} state={state} className={tabClass}>
            {t("groups.detail.tabMembers")}
          </NavLink>
          <NavLink end to={`${base}/roles`} state={state} className={tabClass}>
            {t("groups.detail.tabRoles")}
          </NavLink>
        </nav>
        {children(group, backgroundLocation)}
      </SettingsPage>
    </div>
  );
}
