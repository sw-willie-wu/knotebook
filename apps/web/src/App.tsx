import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigationType,
  useParams,
  type Location,
} from "react-router";
import { ActiveNoteProvider } from "./lib/active-note";
import { SidebarQueryProvider } from "./lib/sidebar-query";
import { TourProvider } from "./components/tour/TourProvider";
import { RealLocationContext } from "./lib/real-location";
import { ThemeProvider } from "./theme";
import { Toaster } from "./components/ui/toast";
import { ChangePasswordGate, RequireAdmin, RequireAuth } from "./auth/guards";
import { SESSION_QUERY_KEY } from "./auth/useSession";
import { clearUploadQueue, setUploadSessionExpiredHandler, setUploadUserSource } from "./uploads/upload-queue-store";
import { AppErrorBoundary, ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading, NoteRouteErrorBoundary } from "./components/ErrorBoundary";
import { NotePageFallback } from "./components/NotePageFallback";
import { PublicNoteErrorBoundary, PublicNoteFallback } from "./components/PublicNoteShell";
import LoginPage from "./pages/LoginPage";
import HomePage from "./pages/HomePage";
import { AppShellLayout } from "./components/AppShellLayout";
import { NOTE_ROUTE_PATTERNS, TRASH_PREVIEW_ROUTE } from "./lib/phone-list";
import { KNOWLEDGE_INDEX_ROUTE_PATTERNS } from "./lib/knowledge-index-path";
import { SettingsModal } from "./settings/SettingsModal";
import { GroupModal, GroupSubpathRedirect, LegacyGroupRedirect } from "./components/groups/GroupModal";
import { AdminModal } from "./components/admin/AdminModal";

// BlockNote and the collab stack (~1.3 MB); scripts/check-bundle-size.mjs keeps them out of the entry bundle.
const NotePage = lazy(() => import("./pages/NotePage"));
const TrashPreviewPage = lazy(() => import("./pages/TrashPreviewPage"));
const KnowledgeIndexPage = lazy(() => import("./pages/KnowledgeIndexPage"));

// Rarely used pages are lazy (#201). LoginPage and HomePage stay in the entry bundle (first screens), and so do
// the modal shells (SettingsModal/GroupModal/AdminModal): the modal frame must appear at once, only content waits.
// scripts/check-bundle-size.mjs also requires the AdminSections chunk to exist.
const RegisterPage = lazy(() => import("./pages/RegisterPage"));
const LinkAccountPage = lazy(() => import("./pages/LinkAccountPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));
const ChangePasswordPage = lazy(() => import("./pages/ChangePasswordPage"));
const AuthorizePage = lazy(() => import("./pages/AuthorizePage"));
const SettingsAccountSection = lazy(() =>
  import("./settings/SettingsAccountSection").then(m => ({ default: m.SettingsAccountSection })),
);
const SettingsLoginSection = lazy(() =>
  import("./settings/SettingsLoginSection").then(m => ({ default: m.SettingsLoginSection })),
);
const SettingsAuthorizationSection = lazy(() =>
  import("./settings/SettingsAuthorizationSection").then(m => ({ default: m.SettingsAuthorizationSection })),
);
const SettingsStorageUsageSection = lazy(() =>
  import("./settings/SettingsStorageUsageSection").then(m => ({ default: m.SettingsStorageUsageSection })),
);
const PersonalTagsSection = lazy(() =>
  import("./settings/TagsSection").then(m => ({ default: m.PersonalTagsSection })),
);
const SettingsGroupsOverview = lazy(() =>
  import("./settings/SettingsGroupsOverview").then(m => ({ default: m.SettingsGroupsOverview })),
);
const SettingsAboutSection = lazy(() =>
  import("./settings/SettingsAboutSection").then(m => ({ default: m.SettingsAboutSection })),
);
const GroupMembersSection = lazy(() =>
  import("./components/groups/GroupSections").then(m => ({ default: m.GroupMembersSection })),
);
const GroupRolesSection = lazy(() =>
  import("./components/groups/GroupSections").then(m => ({ default: m.GroupRolesSection })),
);
const GroupTagsSection = lazy(() =>
  import("./components/groups/GroupSections").then(m => ({ default: m.GroupTagsSection })),
);
const GroupStorageSection = lazy(() =>
  import("./components/groups/GroupSections").then(m => ({ default: m.GroupStorageSection })),
);
const GroupAboutSection = lazy(() =>
  import("./components/groups/GroupSections").then(m => ({ default: m.GroupAboutSection })),
);
const AdminUsersSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminUsersSection })));
const AdminGroupsSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminGroupsSection })));
const AdminLoginSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminLoginSection })));
const AdminStorageSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminStorageSection })));
const AdminAiSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminAiSection })));
const AdminKnowledgeFieldsSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminKnowledgeFieldsSection })));
const AdminLimitsSection = lazy(() => import("./components/admin/AdminSections").then(m => ({ default: m.AdminLimitsSection })));

