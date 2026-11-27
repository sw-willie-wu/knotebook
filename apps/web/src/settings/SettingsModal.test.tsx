import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type MemoryRouterProps } from "react-router";
import * as Y from "yjs";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { CollabState } from "@/collab/connection";
import { adminRole, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { clickOutside } from "@/test/outside-click";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Settings master modal: two Routes trees plus the modal-over-background mechanism, always run through the real
// `AppRoutes` (the single source of truth in App.tsx), not an equivalent rebuilt tree - this verifies the wiring
// (guard reuse, backgroundLocation dependence, the Dialog layout route not remounting), not just the behavior of the
// `SettingsModal` component rendered alone. The fetch mock convention is the same as `ChangePasswordPage.test.tsx`
// (mock global fetch, not the hooks).
//
// When the background page is `/notes/:ref`, `NotePage` needs `useCollab` (Hocuspocus/WebSocket) and a real
// BlockNote editor - neither is in the jsdom test scope (the connection state machine is fully covered by connection.test.ts,
// the editor itself is left to manual verification), so this uses the minimal-stub convention already in `NotePage.test.tsx`:
// it only checks that the background page is mounted, not editor / collaboration details.

// NoteEditor is slot-based - this stub follows NotePage.test.tsx's minimal-stub convention (two bindings, see the mock in that file),
// takes headerSlot/footerSlot and renders them as-is; otherwise `getByLabelText("Note title")`
// (the TitleInput inside headerSlot) would not be found.
vi.mock("@/components/NoteEditor", () => ({
  NoteEditor: ({
    editable,
    headerSlot,
    footerSlot,
    previewSlot,
  }: {
    editable: boolean;
    headerSlot?: ReactNode;
    footerSlot?: ReactNode;
    previewSlot?: ReactNode;
  }) => (
    <div data-testid="note-editor" data-editable={String(editable)}>
      {headerSlot}
      {previewSlot !== undefined && <div data-testid="mock-preview-slot">{previewSlot}</div>}
      {footerSlot}
    </div>
  ),
}));

// #201: in this file the "authorization" block is used only to check that a block chunk load failure is caught by the boundary inside the modal -
// the stub throws the chunk-failure message directly (a real lazy reject, passing through Suspense, also reaches the
// boundary as a render throw; the Vite preload message is in ErrorBoundary.tsx's allowlist). The other cases in this file don't enter `/settings/authorization`
// (it used to hang under the group roles page, which moved to the group modal; the "About" page has its own case that needs its h1, so it doesn't hang there).
vi.mock("@/settings/SettingsAuthorizationSection", () => ({
  SettingsAuthorizationSection: () => {
    throw new Error("Failed to fetch dynamically imported module: https://x/assets/SettingsAuthorizationSection-abc.js");
  },
}));

/**
 * Negative criterion for "no flash of the settings panel": any `[role=dialog]` mounted into the DOM during the redirect must have an accessible name (the
 * `DialogTitle` text that `aria-labelledby` points to) that is not the settings panel's title "Settings". It only records, and doesn't judge "must equal the destination" (the group modal first has a fallback title).
 * It records `addedNodes` (with descendants) rather than running `querySelectorAll` at callback time - a node that flashes may be removed before the callback runs (same as the
 * "no modal flash first" case in this file); the title is also searched within the added subtree first (`getElementById` can't find it once the node has left the document).
 */
function watchDialogTitles() {
  const titles = new Set<string>();
  const titleOf = (dialog: Element): string => {
    const labelId = dialog.getAttribute("aria-labelledby");
    if (!labelId) return "";
    const inSubtree = [...dialog.querySelectorAll("[id]")].find((el) => el.id === labelId);
    return (inSubtree ?? document.getElementById(labelId))?.textContent ?? "";
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const dialogs = node.matches('[role="dialog"]') ? [node] : [];
        dialogs.push(...node.querySelectorAll('[role="dialog"]'));
        for (const dialog of dialogs) titles.add(titleOf(dialog));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  return { titles, stop: () => observer.disconnect() };
}

function createStubProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    // issue #48: the background page is a normally opened, synced note - NotePage now gates editable on synced.
    synced: true,
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
  };
}

