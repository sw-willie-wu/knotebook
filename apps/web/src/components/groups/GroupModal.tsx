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
 * `<Navigate to="/groups/:id">` doesn't substitute params, hence `useParams`. `LegacyGroupRedirect` must forward
 * `location.state`: old URLs can carry `backgroundLocation`, and dropping it makes closing the modal land on `/`
 * instead of the original page.
 */
export function LegacyGroupRedirect({ suffix }: { suffix: "" | "/roles" }) {
  const { id = "" } = useParams();
  const location = useLocation();
  return <Navigate to={`/groups/${encodeURIComponent(id)}${suffix}`} replace state={location.state} />;
}

/**
 * Sits inside `GroupModal` (its `path="*"` child) so the destination is the same modal and no other panel flashes.
 * Forwards `location.state` to keep `backgroundLocation`, as `LegacyGroupRedirect` does.
 */
export function GroupSubpathRedirect() {
  const { id = "" } = useParams();
  const location = useLocation();
  return <Navigate to={`/groups/${encodeURIComponent(id)}`} replace state={location.state} />;
}

/**
 * Group lookup (in the sidebar's `useGroups()` cache) is case-insensitive: the server returns lowercase ids but a URL
 * can be typed in uppercase. Non-member, missing and invalid ids look the same: `errors.not_found` in the right card,
 * `groups.nav.label` as title, no subtitle, shell and items as usual; loading and an error without data use the same
 * fallback title. A failed refetch with data still present keeps the old data instead of replacing the panel with an error.
 * The right card's lazy error boundary matches `SettingsModal`: inline frame, `chunk="group"`, `resetKey` from the real pathname.
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
    ...(group?.canManageGroup === true ? [{ to: `${base}/tags`, label: t("tags.manage.nav") }] : []),
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