// `key={chunk}`: sibling routes share element type and position, so React would reuse one boundary and carry its
// error state and retry budget to the next page. Not resetKey, whose change in the error state reloads the page.
// ChunkLoadBeacon must stay inside Suspense, or it loops reloading (see ErrorBoundary.tsx).
function LazyPageRoute({ chunk, frame, children }: { chunk: string; frame: "page"; children: ReactNode }) {
  return (
    <LazyRouteErrorBoundary key={chunk} resetKey={undefined} chunk={chunk} frame={frame}>
      <Suspense fallback={<LazyRouteLoading frame={frame} />}>
        {children}
        <ChunkLoadBeacon chunk={chunk} />
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}

const PublicNotePage = lazy(() => import("./pages/PublicNotePage"));

// Like NoteRoute, resetKey comes from the path rather than location.key so a closed modal does not look like a switch.
// The path is parsed in the lazy page, which keeps that code out of the entry bundle.
function KnowledgeIndexRoute() {
  const { pathname } = useLocation();
  return (
    <LazyRouteErrorBoundary key="knowledge-index" resetKey={pathname} chunk="knowledge-index">
      <Suspense fallback={<LazyRouteLoading />}>
        <KnowledgeIndexPage />
        <ChunkLoadBeacon chunk="knowledge-index" />
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}

function TrashPreviewRoute() {
  const { id } = useParams();
  return (
    <LazyRouteErrorBoundary key="trash-preview" resetKey={id} chunk="trash-preview">
      <Suspense fallback={<NotePageFallback />}>
        <TrashPreviewPage />
        <ChunkLoadBeacon chunk="trash-preview" />
      </Suspense>
    </LazyRouteErrorBoundary>
  );
}

// resetKey from route params, not location.key: closing a settings modal creates a new key, which would look like a
// note switch and reload. Cost: navigating again to the same params doesn't retry.
// ChunkLoadBeacon must stay inside Suspense, or it loops reloading (see ErrorBoundary.tsx).
function NoteRoute() {
  // The `g:` prefix is defensive only: group ids are uuids and can't equal a handle.
  const { ref, handle, groupId, slug } = useParams();
  const resetKey =
    groupId !== undefined && slug !== undefined
      ? `g:${groupId}/${slug}`
      : handle !== undefined && slug !== undefined
        ? `${handle}/${slug}`
        : ref;
  return (
    <NoteRouteErrorBoundary resetKey={resetKey}>
      <Suspense fallback={<NotePageFallback />}>
        <NotePage />
        <ChunkLoadBeacon />
      </Suspense>
    </NoteRouteErrorBoundary>
  );
}

// Own fallback and boundary: NotePageFallback/NoteRouteErrorBoundary render an AppShell that fetches /api/auth/me
// and shows the sidebar, which an anonymous page must not do. No ChunkLoadBeacon or auto-reload budget: the public
// page relies on the error card's manual retry (full reload).
function PublicNoteRoute() {
  return (
    <PublicNoteErrorBoundary>
      <Suspense fallback={<PublicNoteFallback />}>
        <PublicNotePage />
      </Suspense>
    </PublicNoteErrorBoundary>
  );
}

/**
 * An upload answered 401 may run with no page of its note open. Refetching the session lets `RequireAuth` confirm it is
 * gone and send the person to login with `?next=`, instead of trusting a single 401. The queue is cleared when the
 * session ends or another account takes the tab, so nobody sees or retries the previous person's files; the cache is
 * watched rather than queried because public pages must make no session request.
 */
function useUploadQueueSession() {
  const queryClient = useQueryClient();
  useEffect(() => {
    setUploadSessionExpiredHandler(() => void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }));
    setUploadUserSource(() => queryClient.getQueryData<UserDto | null>(SESSION_QUERY_KEY)?.id);
    const sessionHash = hashKey(SESSION_QUERY_KEY);
    let owner: string | undefined;
    const check = () => {
      const user = queryClient.getQueryData<UserDto | null>(SESSION_QUERY_KEY);
      if (user === undefined) return;
      if (user === null || (owner !== undefined && owner !== user.id)) clearUploadQueue();
      owner = user?.id;
    };
    check();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash === sessionHash) check();
    });
    return () => {
      unsubscribe();
      setUploadSessionExpiredHandler(undefined);
      setUploadUserSource(undefined);
    };
  }, [queryClient]);
}