const collab = vi.hoisted(() => ({
  state: { phase: "connecting" } as CollabState,
  onUnauthorized: undefined as (() => void) | undefined,
  doc: undefined as unknown as Y.Doc,
  provider: undefined as unknown as ReturnType<typeof createStubProvider>,
  /** #179: the noteId passed to useCollab on every render (the real useCollab tears down / reconnects by it). Tests clear it themselves. */
  noteIds: [] as (string | undefined)[],
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ noteId, onUnauthorized }: { noteId: string | undefined; onUnauthorized: () => void }) => {
    collab.noteIds.push(noteId);
    collab.onUnauthorized = onUnauthorized;
    return { state: collab.state, doc: collab.doc, provider: collab.provider, synced: collab.provider.synced };
  },
}));

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const ADMIN_USER: UserDto = {
  id: "u-admin",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};
const PLAIN_USER: UserDto = {
  id: "u-plain",
  email: "plain@example.com",
  handle: "tester",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u-plain",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

/** Basic fetch mock: `/api/auth/me` (returns the logged-in user or 401 per
 * `getLoggedInAs`), `/api/notes` (list, empty array), `/api/notes/:ref`
 * (single note, always returns `NOTE`), backlinks (empty) - the route guards and HomePage/NotePage both need
 * these. Callers can layer on handlers for other endpoints (e.g. `POST /api/auth/password`). */
function baseFetchHandlers(getLoggedInAs: () => UserDto | null) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      const user = getLoggedInAs();
      if (user) return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
      return fakeResponse({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
      });
    }
    if (url === "/api/folders") return new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/tokens" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) });
    }
    if (url === "/api/storage" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ usedBytes: 0, quotaBytes: 2147483648, planName: "Basic", byKind: { image: 0, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 } }) });
    }
    if (url === "/api/auth/avatars" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ candidates: [], auto: false, refreshable: [] }) });
    }
    if (url === "/api/auth/identities" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ identities: [], linkable: [], hasPassword: true, passwordLoginEnabled: true }) });
    }
    if (url.endsWith("/backlinks") && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) });
    }
    if (url.startsWith("/api/notes/") && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(NOTE) });
    }
    if (url === "/api/admin/users" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/admin/invites" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/config" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) });
    }
    if (url === "/api/admin/storage-plans" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ plans: [], defaults: { userPlanId: "", groupPlanId: "" } }) });
    }
    if (url === "/api/admin/trash/settings" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ retentionDays: 7 }) });
    }
    return null;
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

const historyNav: { back?: () => void; push?: (to: string) => void } = {};
function HistoryNavHandle() {
  const navigate = useNavigate();
  useEffect(() => {
    historyNav.back = () => void navigate(-1);
    historyNav.push = (to) => void navigate(to);
    return () => {
      historyNav.back = undefined;
      historyNav.push = undefined;
    };
  }, [navigate]);
  return null;
}

function renderAt(
  initialEntries: NonNullable<MemoryRouterProps["initialEntries"]>,
  fetchMock: ReturnType<typeof vi.fn>,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <ActiveNoteProvider>
            <AppRoutes />
            <LocationProbe />
            <HistoryNavHandle />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** DropdownMenuTrigger (`UserMenu`) only attaches `onPointerDown` (see the `@radix-ui/react-dropdown-menu`
 * source), so a plain `fireEvent.click` can't open it - this is about jsdom's pointer event compatibility,
 * not a bug. */
function openUserMenu(userDisplayName: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: userDisplayName }), { button: 0 });
}

