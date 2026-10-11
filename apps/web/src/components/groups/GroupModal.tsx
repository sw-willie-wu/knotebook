import { Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation, useNavigate, useParams, type Location } from "react-router";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { ManagementShell } from "@/components/management/ManagementShell";
import { roleLabel } from "@/lib/group-role";
import type { GroupOutletContext } from "./group-outlet";

/**
 * 群組 modal（#247 §6）：`GroupModal`（layout route）、`GroupSubpathRedirect`（未知子路徑）、`LegacyGroupRedirect`（舊網址）。
 * 三者都在首包；四個區塊在 lazy 的 `GroupSections`。
 *
 * `LegacyGroupRedirect`：舊網址 `/settings/groups/:id`、`/settings/groups/:id/roles` 轉到群組 modal。
 * `<Navigate to="/groups/:id">` 不會代入參數，所以讀 `useParams`。**必須轉傳 `location.state`**：舊網址可能
 * 帶著 `backgroundLocation`（出貨前開著的分頁、尚未改到的呼叫點），不帶 state 的 `<Navigate>` 會把背景丟掉，
 * 關閉群組 modal 就落到 `/` 而不是原本那頁。首包、很小。
 */
export function LegacyGroupRedirect({ suffix }: { suffix: "" | "/roles" }) {
  const { id = "" } = useParams();
  const location = useLocation();
  return <Navigate to={`/groups/${encodeURIComponent(id)}${suffix}`} replace state={location.state} />;
}

/**
 * `/groups/:id/<未知子路徑>` → `/groups/:id`（#247 §6.1）。掛在 `GroupModal` **裡面**（它的 `path="*"` 子 route）：
 * 目的地是同一個 modal，不會閃別的面板。`<Navigate to="/groups/:id">` 不代入參數，所以讀 `useParams`；
 * 轉傳 `location.state` 才不會丟掉 `backgroundLocation`（同 `LegacyGroupRedirect` 的理由）。
 */
export function GroupSubpathRedirect() {
  const { id = "" } = useParams();
  const location = useLocation();
  return <Navigate to={`/groups/${encodeURIComponent(id)}`} replace state={location.state} />;
}

/**
 * 群組 modal（#247 §6.0）——第二棵 Routes 樹的 layout route，外殼是 `ManagementShell`。
 *
 * - 群組由 `useGroups()`（與側欄同一份快取）以 `:id` 找，**不分大小寫**（#241 起 server 一律回小寫 id，但網址可能被手打成大寫）。
 * - **S4**：非成員、不存在、id 不合法同一形——右卡 `errors.not_found`、標題 `groups.nav.label`、沒有副文字；外殼與四個項次照常。
 *   載入中與（沒有任何舊資料時的）錯誤也用同一個備用標題。
 * - 已有資料時 refetch 失敗（`isError` 但 `data` 仍在）照樣用舊資料——不把整個面板換成錯誤字（Review Focus 1）。
 * - 右卡的 lazy 錯誤邊界同 `SettingsModal`：inline frame、`chunk="group"`、`resetKey` 取真實 pathname。
 * - 關閉（Esc／✕）：`navigate(backgroundLocation ?? "/")`。
 */
export function GroupModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { id = "" } = useParams();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  const groupsQuery = useGroups();
  const wanted = id.toLowerCase();
  const group = groupsQuery.data?.find((candidate) => candidate.id.toLowerCase() === wanted);

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  const base = `/groups/${encodeURIComponent(id)}`;
  const items = [
    { to: base, label: t("groups.nav.members"), end: true },
    { to: `${base}/roles`, label: t("groups.nav.roles") },
    { to: `${base}/storage`, label: t("groups.nav.storage") },
    { to: `${base}/about`, label: t("groups.nav.about") },
  ];

  let content: ReactNode;
  if (group) {
    const context: GroupOutletContext = { group };
    content = (
      <LazyRouteErrorBoundary resetKey={location.pathname} chunk="group" frame="inline">
        <Suspense fallback={<LazyRouteLoading frame="inline" />}>
          <Outlet context={context} />
          <ChunkLoadBeacon chunk="group" />
        </Suspense>
      </LazyRouteErrorBoundary>
    );
  } else if (groupsQuery.data === undefined && groupsQuery.isPending) {
    content = <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  } else if (groupsQuery.data === undefined) {
    const err = groupsQuery.error;
    content = (
      <p role="alert" className="text-sm text-destructive">
        {err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback")}
      </p>
    );
  } else {
    content = (
      <p role="alert" className="text-sm text-destructive">
        {t("errors.not_found")}
      </p>
    );
  }

  return (
    <ManagementShell
      title={group ? group.name : t("groups.nav.label")}
      subtitle={group && group.myRole !== null ? roleLabel(t, group.myRole) : undefined}
      items={items}
      onOpenChange={handleOpenChange}
    >
      {content}
    </ManagementShell>
  );
}