/**
 * Two `<Routes>` trees for modal-over-background. The main tree gets `location={backgroundLocation}`, which overrides
 * LocationContext, so matching, `<Navigate>` and useLocation() under it all see the background page. The second tree
 * holds only the panels (/settings/*, /groups/*, /admin/*) on the real location and matches nothing elsewhere, so its
 * guards don't run. Never add panel paths to the main tree, or the background page stops rendering.
 * Logged out under a modal, both trees redirect to /login; the second tree's effect runs last, so `next` is the real
 * URL (App.test.tsx); if a modal route moves out of the second tree, `next` silently becomes the background page.
 * Only with backgroundLocation state do the trees disagree; both Navigates replace, so one history entry results.
 * /change-password is outside ChangePasswordGate because it is the gate's target.
 */
export function AppRoutes() {
  useUploadQueueSession();
  const location = useLocation();
  const navigationType = useNavigationType();
  const realLocation = useMemo(() => ({ location, navigationType }), [location, navigationType]);
  const state = location.state as { backgroundLocation?: Location } | null;

  return (
    // In the main tree useLocation() is the background and useNavigationType() is always POP; NotePage needs the real ones.
    <RealLocationContext.Provider value={realLocation}>
      <Routes location={state?.backgroundLocation ?? location}>
        <Route path="/login" element={<LoginPage />} />
        {/* Outside RequireAuth; the page itself redirects a logged-in user. */}
        <Route
          path="/register"
          element={
            <LazyPageRoute chunk="register" frame="page">
              <RegisterPage />
            </LazyPageRoute>
          }
        />
        {/* Outside RequireAuth: it only needs the pending-link cookie. */}
        <Route
          path="/link-account"
          element={
            <LazyPageRoute chunk="link-account" frame="page">
              <LinkAccountPage />
            </LazyPageRoute>
          }
        />
        {/* Outside RequireAuth; the page asks a logged-in user to log out first. */}
        <Route
          path="/reset-password"
          element={
            <LazyPageRoute chunk="reset-password" frame="page">
              <ResetPasswordPage />
            </LazyPageRoute>
          }
        />
        {/* Public share pages: anonymous, outside RequireAuth. PublicNotePage tells the two forms apart by params.
            /p must stay out of shared EXCLUDED_PREFIXES so the SPA fallback serves it (noindex is set server-side). */}
        <Route path="/p/:token" element={<PublicNoteRoute />} />
        <Route path="/p/:handle/:slug" element={<PublicNoteRoute />} />
        <Route element={<RequireAuth />}>
          <Route
            path="/change-password"
            element={
              <LazyPageRoute chunk="change-password" frame="page">
                <ChangePasswordPage />
              </LazyPageRoute>
            }
          />
          <Route element={<ChangePasswordGate />}>
            {/* OAuth consent; when logged out, the guard's `next` brings the user back here after login. */}
            <Route
              path="/authorize"
              element={
                <LazyPageRoute chunk="authorize" frame="page">
                  <AuthorizePage />
                </LazyPageRoute>
              }
            />
            {/* `/notes/:ref` is the legacy form, kept for old links. */}
            {/* One shared layout so the sidebar doesn't remount on navigation (keeps list scroll and selection mode). */}
            <Route element={<AppShellLayout />}>
              {/* Patterns shared with the phone layout's "is this a note route" check. */}
              {NOTE_ROUTE_PATTERNS.map((path) => (
                <Route key={path} path={path} element={<NoteRoute />} />
              ))}
              <Route path={TRASH_PREVIEW_ROUTE} element={<TrashPreviewRoute />} />
              {KNOWLEDGE_INDEX_ROUTE_PATTERNS.map((path) => (
                <Route key={path} path={path} element={<KnowledgeIndexRoute />} />
              ))}
              <Route path="/*" element={<HomePage />} />
            </Route>
          </Route>
        </Route>
      </Routes>
      {/* Second tree: panels only, on the real location (see AppRoutes). */}
      <Routes>
        <Route element={<RequireAuth />}>
          <Route element={<ChangePasswordGate />}>
            <Route element={<SettingsModal />}>
              {/* Layout route, so switching sections doesn't remount the dialog. */}
              <Route path="/settings/account" element={<SettingsAccountSection />} />
              {/* Also the OIDC account-link return target. */}
              <Route path="/settings/login" element={<SettingsLoginSection />} />
              <Route path="/settings/authorization" element={<SettingsAuthorizationSection />} />
              {/* Personal storage usage. */}
              <Route path="/settings/storage" element={<SettingsStorageUsageSection />} />
              <Route path="/settings/tags" element={<PersonalTagsSection />} />
              {/* Read-only, any logged-in user. */}
              <Route path="/settings/groups" element={<SettingsGroupsOverview />} />
              <Route path="/settings/about" element={<SettingsAboutSection />} />
            </Route>
            {/* Any logged-in user, not under RequireAdmin. */}
            <Route path="/groups/:id" element={<GroupModal />}>
              <Route index element={<GroupMembersSection />} />
              <Route path="roles" element={<GroupRolesSection />} />
              <Route path="tags" element={<GroupTagsSection />} />
              <Route path="storage" element={<GroupStorageSection />} />
              <Route path="about" element={<GroupAboutSection />} />
              <Route path="*" element={<GroupSubpathRedirect />} />
            </Route>
            {/* Redirects outside AdminModal (no modal flash) but inside RequireAdmin (non-admins go straight to /).
                Inside ChangePasswordGate so a forced password change comes before the admin check. */}
            <Route element={<RequireAdmin />}>
              <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
              <Route path="/admin/auth" element={<Navigate to="/admin/login" replace />} />
              <Route path="/admin/versions" element={<Navigate to="/admin/storage" replace />} />
              <Route element={<AdminModal />}>
                <Route path="/admin/users" element={<AdminUsersSection />} />
                <Route path="/admin/groups" element={<AdminGroupsSection />} />
                <Route path="/admin/login" element={<AdminLoginSection />} />
                <Route path="/admin/storage" element={<AdminStorageSection />} />
                <Route path="/admin/ai" element={<AdminAiSection />} />
                <Route path="/admin/knowledge-fields" element={<AdminKnowledgeFieldsSection />} />
                <Route path="/admin/limits" element={<AdminLimitsSection />} />
              </Route>
              <Route path="/admin/*" element={<Navigate to="/admin/users" replace />} />
            </Route>
          </Route>
          {/* Legacy group URLs; outside SettingsModal so the settings panel doesn't flash. */}
          <Route path="/settings/groups/:id" element={<LegacyGroupRedirect suffix="" />} />
          <Route path="/settings/groups/:id/roles" element={<LegacyGroupRedirect suffix="/roles" />} />
          {/* Outside SettingsModal (no modal flash); the target's own guard decides access, e.g. RequireAdmin. */}
          <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
          <Route path="/settings/users" element={<Navigate to="/admin/users" replace />} />
          <Route path="/settings/ai" element={<Navigate to="/admin/ai" replace />} />
        </Route>
        {/* Silences "No routes matched" on non-panel paths. Never put it under a guard: the guard would run on every page. */}
        <Route path="*" element={null} />
      </Routes>
    </RealLocationContext.Provider>
  );
}

export default function App() {
  // Outermost so errors in ThemeProvider/Toaster are caught too; its fallback needs no context.
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          {/* Wraps both Routes trees so the active-note highlight survives closing a modal. */}
          <ActiveNoteProvider>
            <SidebarQueryProvider>
              {/* Outside Routes so the tour survives page changes; it reads the sidebar query. */}
              <TourProvider>
                <AppRoutes />
              </TourProvider>
            </SidebarQueryProvider>
          </ActiveNoteProvider>
        </BrowserRouter>
        <Toaster />
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