describe("SettingsModal (two Routes trees, modal-over-background)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
  });

  it("opening settings from /notes/x inside the app (UserMenu \"Settings\" entry) -> the modal and the background page coexist in the DOM; closing -> back to the background /notes/x", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/notes/my-note"], fetchMock);

    // This waits for the **real** NotePage lazy import (the whole BlockNote dependency chain); RTL's default 1 s has too thin a margin under cold-start
    // load and fails intermittently (#69); the wait limit is the global asyncUtilTimeout from test/setup.ts.
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Account info" })).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // After closing it still lands on the background location (before opening settings NotePage had already settled /notes/my-note into /n/tester/my-note,
    // and since #179 the settling goes through the router, so the background remembers it) - the editor stub is still there, not navigated elsewhere.
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
  });

  it("backgroundLocation survives switching between sections: open settings from /notes/x -> switch to Storage -> switch to Groups -> close -> back to /notes/x (not back to /)", async () => {
    // This case guards `ManagementNavItem` (components/management/ManagementShell.tsx)'s
    // `state={backgroundLocation ? {...} : undefined}` - without it, after one switch between items
    // `location.state.backgroundLocation` becomes undefined, closing can only land on `/`, and silently tears down the collab provider of the background
    // `/notes/:ref`. Since #247 there are six items: after switching through two new items in a row, the background must still be carried along.
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/notes/my-note"], fetchMock);

    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());

    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings" })).getByText("Storage"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument());

    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings" })).getByText("Groups"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Lands on this note (the background already settled to /n/tester/my-note, see the previous case), not wrongly brought back to /: `AppShell` (HomePage uses the same shell)
    // always has a "New note" button, so it can't tell them apart; assert something specific to `NotePage` instead -
    // the editor stub is still there and the title input carries this note's title (HomePage has no such field;
    // if backgroundLocation were lost midway and landed on /, this label wouldn't be found).
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Note title")).toHaveValue("My Note");
  });

  it("direct deep link /settings/account (no state) -> background = HomePage (the main tree takes the real location and falls to the /* catch-all)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    // While Radix Dialog is open it marks background siblings `aria-hidden` (part of the focus trap),
    // and `getByRole` filters by the accessibility tree so it can't find them - use `getByText`, which isn't affected by `aria-hidden`
    // (same reasoning as the `note-editor` testid assertions), to verify that HomePage really is mounted,
    // not the visibility in the accessibility tree.
    expect(screen.getByText("New note")).toBeInTheDocument();
  });

  // Site admin lives under /admin/* (since #247 a modal in the second tree): the old /settings/users and /settings/ai always redirect there (old bookmarks and
  // old doc links keep working) without flashing the settings panel first (negative criterion); for a non-admin, after the redirect RequireAdmin at /admin sends them to /.
  for (const [from, to, heading] of [
    ["/settings/users", "/admin/users", "User management"],
    ["/settings/ai", "/admin/ai", "AI providers & actions"],
  ] as const) {
    it(`admin deep link ${from} -> redirects to ${to} (site admin modal, not the settings modal)`, async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
        if (res) return Promise.resolve(res);
        if (url.startsWith("/api/admin/ai/") && method === "GET") {
          const key = url.slice("/api/admin/ai/".length);
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ [key]: [] }) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      });

      // "No settings-panel flash first": the destination is itself a modal (site admin), so we can't assert "no dialog at all";
      // instead assert that the titles of dialogs mounted along the way are never "Settings" (negative criterion, `watchDialogTitles`).
      const watcher = watchDialogTitles();
      try {
        renderAt([from], fetchMock);

        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(to));
        const dialog = await screen.findByRole("dialog", { name: "Site admin" });
        await waitFor(() => expect(within(dialog).getByRole("heading", { level: 1, name: heading })).toBeInTheDocument());
        expect([...watcher.titles]).not.toContain("Settings");
      } finally {
        watcher.stop();
      }
    });
  }

  it("non-admin deep link /settings/users -> /admin/users -> RequireAdmin sends to / (no modal opens throughout)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const watcher = watchDialogTitles();
    try {
      renderAt(["/settings/users"], fetchMock);

      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
      await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
      expect(screen.queryByRole("dialog", { name: "Site admin" })).not.toBeInTheDocument();
      expect([...watcher.titles]).not.toContain("Settings");
    } finally {
      watcher.stop();
    }
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/users", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/invites", expect.anything());
  });

  it("admin deep link /settings/account -> the navigation has exactly seven items in fixed order and **doesn't show** Users / AI (site admin isn't inside settings)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    const nav = within(screen.getByRole("navigation", { name: "Settings" }));
    // Take each item's label span (the "Groups" item has a count span on its right, so textContent would run together)
    expect(nav.getAllByRole("link").map((a) => a.querySelector("span")?.textContent)).toEqual([
      "Account info", "Sign-in", "Authorization", "Storage", "Tags", "Groups", "About",
    ]);
    expect(nav.queryByText("Users")).not.toBeInTheDocument();
    expect(nav.queryByText("AI")).not.toBeInTheDocument();
  });

  it("non-admin deep link /settings/account -> the navigation likewise has exactly seven items (same as for an admin)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    const nav = within(screen.getByRole("navigation", { name: "Settings" }));
    expect(nav.getAllByRole("link").map((a) => a.querySelector("span")?.textContent)).toEqual([
      "Account info", "Sign-in", "Authorization", "Storage", "Tags", "Groups", "About",
    ]);
    expect(nav.queryByText("Users")).not.toBeInTheDocument();
    expect(nav.queryByText("AI")).not.toBeInTheDocument();
  });

  it("#247: the left card's \"Groups\" item shows the number of groups the user belongs to on its right", async () => {
    const groups = [
      groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, adminRole()),
      groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, adminRole()),
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderAt(["/settings/about"], fetchMock);
    const nav = within(await screen.findByRole("navigation", { name: "Settings" }));
    const groupsLink = nav.getByRole("link", { name: "Groups" }); // the count is aria-hidden, so the accessible name stays "Groups"
    await waitFor(() => expect(within(groupsLink).getByText("2")).toHaveClass("text-muted-foreground"));
    // Get it again by name **after** the count appears: the accessible name is still exactly "Groups" (when the link was fetched above the count hadn't arrived).
    // A string `name` in ByRole is already an exact whole-string match (ByRoleOptions has no `exact` option), so "Groups 2" wouldn't match.
    expect(nav.getByRole("link", { name: "Groups" })).toBe(groupsLink);
    expect(within(groupsLink).getByText("2")).toHaveAttribute("aria-hidden", "true");
  });

  it("#247: while the group list is loading -> the \"Groups\" item shows no count", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return new Promise<Response>(() => {}); // never responds
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderAt(["/settings/about"], fetchMock);
    const nav = within(await screen.findByRole("navigation", { name: "Settings" }));
    const groupsLink = nav.getByRole("link", { name: "Groups" });
    expect(within(groupsLink).queryByText(/^\d+$/)).toBeNull(); // only the label, no count
  });

  it("#247: /settings -> redirects to /settings/account (mounted outside SettingsModal, inside RequireAuth)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const res = baseFetchHandlers(() => PLAIN_USER)(String(input), (init?.method ?? "GET").toUpperCase());
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderAt(["/settings"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/));
    expect(await screen.findByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("#247: opening /settings while signed out -> /login?next=%2Fsettings (the redirect is inside RequireAuth)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/auth/config") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }) }));
      }
      const res = baseFetchHandlers(() => null)(String(input), (init?.method ?? "GET").toUpperCase());
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderAt(["/settings"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/login$/));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("#247: the panel has exactly one Close and exactly one DialogTitle (= \"Settings\")", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const res = baseFetchHandlers(() => PLAIN_USER)(String(input), (init?.method ?? "GET").toUpperCase());
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderAt(["/settings/about"], fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await within(dialog).findByRole("heading", { level: 1, name: "About" });
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)).toHaveTextContent("Settings");
  });

  it("/settings/account <-> /settings/groups switching: the Dialog DOM node isn't remounted (identity unchanged)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    const dialogBefore = screen.getByRole("dialog");

    fireEvent.click(within(screen.getByRole("navigation")).getByText("Groups"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(dialogBefore);
  });

  it("clicking outside the modal doesn't close it and text already typed into an inline form remains (Esc / X closing as usual is covered by ui/dialog.test)", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderAt(["/settings/login"], fetchMock);
    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "keep-me-typed" } });
    await clickOutside();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("keep-me-typed");
  });

  it("changing the password inside the modal succeeds -> no navigation, the modal stays open, a toast appears (onSuccess=()=>toast(...))", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/auth/password" && method === "POST") {
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/login"], fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByText("Password updated.")).toBeInTheDocument());
    // No navigation: the change-password title and form of the login page are still there - if it took the forced-page `navigate("/")` branch,
    // the second tree would stop matching and unmount, and this title would disappear.
    expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("#201: a settings block chunk load failure (quota already used) -> error + retry stay inside the modal content area, the frame and navigation remain (doesn't bubble to the app-level fallback)", async () => {
    // Seed the settings quota flag = "already auto-reloaded" -> goes straight to the error screen (jsdom's location.reload
    // can't be stubbed; the auto-reload path is covered by ErrorBoundary.test).
    sessionStorage.setItem("knotebook:chunk-reload:settings", "1");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    try {
      renderAt(["/settings/authorization"], fetchMock);

      const dialog = await screen.findByRole("dialog");
      await waitFor(
        () =>
          expect(
            within(dialog).getByText(
              "Couldn't load this page — check your connection, or a new version may have been deployed.",
            ),
          ).toBeInTheDocument(),
      );
      expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(within(dialog).getByRole("link", { name: "Account info" })).toBeInTheDocument();
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    } finally {
      sessionStorage.removeItem("knotebook:chunk-reload:settings");
    }
  });

  it("legacy URL /settings/groups/:id -> /groups/:id, /roles -> /groups/:id/roles; dialog titles mounted along the way are never Settings (negative criterion)", async () => {
    const G = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    for (const [from, to] of [[`/settings/groups/${G}`, `/groups/${G}`], [`/settings/groups/${G}/roles`, `/groups/${G}/roles`]] as const) {
      const watcher = watchDialogTitles();
      try {
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const res = baseFetchHandlers(() => PLAIN_USER)(String(input), (init?.method ?? "GET").toUpperCase());
          if (res) return Promise.resolve(res);
          throw new Error(`unexpected fetch: ${String(input)}`);
        });
        renderAt([from], fetchMock);
        await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(to));
        // baseFetchHandlers returns [] for /api/groups, so the group modal shows not_found under the fallback title "Group".
        expect(await screen.findByRole("dialog", { name: "Group" })).toBeInTheDocument();
        expect([...watcher.titles]).not.toContain("Settings");
      } finally {
        watcher.stop();
        cleanup();
        vi.unstubAllGlobals();
      }
    }
  });

  it("legacy URL carrying backgroundLocation -> after redirect, closing the group modal returns to that background page (LegacyGroupRedirect forwards location.state)", async () => {
    const G = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    // The background uses a canonical URL: legacy forms like `/notes/x` get settled by NotePage into `/n/tester/my-note` (#179), so the landing wouldn't be the original string
    const bg = { pathname: "/n/tester/my-note", search: "", hash: "", state: null, key: "bg" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const res = baseFetchHandlers(() => PLAIN_USER)(String(input), (init?.method ?? "GET").toUpperCase());
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    renderAt([{ pathname: `/settings/groups/${G}`, state: { backgroundLocation: bg } }], fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Group" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/n/tester/my-note"));
  });


  /** A single-note fake server that can be renamed: a PATCH to the title recomputes the slug (auto slug), and every later single-note GET
   * (by-path, :ref, :id) returns the current version - simulating that the server's prev_slug also resolves to the same note. */
  function renameableFetch() {
    let current: NoteDto = { ...NOTE, slugIsCustom: false };
    const overrides = new Map<string, NoteDto>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const override = method === "GET" ? overrides.get(url) : undefined;
      if (override) return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(override) }));
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { title: string };
        current = { ...current, title: body.title, slug: body.title.toLowerCase().replace(/\s+/g, "-") };
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(current) }));
      }
      if (url.startsWith("/api/notes/") && !url.endsWith("/backlinks") && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(current) }));
      }
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    return {
      fetchMock,
      rename: (slug: string) => (current = { ...current, slug }),
      override: (url: string, note: NoteDto) => overrides.set(url, note),
    };
  }

  it("#179 (real AppRoutes wiring): after a rename the old slug is taken by new note B -> navigating to the old URL with PUSH lands on B (the main tree's useNavigationType reports POP, so the real one must be used)", async () => {
    const { fetchMock, override } = renameableFetch();
    renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());

    const title = screen.getByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed Note" } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-note$/));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const NOTE_B: NoteDto = { ...NOTE, id: "33333333-3333-4333-8333-333333333333", title: "Note B", slug: "my-note" };
    override("/api/notes/by-path/tester/my-note", NOTE_B);
    override(`/api/notes/${NOTE_B.id}`, NOTE_B);
    await act(async () => {
      historyNav.push?.("/n/tester/my-note");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note$/);
  });

  it("#179: open settings -> close -> change the title (URL becomes the new slug) -> back to settings (the background remembers the pre-rename URL) -> no re-resolve: collab doesn't reconnect, no by-path request, the editor doesn't remount", async () => {
    // The shape: the backgroundLocation of that back entry is the pre-rename /n/tester/my-note, which is neither
    // resolvedFor.key (already followed to the new URL) nor the current canonical - it can only be recognized through the record of "URLs this note has been through".
    const { fetchMock } = renameableFetch();
    renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    const editor = screen.getByTestId("note-editor");

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note$/));

    const title = screen.getByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed Note" } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-note$/));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    collab.noteIds.length = 0;
    const byPathCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/notes/by-path/")).length;
    const byPathBefore = byPathCalls();

    await act(async () => {
      historyNav.back?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/));
    expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(collab.noteIds.length).toBeGreaterThan(0);
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(byPathCalls()).toBe(byPathBefore);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("#179: change the title (URL becomes the new slug) -> open settings -> close -> the URL is the new slug, not rolled back to the old one; collab isn't torn down, the editor doesn't remount", async () => {
    const { fetchMock } = renameableFetch();
    renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    const editor = screen.getByTestId("note-editor");
    collab.noteIds.length = 0;

    const title = screen.getByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed Note" } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/renamed-note"));

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Regression guarded: the router location staying on the old URL, with backgroundLocation recording it, so closing the modal navigates back to /n/tester/my-note.
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-note$/);
    // Changing the URL (params) must not count as switching notes: the noteId passed to useCollab stays the same note throughout (the real useCollab
    // tears down and reconnects by noteId), and the editor is the same DOM node (not swapped for a placeholder card and remounted).
    expect(collab.noteIds.length).toBeGreaterThan(0);
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("#179: the note is renamed while the settings modal is open (the refetch brings the new slug) -> the modal isn't closed and the real URL doesn't change; after closing it returns to the new slug", async () => {
    const { fetchMock, rename } = renameableFetch();
    const queryClient = renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    const editor = screen.getByTestId("note-editor");

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    collab.noteIds.length = 0;

    rename("renamed-elsewhere");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.slug).toBe("renamed-elsewhere"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-elsewhere$/));
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("#179: renamed while the modal is open -> switch to the Groups tab -> back to Account -> no re-resolve (collab doesn't reconnect, the editor doesn't remount); after closing, lands on the new slug", async () => {
    // The shape: if the current entry's backgroundLocation were rewritten while the modal is open, the entry that back returns to would still hold the
    // old URL, the background params wouldn't match the resolvedFor.key that has already followed the new URL -> re-resolve.
    const { fetchMock, rename } = renameableFetch();
    const queryClient = renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    const editor = screen.getByTestId("note-editor");

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Groups"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/groups$/));
    collab.noteIds.length = 0;

    rename("renamed-elsewhere");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.slug).toBe("renamed-elsewhere"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      historyNav.back?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/));
    expect(screen.getByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument();
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-elsewhere$/));
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });
});
