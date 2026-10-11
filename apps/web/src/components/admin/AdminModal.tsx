import { Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, type Location } from "react-router";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { ManagementShell } from "@/components/management/ManagementShell";

/**
 * 站台管理 modal（#247 §7，W1／W14）——第二棵 Routes 樹的 layout route，外殼是 `ManagementShell`，五項：
 * 使用者／群組／登入／儲存方案（含站台版本設定）／AI 代理。
 *
 * 守衛不在這裡：`App.tsx` 把本路由掛在 `RequireAuth → ChangePasswordGate → RequireAdmin` 底下；`/admin`、`/admin/auth`、
 * `/admin/versions` 與未知子路徑的轉址掛在本元件**外面**（RequireAdmin 之下）——不先閃 modal，非 admin 直接被 RequireAdmin 導 `/`。
 * 主樹對 `/admin/*` 落在 `/*` 的 `HomePage`（深連結時的背景）。
 *
 * 關閉（Esc／✕）：`navigate(backgroundLocation ?? "/")`。「回筆記」項次已刪（關閉即回）。
 * 右卡的 lazy 錯誤邊界同 `SettingsModal`：inline frame、`chunk="admin"`、`resetKey` 取真實 pathname。
 */
export function AdminModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  const items = [
    { to: "/admin/users", label: t("admin.nav.users") },
    { to: "/admin/groups", label: t("admin.nav.groups") },
    { to: "/admin/login", label: t("admin.nav.auth") },
    { to: "/admin/storage", label: t("admin.nav.storage") },
    { to: "/admin/ai", label: t("admin.nav.ai") },
  ];

  return (
    <ManagementShell title={t("admin.nav.label")} items={items} onOpenChange={handleOpenChange}>
      <LazyRouteErrorBoundary resetKey={location.pathname} chunk="admin" frame="inline">
        <Suspense fallback={<LazyRouteLoading frame="inline" />}>
          <Outlet />
          <ChunkLoadBeacon chunk="admin" />
        </Suspense>
      </LazyRouteErrorBoundary>
    </ManagementShell>
  );
}
