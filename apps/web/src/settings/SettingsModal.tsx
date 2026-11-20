import { Suspense } from "react";
import { Outlet, useLocation, useNavigate, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { useGroups } from "@/api/groups";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { ManagementShell, type ManagementNavItemSpec } from "@/components/management/ManagementShell";

interface SettingsLocationState {
  backgroundLocation?: Location;
}

/**
 * Pages are lazy chunks (#201) while the shell stays in the entry bundle, so the frame and navigation appear at once. Switching tabs is a
 * nested route change, so `<Dialog>` stays mounted. `resetKey` is the real pathname so clicking another tab on the error screen changes
 * the destination. `ChunkLoadBeacon` must sit inside Suspense beside `<Outlet/>` (placement invariant in ErrorBoundary.tsx);
 * `chunk="settings"` is a reload-quota alias shared by all settings pages, not a real chunk. Site administration isn't here (its entry is
 * in `UserMenu`).
 */
export function SettingsModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const backgroundLocation = (location.state as SettingsLocationState | null)?.backgroundLocation;
  // Same ['groups'] cache as the sidebar, so no extra fetch.
  const groups = useGroups();

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  const items: ManagementNavItemSpec[] = [
    { to: "/settings/account", label: t("settings.nav.account") },
    { to: "/settings/login", label: t("settings.nav.login") },
    { to: "/settings/authorization", label: t("settings.nav.authorization") },
    { to: "/settings/storage", label: t("settings.nav.storage") },
    { to: "/settings/tags", label: t("tags.manage.nav") },
    { to: "/settings/groups", label: t("settings.nav.groups"), count: groups.data?.length },
    { to: "/settings/about", label: t("settings.nav.about") },
  ];

  return (
    <ManagementShell title={t("settings.title")} description={t("settings.description")} items={items} onOpenChange={handleOpenChange}>
      <LazyRouteErrorBoundary resetKey={location.pathname} chunk="settings" frame="inline">
        <Suspense fallback={<LazyRouteLoading frame="inline" />}>
          <Outlet />
          <ChunkLoadBeacon chunk="settings" />
        </Suspense>
      </LazyRouteErrorBoundary>
    </ManagementShell>
  );
}
