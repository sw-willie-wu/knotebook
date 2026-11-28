import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  Route,
  Router,
  Routes,
  UNSAFE_createMemoryHistory,
  useLocation,
  useNavigate,
  useNavigationType,
  type Location,
  type NavigationType,
} from "react-router";
import * as Y from "yjs";
import {
  COLLAB_CLOSE_REVOKED,
  canonicalNotePath,
  type BacklinkDto,
  type NoteDto,
  type Role,
  type UserDto,
} from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { RealLocationContext, withCanonicalizedFrom } from "@/lib/real-location";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import * as toastModule from "@/components/ui/toast";
import { canEdit as canEditRole, type CollabState } from "@/collab/connection";
import { EDITOR_PERMS, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { invalidateNoteQueries } from "@/api/notes";
import { Awareness } from "y-protocols/awareness";
import { resetLocalPresenceFieldForTest } from "@/components/presence/local-field";
import { setRemote, userState } from "@/components/presence/test-awareness";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { findDrawerButton, findTourTarget } from "@/lib/tour-find";
import { AppShellLayout } from "@/components/AppShellLayout";
import { stubLayoutTier } from "@/test/layout-tier";

// BlockNote needs a whole set of DOM/Range APIs jsdom lacks, and mounting it in a unit test would only test the environment; this file
// verifies only that the page hands the right props to the editor, and leaves the editor itself to manual verification.
//
// The NoteEditor mock is slot-based: an older mock that only took `editable` would swallow the whole header (TitleInput / ConnectionBadge /
// share button / kebab) and the backlinks chips once slots were introduced. It now renders `headerSlot` / `footerSlot` as they are, so
// existing tests relying on queries such as `getByLabelText("Note title")` keep passing with the new structure. `SettingsModal.test.tsx` binds
// to the same mock shape (its header says it follows this file's minimal-stand-in convention), so update both together.
// Version history: the stand-in also renders `previewSlot` (wrapped in `mock-preview-slot`) and provides two driver buttons - entering a preview
// (`startPreview`) and opening the three-way apply dialog (`openDialog({ kind: "apply" })`); in the real NoteEditor these two paths are
// triggered by the panel, which sits in NoteEditor's third column and which the stand-in does not render.
const VERSION_1 = vi.hoisted(() => ({
  id: "0001aaaa-0000-4000-8000-000100010000", // = vid(1); vi.hoisted runs before imports, so vid cannot be called
  seq: 1,
  kind: "manual" as const,
  name: null,
  editors: [],
  baseSeq: null,
  base: null,
  createdAt: "2026-01-01T00:00:00.000Z",
}));
const editorMock = vi.hoisted(() => ({ scroller: null as null | ((c: unknown) => boolean), noteMaxBytes: undefined as number | undefined, precheckCtx: undefined as undefined | (() => Promise<Record<string, unknown>>), restored: 0 }));
const siteConfig = vi.hoisted(() => ({ noteMaxBytes: undefined as number | undefined, maxUploadBytes: undefined as number | undefined }));
// #297: `mock-column` uses the real `useNoteWidth(noteId)`, and the width test relies on it to verify that NotePage hands the header menu and the editor the same id.
vi.mock("@/components/NoteEditor", async () => {
  const React = await import("react");
  const { useVersions } = await import("@/lib/versions-context");
  const { useNoteWidth } = await import("@/components/note-width");
  function NoteEditorMock({
    editable,
    noteId,
    headerSlot,
    contentTopSlot,
    tagEntry,
    footerSlot,
    previewSlot,
    onCursorScroller,
    noteMaxBytes,
    precheckCtx,
    mobileToolbar,
    fabClearance,
  }: {
    mobileToolbar?: boolean;
    fabClearance?: boolean;
    editable: boolean;
    noteId: string;
    headerSlot?: ReactNode;
    contentTopSlot?: ReactNode;
    tagEntry?: {
      open: (opts?: { returnFocus?: () => void }) => void;
      applyHash?: (input: { names: string[]; restore: () => boolean }) => void;
      currentTagNames?: () => readonly string[];
    };
    footerSlot?: ReactNode;
    previewSlot?: ReactNode;
    onCursorScroller?: (s: unknown) => void;
    noteMaxBytes?: number;
    precheckCtx?: () => Promise<Record<string, unknown>>;
  }) {
    editorMock.noteMaxBytes = noteMaxBytes;
    editorMock.precheckCtx = precheckCtx;
    const versions = useVersions();
    const [width] = useNoteWidth(noteId);
    React.useEffect(() => {
      onCursorScroller?.(editorMock.scroller);
      return () => onCursorScroller?.(null);
    }, [onCursorScroller]);
    return (
      <div data-testid="note-editor" data-editable={String(editable)} data-fab-clearance={String(fabClearance === true)} data-tag-entry={String(tagEntry !== undefined)}>
        {tagEntry && (
          <button type="button" onClick={() => tagEntry.open()}>
            mock-slash-tag
          </button>
        )}
        {tagEntry?.applyHash && (
          <button type="button" onClick={() => tagEntry.applyHash?.({ names: ["Alpha"], restore: () => (editorMock.restored += 1, true) })}>
            mock-apply-hash
          </button>
        )}
        {tagEntry?.currentTagNames && <span data-testid="mock-current-tag-names">{tagEntry.currentTagNames().join("|")}</span>}
        {headerSlot}
        <div data-testid="mock-content-top">{contentTopSlot}</div>
        <div data-testid="mock-column" data-width={width} />
        <div data-testid="mock-content" contentEditable={editable} suppressContentEditableWarning tabIndex={0} />
        <button type="button" onClick={() => versions.startPreview({ seq: 1, id: VERSION_1.id, name: null })}>
          mock-start-preview
        </button>
        <button type="button" onClick={() => versions.openDialog({ kind: "apply", version: VERSION_1 })}>
          mock-open-apply
        </button>
        {previewSlot !== undefined && <div data-testid="mock-preview-slot">{previewSlot}</div>}
        {footerSlot}
        {mobileToolbar === true && (
          <div data-mobile-edit-toolbar="" data-testid="mock-mobile-toolbar">
            <button type="button">mock-toolbar-button</button>
          </div>
        )}
      </div>
    );
  }
  return { NoteEditor: NoteEditorMock };
});

/** Minimal stand-in for `provider.on("synced", ...)` / `.off(...)` / `.synced`. Most existing tests never emit and leave `synced` at the default
 * `false`, so the link-sync state machine sends no `POST .../links` there (`onSynced()` is its only submit trigger, see `link-sync.ts`). But the
 * "link-sync wiring" tests call `.emit("synced", ...)` or set `.synced` to `true` directly; the stand-in must support both, and the `mockFetch`
 * branch `POST .../links` -> 204 is the success response those tests depend on (not just a defensive branch). */
function createStubProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    synced: false,
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
    /** Calls every handler registered via `.on(event, ...)` directly - NOT by setting `synced = true` first and letting the
     * `if (provider.synced) handleSynced()` catch-up call in NotePage's mount effect run. `emit` is what really exercises whether the
     * subscription `provider.on("synced", handleSynced)` itself is wired: if that line were removed, `listeners` would hold no handler
     * and `emit` would do nothing. */
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
  };
}

// useCollab's real behaviour (HocuspocusProvider + WebSocket) does not run in jsdom; the state machine itself is fully covered by
// connection.test.ts. Here it is replaced with a return value the test can manipulate directly, to verify NotePage's reaction to each phase.
//
// Using `{fake:"doc"}` / `{fake:"provider"}` for `doc` / `provider` would make NotePage's link-sync mount effect (`doc.on("update",...)` /
// `provider.on("synced",...)`) throw a TypeError (those stand-ins have no `.on`): `doc` is a real `Y.Doc` and `provider` is the minimal
// `on` / `off` / `synced` stand-in above. Both live in this module-level `vi.hoisted` object and are rebuilt per test by `beforeEach` (see
// below) - they must NOT be created anew on every `useCollab()` call inside the mock factory: the link-sync mount effect's deps are
// `[noteId, doc, provider]`, and fresh objects each render would tear it down and resubscribe on every render, so in a real scenario the
// provider's `synced` (emitted once, on the false -> true edge) would be missed during the subscription gap.
/** Seam to intercept navigate: default `undefined` = use the real useNavigate; a test can set `navSpy.current` to a vi.fn() to hold back
 * navigation and observe where the screen stops during the renders of a resolution 404 (otherwise navigate is too fast and the
 * intermediate state cannot be asserted). Reset in afterEach. */
const navSpy = vi.hoisted(() => ({ current: undefined as ((to: unknown, opts?: unknown) => void) | undefined }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return navSpy.current ?? real;
    },
  };
});

const collab = vi.hoisted(() => ({
  state: { phase: "connecting" } as CollabState,
  onUnauthorized: undefined as (() => void) | undefined,
  doc: undefined as unknown as Y.Doc,
  provider: undefined as unknown as ReturnType<typeof createStubProvider>,
  // The noteId passed to useCollab on each render; tests clear it themselves.
  noteIds: [] as (string | undefined)[],
  onDocUpdate: undefined as (() => void) | undefined,
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({
    noteId,
    onUnauthorized,
    onDocUpdate,
  }: {
    noteId: string | undefined;
    onUnauthorized: () => void;
    onDocUpdate?: () => void;
  }) => {
    collab.noteIds.push(noteId);
    collab.onUnauthorized = onUnauthorized;
    collab.onDocUpdate = onDocUpdate;
    // issue #48: NotePage gates editable on `synced`. The real useCollab's `synced` is sticky and tracks `provider.synced`; in tests it directly
    // reflects the stub's `provider.synced` - setting it in one place feeds both editable and the link-sync mount effect.
    return {
      state: collab.state,
      doc: collab.doc,
      provider: collab.provider,
      synced: collab.provider.synced,
      syncedFor: collab.provider.synced ? (noteId ?? null) : null,
    };
  },
}));

const { default: NotePage, scheduleTerminalReconcile } = await import("./NotePage");

// Must match TERMINAL_RECONCILE_INTERVAL_MS / TERMINAL_RECONCILE_TIMEOUT_MS in NotePage.tsx; the poll-count assertions use them.
const RECONCILE_INTERVAL_MS = 750;
const RECONCILE_TIMEOUT_MS = 6_000;

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
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

function mockFetch(
  note: NoteDto | { status: number; code: string } = NOTE,
  backlinks: BacklinkDto[] = [],
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    // #103: the sidebar's (AppShell -> NoteList) `useGroups()` - without this route the mock's throw becomes a rejected query, the group
    // section gets an extra `role="alert"`, and it collides with this file's singular alert queries.
    if (url === "/api/groups" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url === "/api/favorites" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url === "/api/auth/me") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
    }
    if (url === "/api/auth/config") {
      const body = { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true, ...(siteConfig.noteMaxBytes === undefined ? {} : { noteMaxBytes: siteConfig.noteMaxBytes }), ...(siteConfig.maxUploadBytes === undefined ? {} : { maxUploadBytes: siteConfig.maxUploadBytes }) };
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) }));
    }
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    // Fetch for the backlinks collapsed section (`useBacklinks`). It must come before the `GET /api/notes/` catch-all below - `/api/notes/:id/backlinks`
    // also matches that `startsWith` check, and in the wrong order a backlinks request would be fed a NoteDto (the catch-all branch returns `note`,
    // not `{backlinks:[]}`). Most NotePage tests here do not verify backlinks content, so a fixed empty array is enough (with 0 items
    // `BacklinksSection` is hidden entirely and does not interfere with existing assertions); the layout tests pass a non-empty array.
    // Version history: list (panel `limit=50`, re-fetch before apply `limit=1`), snapshot, apply. Same requirement: before the
    // `GET /api/notes/` catch-all. The snapshot's `AAA=` is `Y.encodeStateAsUpdate(new Y.Doc())` (an empty doc).
    const versionsBase = `/api/notes/${encodeURIComponent(NOTE.id)}/versions`;
    const versionCurrent = { baseSeq: 1, base: { id: VERSION_1.id, name: null, deleted: false }, dirty: false, nextSeq: 2, autoEnabled: true };
    if ((url === `${versionsBase}?limit=50` || url === `${versionsBase}?limit=1`) && method === "GET") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ versions: [VERSION_1], current: versionCurrent, nextBefore: null }),
        }),
      );
    }
    if (url === `${versionsBase}/1` && method === "GET") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ id: VERSION_1.id, seq: 1, ydoc: "AAA=" }) }),
      );
    }
    if (url === `${versionsBase}/1/apply` && method === "POST") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ current: versionCurrent }) }),
      );
    }
    if (url === versionsBase && method === "POST") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ ...VERSION_1, id: "0002aaaa-0000-4000-8000-000200020000", seq: 2, upgraded: false }),
        }),
      );
    }
    if (url.endsWith("/backlinks") && method === "GET") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks }) }),
      );
    }
    if (url.startsWith("/api/notes/") && method === "GET") {
      if ("status" in note) {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: note.status,
            json: () => Promise.resolve({ error: { code: note.code, message: "x" } }),
          }),
        );
      }
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(note) }));
    }
    // The link-sync submit endpoint. The "link-sync wiring" tests emit "synced" (or set `collab.provider.synced` to `true`) to trigger a real
    // submit, and this is the success response (204) they depend on - not a defensive branch kept in reserve.
    if (url.endsWith("/links") && method === "POST") {
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function ActiveProbe() {
  const { activeNoteId } = useActiveNote();
  return <div data-testid="active-probe">{activeNoteId ?? "none"}</div>;
}

/** Simulates NoteList's optimistic set: seeds `id` into the context on mount (the source of a leftover).
 * `id` is optional and the component is always mounted - the provider's children shape must stay stable between render and rerender (a
 * shifted child makes React remount the whole NotePage and zeroes in-page state such as previousRoleRef, which made the role-downgrade
 * rerender cases fail falsely). */
function SeedActive({ id }: { id?: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    if (id !== undefined) setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

/** The router's location. Convergence goes through navigate and MemoryRouter does not touch window.location, so the router location is the source of truth for the URL. */
function RouterPathProbe() {
  const location = useLocation();
  return (
    <div data-testid="router-path" data-key={location.key}>
      {location.pathname}
    </div>
  );
}

function GoToOther() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/notes/other-note")}>
      go-b
    </button>
  );
}

function routerPath(): string | null {
  return screen.getByTestId("router-path").textContent;
}

/** Shared by renderNotePage and the rerender cases so the tree shape stays stable; it also mounts the /n/ and /g/ routes, or NotePage would be unmounted after convergence. */
function NotePageTree({ seedActiveId }: { seedActiveId?: string }) {
  return (
    <ActiveNoteProvider>
      <SeedActive id={seedActiveId} />
      <ActiveProbe />
      <RouterPathProbe />
      <Routes>
        <Route element={<AppShellLayout />}>
          <Route path="/notes/:ref" element={<NotePage />} />
          <Route path="/n/:handle/:slug" element={<NotePage />} />
          <Route path="/g/:groupId/:slug" element={<NotePage />} />
          <Route path="/" element={<div>home landing</div>} />
        </Route>
      </Routes>
    </ActiveNoteProvider>
  );
}

function renderNotePage(ref: string, options: { seedActiveId?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/notes/${ref}`]}>
          <NotePageTree seedActiveId={options.seedActiveId} />
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

// `sidebar.tab` leaks into later cases of the same file (the cases that write it come later in the file), so clear it at file top level.
afterEach(() => localStorage.removeItem("sidebar.tab"));

describe("NotePage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    // The previous case's NotePage callbacks stay on the hoisted object; without clearing, "wait until the callback shows up" would immediately get the old page's one.
    collab.onUnauthorized = undefined;
    siteConfig.noteMaxBytes = undefined;
    siteConfig.maxUploadBytes = undefined;
    editorMock.noteMaxBytes = undefined;
    editorMock.precheckCtx = undefined;
    window.history.replaceState(null, "", "/");
    // The toast store is module-level; without resetting it the previous test's toast stays on screen.
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
    siteConfig.maxUploadBytes = undefined;
  });

  describe("the pre-upload check handed to the editor", () => {
    /** `mockFetch` plus the usage routes and a groups list; returns the URLs requested after `since()` is called. */
    function stubWithUsage(note: NoteDto, groups: unknown[] = []) {
      const base = mockFetch(note);
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          urls.push(url);
          if (url === "/api/storage" || url === "/api/groups/g1/storage") return Promise.resolve(Response.json({ usedBytes: 300, quotaBytes: 1000 }));
          if (url === "/api/groups") return Promise.resolve(Response.json(groups));
          return base(input, init);
        }),
      );
      return { since: () => urls.splice(0) };
    }

    async function providerAfterOpen() {
      collab.provider.synced = true;
      renderNotePage("my-note");
      await waitFor(() => expect(editorMock.precheckCtx).toBeDefined());
    }

    it("the owner's personal note: the configured limits and the personal space's room", async () => {
      siteConfig.maxUploadBytes = 654_321;
      const fetches = stubWithUsage(NOTE);
      await providerAfterOpen();
      fetches.since();
      await expect(editorMock.precheckCtx!()).resolves.toMatchObject({ maxUploadBytes: 654_321, roomBytes: 700 });
      expect(fetches.since()).toEqual(["/api/auth/config", "/api/storage"]);
    });

    it("someone else's personal note (shared with an editor): no usage request, room unknown", async () => {
      const fetches = stubWithUsage({ ...NOTE, role: "editor", ownerId: "u2", permissions: EDITOR_PERMS });
      await providerAfterOpen();
      fetches.since();
      await expect(editorMock.precheckCtx!()).resolves.toMatchObject({ roomBytes: undefined });
      expect(fetches.since()).toEqual(["/api/auth/config"]);
    });

    it.each([
      [true, ["/api/auth/config", "/api/groups/g1/storage"], 700],
      [false, ["/api/auth/config"], undefined],
    ])("a group note, managing the group %s: usage only for managers", async (canManageGroup, requested, room) => {
      const fetches = stubWithUsage(
        { ...NOTE, ownerId: null, ownerHandle: null, role: "editor", groupId: "g1", group: { id: "g1", name: "G" }, permissions: EDITOR_PERMS },
        [{ id: "g1", name: "G", canManageGroup }],
      );
      await providerAfterOpen();
      // The group list arrives after the note; the provider follows it.
      await waitFor(async () => {
        fetches.since();
        await expect(editorMock.precheckCtx!()).resolves.toMatchObject({ roomBytes: room });
        expect(fetches.since()).toEqual(requested);
      });
    });
  });

  it("opening with an old-form uuid ref: resolves the note, replaces the URL with the new canonical form, mounts the editor", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true; // normal open path: only after sync is there an editable title input (issue #48)
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);

    renderNotePage(NOTE.id);

    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(screen.getByLabelText("Note title")).toHaveValue("My Note");
    // #122: canonical is the single `/n/<ownerHandle>/<slug>` form - an old-form link arriving converges the URL to the new form.
    // #179: convergence goes through router navigate (no longer window.history.replaceState).
    await waitFor(() => expect(routerPath()).toBe(canonicalNotePath(NOTE)));
    expect(routerPath()).toBe("/n/tester/my-note");
  });

  it("issue #48: a connection that has never synced (cannot connect on open) -> read-only even if the REST role is owner", async () => {
    // Before the first sync the local Y.Doc is empty - being "editable" would mean typing into a blank-looking but normal note and losing
    // it on refresh. It must be read-only regardless of how high the REST role is.
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = false;

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    // But the title stays editable (#48): the title goes through REST last-write-wins, not Yjs, so changing the title is entirely safe when
    // co-editing cannot connect but REST works. Locking it together with synced would be a regression.
    expect(screen.getByLabelText("Note title")).toBeInTheDocument();
  });

  describe("note size limit (front-end check)", () => {
    afterEach(() => {
      siteConfig.noteMaxBytes = undefined;
    });
    it("the configured noteMaxBytes (GET /api/auth/config) is handed to the editor (for checks on paste, drop and in-site AI apply)", async () => {
      siteConfig.noteMaxBytes = 123_456;
      vi.stubGlobal("fetch", mockFetch());
      collab.provider.synced = true;
      renderNotePage("my-note");
      await waitFor(() => expect(editorMock.noteMaxBytes).toBe(123_456));
    });

    it("a note over the limit: opening (after sync) shows a notice that does not block editing; it disappears after content is deleted and the throttle time passes; it reappears when it grows past the limit again", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        collab.doc.getText("t").insert(0, "x".repeat(2_000));
        siteConfig.noteMaxBytes = Y.encodeStateAsUpdate(collab.doc).byteLength - 100;
        vi.stubGlobal("fetch", mockFetch());
        collab.provider.synced = true;
        renderNotePage("my-note");
        const notice = "This note is over the size limit; editing may be slow. Delete content to shrink it.";
        expect(await screen.findByText(notice)).toBeInTheDocument();
        await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true")); // editing is not blocked
        act(() => collab.doc.getText("t").delete(0, 1_500));
        expect(screen.getByText(notice), "節流：還沒重算").toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_100);
        });
        expect(screen.queryByText(notice)).toBeNull();
        act(() => collab.doc.getText("t").insert(0, "y".repeat(3_000)));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_100);
        });
        expect(screen.getByText(notice)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("within the limit, or no limit configured, or not synced yet: not shown", async () => {
      collab.doc.getText("t").insert(0, "x".repeat(2_000));
      siteConfig.noteMaxBytes = Y.encodeStateAsUpdate(collab.doc).byteLength + 1_000;
      vi.stubGlobal("fetch", mockFetch());
      collab.provider.synced = true;
      const first = renderNotePage("my-note");
      await waitFor(() => expect(editorMock.noteMaxBytes).toBe(siteConfig.noteMaxBytes));
      expect(screen.queryByText(/over the size limit/)).toBeNull();
      first.unmount();
      siteConfig.noteMaxBytes = 10;
      collab.provider.synced = false;
      renderNotePage("my-note");
      await waitFor(() => expect(editorMock.noteMaxBytes).toBe(10));
      expect(screen.queryByText(/over the size limit/), "還沒同步").toBeNull();
    });
  });

  it("issue #48: editable after syncing once (owner)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));
  });

  it("wiring: after the owner mounts, the provider fires the synced event -> really calls POST /api/notes/:id/links (verifies the provider.on('synced', ...) mount wiring itself, not only link-sync's internal state machine)", async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderNotePage("my-note");
    // Do not look at editable (that needs synced, and this case tests precisely the "emit synced event" path; setting provider.synced=true
    // first would take the getter catch-up call, not the event itself).
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());

    // Use `emit` to call the handler registered through `.on("synced", ...)` directly - this path does not go through the `provider.synced`
    // getter catch-up call (see the `createStubProvider` comment), and specifically exercises the `provider.on("synced", handleSynced)`
    // subscription line in NotePage's mount effect.
    collab.provider.emit("synced", { state: true });

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/notes/${NOTE.id}/links`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("getter catch-up: provider already synced before the effect mounts => submits once more without an event", async () => {
    // After the mount effect subscribes `provider.on("synced", ...)` it immediately checks `if (provider.synced) handleSynced()` - this
    // catch-up call is for the edge case where "the effect mounts after the provider has long since synced" (StrictMode remount, or just a
    // step slower): the false -> true edge event was already emitted and will not come again. Deliberately NO event is emitted here; only
    // the `synced` state is set to `true`, so NotePage can submit only through this catch-up wiring - if that line were removed, the POST would never arrive.
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    collab.provider.synced = true;

    renderNotePage("my-note");

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/notes/${NOTE.id}/links`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("start condition: viewer fixture (canEdit false) => no start() => no submit even when the synced event fires", async () => {
    const fetchSpy = mockFetch({ ...NOTE, role: "viewer" });
    vi.stubGlobal("fetch", fetchSpy);

    renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));

    collab.provider.emit("synced", { state: true });
    // link-sync's `onSynced()` is a fully synchronous no-op when `!started` (see link-sync.ts); waiting one more round of
    // microtask/macrotask here is just being conservative so no async branch is missed.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchSpy).not.toHaveBeenCalledWith(`/api/notes/${NOTE.id}/links`, expect.anything());
  });

  it("connected with role viewer -> editor read-only, title becomes plain text", async () => {
    vi.stubGlobal("fetch", mockFetch({ ...NOTE, role: "viewer" }));
    collab.state = { phase: "connected", role: "viewer" };

    collab.provider.synced = true; // #335: for a viewer the badge switches to "Read-only" only when connected and synced
    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    // Scoped to `container.querySelector("header")`: a bare `queryByLabelText(...).not.toBeInTheDocument()` passes vacuously under the new
    // mock even if headerSlot is not rendered at all; scoping to the header and asserting both "heading present" and "textbox absent"
    // ties the check to the same container.
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("heading", { name: "My Note" })).toBeInTheDocument();
    expect(within(header!).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  // #115: the header returns to full card width (left / right aligned) - the single-level header is itself the content row, the title hugs
  // the left and the controls the right, and `px-5` (20px) lines up with the `<md` body's left edge. #88's "content row wrapped in the
  // article column" was deliberately removed by this redesign (the reverse scan lives in article-column.guard.test.ts (d): NotePage must no
  // longer import the article-column constant).
  it("#115: single-level header at full card width (px-5, no longer in the article column)", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(header).toHaveClass("flex", "items-center", "gap-3", "border-b", "border-border", "px-5", "py-3");
    expect(header).toContainElement(screen.getByLabelText("Note title"));
    // #115: first in the header is the `xl:hidden` sidebar button (the entry to the floating sidebar - the note page has no NarrowTopBar,
    // so this button is the only entry).
    expect(header).toContainElement(screen.getByRole("button", { name: "Open sidebar" }));
  });

  it("phone (< 640): first in the header is 'Back to notes', no 'Open sidebar' (the drawer is unreachable on phone)", async () => {
    stubLayoutTier("phone");
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = document.querySelector("header") as HTMLElement;
    expect(header.querySelector("button")).toBe(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.queryByRole("button", { name: "Open sidebar" })).toBeNull();
  });

  describe("phone header, two rows (title + location subtitle)", () => {
    function setupPhone() {
      resetLocalPresenceFieldForTest();
      const awareness = new Awareness(new Y.Doc());
      onTestFinished(() => awareness.destroy());
      collab.state = { phase: "connected", role: "owner" };
      collab.provider = Object.assign(createStubProvider(), { awareness });
      setRemote(awareness, 10, userState("u2", "Bea"));
      stubLayoutTier("phone");
      vi.stubGlobal("fetch", mockFetch({ ...NOTE, lastEdited: { at: "2026-02-03T04:05:06.000Z", byHandle: "alice", agentLabel: null } }));
    }

    it("first row: back, title, star, share, kebab; no width button; second row: connection dot, location, who is online, last edited", async () => {
      setupPhone();
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");

      const header = document.querySelector("header") as HTMLElement;
      const top = within(header).getByTestId("note-header-title-row");
      const sub = within(header).getByTestId("note-header-subline");
      // The title and the line under it (connection dot, location, online users) are one block; the back arrow and the right-hand action buttons are its siblings, and the row aligns with items-center to the vertical center of that block.
      const block = within(top).getByTestId("note-header-block");
      expect(top).toHaveClass("items-center");
      expect(block.parentElement).toBe(top);
      expect(block).toHaveClass("flex", "flex-col", "min-w-0", "flex-1");
      expect(block.children[0]).toBe(within(top).getByLabelText("Note title"));
      expect(block.children[1]).toBe(sub);
      expect(top.children[0]).toBe(within(top).getByRole("button", { name: "Back to notes" }));
      // The notch inset is given by NoteEditor's header slot (the banner sits below it too), so the header itself keeps a 12px top padding.
      expect(header).toHaveClass("pt-3");
      expect(header.className).not.toContain("safe-area-inset");
      expect(within(top).getByRole("button", { name: "Back to notes" })).toBeInTheDocument();
      expect(within(top).getByRole("button", { name: "Favorite" })).toBeInTheDocument();
      expect(within(top).getByRole("button", { name: "Share" })).toBeInTheDocument();
      expect(within(top).getByRole("button", { name: "More" })).toBeInTheDocument();
      expect(within(header).queryByRole("button", { name: /^Width/ })).toBeNull();

      expect(top).toContainElement(sub);
      expect(within(sub).getByRole("status")).toBeInTheDocument();
      const location = within(sub).getByRole("button", { name: "Show in list: My notes" });
      expect(await within(sub).findByRole("group", { name: "Also viewing this note" })).toBeInTheDocument();
      expect(within(sub).getByTestId("last-edited")).toBeInTheDocument();
      const order = [location, within(sub).getByRole("status"), within(sub).getByRole("group", { name: "Also viewing this note" }), within(sub).getByTestId("last-edited")];
      for (let i = 0; i < order.length - 1; i++) {
        expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it("connection state and online users appear once on the whole page (not one copy hidden by CSS)", async () => {
      setupPhone();
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");
      await screen.findByRole("group", { name: "Also viewing this note" });

      const header = document.querySelector("header") as HTMLElement;
      expect(within(header).getAllByRole("status")).toHaveLength(1);
      expect(within(header).getAllByRole("group", { name: "Also viewing this note" })).toHaveLength(1);
      expect(within(header).getAllByTestId("last-edited")).toHaveLength(1);
    });

    it("location button tap height: the subtitle row has vertical padding, and together with the title row it adds up to >= 44 (class assertion, jsdom has no layout)", async () => {
      setupPhone();
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");

      expect(screen.getByRole("button", { name: /^Show in list/ })).toHaveClass("py-2");
      expect(screen.getByLabelText("Note title")).toHaveClass("text-xl");
    });

    it("fixed tier: keeps the single-row header, no subtitle row and no location button", async () => {
      vi.stubGlobal("fetch", mockFetch());
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");

      const header = document.querySelector("header") as HTMLElement;
      expect(within(header).queryByTestId("note-header-subline")).toBeNull();
      expect(within(header).queryByTestId("note-header-title-row")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Show in list/ })).toBeNull();
    });

    it("floating tier: also keeps the single-row header", async () => {
      stubLayoutTier("overlay");
      vi.stubGlobal("fetch", mockFetch());
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");

      expect(document.querySelector("header [data-testid='note-header-subline']")).toBeNull();
      expect(screen.queryByRole("button", { name: /^Show in list/ })).toBeNull();
    });
  });

  describe("phone bottom browse bar", () => {
    const BAR = "note-browse-bar";

    async function renderEditable(note: NoteDto = NOTE, role: "owner" | "viewer" = "owner") {
      stubLayoutTier("phone");
      collab.state = { phase: "connected", role };
      collab.provider.synced = true;
      vi.stubGlobal("fetch", mockFetch(note));
      const view = renderNotePage("my-note");
      await screen.findByTestId("note-editor");
      await screen.findByTestId(BAR);
      return view;
    }

    it("editable: focus enters the editing area -> the browse bar disappears; focus on the header title -> it comes back", async () => {
      await renderEditable();
      expect(within(screen.getByTestId(BAR)).getByRole("button", { name: "New note" })).toBeInTheDocument();
      act(() => screen.getByTestId("mock-content").focus());
      expect(screen.queryByTestId(BAR)).toBeNull();
      act(() => screen.getByLabelText("Note title").focus());
      expect(screen.getByTestId(BAR)).toBeInTheDocument();
    });

    it("focus moves to the editing toolbar (blur carries relatedTarget): still counts as editing, the browse bar does not flash back", async () => {
      await renderEditable();
      const content = screen.getByTestId("mock-content");
      act(() => content.focus());
      expect(screen.queryByTestId(BAR)).toBeNull();
      const toolbar = document.createElement("div");
      toolbar.setAttribute("data-mobile-edit-toolbar", "");
      document.body.appendChild(toolbar);
      onTestFinished(() => toolbar.remove());
      fireEvent.blur(content, { relatedTarget: toolbar });
      expect(screen.queryByTestId(BAR)).toBeNull();
      // Focus really leaves for elsewhere: it comes back.
      fireEvent.blur(content, { relatedTarget: screen.getByLabelText("Note title") });
      expect(screen.getByTestId(BAR)).toBeInTheDocument();
    });

    it("bottom space (fabClearance) moves with the floating button: present when not editing; absent when focus is in the editing area; present again on returning to the title", async () => {
      await renderEditable();
      const editor = () => screen.getByTestId("note-editor");
      expect(editor()).toHaveAttribute("data-fab-clearance", "true");
      act(() => screen.getByTestId("mock-content").focus());
      expect(editor()).toHaveAttribute("data-fab-clearance", "false");
      act(() => screen.getByLabelText("Note title").focus());
      expect(editor()).toHaveAttribute("data-fab-clearance", "true");
    });

    it("editable: focus enters the editing area -> the editing toolbar appears; focus on the header title -> it disappears", async () => {
      await renderEditable();
      expect(screen.queryByTestId("mock-mobile-toolbar")).toBeNull();
      act(() => screen.getByTestId("mock-content").focus());
      expect(screen.getByTestId("mock-mobile-toolbar")).toBeInTheDocument();
      act(() => screen.getByLabelText("Note title").focus());
      expect(screen.queryByTestId("mock-mobile-toolbar")).toBeNull();
    });

    it("focus on a toolbar button: the toolbar stays and the browse bar does not flash back", async () => {
      await renderEditable();
      act(() => screen.getByTestId("mock-content").focus());
      act(() => screen.getByRole("button", { name: "mock-toolbar-button" }).focus());
      expect(screen.getByTestId("mock-mobile-toolbar")).toBeInTheDocument();
      expect(screen.queryByTestId(BAR)).toBeNull();
    });

    it("downgraded to read-only while focus is on a toolbar button: the editing toolbar does not stay (not rendered even if the flag is still set)", async () => {
      const { rerender, queryClient } = await renderEditable();
      act(() => screen.getByTestId("mock-content").focus());
      act(() => screen.getByRole("button", { name: "mock-toolbar-button" }).focus());
      expect(screen.getByTestId("mock-mobile-toolbar")).toBeInTheDocument();
      collab.state = { phase: "connected", role: "viewer" };
      rerender(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/notes/my-note"]}>
              <NotePageTree />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
      expect(screen.queryByTestId("mock-mobile-toolbar")).toBeNull();
    });

    it("read-only: tapping the body shows no editing toolbar", async () => {
      await renderEditable({ ...NOTE, role: "viewer", ownerId: "u2", permissions: VIEWER_PERMS }, "viewer");
      act(() => screen.getByTestId("mock-content").focus());
      expect(screen.queryByTestId("mock-mobile-toolbar")).toBeNull();
    });

    it.each(["overlay", "docked"] as const)("%s: focusing the editing area shows no editing toolbar", async (tier) => {
      stubLayoutTier(tier);
      collab.state = { phase: "connected", role: "owner" };
      collab.provider.synced = true;
      vi.stubGlobal("fetch", mockFetch());
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");
      act(() => screen.getByTestId("mock-content").focus());
      expect(screen.queryByTestId("mock-mobile-toolbar")).toBeNull();
    });

    it("editing area unmounted while focus is still inside (tapping a link to switch notes): the new screen's browse bar is not hidden by the old editing flag", async () => {
      stubLayoutTier("phone");
      collab.state = { phase: "connected", role: "owner" };
      collab.provider.synced = true;
      vi.stubGlobal("fetch", mockFetch());
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/notes/my-note"]}>
              <GoToOther />
              <NotePageTree />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
      await screen.findByTestId(BAR);
      act(() => screen.getByTestId("mock-content").focus());
      expect(screen.queryByTestId(BAR)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "go-b" }));
      await waitFor(() => expect(routerPath()).not.toBe("/notes/my-note"));
      expect(await screen.findByTestId(BAR)).toBeInTheDocument();
    });

    it("downgraded to read-only while editing (focus flag still set): the browse bar comes back", async () => {
      const { rerender, queryClient } = await renderEditable();
      act(() => screen.getByTestId("mock-content").focus());
      expect(screen.queryByTestId(BAR)).toBeNull();
      collab.state = { phase: "connected", role: "viewer" };
      rerender(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter initialEntries={["/notes/my-note"]}>
              <NotePageTree />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
      expect(screen.getByTestId(BAR)).toBeInTheDocument();
    });

    it("read-only: tapping the body keeps the browse bar, there is no 'New note', search is still there", async () => {
      await renderEditable({ ...NOTE, role: "viewer", ownerId: "u2", permissions: VIEWER_PERMS }, "viewer");
      act(() => screen.getByTestId("mock-content").focus());
      fireEvent.focus(screen.getByTestId("mock-content"));
      expect(screen.getByTestId(BAR)).toBeInTheDocument();
      expect(within(screen.getByTestId(BAR)).queryByRole("button", { name: "New note" })).toBeNull();
      expect(within(screen.getByTestId(BAR)).getByRole("button", { name: "Search notes" })).toBeInTheDocument();
    });

    it("before the first sync completes (not editable yet): browse bar, not editing state", async () => {
      stubLayoutTier("phone");
      collab.state = { phase: "connected", role: "owner" };
      collab.provider.synced = false;
      vi.stubGlobal("fetch", mockFetch());
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");
      fireEvent.focus(screen.getByTestId("mock-content"));
      expect(screen.getByTestId(BAR)).toBeInTheDocument();
    });

    it.each(["overlay", "docked"] as const)("%s: no browse bar", async (tier) => {
      stubLayoutTier(tier);
      vi.stubGlobal("fetch", mockFetch());
      renderNotePage("my-note");
      await screen.findByTestId("note-editor");
      expect(screen.queryByTestId(BAR)).toBeNull();
    });
  });

  it("floating tier (640-1279): the header has 'Open sidebar' and no 'Back to notes'", async () => {
    stubLayoutTier("overlay");
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    expect(within(document.querySelector("header") as HTMLElement).getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull();
  });

  // A class assertion, not a behaviour assertion: jsdom has no layout. The header shrink order (title yields down to 64px -> label
  // truncates -> the rest do not shrink) is the combination of TitleInput min-w-16, LastEditedLabel truncate, and Share / kebab shrink-0.
  it("header shrink contract (class assertion, jsdom has no layout): title min-w-16, Share and kebab shrink-0", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    expect(screen.getByLabelText("Note title")).toHaveClass("min-w-16");
    expect(screen.getByRole("button", { name: "Share" })).toHaveClass("shrink-0");
    expect(screen.getByRole("button", { name: "More" })).toHaveClass("shrink-0");
  });

  it("the feature tour finds the header's hamburger button, Share and kebab through data-kb-tour-target", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = within(document.querySelector("header")!);
    expect(findDrawerButton()).toBe(header.getByRole("button", { name: "Open sidebar" }));
    expect(findTourTarget("share")).toBe(header.getByRole("button", { name: "Share" }));
    expect(findTourTarget("noteMenu")).toBe(header.getByRole("button", { name: "More" }));
  });

  it("owner: the header is an @container; the width button comes after Share and before the kebab", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = document.querySelector("header")!;
    expect(header).toHaveClass("@container");
    const width = within(header).getByRole("button", { name: /^Width/ });
    const share = within(header).getByRole("button", { name: "Share" });
    const more = within(header).getByRole("button", { name: "More" });
    expect(share.compareDocumentPosition(width) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(width.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the header kebab has 'Width' (the width can be changed at any viewport width; the header button is hidden at narrow widths)", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    fireEvent.pointerDown(within(document.querySelector("header")!).getByRole("button", { name: "More" }), { button: 0 });
    expect(await screen.findByRole("menuitem", { name: "Width" })).toBeInTheDocument();
  });

  it("header gap collapses to gap-2 at phone width (a container query cannot apply to the header's own gap)", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    expect(document.querySelector("header")).toHaveClass("gap-3", "max-sm:gap-2");
  });

  it("header child order: nav button, title, connection, online users, last edited, star, share, width, kebab", async () => {
    resetLocalPresenceFieldForTest();
    const awareness = new Awareness(new Y.Doc());
    onTestFinished(() => awareness.destroy());
    collab.state = { phase: "connected", role: "owner" };
    collab.provider = Object.assign(createStubProvider(), { awareness });
    setRemote(awareness, 10, userState("u2", "Bea"));
    vi.stubGlobal("fetch", mockFetch({ ...NOTE, lastEdited: { at: "2026-02-03T04:05:06.000Z", byHandle: "alice", agentLabel: null } }));

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = document.querySelector("header")!;
    const order = [
      within(header).getByRole("button", { name: "Open sidebar" }),
      within(header).getByLabelText("Note title"),
      within(header).getByRole("status"),
      await within(header).findByRole("group", { name: "Also viewing this note" }),
      within(header).getByTestId("last-edited"),
      within(header).getByRole("button", { name: "Favorite" }),
      within(header).getByRole("button", { name: "Share" }),
      within(header).getByRole("button", { name: /^Width/ }),
      within(header).getByRole("button", { name: "More" }),
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("the header has the favorites star, positioned before Share (#334)", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = document.querySelector("header")!;
    const star = within(header).getByRole("button", { name: "Favorite" });
    const share = within(header).getByRole("button", { name: "Share" });
    expect(star.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(star).toHaveAttribute("aria-pressed", "false");
  });

  it("viewer: the header also has the width button (a personal reading preference)", async () => {
    vi.stubGlobal("fetch", mockFetch({ ...NOTE, role: "viewer" }));
    collab.state = { phase: "connected", role: "viewer" };

    renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));

    expect(within(document.querySelector("header")!).getByRole("button", { name: /^Width/ })).toBeInTheDocument();
  });

  it("downgrade: connected(owner) -> connected(viewer) toasts and switches to read-only", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    collab.provider.synced = true;

    const { rerender, queryClient } = renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));

    collab.state = { phase: "connected", role: "viewer" };
    rerender(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}><NotePageTree /></MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    await waitFor(() =>
      expect(screen.getByText("Your access changed to viewer. This note is now read-only.")).toBeInTheDocument(),
    );
  });

  it("role changing to 'none' (the first half of the revoke flow) does not report 'changed to viewer' - that would contradict the revoke notice that follows", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "editor" };
    collab.provider.synced = true;

    const { rerender, queryClient } = renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));

    collab.state = { phase: "connected", role: "none" };
    rerender(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}><NotePageTree /></MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    expect(screen.queryByText("Your access changed to viewer. This note is now read-only.")).not.toBeInTheDocument();
  });

  it("kicked terminal state -> toast 'lost access' and back to /", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "kicked" };

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("You no longer have access to this note.")).toBeInTheDocument();
    // The revoke close reason constant itself is provided by shared; the client only recognizes the reason string (code hardcoded as 1000).
    expect(COLLAB_CLOSE_REVOKED).toBe("knotebook:revoked");
  });

  it("deleted terminal state -> toast and back to /", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "deleted" };

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This note has been deleted.")).toBeInTheDocument();
  });

  it("#269 outdated: no navigation, no toast; banner appears; editor and title read-only", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;
    collab.state = { phase: "outdated" };

    renderNotePage("my-note");

    expect(await screen.findByRole("alert")).toHaveTextContent("Knotebook has been updated");
    expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false");
    // Read-only title = plain text (same assertion shape as the "connected with role viewer" case: scoped to header, heading present, textbox absent).
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("heading", { name: "My Note" })).toBeInTheDocument();
    expect(within(header!).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
  });

  it("first resolution 404 -> linkInvalid text (must not reuse 'note deleted') and back to /", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    renderNotePage("gone");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
  });

  it("after a successful resolution, set active (the final correction point - opening directly from a URL / bookmark lights it too; an optimistic wrong set is corrected here)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;

    // Seed a wrong id (simulating an optimistic wrong set) - after a successful resolution it must be corrected to the real one.
    renderNotePage(NOTE.id, { seedActiveId: "99999999-9999-4999-8999-999999999999" });

    // First confirm the wrong set is really present (not an idle run where everything was right all along), then assert the correction.
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent("99999999"));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id));
  });

  it("real wiring clears on unmount: closing the page turns it off (current === own -> clear); another page setting first -> not cleared by mistake (conditional clear)", async () => {
    // The race case in active-note.test guards a replica of the page - this pins the same two semantics onto the real NotePage.
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const OTHER_ID = "22222222-2222-4222-8222-222222222222";
    const tree = (withPage: boolean, seedActiveId?: string) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/notes/${NOTE.id}`]}>
            <ActiveNoteProvider>
              <SeedActive id={seedActiveId} />
              <ActiveProbe />
              {withPage ? (
                <Routes>
                  <Route element={<AppShellLayout />}>
                    <Route path="/notes/:ref" element={<NotePage />} />
                    {/* #179: the convergence effect uses router navigate to replace the old form with the new /n/ form */}
                    <Route path="/n/:handle/:slug" element={<NotePage />} />
                    <Route path="/" element={<div>home landing</div>} />
                  </Route>
                </Routes>
              ) : (
                <div />
              )}
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    );

    const view = render(tree(true));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id));

    view.rerender(tree(false));
    expect(screen.getByTestId("active-probe")).toHaveTextContent("none");

    // Race not cleared by mistake: after the page is reopened and lit, another page (simulating NoteList's optimistic set) sets another id
    // first, then this page unmounts - its cleanup carries the old id while current is already someone else's, so it must not turn off the highlight that was just lit.
    view.rerender(tree(true));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id));
    view.rerender(tree(true, OTHER_ID));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(OTHER_ID));
    view.rerender(tree(false, OTHER_ID));
    expect(screen.getByTestId("active-probe")).toHaveTextContent(OTHER_ID);
  });

  it("clearing optimistic leftovers before navigating away on a resolution 404: the id NoteList set on click does not stay stuck in the sidebar", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    // SeedActive simulates NoteList's optimistic set: a note was clicked and then its resolution failed. NotePage never set this id
    // successfully, so the conditional clear on unmount cannot match by id - only setActiveNoteId(null) on the 404 exit can clear the
    // leftover (removing that line turns this case red).
    renderNotePage("gone", { seedActiveId: "99999999-9999-4999-8999-999999999999" });
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent("99999999"));

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent("none"));
  });

  const NOTE_B: NoteDto = {
    ...NOTE,
    id: "33333333-3333-4333-8333-333333333333",
    title: "Note B",
    slug: "note-b",
  };

  /** `bPending` holds B's resolution (the window before the resolution response); `killRef(ref)` makes a ref 404 afterwards and `failRef(ref)` makes it 500;
   * `setRef(ref, note)` makes a ref resolve to that note (e.g. an old slug taken over by a new note). The shares / public-link / PATCH handlers exist so the
   * real ShareDialog can run the whole persist path. */
  function stubTwoNotes(options: { bPending?: boolean } = {}) {
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => (releaseB = resolve));
    const byRef = new Map<string, NoteDto>([
      [NOTE.id, NOTE],
      ["my-note", NOTE],
      [NOTE_B.id, NOTE_B],
      ["note-b", NOTE_B],
    ]);
    const failRefs = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      if (url === "/api/auth/me") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) });
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      if (url.endsWith("/backlinks") && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) });
      }
      if (url.endsWith("/shares") && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      if (url.endsWith("/public-link") && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null }) });
      }
      if (url.startsWith("/api/notes/by-path/") && method === "GET") {
        // #122 new-form resolution endpoint: /api/notes/by-path/<handle>/<slug>. Fidelity note: the real server JOINs users + notes.slug (a
        // uuid sent to by-path does not match), while this looks up byRef directly (including id keys) - no case depends on that
        // difference now, so do not write one that does.
        const [handle, pathSlug] = url
          .slice("/api/notes/by-path/".length)
          .split("/")
          .map((seg) => decodeURIComponent(seg));
        const hit = handle === NOTE.ownerHandle ? byRef.get(pathSlug) : undefined;
        if (hit?.id === NOTE_B.id && options.bPending) await bGate;
        if (!hit) {
          return fakeResponse({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }),
          });
        }
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(hit) });
      }
      if (url.startsWith("/api/notes/") && method === "PATCH") {
        const id = decodeURIComponent(url.slice("/api/notes/".length));
        const base = id === NOTE_B.id ? NOTE_B : NOTE;
        const body = JSON.parse(String(init?.body)) as { title?: string; slug?: string | null };
        const updated: NoteDto = {
          ...base,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.slug !== undefined
            ? body.slug === null
              ? { slug: "auto-recomputed", slugIsCustom: false }
              : { slug: body.slug, slugIsCustom: true }
            : {}),
        };
        // Write back into the stub state: useUpdateNote.onSuccess invalidates the id key and triggers a persistent-layer refetch - if the stub
        // did not sync, the refetch would bring back the old DTO, and whether the case is green would hinge on the microtask ordering of
        // setQueryData vs refetch (fragile and unlike the real server).
        byRef.set(updated.id, updated);
        byRef.set(updated.slug, updated);
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) });
      }
      if (url.startsWith("/api/notes/") && method === "GET") {
        const ref = decodeURIComponent(url.slice("/api/notes/".length));
        if (failRefs.has(ref)) {
          return fakeResponse({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
          });
        }
        const hit = byRef.get(ref);
        if (hit?.id === NOTE_B.id && options.bPending) await bGate;
        if (!hit) {
          return fakeResponse({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }),
          });
        }
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(hit) });
      }
      if (url.endsWith("/links") && method === "POST") {
        return fakeResponse({ ok: true, status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      releaseB: () => releaseB(),
      killRef: (ref: string) => byRef.delete(ref),
      failRef: (ref: string) => failRefs.add(ref),
      setRef: (ref: string, note: NoteDto) => byRef.set(ref, note),
    };
  }

  function NavToB() {
    const nav = useNavigate();
    return (
      <>
        <button type="button" onClick={() => void nav("/notes/note-b")}>
          go-b
        </button>
        <button type="button" onClick={() => void nav("/n/tester/note-b")}>
          go-b-new
        </button>
        <button type="button" onClick={() => void nav("/n/tester/my-note")}>
          go-my-note
        </button>
      </>
    );
  }

  function renderTwoNoteTree(initialEntry = "/notes/my-note") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <ActiveNoteProvider>
              <SeedActive id={undefined} />
              <ActiveProbe />
              <RouterPathProbe />
              <NavToB />
              <Routes>
                <Route element={<AppShellLayout />}>
                  <Route path="/notes/:ref" element={<NotePage />} />
                  <Route path="/n/:handle/:slug" element={<NotePage />} />
                  <Route path="/" element={<div>home landing</div>} />
                </Route>
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  it("after a title change, invalidating everything -> the page survives and does not trigger the deleted exit (the id key never goes stale)", async () => {
    const { fetchMock, killRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    // Simulates the old slug key being dead after a title change (the server has recomputed the auto slug): under the old architecture, a
    // focus / invalidate refetch of ['note', 'my-note'] would 404 and be treated as "note deleted", kicking the user to the home page - exactly the disease id anchoring cures.
    killRef("my-note");
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id);
    // Mechanism pinned directly: after the invalidate, no GET is sent for the old slug key again - the resolution query is disabled and
    // the persistent layer uses the id key; also pins that an empty ref `/api/notes/` is not requested.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u === "/api/notes/my-note")).toHaveLength(1);
    expect(urls).not.toContain("/api/notes/");
  });

  it("same-pattern real navigation (clicking another note in the sidebar) -> the content switches to the new note and the URL converges to the new canonical", async () => {
    stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    fireEvent.click(screen.getByRole("button", { name: "go-b" }));

    // Assert the content (the title input's value), not the highlight: under the same pattern a params change only re-renders without
    // remounting, so the resolution mechanism must react to the params change or the content stays stuck on the old note.
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/note-b"));
    expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE_B.id);
  });

  it("cross-pattern real navigation (old-form page -> /n/ new form) -> content switches to the new note, URL / highlight in sync", async () => {
    stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    fireEvent.click(screen.getByRole("button", { name: "go-b-new" }));

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/note-b"));
    // Highlight deferred: only the final state "active follows the new note" is asserted - the conditional clear's discrimination is
    // covered by the "real wiring clears on unmount" case above.
    expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE_B.id);
  });

  it("#297: each note remembers its own: A set to full width via the header -> B is standard -> back to A is still full width; the body column (mock-column) follows the header", async () => {
    const widthKeys = () => Object.keys(localStorage).filter((k) => k.startsWith("note.width."));
    for (const key of widthKeys()) localStorage.removeItem(key);
    try {
      stubTwoNotes();
      collab.provider.synced = true;

      renderTwoNoteTree();
      await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
      expect(screen.getByTestId("mock-column")).toHaveAttribute("data-width", "standard");

      fireEvent.click(screen.getByRole("button", { name: /^Width/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Width/ }));
      expect(screen.getByRole("button", { name: /^Width/ })).toHaveAccessibleName("Width: Full width — click for Standard");
      expect(screen.getByTestId("mock-column")).toHaveAttribute("data-width", "full");

      fireEvent.click(screen.getByRole("button", { name: "go-b-new" }));
      await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
      expect(screen.getByRole("button", { name: /^Width/ })).toHaveAccessibleName("Width: Standard — click for Wide");
      expect(screen.getByTestId("mock-column")).toHaveAttribute("data-width", "standard");

      fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));
      await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
      expect(screen.getByRole("button", { name: /^Width/ })).toHaveAccessibleName("Width: Full width — click for Standard");
      expect(screen.getByTestId("mock-column")).toHaveAttribute("data-width", "full");

      expect(widthKeys()).toEqual([`note.width.${NOTE.id}`]);
      expect(localStorage.getItem(`note.width.${NOTE.id}`)).toBe("full");
    } finally {
      for (const key of widthKeys()) localStorage.removeItem(key);
    }
  });

  it("between new-form pages (/n/ -> /n/, same pattern) -> content and URL both switch to the new note", async () => {
    // The useNoteByPath query key must include the handle and the slug - if the slug segment is dropped, at the instant of navigation
    // resolveQuery.data is the previous note's DTO, seeding writes {key: new, id: old}, the page stays stuck on A forever and the URL is converged back to A.
    stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    fireEvent.click(screen.getByRole("button", { name: "go-b-new" }));

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/note-b"));
  });

  it("new-form by-path 404 -> linkInvalid exit (the new branch of the two-form split)", async () => {
    stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree("/n/tester/never-here");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
  });

  it("opening with the /n/ new form: resolution goes through useNoteByPath (by-path endpoint, not the old-form ref) and the URL converges to canonical", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("/api/notes/by-path/tester/my-note");
    expect(urls).not.toContain("/api/notes/my-note");
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));
  });

  it("after navigating to B and before the resolution response, the screen has no A title or editable editor (loading placeholder); convergence gate: a cache update of the old note does not write the URL", async () => {
    const { releaseB } = stubTwoNotes({ bPending: true });
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));

    fireEvent.click(screen.getByRole("button", { name: "go-b" }));

    // Transition: the old note's NoteEditor/TitleInput must not render (loading placeholder card).
    await waitFor(() => expect(screen.queryByTestId("note-editor")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument();

    // Convergence gate: while a re-resolution is in flight, an update to the old note's (A) persistent layer (e.g. its refetch bringing
    // back a new slug) must not move the URL away - the needsResolve gate must stop it.
    // Must flush a **macrotask**: react-query notifications are scheduled as macrotasks, so a synchronous act assertion would land before
    // the re-render and pass vacuously (it would pass even with the gate removed and the URL really moved away).
    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug: "moved-away" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(routerPath()).not.toBe("/n/tester/moved-away");
    // #179: the router URL is B's old-form URL just navigated to (after convergence goes through navigate, the router and the address bar agree); it stays put during the transition.
    expect(routerPath()).toBe("/notes/note-b");

    releaseB();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/note-b"));
  });

  it("an open tag input does not carry over to the next note, nor reappear when coming back", async () => {
    stubTwoNotes();
    collab.provider.synced = true;
    renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    fireEvent.click(await screen.findByRole("button", { name: "mock-slash-tag" }));
    await screen.findByRole("combobox", { name: "Tag name" });

    fireEvent.click(screen.getByRole("button", { name: "go-b" }));
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    expect(screen.queryByRole("combobox", { name: "Tag name" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    expect(screen.queryByRole("combobox", { name: "Tag name" })).toBeNull();
  });

  it("persistent-layer 404 = real deletion -> note.deleted text and back to / (must not fall into linkInvalid - what the needsResolve precondition guards)", async () => {
    // Opening by uuid: the resolution layer and persistent layer share one cache entry (["note", <id>]) - a real-deletion 404 also makes
    // resolveQuery.isError true, and without the needsResolve precondition linkInvalid would show the wrong text. This case guards both the
    // existence of the noteGone exit and that precondition.
    const { killRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree(`/notes/${NOTE.id}`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    killRef(NOTE.id);
    killRef("my-note");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This note has been deleted.")).toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-probe")).toHaveTextContent("none");
  });

  it("slug change (cache write-back) -> the convergence effect updates the URL (positive side)", async () => {
    // This case guards that the convergence effect is **driven by data changes** (it turns red if `note` is missing from the deps). The UI
    // entry for an internal custom URL (ShareDialog's SlugField) has been removed - a slug change
    // can now only come from title re-derivation (#145) or other write paths, so setQueryData is used here to simulate "the persistent-layer
    // note got a new slug", the same technique as the transition case above (`queryClient.setQueryData(["note", ...])`).
    stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));

    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug: "renamed" });
    });

    await waitFor(() => expect(routerPath()).toBe("/n/tester/renamed"));
  });

  it("#179: renaming changes the URL through the router (params change) without re-resolving - co-editing is not torn down, the editor is not remounted; the same for two consecutive renames", async () => {
    // After the convergence effect goes through `navigate`, params change; if that were treated as a real navigation, `noteId` would
    // become undefined in the transition render (the real useCollab tears down and reconnects on noteId), NoteEditor would be swapped for the
    // placeholder and remounted, and the new slug would 404 on this fake server's by-path -> linkInvalid back to the home page. The second
    // rename guards `resolvedFor.key` keeping up: in the render where data changed first and the URL second, params are neither the old key
    // nor the new canonical.
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));
    const editor = screen.getByTestId("note-editor");
    const byPathCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/notes/by-path/")).length;
    const byPathBefore = byPathCalls();
    collab.noteIds.length = 0;

    for (const slug of ["renamed-once", "renamed-twice"]) {
      await act(async () => {
        queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => expect(routerPath()).toBe(`/n/tester/${slug}`));
    }

    expect(collab.noteIds.length).toBeGreaterThan(0);
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
    expect(byPathCalls()).toBe(byPathBefore);
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
  });

  it("#179: with the sidebar drawer open, renaming changes the URL -> the drawer stays; really switching to another note -> the drawer closes", async () => {
    // AppShell closes the drawer when pathname changes: after the convergence effect goes through router navigate, a URL change on the same
    // note changes pathname too - the convergence marker (canonicalizedFrom = the previous pathname) tells them apart.
    stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));

    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    await screen.findByRole("dialog", { name: "Navigation" });

    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug: "renamed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(routerPath()).toBe("/n/tester/renamed"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    // Positive control: a real navigation to another note still closes the drawer (the drawer is modal, the test button outside is aria-hidden and its accessible name counts as an empty string - query by text instead).
    fireEvent.click(screen.getByText("go-b-new"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/note-b"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("#179: after A is renamed its old slug is taken by new note B - clicking a link (PUSH) to the old URL must re-resolve and land on B, and must not stay on A just because 'A visited this URL'", async () => {
    // Old slugs are not kept (uniqueness holds only on the current (owner_id, slug)). knownKeys may only be adopted on back / forward (POP).
    const { setRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));

    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug: "renamed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(routerPath()).toBe("/n/tester/renamed"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    setRef("my-note", { ...NOTE_B, slug: "my-note" });
    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    expect(routerPath()).toBe("/n/tester/my-note");
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE_B.id));
  });

  it("#179: after A is renamed, clicking a link to the dead old URL -> linkInvalid back to the home page, and the persistent-layer ['note', A] is not overwritten by the resolution layer's stale cache back to its pre-rename state", async () => {
    // When the resolution layer's refetch for the old slug 404s, react-query keeps the old data (A before the rename); if seed wrote it as is, the persistent layer would roll back.
    const { killRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));

    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, title: "Renamed", slug: "renamed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(routerPath()).toBe("/n/tester/renamed"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    killRef("my-note"); // the old slug can no longer be resolved
    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
    const resident = queryClient.getQueryData<NoteDto>(["note", NOTE.id]);
    expect(resident?.slug).toBe("renamed");
    expect(resident?.title).toBe("Renamed");
  });

  it("#179: the same (location.key, canonical) pair writes the URL once - when navigate takes no effect, it does not replace again on every rerun", async () => {
    stubTwoNotes();
    collab.provider.synced = true;
    const navCalls: unknown[] = [];
    const pathOf = (to: unknown) => (typeof to === "string" ? to : (to as { pathname?: string }).pathname);
    navSpy.current = (to) => void navCalls.push(to); // hold back navigation: the router location stays at /notes/my-note

    const queryClient = renderTwoNoteTree("/notes/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(navCalls.map(pathOf)).toContain("/n/tester/my-note"));

    // The persistent-layer note gets a new object (slug unchanged, only the title changed - an equal-valued object would be structurally
    // shared into the same reference by react-query and the effect would not rerun) -> the convergence effect reruns twice.
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        queryClient.setQueryData(["note", NOTE.id], { ...NOTE, title: `My Note ${i}` });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(navCalls.filter((to) => pathOf(to) === "/n/tester/my-note")).toHaveLength(1);
  });

  // Note-switch gap: BrowserRouter wraps setState in startTransition, so history changes first and the screen later.

  /** A router that can be held back: while held, history changes entries as usual but the router location does not follow - reproducing the gap before a transition commits. */
  function renderHeldTree(
    initialEntry: string | { pathname: string; state: unknown },
    earlierEntries: { pathname: string; state: unknown }[] = [],
  ) {
    const history = UNSAFE_createMemoryHistory({
      initialEntries: [...earlierEntries, initialEntry],
      initialIndex: earlierEntries.length,
      v5Compat: true,
    });
    const gate = { held: false, commit: undefined as (() => void) | undefined };
    function HeldRouter({ children }: { children: ReactNode }) {
      const [state, setState] = useState<{ action: NavigationType; location: Location }>({
        action: history.action,
        location: history.location,
      });
      useLayoutEffect(() => {
        gate.commit = () => setState({ action: history.action, location: history.location });
        return history.listen(() => {
          if (!gate.held) gate.commit?.();
        });
      }, []);
      return (
        <Router location={state.location} navigationType={state.action} navigator={history}>
          {children}
        </Router>
      );
    }
    /** Follows AppRoutes in App.tsx: the real location goes into RealLocationContext and the main tree takes backgroundLocation (the settings modal). */
    function AppRoutesLike() {
      const location = useLocation();
      const navigationType = useNavigationType();
      const real = useMemo(() => ({ location, navigationType }), [location, navigationType]);
      const background = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
      return (
        <RealLocationContext.Provider value={real}>
          <Routes location={background ?? location}>
            <Route element={<AppShellLayout />}>
              <Route path="/notes/:ref" element={<NotePage />} />
              <Route path="/n/:handle/:slug" element={<NotePage />} />
              <Route path="/" element={<div>home landing</div>} />
            </Route>
          </Routes>
        </RealLocationContext.Provider>
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <HeldRouter>
            <ActiveNoteProvider>
              <RouterPathProbe />
              <NavToB />
              <AppRoutesLike />
            </ActiveNoteProvider>
          </HeldRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return {
      history,
      queryClient,
      hold: () => void (gate.held = true),
      release: () => {
        gate.held = false;
        act(() => gate.commit?.());
      },
    };
  }

  const titlePatches = (fetchMock: ReturnType<typeof stubTwoNotes>["fetchMock"]) =>
    fetchMock.mock.calls
      .filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "PATCH")
      .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as unknown }));

  const flushMacrotask = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("note-switch gap: the URL has moved to B while the screen is still A - typing in A's title field and blur must not PATCH A", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    const nav = renderHeldTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    nav.hold();
    fireEvent.click(screen.getByRole("button", { name: "go-b-new" }));
    expect(nav.history.location.pathname).toBe("/n/tester/note-b");
    const input = screen.getByLabelText("Note title");
    expect(input).toHaveValue("My Note"); // gap: the old page is still mounted and interactive

    fireEvent.change(input, { target: { value: "Typed in the gap" } });
    fireEvent.blur(input);
    await flushMacrotask();
    expect(titlePatches(fetchMock)).toEqual([]);

    nav.release();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    expect(titlePatches(fetchMock)).toEqual([]);
  });

  it("note-switch gap: going back to another note (that entry was left by convergence and carries the convergence marker) also counts as a switch, and must not PATCH A", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    const nav = renderHeldTree("/n/tester/my-note", [
      { pathname: "/n/tester/note-b", state: withCanonicalizedFrom(null, "/notes/note-b") },
    ]);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    nav.hold();
    act(() => nav.history.go(-1));
    expect(nav.history.location.pathname).toBe("/n/tester/note-b");

    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Typed in the gap" } });
    fireEvent.blur(input);
    await flushMacrotask();
    expect(titlePatches(fetchMock)).toEqual([]);
    nav.release();
  });

  it("note-switch gap: back to another note's entry whose convergence marker happens to equal the current URL (the old URL reused by another note) is not let through either", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    const nav = renderHeldTree("/n/tester/my-note", [
      { pathname: "/n/tester/note-b", state: withCanonicalizedFrom(null, "/n/tester/my-note") },
    ]);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    nav.hold();
    act(() => nav.history.go(-1));

    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Typed in the gap" } });
    fireEvent.blur(input);
    await flushMacrotask();
    expect(titlePatches(fetchMock)).toEqual([]);
    nav.release();
  });

  it("note-switch gap: a REPLACE to another note whose state carries a convergence marker for another URL (e.g. reusing the old state) also counts as a switch", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    const nav = renderHeldTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    nav.hold();
    act(() => nav.history.replace("/n/tester/note-b", withCanonicalizedFrom(null, "/notes/note-b")));

    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Typed in the gap" } });
    fireEvent.blur(input);
    await flushMacrotask();
    expect(titlePatches(fetchMock)).toEqual([]);
    nav.release();
  });

  it("counter-example of the gap: with the settings modal open (the main tree takes the background location) and no navigation in flight, the background page's title saves as usual", async () => {
    // The baseline must be the real location: comparing against the background location, the key and the pathname both differ from history's current, and it would be misjudged as a note switch.
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    renderHeldTree({
      pathname: "/settings/profile",
      state: { backgroundLocation: { pathname: "/n/tester/my-note", search: "", hash: "", state: null, key: "bg" } },
    });
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Behind the modal" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(titlePatches(fetchMock)).toEqual([{ url: `/api/notes/${NOTE.id}`, body: { title: "Behind the modal" } }]),
    );
  });

  it("counter-example of the gap: while the same note's convergence changes the URL after a rename (transition not committed), typing + blur continues to save into the same note", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    const nav = renderHeldTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    nav.hold();
    await act(async () => {
      nav.queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug: "renamed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The convergence effect has already replaced (history changed) while the router still sits on the old URL.
    expect(nav.history.location.pathname).toBe("/n/tester/renamed");
    expect(routerPath()).toBe("/n/tester/my-note");

    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Keep typing" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(titlePatches(fetchMock)).toEqual([{ url: `/api/notes/${NOTE.id}`, body: { title: "Keep typing" } }]),
    );
    nav.release();
  });

  it("counter-example of the gap: while a navigation that only changes the hash (paragraph anchor) of the same note is in flight, typing + blur saves as usual", async () => {
    const { fetchMock } = stubTwoNotes();
    collab.provider.synced = true;
    const nav = renderHeldTree("/n/tester/my-note");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    nav.hold();
    act(() => nav.history.push("/n/tester/my-note#some-block"));

    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Same note" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(titlePatches(fetchMock)).toEqual([{ url: `/api/notes/${NOTE.id}`, body: { title: "Same note" } }]),
    );
    nav.release();
  });

  it("persistent-layer non-404 error (500) -> the error card stays on the page, no navigation, no 404 text", async () => {
    const { failRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree(`/notes/${NOTE.id}`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    failRef(NOTE.id);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
  });

  it("the render of a resolution 404 lands on the loading placeholder (not the error card); the exit relies on navigate only", async () => {
    // Hold back navigate so the intermediate state is observable (otherwise navigation is too fast to assert this stage).
    const nav = vi.fn();
    navSpy.current = nav;
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    renderNotePage("gone");

    await waitFor(() => expect(nav).toHaveBeenCalledWith("/", { replace: true }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
  });

  it("a non-404 load error stays on the page showing a message, no navigation", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 500, code: "internal" }));

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    const card = screen.getByRole("alert").parentElement;
    expect(card).toHaveClass("min-w-0", "flex-1", "overflow-y-auto", "rounded-xl", "border", "border-border", "bg-card");
    // #115: the placeholder card also needs the narrow-viewport drawer entry - isError is a state that **halts** (note deleted, no
    // permission), and without this button a `<md` user would have zero navigation exits on the error screen.
    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
  });

  // The note itself loaded, but `doc|provider|user` are not all ready yet (here `user` is stuck: `/api/auth/me` behind `useSession()` is
  // deliberately delayed) - what renders is the placeholder card without header / footer slots, not `NoteEditor`.
  it("while doc/provider/user are not ready, renders a placeholder card without the header, not NoteEditor", async () => {
    let resolveMe!: () => void;
    const meGate = new Promise<void>((resolve) => {
      resolveMe = resolve;
    });
    const base = mockFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/auth/me") {
          return meGate.then(() => base(input, init));
        }
        return base(input, init);
      }),
    );

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
    expect(screen.queryByTestId("note-editor")).not.toBeInTheDocument();
    expect(document.querySelector("header")).toBeNull();
    const card = screen.getByText("Loading…").parentElement;
    expect(card).toHaveClass("min-w-0", "flex-1", "overflow-y-auto", "rounded-xl", "border", "border-border", "bg-card");
    expect(card).toHaveClass("max-sm:rounded-none", "max-sm:border-0", "max-sm:pb-[env(safe-area-inset-bottom)]");

    resolveMe();
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(document.querySelector("header")).not.toBeNull();
  });

  it("the token 401 sign-out callback clears ['me'] and navigates to /login", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route element={<AppShellLayout />}>
                  <Route path="/notes/:ref" element={<NotePage />} />
                  {/* #179: the convergence effect uses router navigate to replace the old form with the new /n/ form */}
                  <Route path="/n/:handle/:slug" element={<NotePage />} />
                  <Route path="/login" element={<div>login page</div>} />
                </Route>
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(collab.onUnauthorized).toBeTypeOf("function"));
    collab.onUnauthorized!();

    // Assert navigation only: right after `['me']` is set with setQueryData(null) there is an invalidate, and the fake server still returns a
    // user, so the cache is immediately refilled - that is normal behaviour and not something to assert.
    await waitFor(() => expect(screen.getByText("login page")).toBeInTheDocument());
  });

  // NoteEditor is now called in slot form - the NotePage body renders `<div className="flex min-h-0 flex-1"><NoteEditor .../></div>`
  // directly, so the direct parent of the `NoteEditor` (mock) container is this body row, no longer the old self-scrolling
  // `overflow-y-auto` container (scrolling is left entirely to NoteEditor's internals / each card's own `overflow-y-auto`, see
  // `NoteEditor.tsx` / `AppShell.tsx`).
  it("the NoteEditor container exists and its parent is the slot-based body row (flex min-h-0 flex-1), not the old self-scrolling container", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");

    const editor = await screen.findByTestId("note-editor");
    const bodyRow = editor.parentElement;
    expect(bodyRow).not.toBeNull();
    expect(bodyRow).toHaveClass("flex", "min-h-0", "flex-1");
    expect(bodyRow).not.toHaveClass("overflow-y-auto");
  });

  // Backlinks went from a collapsible `<details>` to always-visible chips, and NotePage no longer wraps them in an extra container -
  // `footerSlot` is the `<BacklinksSection>` itself, with the geometry (shrink-0 / border-t / scroll cap) entirely inside that component
  // (covered in BacklinksSection.test.tsx). Here only the slot wiring is verified: the content of footerSlot (the chip links) really
  // appears inside the note-editor container rendered by the mock, so the slot is not left unconnected.
  it("footerSlot (backlinks chips) really is wired into NoteEditor, not a slot left unconnected", async () => {
    const backlink: BacklinkDto = { id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other", ownerHandle: "tester", groupId: null };
    vi.stubGlobal("fetch", mockFetch(NOTE, [backlink]));

    renderNotePage("my-note");

    const editor = await screen.findByTestId("note-editor");
    await waitFor(() => expect(within(editor).getByRole("link", { name: "Other" })).toBeInTheDocument());
    expect(within(editor).getByText("Mentioned in 1 note")).toBeInTheDocument();
    expect(editor.querySelector("details")).toBeNull();
  });
});

// #175: `/g/:groupId/:slug` (NotePage's third form). A group note has no personal owner; canonical is `/g/<groupId>/<slug>`; resolution
// goes through `GET /api/notes/by-group-path/:groupId/:slug` (`useNoteByGroupPath`), not by-path and not `:ref`.
describe("NotePage x /g/ group notes (#175)", () => {
  const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const G_NOTE: NoteDto = {
    ...NOTE,
    id: "44444444-4444-4444-8444-444444444444",
    title: "Group Note",
    slug: "group-note",
    slugIsCustom: false,
    ownerId: null,
    ownerHandle: null,
    role: "editor",
    groupId: GROUP_ID,
    group: { id: GROUP_ID, name: "Workshop A" },
    permissions: { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
  };
  const G_NOTE_2: NoteDto = { ...G_NOTE, id: "55555555-5555-4555-8555-555555555555", title: "Group Note 2", slug: "group-note-2" };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.provider.synced = true;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
  });

  /** by-group-path looks up `<groupId>/<slug>`; `aliases` simulates the redirect table (old slug -> current note); by-path only knows `legacyByPath`;
   * `GET /api/notes/:id` looks up by id. Every call is recorded in `calls`: assert which endpoint was hit from `calls`, because `api()` turns a throw into a rejected query. */
  function stubGroupNotes(
    options: { aliases?: Record<string, NoteDto>; legacyByPath?: Record<string, NoteDto> } = {},
  ) {
    const calls: string[] = [];
    const byId = new Map<string, NoteDto>([
      [G_NOTE.id, G_NOTE],
      [G_NOTE_2.id, G_NOTE_2],
    ]);
    const bySlug = new Map<string, NoteDto>([
      [G_NOTE.slug, G_NOTE],
      [G_NOTE_2.slug, G_NOTE_2],
      ...Object.entries(options.aliases ?? {}),
    ]);
    const notFound = () =>
      fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }) });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push(`${method} ${url}`);
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url.endsWith("/backlinks") && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) }));
        }
        if (url.startsWith("/api/notes/by-group-path/") && method === "GET") {
          const [groupId, slug] = url
            .slice("/api/notes/by-group-path/".length)
            .split("/")
            .map((seg) => decodeURIComponent(seg));
          const hit = groupId === GROUP_ID ? bySlug.get(slug) : undefined;
          return Promise.resolve(hit ? fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(hit) }) : notFound());
        }
        if (url.startsWith("/api/notes/by-path/") && method === "GET") {
          const key = url.slice("/api/notes/by-path/".length);
          const hit = options.legacyByPath?.[key];
          return Promise.resolve(hit ? fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(hit) }) : notFound());
        }
        if (url.startsWith("/api/notes/") && method === "GET") {
          const hit = byId.get(decodeURIComponent(url.slice("/api/notes/".length)));
          return Promise.resolve(hit ? fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(hit) }) : notFound());
        }
        if (url.endsWith("/links") && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return { calls };
  }

  function NavToGroupNote2() {
    const nav = useNavigate();
    return (
      <button type="button" onClick={() => void nav(`/g/${GROUP_ID}/group-note-2`)}>
        go-g2
      </button>
    );
  }

  function renderGroupTree(initialEntry: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <ActiveNoteProvider>
              <RouterPathProbe />
              <NavToGroupNote2 />
              <Routes>
                <Route element={<AppShellLayout />}>
                  <Route path="/notes/:ref" element={<NotePage />} />
                  <Route path="/n/:handle/:slug" element={<NotePage />} />
                  <Route path="/g/:groupId/:slug" element={<NotePage />} />
                  <Route path="/" element={<div>home landing</div>} />
                </Route>
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  it("opening via /g/: resolution hits by-group-path (not by-path, not :ref), seeds ['note', id], the URL stays canonical", async () => {
    const { calls } = stubGroupNotes();
    window.history.replaceState(null, "", `/g/${GROUP_ID}/group-note`);

    const queryClient = renderGroupTree(`/g/${GROUP_ID}/group-note`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Group Note"));

    const gets = calls.filter((c) => c.startsWith("GET /api/notes/"));
    expect(gets).toContain(`GET /api/notes/by-group-path/${GROUP_ID}/group-note`);
    expect(gets.some((c) => c.startsWith("GET /api/notes/by-path/"))).toBe(false);
    expect(gets).not.toContain("GET /api/notes/group-note");
    expect(queryClient.getQueryData<NoteDto>(["note", G_NOTE.id])?.id).toBe(G_NOTE.id);
    expect(routerPath()).toBe(`/g/${GROUP_ID}/group-note`);
    expect(canonicalNotePath(G_NOTE)).toBe(`/g/${GROUP_ID}/group-note`);
  });

  it("by-group-path returns a slug different from the URL (redirect table / prev_slug hit) -> the convergence effect replaces to /g/<gid>/<new slug>", async () => {
    stubGroupNotes({ aliases: { "old-group-note": G_NOTE } });
    window.history.replaceState(null, "", `/g/${GROUP_ID}/old-group-note`);

    renderGroupTree(`/g/${GROUP_ID}/old-group-note`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Group Note"));
    await waitFor(() => expect(routerPath()).toBe(`/g/${GROUP_ID}/group-note`));
  });

  it("/n/<h>/<old> hits by-path and returns a group note (migration redirect) -> replace to /g/<gid>/<slug>", async () => {
    const { calls } = stubGroupNotes({ legacyByPath: { "tester/old-personal": G_NOTE } });
    window.history.replaceState(null, "", "/n/tester/old-personal");

    renderGroupTree("/n/tester/old-personal");
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Group Note"));
    await waitFor(() => expect(routerPath()).toBe(`/g/${GROUP_ID}/group-note`));
    expect(calls).toContain("GET /api/notes/by-path/tester/old-personal");
    expect(calls.some((c) => c.startsWith("GET /api/notes/by-group-path/"))).toBe(false);
  });

  it("/g/ -> /g/ same-pattern navigation -> content and URL both switch to the new note (the resolution layer's data must belong to the current params)", async () => {
    stubGroupNotes();
    window.history.replaceState(null, "", `/g/${GROUP_ID}/group-note`);

    renderGroupTree(`/g/${GROUP_ID}/group-note`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Group Note"));

    fireEvent.click(screen.getByRole("button", { name: "go-g2" }));

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Group Note 2"));
    await waitFor(() => expect(routerPath()).toBe(`/g/${GROUP_ID}/group-note-2`));
  });

  it("#182: after revalidation a group note's role changes but access remains (editor -> viewer) -> re-fetches ['groups'] (the sidebar '+' looks at myRole)", async () => {
    const { calls } = stubGroupNotes();
    collab.state = { phase: "connected", role: "editor" };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/g/${GROUP_ID}/group-note`]}>
            <ActiveNoteProvider>
              <Routes>
                <Route element={<AppShellLayout />}>
                  <Route path="/g/:groupId/:slug" element={<NotePage />} />
                </Route>
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const count = (call: string) => calls.filter((c) => c === call).length;
    // The sidebar "+" looks at ['groups']; the header kebab / share look at the permissions of ['note', id]; the sidebar note row kebab looks at the permissions of ['notes'].
    const watched = ["GET /api/groups", `GET /api/notes/${G_NOTE.id}`, "GET /api/notes"];

    const view = render(tree());
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));
    await waitFor(() => expect(count("GET /api/groups")).toBeGreaterThan(0));
    // Let every request of the initial load land, so any later increment can only come from the role change.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const before = watched.map(count);

    collab.state = { phase: "connected", role: "viewer" };
    view.rerender(tree());

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    await waitFor(() => expect(watched.map(count)).toEqual(before.map((n) => n + 1)));
  });

  // Note switch: previousRoleRef must not compare across notes.
  // NotePage does not remount when switching notes (same component instance), and the old ref kept the previous note's role. This
  // simulates the real useCollab timing:
  // (1) in the first few renders after the switch the state is still the previous note's leftover connected (the real hook only sets
  //   state(INITIAL) in the new noteId's connection effect), and noteId is already the new one - judging "switched" by noteId alone cannot block this;
  // (2) the new note's connection effect brings in a new provider and resets to connecting; (3) the new note connects.
  // Each case ends with a **real** role change inside the new note as a positive control: the same observation technique (wait a
  // macrotask, count requests, find the toast) can see it when it should happen - proving that the earlier "did not happen" assertions are not because it cannot be observed at all.
  const DOWNGRADE_TOAST = "Your access changed to viewer. This note is now read-only.";
  const RESTORE_TOAST = "Your edit access has been restored.";

  async function switchNoteScenario(from: Role, to: Role) {
    const { calls } = stubGroupNotes();
    collab.state = { phase: "connected", role: from };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/g/${GROUP_ID}/group-note`]}>
            <ActiveNoteProvider>
              <NavToGroupNote2 />
              <Routes>
                <Route element={<AppShellLayout />}>
                  <Route path="/g/:groupId/:slug" element={<NotePage />} />
                </Route>
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const count = (call: string) => calls.filter((c) => c === call).length;
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    const titleShown = (title: string) =>
      expect(screen.queryByRole("heading", { name: title }) ?? screen.getByLabelText("Note title")).toSatisfy(
        (el: HTMLElement) => el.textContent === title || (el as HTMLInputElement).value === title,
      );

    const view = render(tree());
    await waitFor(() => titleShown("Group Note"));
    await waitFor(() => expect(count("GET /api/groups")).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // (1) Switch notes: collab.state is deliberately left alone (the previous note's connected leftover) and the provider is still the old one.
    // At this moment the real hook (the switch passes through noteId=undefined, cleanup already did setSession(null)) gives provider=null;
    // the test keeping the old provider is the stricter scenario (a leftover connected paired with a provider that still looks valid).
    collab.noteIds = [];
    fireEvent.click(screen.getByRole("button", { name: "go-g2" }));
    await waitFor(() => expect(collab.noteIds).toContain(G_NOTE_2.id));
    await waitFor(() => titleShown("Group Note 2"));
    await settle();
    // (2) The new note's connection: a new provider, reset.
    collab.provider = createStubProvider();
    collab.provider.synced = true;
    collab.state = { phase: "connecting" };
    view.rerender(tree());
    await settle();
    // Switching notes itself refetches (the new note's note / backlinks, etc.): take the baseline before the new note becomes connected and after everything has landed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const groupsBefore = count("GET /api/groups");
    // (3) The new note becomes connected: the first time it only records and does not compare.
    collab.state = { phase: "connected", role: to };
    view.rerender(tree());
    await waitFor(() =>
      expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", canEditRole(to) ? "true" : "false"),
    );
    await settle();
    await settle();

    return { view, tree, count, settle, groupsBefore };
  }

  it("switching notes: editable note -> view-only note shows no 'changed to viewer' toast and does not invalidate ['groups']; a real recovery inside the new note is still reported", async () => {
    const { view, tree, count, settle, groupsBefore } = await switchNoteScenario("editor", "viewer");

    expect(screen.queryByText(DOWNGRADE_TOAST)).not.toBeInTheDocument();
    expect(count("GET /api/groups")).toBe(groupsBefore);

    // Positive control: viewer -> editor inside the new note is a real role change - both the toast and the ['groups'] invalidation must appear.
    collab.state = { phase: "connected", role: "editor" };
    view.rerender(tree());
    await settle();
    await waitFor(() => expect(screen.getByText(RESTORE_TOAST)).toBeInTheDocument());
    await waitFor(() => expect(count("GET /api/groups")).toBe(groupsBefore + 1));
  });

  it("switching notes: view-only note -> editable note shows no 'edit access restored' toast; a real downgrade inside the new note is still reported", async () => {
    const { view, tree, count, settle, groupsBefore } = await switchNoteScenario("viewer", "editor");

    expect(screen.queryByText(RESTORE_TOAST)).not.toBeInTheDocument();
    expect(count("GET /api/groups")).toBe(groupsBefore);

    // Positive control (also the regression for "editor -> viewer within the same note is still reported as a downgrade").
    collab.state = { phase: "connected", role: "viewer" };
    view.rerender(tree());
    await settle();
    await waitFor(() => expect(screen.getByText(DOWNGRADE_TOAST)).toBeInTheDocument());
    await waitFor(() => expect(count("GET /api/groups")).toBe(groupsBefore + 1));
  });

  it("by-group-path 404 -> linkInvalid exit and back to /", async () => {
    stubGroupNotes();
    renderGroupTree(`/g/${GROUP_ID}/never-here`);

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
  });

  it("invalidateNoteQueries: a group note invalidates ['note-by-group-path', groupId, slug] and does not touch ['note-by-path', ...]; a personal note is the reverse", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["note", G_NOTE.id], G_NOTE);
    queryClient.setQueryData(["note-by-group-path", GROUP_ID, G_NOTE.slug], G_NOTE);
    queryClient.setQueryData(["note-by-path", null, G_NOTE.slug], G_NOTE);
    queryClient.setQueryData(["note", NOTE.id], NOTE);
    queryClient.setQueryData(["note-by-path", NOTE.ownerHandle, NOTE.slug], NOTE);
    queryClient.setQueryData(["note-by-group-path", GROUP_ID, NOTE.slug], NOTE);

    invalidateNoteQueries(queryClient, G_NOTE, G_NOTE.id);
    expect(queryClient.getQueryState(["note", G_NOTE.id])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["note-by-group-path", GROUP_ID, G_NOTE.slug])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["note-by-path", null, G_NOTE.slug])?.isInvalidated).toBe(false);

    invalidateNoteQueries(queryClient, NOTE, NOTE.id);
    expect(queryClient.getQueryState(["note-by-path", NOTE.ownerHandle, NOTE.slug])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["note-by-group-path", GROUP_ID, NOTE.slug])?.isInvalidated).toBe(false);
  });
});

// Wiring between the sidebar note row kebab and NotePage (NotePageControlsContext / location.state openEdits).

function SidebarLocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location" data-key={location.key}>
      {location.pathname}|{JSON.stringify(location.state ?? null)}
    </div>
  );
}

/** The `mockFetch` catch-all would answer `/api/notes/:id/edits` with a NoteDto, so intercept it first and return `{edits: []}`. */
function withEditsAndList(inner: ReturnType<typeof mockFetch>, notes: () => NoteDto[] = () => []) {
  const calls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (url.endsWith("/edits") && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ edits: [] }) }));
    }
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes()) }));
    }
    return inner(input, init);
  });
  return { fn, calls };
}

function renderWithProbe(initialEntry: string | { pathname: string; state: unknown }, extra?: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <ActiveNoteProvider>
            <SidebarLocationProbe />
            {extra}
            <Routes>
              <Route element={<AppShellLayout />}>
                <Route path="/notes/:ref" element={<NotePage />} />
                <Route path="/n/:handle/:slug" element={<NotePage />} />
                <Route path="/" element={<div>home landing</div>} />
              </Route>
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

async function openSidebarRowMenu(title: string): Promise<HTMLElement> {
  const section = await screen.findByRole("tabpanel");
  const trigger = await within(section).findByRole("button", { name: `Note actions for ${title}` });
  fireEvent.pointerDown(trigger, { button: 0 });
  return screen.findByRole("menu");
}

describe("NotePage x sidebar note row kebab", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  it("entering with state {openEdits:true} -> opens the AI edit history once ready and the state is cleared by a replace; without state it does not open", async () => {
    const { fn } = withEditsAndList(mockFetch());
    vi.stubGlobal("fetch", fn);

    const plain = renderNotePage("my-note");
    await screen.findByLabelText("Note title", { selector: "input" });
    expect(screen.queryByRole("dialog", { name: "AI edits on this note" })).toBeNull();
    plain.unmount();

    renderWithProbe({ pathname: "/notes/my-note", state: { openEdits: true } });
    // The final landing is canonical (#179: convergence goes through router navigate and keeps the **current** state - openEdits already cleared - adding only a convergence marker).
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note\|\{"knotebookCanonicalizedFrom":"\/notes\/my-note"\}$/));
    expect(await screen.findByRole("dialog", { name: "AI edits on this note" })).toBeInTheDocument();
  });

  it("sidebar kebab on the open note, pressing AI edit history: opens the same dialog, no navigation, no remount", async () => {
    // A wrong implementation where the sidebar cannot get the controls and goes through navigate(canonical, {state}) would give the same
    // path and final state as the correct one (canonical convergence already turns `/notes/my-note` into `/n/tester/my-note`; since #179
    // convergence goes through router navigate, and params equal to canonical neither re-resolve nor remount) - the only visible difference
    // is **location.key**: any navigation (push or replace) changes the key. So wait for convergence to settle first and record the key;
    // after pressing the menu item the key must be unchanged.
    const { fn } = withEditsAndList(mockFetch(), () => [NOTE]);
    vi.stubGlobal("fetch", fn);
    collab.state = { phase: "connected", role: "owner" };

    renderWithProbe("/notes/my-note");
    const titleInput = await screen.findByLabelText("Note title", { selector: "input" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note\|\{"knotebookCanonicalizedFrom":"\/notes\/my-note"\}$/));
    const keyBefore = screen.getByTestId("location").dataset.key;

    const menu = await openSidebarRowMenu("My Note");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));

    expect(await screen.findByRole("dialog", { name: "AI edits on this note" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note\|\{"knotebookCanonicalizedFrom":"\/notes\/my-note"\}$/);
    expect(screen.getByTestId("location").dataset.key).toBe(keyBefore);
    expect(screen.getByLabelText("Note title", { selector: "input" })).toBe(titleInput);
  });

  it("sidebar kebab deleting the open note: back to the home page, no 'note was deleted' toast", async () => {
    let deleted = false;
    const inner = mockFetch();
    const { fn, calls } = withEditsAndList(
      ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === `/api/notes/${NOTE.id}` && method === "DELETE") {
          deleted = true;
          return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        }
        if (deleted && url.startsWith("/api/notes/") && !url.endsWith("/backlinks") && method === "GET") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 404,
              json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }),
            }),
          );
        }
        return inner(input, init);
      }) as ReturnType<typeof mockFetch>,
      () => (deleted ? [] : [NOTE]),
    );
    vi.stubGlobal("fetch", fn);
    collab.state = { phase: "connected", role: "owner" };

    renderWithProbe("/notes/my-note");
    await screen.findByLabelText("Note title", { selector: "input" });

    const menu = await openSidebarRowMenu("My Note");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("home landing")).toBeInTheDocument();
    expect(calls).toContain(`DELETE /api/notes/${NOTE.id}`);
    // The `GET /api/notes/<id>` 404 after invalidation comes back a bit later - give it a chance to land before asserting there is no toast.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText("This note has been deleted.")).toBeNull();
  });

  // After moving to the trash, the persistent layer ["note", id] stays in the 404 in_trash error state; undo must first overwrite the
  // persistent layer and then navigate back, otherwise the reopened NotePage reads the old error -> "this note was deleted" and bounces to the home page.
  // Hardcoded to enter from `/n/tester/my-note` (by-path): only the by-path form (and likewise `/g/<groupId>/<slug>`) leaves a
  // resolution-layer `["note-by-path", ...]` cache, and the persistent layer refetches once on mount so that its `dataUpdatedAt` is newer than the
  // resolution layer, which is when the "seed effect does not seed after undo" condition holds; entering from `/notes/<slug>` or `/notes/<id>`
  // refetches by-path on reopening and seeds as usual, so it would not bounce even without seeding.
  it("header kebab moves to the trash -> back to the home page -> press Undo: back to that note, the title field appears, and the 'this note was deleted' message does not appear at any point", async () => {
    let trashed = false;
    const inner = mockFetch();
    const { fn, calls } = withEditsAndList(
      ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === `/api/notes/${NOTE.id}` && method === "DELETE") {
          trashed = true;
          return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        }
        if (url === "/api/trash/restore" && method === "POST") {
          trashed = false;
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored: [NOTE], skipped: [] }) }));
        }
        if (trashed && url === `/api/notes/${NOTE.id}` && method === "GET") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 404,
              json: () => Promise.resolve({ error: { code: "in_trash", message: "x" }, noteId: NOTE.id }),
            }),
          );
        }
        return inner(input, init);
      }) as ReturnType<typeof mockFetch>,
      () => (trashed ? [] : [NOTE]),
    );
    vi.stubGlobal("fetch", fn);
    collab.state = { phase: "connected", role: "owner" };
    // "Does not appear at any point" is judged from the toast call record, not a screen snapshot: the noteGone exit records synchronously at the moment toast() is called, regardless of which render commits first afterwards.
    const toastSpy = vi.spyOn(toastModule, "toast");
    onTestFinished(() => toastSpy.mockRestore());
    const toastTitles = () => toastSpy.mock.calls.map(([item]) => item.title);

    const { queryClient } = renderWithProbe("/n/tester/my-note");
    await screen.findByLabelText("Note title", { selector: "input" });

    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/\|/));
    // Wait until the persistent-layer refetch after moving to the trash (404 in_trash) has really landed as an error state - that is the starting point (no fixed wait).
    await waitFor(() => expect(queryClient.getQueryState(["note", NOTE.id])?.status).toBe("error"));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    // "Back at that note" requires three things together: URL, title field, persistent layer success. If the seed is missing, the reopened
    // page reads the old error and bounces home (the URL becomes /) and this wait times out red; the persistent layer is invalidated and refetched into success only later, by which time the URL is already /.
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note\|/);
      expect(screen.getByLabelText("Note title", { selector: "input" })).toBeInTheDocument();
      expect(queryClient.getQueryState(["note", NOTE.id])?.status).toBe("success");
    });
    expect(calls).toContain("POST /api/trash/restore");
    // The title field appearing = the reopened page has a render that is not the noteGone placeholder card; React has already run the
    // previously committed effects (including the noteGone exit) before it, so if it was judged "deleted", toast() must already have been
    // called by now. The two positive messages both come from trash-undo and only prove that spy is attached; that NotePage's own calls
    // would be caught is shown by removing the seed and making noteGone not navigate (the next line then fails).
    expect(toastTitles()).toEqual(expect.arrayContaining(["Moved to the trash", "Restored 1 note"]));
    expect(toastTitles()).not.toContain("This note has been deleted.");
    expect(screen.queryByText("This note has been deleted.", { exact: true })).toBeNull();
  });
});

// A resolution-layer 404 `in_trash` (with a top-level noteId) -> a card, no navigation; other 404s remain link-invalid as before.
// The regression for the link-invalid 404 is covered by existing cases: "first resolution 404 -> linkInvalid text", "new-form by-path 404 -> linkInvalid exit" and "by-group-path 404 -> linkInvalid exit and back to /".
describe("NotePage x same-note snippet from sidebar content search", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  it("clicking a same-note snippet in the sidebar while that note is open -> goes through the paragraph anchor (stays on the original URL, only the hash changes), not a push to the snippet's href", async () => {
    // The anchor API is registered by the page to the outer sidebar shell; if not registered, the sidebar treats it as another note and navigates to the href (which would drop the current URL's query).
    const { fn } = withEditsAndList(
      ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/search?")) {
          const hit = { note: NOTE, matchedOn: "body", matches: [{ sectionId: "h1", heading: "Gamma", snippet: "the needle is here" }] };
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ hits: [hit], nextCursor: null }) }));
        }
        return mockFetch()(input, init);
      }) as ReturnType<typeof mockFetch>,
      () => [NOTE],
    );
    vi.stubGlobal("fetch", fn);
    collab.state = { phase: "connected", role: "owner" };
    collab.provider.synced = true;

    renderWithProbe("/n/tester/my-note?keep=1", <FullLocationProbe />);
    await screen.findByLabelText("Note title", { selector: "input" });

    const aside = screen.getByRole("complementary");
    fireEvent.change(within(aside).getByRole("textbox", { name: "Search notes" }), { target: { value: "needle" } });
    fireEvent.click(await within(aside).findByTestId("body-match"));

    await waitFor(() => expect(screen.getByTestId("full-location")).toHaveTextContent("/n/tester/my-note?keep=1#b-h1"));
  });
});

describe("NotePage x in the trash", () => {
  const GROUP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const G_NOTE: NoteDto = {
    ...NOTE,
    id: "66666666-6666-4666-8666-666666666666",
    title: "Group Note",
    slug: "group-note",
    slugIsCustom: false,
    ownerId: null,
    ownerHandle: null,
    role: "editor",
    groupId: GROUP_ID,
    group: { id: GROUP_ID, name: "Workshop A" },
    permissions: { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
  };
  const OTHER_NOTE: NoteDto = { ...NOTE, id: "77777777-7777-4777-8777-777777777777", title: "Other Note", slug: "other-note" };
  const LINK_INVALID = "This link is invalid or the note doesn't exist.";
  const IN_TRASH = "This note is in the trash";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.provider.synced = true;
    collab.onUnauthorized = undefined;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  /** Both notes start in the trash and the resolution endpoints return 404 `code` (default in_trash; `noteId: false` omits the top-level noteId) until `POST /api/trash/restore`.
   * `initiallyTrashed: false` starts as an ordinary note; `restoreKeepsTrashed` makes restore succeed while the resolution refetch is still in_trash; `holdRestore` holds the restore
   * response until `release()`. OTHER_NOTE always returns 200. */
  function stubTrashed(
    opts: {
      code?: string;
      noteId?: boolean;
      initiallyTrashed?: boolean;
      restoreKeepsTrashed?: boolean;
      holdRestore?: boolean;
    } = {},
  ) {
    let trashed = opts.initiallyTrashed ?? true;
    const calls: string[] = [];
    let releaseRestore: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const reply = (note: NoteDto) =>
      trashed
        ? fakeResponse({
            ok: false,
            status: 404,
            json: () =>
              Promise.resolve({
                error: { code: opts.code ?? "in_trash", message: "x" },
                ...(opts.noteId === false ? {} : { noteId: note.id }),
              }),
          })
        : fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(note) });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push(`${method} ${url}`);
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url.endsWith("/backlinks") && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) }));
        }
        if (url.endsWith("/links") && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        }
        if (url === "/api/trash/restore" && method === "POST") {
          const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
          const restored = [NOTE, G_NOTE].filter((note) => ids.includes(note.id));
          const done = () => {
            if (!opts.restoreKeepsTrashed) trashed = false;
            return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored, skipped: [] }) });
          };
          return opts.holdRestore ? held.then(done) : Promise.resolve(done());
        }
        if (url === "/api/trash/purge" && method === "POST") {
          const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ purged: ids, skipped: [] }) }));
        }
        if ((url === `/api/trash/${NOTE.id}` || url === `/api/trash/${G_NOTE.id}`) && method === "GET") {
          const matched = url.endsWith(NOTE.id) ? NOTE : G_NOTE;
          return Promise.resolve(
            trashed
              ? fakeResponse({
                  ok: true,
                  status: 200,
                  json: () =>
                    Promise.resolve({
                      id: matched.id,
                      title: matched.title,
                      deletedAt: "2026-10-20T00:00:00.000Z",
                      purgeAt: "2026-10-27T00:00:00.000Z",
                      deletedBy: { handle: "tester", displayName: "Tester" },
                      group: matched.group,
                      folderPath: [],
                      ydoc: "AAA=",
                    }),
                })
              : fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }) }),
          );
        }
        if (url === `/api/notes/by-path/${NOTE.ownerHandle}/${NOTE.slug}` && method === "GET") {
          return Promise.resolve(reply(NOTE));
        }
        if (url === `/api/notes/by-group-path/${GROUP_ID}/${G_NOTE.slug}` && method === "GET") {
          return Promise.resolve(reply(G_NOTE));
        }
        if ((url === `/api/notes/${NOTE.id}` || url === `/api/notes/${NOTE.slug}`) && method === "GET") {
          return Promise.resolve(reply(NOTE));
        }
        if (url === `/api/notes/${G_NOTE.id}` && method === "GET") {
          return Promise.resolve(reply(G_NOTE));
        }
        if (
          (url === `/api/notes/by-path/${OTHER_NOTE.ownerHandle}/${OTHER_NOTE.slug}` || url === `/api/notes/${OTHER_NOTE.id}`) &&
          method === "GET"
        ) {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(OTHER_NOTE) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return {
      calls,
      untrash: () => {
        trashed = false;
      },
      release: () => releaseRestore?.(),
    };
  }

  function renderAt(entry: string, queries: { retry?: number | false; retryDelay?: number } = { retry: false }) {
    const queryClient = new QueryClient({ defaultOptions: { queries } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[entry]}>
            <NotePageTree />
            <NavButtons />
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  // fireEvent.click does not move focus, which the focus cases rely on.
  function NavButtons() {
    const nav = useNavigate();
    return (
      <>
        <button type="button" onClick={() => void nav(`/n/tester/${OTHER_NOTE.slug}`)}>
          go-other
        </button>
        <button type="button" onClick={() => void nav(`/n/tester/${NOTE.slug}`)}>
          go-my-note
        </button>
      </>
    );
  }

  const titleInput = () => screen.getByLabelText("Note title", { selector: "input" });

  function spyToasts() {
    const toastSpy = vi.spyOn(toastModule, "toast");
    onTestFinished(() => toastSpy.mockRestore());
    return () => toastSpy.mock.calls.map(([item]) => item.title);
  }

  // Gives a mistaken link-invalid exit effect the chance to navigate.
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  async function expectCardStays(entry: string) {
    const toastTitles = spyToasts();
    renderAt(entry);
    expect(await screen.findByRole("heading", { level: 2, name: IN_TRASH })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to trash" })).toBeInTheDocument();
    // The preview header includes the narrow-screen navigation exit (SidebarDrawerButton, #115) (jsdom does not apply xl:hidden).
    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
    await settle();
    expect(toastTitles()).not.toContain(LINK_INVALID);
    expect(screen.queryByText(LINK_INVALID)).toBeNull();
    expect(screen.queryByText("home landing")).toBeNull();
    expect(routerPath()).toBe(entry);
    expect(screen.getByRole("heading", { level: 2, name: IN_TRASH })).toBeInTheDocument();
  }

  async function expectLinkInvalid(entry: string) {
    renderAt(entry);
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText(LINK_INVALID)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: IN_TRASH })).toBeNull();
  }

  it("by-path returns 404 in_trash (with noteId) -> read-only preview with Delete permanently that purges and returns home", async () => {
    const { calls } = stubTrashed();
    renderAt("/n/tester/my-note");
    expect(await screen.findByRole("heading", { level: 1, name: "My Note" })).toBeInTheDocument();
    expect(screen.getByText("This note has no content.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(calls).toContain("POST /api/trash/purge");
  });

  it("by-path returns 404 in_trash (with noteId) -> a card; no link-invalid toast, no navigation back to the home page", async () => {
    stubTrashed();
    await expectCardStays("/n/tester/my-note");
  });

  // Using the `/notes/<slug>` form: the resolution-layer key is `["note", slug]`, which is not in the prefix list of invalidateTrashRelated.
  it("/notes/<slug> form: card -> press Restore -> sends restore, the resolution layer refetch returns 200 -> the card disappears, the title field appears and gets focus", async () => {
    const { calls } = stubTrashed();
    renderAt(`/notes/${NOTE.slug}`);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Note title", { selector: "input" })).toHaveValue("My Note");
      expect(screen.queryByRole("heading", { level: 2, name: IN_TRASH })).toBeNull();
    });
    expect(calls).toContain("POST /api/trash/restore");
    await waitFor(() => expect(routerPath()).toBe("/n/tester/my-note"));
    expect(screen.queryByText(LINK_INVALID)).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Note title", { selector: "input" })).toHaveFocus());
  });

  it("opening a note normally (not in the trash): the title field does not take focus", async () => {
    stubTrashed({ initiallyTrashed: false });
    renderAt("/n/tester/my-note");
    await waitFor(() => expect(titleInput()).toHaveValue("My Note"));
    await settle();
    expect(titleInput()).not.toHaveFocus();
  });

  it("after a restore took focus, switching notes and switching back: neither open focuses the title field (the flag is cleared once used)", async () => {
    stubTrashed();
    renderAt(`/notes/${NOTE.slug}`);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(titleInput()).toHaveFocus());
    act(() => titleInput().blur());

    fireEvent.click(screen.getByRole("button", { name: "go-other" }));
    await waitFor(() => expect(titleInput()).toHaveValue("Other Note"));
    await settle();
    expect(titleInput()).not.toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));
    await waitFor(() => expect(titleInput()).toHaveValue("My Note"));
    await settle();
    expect(titleInput()).not.toHaveFocus();
  });

  it("restore succeeds but the resolution-layer refetch is still in_trash (card stays) -> switch to another note: the other note's title field does not take focus", async () => {
    const { calls, untrash } = stubTrashed({ restoreKeepsTrashed: true });
    renderAt(`/notes/${NOTE.slug}`);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.filter((call) => call === `GET /api/notes/${NOTE.slug}`).length).toBeGreaterThanOrEqual(2));
    await settle();
    expect(screen.getByRole("heading", { level: 2, name: IN_TRASH })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "go-other" }));
    await waitFor(() => expect(titleInput()).toHaveValue("Other Note"));
    await settle();
    expect(titleInput()).not.toHaveFocus();

    untrash();
    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));
    await waitFor(() => expect(titleInput()).toHaveValue("My Note"));
    await settle();
    expect(titleInput()).not.toHaveFocus();
  });

  it("restore sent without a reply and then switching to another note -> response lands -> switching back to the restored note: the title field does not take focus", async () => {
    const { release } = stubTrashed({ holdRestore: true });
    renderAt(`/notes/${NOTE.slug}`);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "go-other" }));
    await waitFor(() => expect(titleInput()).toHaveValue("Other Note"));
    await act(async () => {
      release();
    });
    await settle();
    expect(titleInput()).not.toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));
    await waitFor(() => expect(titleInput()).toHaveValue("My Note"));
    await settle();
    expect(titleInput()).not.toHaveFocus();
  });

  it("restore sent without a reply, switch away, switch back before the response lands (a new card) -> response lands: the title field takes focus", async () => {
    const { release } = stubTrashed({ holdRestore: true });
    renderAt(`/notes/${NOTE.slug}`);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "go-other" }));
    await waitFor(() => expect(titleInput()).toHaveValue("Other Note"));
    fireEvent.click(screen.getByRole("button", { name: "go-my-note" }));
    expect(await screen.findByRole("heading", { level: 2, name: IN_TRASH })).toBeInTheDocument();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(titleInput()).toHaveFocus());
  });

  it("by-group-path form behaves like the by-path in_trash case: card, no navigation", async () => {
    stubTrashed();
    await expectCardStays(`/g/${GROUP_ID}/${G_NOTE.slug}`);
  });

  it("/notes/:ref (id) form behaves like the by-path in_trash case: card, no navigation", async () => {
    stubTrashed();
    await expectCardStays(`/notes/${NOTE.id}`);
  });

  it("regression: 404 not_found (even if the body carries a top-level noteId) -> link-invalid toast + back to the home page as before", async () => {
    stubTrashed({ code: "not_found" });
    await expectLinkInvalid("/n/tester/my-note");
  });

  it("404 in_trash without a noteId -> nothing to restore, takes the link-invalid exit", async () => {
    stubTrashed({ noteId: false });
    await expectLinkInvalid("/n/tester/my-note");
  });

  // The production QueryClient retries (default 3 times, backoff 1+2+4 s): here the default is "retries but does not wait", and the resolution endpoint hit count is counted.
  const RETRYING = { retry: 2, retryDelay: 0 };
  const byPathGets = (calls: string[]) => calls.filter((call) => call === "GET /api/notes/by-path/tester/my-note").length;

  // Each of the three resolution-layer hooks needs its own retry (by-path, old-form `/notes/:ref`, group form): one case per form, counting that form's resolution endpoint.
  it.each([
    { form: "by-path", entry: "/n/tester/my-note", endpoint: "GET /api/notes/by-path/tester/my-note" },
    { form: "by-ref", entry: `/notes/${NOTE.id}`, endpoint: `GET /api/notes/${NOTE.id}` },
    {
      form: "by-group-path",
      entry: `/g/${GROUP_ID}/${G_NOTE.slug}`,
      endpoint: `GET /api/notes/by-group-path/${GROUP_ID}/${G_NOTE.slug}`,
    },
  ])("resolution-layer 404 in_trash is not retried ($form): the resolution endpoint is hit once and the card appears directly", async ({ entry, endpoint }) => {
    const { calls } = stubTrashed();
    renderAt(entry, RETRYING);
    expect(await screen.findByRole("heading", { level: 2, name: IN_TRASH })).toBeInTheDocument();
    await settle();
    expect(calls.filter((call) => call === endpoint)).toHaveLength(1);
  });

  it("other 404s retry per the QueryClient default (retry 2 -> 3 calls in total) before taking the link-invalid exit", async () => {
    const { calls } = stubTrashed({ code: "not_found" });
    renderAt("/n/tester/my-note", RETRYING);
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText(LINK_INVALID)).toBeInTheDocument();
    expect(byPathGets(calls)).toBe(3);
  });

  // Production (`new QueryClient()` in `main.tsx`) sets no retry: the query-core default of 3 retries applies.
  it("QueryClient without retry: other 404s retry per the query-core default 3 times (4 calls in total)", async () => {
    const { calls } = stubTrashed({ code: "not_found" });
    renderAt("/n/tester/my-note", { retryDelay: 0 });
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText(LINK_INVALID)).toBeInTheDocument();
    expect(byPathGets(calls)).toBe(4);
  });
});

/**
 * Terminal-state list reconciliation. This path races a **known server behaviour**:
 * `DELETE /api/notes/:id` first `await beforeNoteDeleted(id)` (unload polling cap 20 x 250ms = 5s) **before** the delete transaction runs,
 * so after the client receives NOTE_DELETED that row can still be in the DB for up to 5 seconds. A single refetch is not enough;
 * polling is needed - this group of tests pins that.
 */
describe("scheduleTerminalReconcile", () => {
  const OTHER_NOTE: NoteDto = { ...NOTE, id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other" };

  let queryClient: QueryClient;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Built with fetchQuery and a queryFn so that a later invalidate can refetch.
  async function seedNotesQuery(queryFn: () => Promise<NoteDto[]>) {
    await queryClient.fetchQuery({ queryKey: ["notes"], queryFn });
  }

  it("keeps refetching while the server has not committed the delete, until that row is really gone", async () => {
    let snapshot: NoteDto[] = [NOTE, OTHER_NOTE];
    const queryFn = vi.fn(() => Promise.resolve(snapshot));
    await seedNotesQuery(queryFn);
    expect(queryClient.getQueryData<NoteDto[]>(["notes"])).toHaveLength(2);

    scheduleTerminalReconcile(queryClient, NOTE.id);

    // For the first few rounds the server still returns the old list (the delete transaction has not committed) - the ghost row is still there, so polling must not stop.
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2);
    expect(queryClient.getQueryData<NoteDto[]>(["notes"])).toHaveLength(2);
    const callsWhileGhostPresent = queryFn.mock.calls.length;
    expect(callsWhileGhostPresent).toBeGreaterThan(1);

    snapshot = [OTHER_NOTE];
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2);
    expect(queryClient.getQueryData<NoteDto[]>(["notes"])).toEqual([OTHER_NOTE]);

    const callsAfterConverged = queryFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS);
    expect(queryFn.mock.calls.length).toBe(callsAfterConverged);
  });

  it("that row is already gone at the start -> one fetch and done", async () => {
    const queryFn = vi.fn(() => Promise.resolve([OTHER_NOTE]));
    await seedNotesQuery(queryFn);
    const before = queryFn.mock.calls.length;

    scheduleTerminalReconcile(queryClient, NOTE.id);
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS * 2);

    expect(queryFn.mock.calls.length).toBe(before + 1);
  });

  it("the server keeps returning that row -> stops at the cap, no endless polling", async () => {
    const queryFn = vi.fn(() => Promise.resolve([NOTE, OTHER_NOTE]));
    await seedNotesQuery(queryFn);
    const before = queryFn.mock.calls.length;

    scheduleTerminalReconcile(queryClient, NOTE.id);
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS + RECONCILE_INTERVAL_MS * 2);
    const afterDeadline = queryFn.mock.calls.length;

    // The number of polls is bounded by the time limit (+2 is slack for the first fetch and boundary error).
    expect(afterDeadline - before).toBeLessThanOrEqual(Math.ceil(RECONCILE_TIMEOUT_MS / RECONCILE_INTERVAL_MS) + 2);

    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS * 2);
    expect(queryFn.mock.calls.length).toBe(afterDeadline);
  });

  it("the time limit covers the server's worst case (unload polling 20 x 250ms = 5s)", () => {
    expect(RECONCILE_TIMEOUT_MS).toBeGreaterThan(20 * 250);
  });

  it("noteId unknown (the note never loaded successfully) -> fetches once, no polling", async () => {
    const queryFn = vi.fn(() => Promise.resolve([NOTE, OTHER_NOTE]));
    await seedNotesQuery(queryFn);
    const before = queryFn.mock.calls.length;

    scheduleTerminalReconcile(queryClient, undefined);
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS * 2);

    expect(queryFn.mock.calls.length).toBe(before + 1);
  });

  it("the kicked terminal state's reconciliation invalidates ['groups'] once at the same time (not repeated with the ['notes'] polling)", async () => {
    // The first two returns still say "NOTE is still there" so that ['notes'] polling runs at least two rounds, which tells this apart from
    // the wrong approach of putting the ['groups'] invalidation inside tick() so it repeats every round; it converges from the third return on.
    const notesFn = vi
      .fn<() => Promise<NoteDto[]>>()
      .mockResolvedValueOnce([NOTE, OTHER_NOTE])
      .mockResolvedValueOnce([NOTE, OTHER_NOTE])
      .mockResolvedValue([OTHER_NOTE]);
    await seedNotesQuery(notesFn);
    const groupsFn = vi.fn(() => Promise.resolve([]));
    await queryClient.fetchQuery({ queryKey: ["groups"], queryFn: groupsFn });
    expect(groupsFn).toHaveBeenCalledTimes(1);

    scheduleTerminalReconcile(queryClient, NOTE.id);
    await vi.advanceTimersByTimeAsync(0);

    // ['groups'] is refetched once immediately (one request, hung on scheduleTerminalReconcile itself, not inside tick()).
    await waitFor(() => expect(groupsFn).toHaveBeenCalledTimes(2));

    // On the ['notes'] side NOTE is still there (the first two mocks both returned a list containing NOTE) - polling continues for several
    // rounds; if the ['groups'] invalidation were wrongly placed inside tick(), it would repeat every round here and not stay at 2.
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 3);
    expect(notesFn.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(groupsFn).toHaveBeenCalledTimes(2);
  });
});

// #229: convergence keeps search / hash. `?present` and `#/<slide id>` are the URL state of presentation mode; if convergence (opening
// `/notes/:ref` directly, renaming during playback) wrote only the pathname, the presentation layer would disappear at the first convergence.

function FullLocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="full-location" data-key={location.key}>
      {location.pathname}
      {location.search}
      {location.hash}
    </div>
  );
}

function renderAtEntry(entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <ActiveNoteProvider>
            <FullLocationProbe />
            <Routes>
              <Route element={<AppShellLayout />}>
                <Route path="/notes/:ref" element={<NotePage />} />
                <Route path="/n/:handle/:slug" element={<NotePage />} />
                <Route path="/" element={<div>home landing</div>} />
              </Route>
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("#229 URL convergence keeps search / hash", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.provider.synced = true;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  it("old form /notes/<uuid>?present#/x -> canonical /n/tester/my-note?present#/x (search and hash both kept)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderAtEntry(`/notes/${NOTE.id}?present#/x`);
    await waitFor(() => expect(screen.getByTestId("full-location").textContent).toBe("/n/tester/my-note?present#/x"));
  });

  it("renaming during playback: the URL gets the new slug, ?present + hash are kept, the editor is the same instance (not remounted)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { queryClient } = renderAtEntry("/n/tester/my-note?present#/x");
    const editorBefore = await screen.findByTestId("note-editor");
    await waitFor(() => expect(screen.getByTestId("full-location").textContent).toBe("/n/tester/my-note?present#/x"));

    // react-query notifications go through a macrotask: a synchronous act would land the assertion before the re-render (see the existing comment in the transition case of this file).
    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, title: "Renamed", slug: "renamed" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(screen.getByTestId("full-location").textContent).toBe("/n/tester/renamed?present#/x"));
    expect(screen.getByTestId("note-editor")).toBe(editorBefore);
  });
});

describe("NotePage x version history", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.onUnauthorized = undefined;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  it("Ctrl+S (owner) -> preventDefault, opens the save dialog", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    await screen.findByTestId("note-editor");
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    // First case in this describe to open a dialog: the lazy chunk's cold start under full parallel load can be slow; the global
    // asyncUtilTimeout (10 s, test/setup.ts) covers it, so no separate timeout is set.
    expect(await screen.findByRole("dialog", { name: "Save current version" })).toBeInTheDocument();
  });

  it("Ctrl+S while the save dialog is already open -> still preventDefault (no browser save-as), no second dialog opens, the already-typed name stays", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    await screen.findByTestId("note-editor");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    fireEvent.change(within(dialog).getByLabelText("Version name (optional)"), { target: { value: "草稿" } });
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(screen.getByRole("dialog", { name: "Save current version" })).getByLabelText("Version name (optional)")).toHaveValue("草稿");
  });

  it("pressing Ctrl+S in the save dialog opened from the three-way apply's 'Save first' does not wash out 'apply after saving'", async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-open-apply"));
    const applyDialog = await screen.findByRole("dialog", { name: "Apply agile-beaver (0001aaa)" });
    fireEvent.click(within(applyDialog).getByRole("button", { name: "Save current version" }));
    const saveDialog = await screen.findByRole("dialog", { name: "Save current version" });
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.click(within(saveDialog).getByRole("button", { name: "Save" }));
    const applyUrl = `/api/notes/${encodeURIComponent(NOTE.id)}/versions/1/apply`;
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([input, init]) => String(input) === applyUrl && init?.method === "POST")).toBe(true),
    );
  });

  it("Cmd+S (metaKey) is intercepted too", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    await screen.findByTestId("note-editor");
    const ev = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("viewer -> Ctrl+S is not intercepted (browser default kept), no dialog", async () => {
    vi.stubGlobal("fetch", mockFetch({ ...NOTE, role: "viewer", permissions: VIEWER_PERMS }));
    collab.state = { phase: "connected", role: "viewer" };
    renderNotePage(NOTE.id);
    await screen.findByTestId("note-editor");
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("another dialog already open (e.g. share) -> Ctrl+S is not intercepted", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    await screen.findByTestId("note-editor");
    const fake = document.createElement("div");
    fake.setAttribute("role", "dialog");
    document.body.append(fake);
    try {
      const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      fake.remove();
    }
  });

  it("Ctrl+Shift+S, Alt+S and a plain s are not intercepted", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    await screen.findByTestId("note-editor");
    for (const init of [{ ctrlKey: true, shiftKey: true }, { altKey: true, ctrlKey: true }, {}]) {
      const ev = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
  });

  it("in presentation mode (?present) Ctrl+S is not intercepted and no save dialog opens", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    collab.provider.synced = true;
    renderAtEntry("/n/tester/my-note?present");
    await screen.findByTestId("note-editor");
    const ev = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog", { name: "Save current version" })).not.toBeInTheDocument();
  });

  it("preview: previewSlot is handed to NoteEditor, the banner appears in the header; the editor stand-in is still there", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-start-preview"));
    expect(await screen.findByTestId("mock-preview-slot")).toBeInTheDocument();
    expect(await screen.findByTestId("preview-banner")).toBeInTheDocument();
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
  });

  it("Esc (no overlay): leaves the preview", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-start-preview"));
    await screen.findByTestId("mock-preview-slot");
    // This Esc closes only the preview layer - preventDefault (fireEvent returns false); the search marker's Esc listener yields when it sees defaultPrevented.
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("mock-preview-slot")).not.toBeInTheDocument());
  });

  it("Esc with the kebab menu open during a preview -> closes only the menu, the preview stays (jsdom; real keyboard in e2e/tests/22-versions.spec.ts)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-start-preview"));
    await screen.findByTestId("mock-preview-slot");
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByTestId("mock-preview-slot")).toBeInTheDocument();
  });

  it("Esc with the save dialog open during a preview -> closes only the dialog, the preview stays (jsdom; real keyboard in e2e/tests/22-versions.spec.ts)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-start-preview"));
    await screen.findByTestId("mock-preview-slot");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("mock-preview-slot")).toBeInTheDocument();
  });

  it("Esc already preventDefault'ed by someone else (= handled by Radix, overlay already unmounted) -> the preview stays, even though no overlay is left in the DOM", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-start-preview"));
    await screen.findByTestId("mock-preview-slot");
    expect(document.querySelector('[role="dialog"], [role="menu"]')).toBeNull();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(screen.getByTestId("mock-preview-slot")).toBeInTheDocument();
  });

  it("apply succeeded -> the whole note query group is invalidated (invalidateNoteQueries: ['note', id] and the path-resolution layer ['note-by-path', handle, slug])", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    const { queryClient } = renderNotePage(NOTE.id);
    fireEvent.click(await screen.findByText("mock-open-apply"));
    const dialog = await screen.findByRole("dialog", { name: "Apply agile-beaver (0001aaa)" });
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply without saving" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toContain(JSON.stringify(["note-by-path", "tester", "my-note"]));
    expect(keys).toContain(JSON.stringify(["note", NOTE.id]));
  });
});

describe("NotePage x recent tab follows the open note", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.onDocUpdate = undefined;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  it("the open note, once edited, is moved to the front of the recent tab immediately; GET /api/notes is called once", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    const edited = (at: string) => ({ at, byHandle: "tester", agentLabel: null });
    const noteA: NoteDto = { ...NOTE, lastEdited: edited("2026-10-01T00:00:00.000Z") };
    const noteB: NoteDto = {
      ...NOTE,
      id: "22222222-2222-2222-2222-222222222222",
      title: "Other Note",
      slug: "other-note",
      lastEdited: edited("2026-10-02T00:00:00.000Z"),
    };
    let currentA = noteA;
    const inner = mockFetch(noteA);
    let listCalls = 0;
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        listCalls += 1;
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([noteB, noteA]) }));
      }
      if (
        method === "GET" &&
        url.startsWith("/api/notes/") &&
        !/\/(backlinks|versions|edits|links)/.test(url)
      ) {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(currentA) }));
      }
      return inner(input, init);
    });
    vi.stubGlobal("fetch", fn);

    renderNotePage("my-note");
    const order = () =>
      Array.from(screen.getByRole("tabpanel").querySelectorAll('[data-node-kind="note"]')).map((el) =>
        el.getAttribute("data-node-id"),
      );
    await waitFor(() => expect(order()).toEqual([noteB.id, noteA.id]));
    await screen.findByLabelText("Note title", { selector: "input" });
    await waitFor(() => expect(collab.onDocUpdate).toBeDefined());

    currentA = { ...noteA, lastEdited: edited("2026-10-03T00:00:00.000Z") };
    act(() => collab.onDocUpdate!());

    await waitFor(() => expect(order()).toEqual([noteA.id, noteB.id]));
    expect(listCalls).toBe(1);
  });

  it("back to a cached A: the older lastEdited in the note cache does not overwrite the newer value in the list (the list is not written or reordered)", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    const edited = (at: string) => ({ at, byHandle: "tester", agentLabel: null });
    const aOld: NoteDto = { ...NOTE, lastEdited: edited("2026-10-01T00:00:00.000Z") };
    const aNew: NoteDto = { ...NOTE, lastEdited: edited("2026-10-03T00:00:00.000Z") };
    const noteB: NoteDto = {
      ...NOTE,
      id: "22222222-2222-2222-2222-222222222222",
      title: "Other Note",
      slug: "other-note",
      lastEdited: edited("2026-10-02T00:00:00.000Z"),
    };
    const inner = mockFetch(noteB);
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([aNew, noteB]) }));
      }
      if (method === "GET" && url.startsWith("/api/notes/") && !/\/(backlinks|versions|edits|links)/.test(url)) {
        const isB = url.includes("other-note") || url.includes(noteB.id);
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(isB ? noteB : aNew) }));
      }
      return inner(input, init);
    });
    vi.stubGlobal("fetch", fn);

    const { queryClient } = renderNotePage("other-note");
    const order = () =>
      Array.from(screen.getByRole("tabpanel").querySelectorAll('[data-node-kind="note"]')).map((el) =>
        el.getAttribute("data-node-id"),
      );
    await waitFor(() => expect(order()).toEqual([NOTE.id, noteB.id]));
    await waitFor(() => expect(screen.getByLabelText("Note title", { selector: "input" })).toHaveValue("Other Note"));
    // Stale cache left by "opened A within 5 minutes" (resolution layer + persistent layer); the list already has a newer A.
    queryClient.setQueryData(["note-by-path", "tester", "my-note"], aOld);
    queryClient.setQueryData(["note", NOTE.id], aOld);

    const listWrites: string[] = [];
    const orders: string[] = [];
    const realSet = queryClient.setQueryData.bind(queryClient);
    vi.spyOn(queryClient, "setQueryData").mockImplementation(((key: readonly unknown[], updater: unknown) => {
      const result = (realSet as (k: unknown, u: unknown) => unknown)(key, updater);
      if (key[0] === "notes") {
        const row = queryClient.getQueryData<NoteDto[]>(["notes"])?.find((n) => n.id === NOTE.id);
        listWrites.push(row?.lastEdited?.at ?? "null");
      }
      return result;
    }) as typeof queryClient.setQueryData);
    const observer = new MutationObserver(() => orders.push(order().join(",")));
    observer.observe(screen.getByRole("tabpanel"), { childList: true, subtree: true });

    fireEvent.click(screen.getByRole("tabpanel").querySelector(`[data-node-id="${NOTE.id}"] a`) as HTMLElement, { button: 0 });
    await waitFor(() => expect(screen.getByLabelText("Note title", { selector: "input" })).toHaveValue("My Note"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    observer.disconnect();

    expect(listWrites).toEqual([]);
    expect(orders.filter((o) => o !== [NOTE.id, noteB.id].join(","))).toEqual([]);
  });
});

describe("header avatar row (#293)", () => {
  const GROUP = { name: "Also viewing this note" } as const;
  let awareness: Awareness;

  beforeEach(async () => {
    resetLocalPresenceFieldForTest();
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    awareness = new Awareness(new Y.Doc());
    collab.provider = Object.assign(createStubProvider(), { awareness });
    collab.onUnauthorized = undefined;
    editorMock.scroller = null;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    awareness.destroy();
    collab.doc.destroy();
    editorMock.scroller = null;
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  async function openPage(note: NoteDto = NOTE) {
    vi.stubGlobal("fetch", mockFetch(note));
    const rendered = renderNotePage("my-note");
    // The header is in the editor stand-in's headerSlot; a viewer's title is an h1 (no "Note title" input), so go by the stand-in.
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    return rendered;
  }

  it("position: after ConnectionBadge, before LastEditedLabel", async () => {
    setRemote(awareness, 10, userState("u2", "Bea"));
    await openPage({ ...NOTE, lastEdited: { at: "2026-10-01T00:00:00.000Z", byHandle: "tester", agentLabel: null } });

    await waitFor(() => expect(screen.getByRole("group", GROUP)).toBeInTheDocument());
    const header = document.querySelector("header")!;
    const group = within(header).getByRole("group", GROUP);
    const badge = within(header)
      .getAllByRole("status")
      .find((el) => el.textContent?.includes("Connected"));
    const last = within(header).getByTestId("last-edited");
    expect(badge).toBeDefined();
    expect(badge!.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("without an avatar this tab writes the knotebook field with avatar null", async () => {
    await openPage();

    await waitFor(() =>
      expect(awareness.getLocalState()?.knotebook).toEqual({
        v: 1,
        kind: "user",
        role: "owner",
        avatar: null,
        since: expect.any(Number),
      }),
    );
  });

  it("with an avatar, avatar is written as { id, v } without pending", async () => {
    const { queryClient } = await openPage();
    await waitFor(() => expect(awareness.getLocalState()?.knotebook).toBeDefined());

    act(() => {
      queryClient.setQueryData(["me"], { ...USER, avatar: { id: "av-1", v: 3, pending: true } });
    });

    await waitFor(() => expect((awareness.getLocalState()?.knotebook as { avatar: unknown }).avatar).toEqual({ id: "av-1", v: 3 }));
    const field = awareness.getLocalState()?.knotebook as { avatar: Record<string, unknown> };
    expect(Object.keys(field.avatar).sort()).toEqual(["id", "v"]);
  });

  it("after changing and clearing the avatar, the awareness avatar follows", async () => {
    const { queryClient } = await openPage();
    await waitFor(() => expect(awareness.getLocalState()?.knotebook).toBeDefined());
    const avatarOf = () => (awareness.getLocalState()?.knotebook as { avatar: unknown }).avatar;

    act(() => {
      queryClient.setQueryData(["me"], { ...USER, avatar: { id: "av-1", v: 1, pending: false } });
    });
    await waitFor(() => expect(avatarOf()).toEqual({ id: "av-1", v: 1 }));

    act(() => {
      queryClient.setQueryData(["me"], { ...USER, avatar: { id: "av-2", v: 1, pending: false } });
    });
    await waitFor(() => expect(avatarOf()).toEqual({ id: "av-2", v: 1 }));

    act(() => {
      queryClient.setQueryData(["me"], { ...USER, avatar: null });
    });
    await waitFor(() => expect(avatarOf()).toBeNull());
  });

  it.each([
    ["connecting", /Connecting/],
    ["reconnecting-once", /Reconnecting/],
    ["outdated", /Reload required/],
  ] as const)("not connected (%s): no avatar row, and the local tab writes no knotebook field", async (phase, badgeText) => {
    collab.state = { phase };
    setRemote(awareness, 10, userState("u2", "Bea"));
    await openPage();
    // The badge appearing means the header and its effects have run; only then assert that the avatar row is absent.
    await waitFor(() => expect(within(document.querySelector("header")!).getByText(badgeText)).toBeInTheDocument());

    expect(screen.queryByRole("group", GROUP)).toBeNull();
    expect(awareness.getLocalState()).not.toHaveProperty("knotebook");
  });

  it("scroller wiring: clicking an avatar -> the scroller handed out by NoteEditor receives that cursor", async () => {
    const scroller = vi.fn<(cursor: unknown) => boolean>(() => true);
    editorMock.scroller = scroller;
    const cursor = { anchor: { tag: "a" }, head: { tag: "a" } };
    setRemote(awareness, 10, userState("u2", "Cat", { cursor }));
    await openPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Cat, Editor, go to their cursor" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cat, Editor, go to their cursor" }));
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller).toHaveBeenCalledWith(cursor);
  });

  it("myself (another tab, same user.id) does not appear", async () => {
    setRemote(awareness, 10, userState(USER.id, USER.displayName));
    await openPage();
    await waitFor(() => expect(awareness.getLocalState()?.knotebook).toBeDefined());

    expect(screen.queryByRole("group", GROUP)).toBeNull();
  });

  it("viewer: the local knotebook.role is viewer", async () => {
    collab.state = { phase: "connected", role: "viewer" };
    await openPage({ ...NOTE, role: "viewer" });

    await waitFor(() => expect(awareness.getLocalState()?.knotebook).toMatchObject({ role: "viewer" }));
  });

  it("changing the display name: knotebook.since is updated", async () => {
    const { queryClient } = await openPage();
    await waitFor(() => expect(awareness.getLocalState()?.knotebook).toBeDefined());
    const first = (awareness.getLocalState()!.knotebook as { since: number }).since;

    const now = vi.spyOn(Date, "now").mockReturnValue(first + 60_000);
    try {
      act(() => {
        queryClient.setQueryData(["me"], { ...USER, displayName: "Bea" });
      });
      await waitFor(() => expect((awareness.getLocalState()?.knotebook as { since: number }).since).toBe(first + 60_000));
    } finally {
      now.mockRestore();
    }
  });
});

describe("note tag row", () => {
  const AWS = { id: "t1", name: "AWS", color: "blue" as const };
  const BUDGET = { id: "t2", name: "Budget", color: "green" as const };
  let calls: string[];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connected", role: "owner" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    collab.onUnauthorized = undefined;
    window.history.replaceState(null, "", "/");
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  async function openWith(note: NoteDto, tags: Array<typeof AWS | typeof BUDGET>) {
    const listed: NoteDto = { ...note, tags };
    const { fn, calls: seen } = withEditsAndList(mockFetch(note), () => [listed]);
    calls = seen;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/tags" && (init?.method ?? "GET") === "GET") {
        seen.push("GET /api/tags");
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      return fn(input, init);
    });
    renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
  }

  it("the tag row is the editor's content-top slot: after the header, before the content, in the wide and the phone layout", async () => {
    for (const tier of ["docked", "phone"] as const) {
      stubLayoutTier(tier);
      await openWith(NOTE, [AWS, BUDGET]);
      const top = screen.getByTestId("mock-content-top");
      await waitFor(() => expect(within(top).getByText("AWS")).toBeInTheDocument());
      const header = document.querySelector("header")!;
      expect(header.contains(top)).toBe(false);
      expect(header.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(top.compareDocumentPosition(screen.getByTestId("mock-content")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(header).queryByText("AWS")).toBeNull();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("the header's classes are exactly the same with and without tags", async () => {
    function headerClasses(): string {
      const header = document.querySelector("header")!;
      return [header, ...header.querySelectorAll("*")].map((el) => el.getAttribute("class") ?? "").join("|");
    }
    await openWith(NOTE, []);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toBeInTheDocument());
    const without = headerClasses();
    cleanup();
    await openWith(NOTE, [AWS, BUDGET]);
    await waitFor(() => expect(within(screen.getByTestId("mock-content-top")).getByText("AWS")).toBeInTheDocument());
    expect(headerClasses()).toBe(without);
  });

  it("a note without tags leaves the slot empty", async () => {
    await openWith(NOTE, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    await act(async () => {});
    expect(screen.getByTestId("mock-content-top")).toBeEmptyDOMElement();
  });

  it("the owner gets Add and remove buttons; an edit share on a personal note gets the pills only and no space-list request", async () => {
    await openWith(NOTE, [AWS]);
    const top = screen.getByTestId("mock-content-top");
    await waitFor(() => expect(within(top).getByRole("button", { name: "Add a tag" })).toBeInTheDocument());
    expect(within(top).getByRole("button", { name: "Remove tag AWS" })).toBeInTheDocument();
    await act(async () => {});
    expect(calls).not.toContain("GET /api/tags");
    fireEvent.click(within(top).getByRole("button", { name: "Add a tag" }));
    await waitFor(() => expect(calls).toContain("GET /api/tags"));
    cleanup();

    calls = [];
    collab.state = { phase: "connected", role: "editor" };
    await openWith({ ...NOTE, role: "editor", ownerId: "u2", permissions: EDITOR_PERMS }, [AWS]);
    const shared = screen.getByTestId("mock-content-top");
    await waitFor(() => expect(within(shared).getByText("AWS")).toBeInTheDocument());
    await act(async () => {});
    expect(within(shared).queryByRole("button")).toBeNull();
    expect(calls).not.toContain("GET /api/tags");
  });

  function openHeaderMenu(): void {
    fireEvent.pointerDown(within(document.querySelector("header")!).getByRole("button", { name: "More" }), { button: 0 });
  }

  it("the owner's /tag entry and header Add tag open the input on a note without tags; blurring it folds the row away again", async () => {
    await openWith(NOTE, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    const top = screen.getByTestId("mock-content-top");
    expect(screen.getByTestId("note-editor")).toHaveAttribute("data-tag-entry", "true");

    fireEvent.click(screen.getByRole("button", { name: "mock-slash-tag" }));
    const viaSlash = await within(top).findByRole("combobox", { name: "Tag name" });
    expect(document.activeElement).toBe(viaSlash);
    fireEvent.blur(viaSlash);
    await waitFor(() => expect(top).toBeEmptyDOMElement());

    openHeaderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add tag" }));
    const viaMenu = await within(top).findByRole("combobox", { name: "Tag name" });
    expect(document.activeElement).toBe(viaMenu);
  });

  it("Esc out of the empty input from the header menu puts focus back on the more button", async () => {
    await openWith(NOTE, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    openHeaderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add tag" }));
    const input = await within(screen.getByTestId("mock-content-top")).findByRole("combobox", { name: "Tag name" });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(within(document.querySelector("header")!).getByRole("button", { name: "More" })));
  });

  it("with a version preview open the header menu has no Add tag (the tag row is hidden then)", async () => {
    await openWith(NOTE, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    fireEvent.click(screen.getByText("mock-start-preview"));
    await screen.findByTestId("mock-preview-slot");
    openHeaderMenu();
    await screen.findByRole("menuitem", { name: /Copy link/ });
    expect(screen.queryByRole("menuitem", { name: "Add tag" })).toBeNull();
  });

  it("an edit share and a viewer get no tag entry: no /tag, no Add tag in the header menu", async () => {
    collab.state = { phase: "connected", role: "editor" };
    await openWith({ ...NOTE, role: "editor", ownerId: "u2", permissions: EDITOR_PERMS }, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    expect(screen.getByTestId("note-editor")).toHaveAttribute("data-tag-entry", "false");
    openHeaderMenu();
    await screen.findByRole("menuitem", { name: /Copy link/ });
    expect(screen.queryByRole("menuitem", { name: "Add tag" })).toBeNull();
    cleanup();

    collab.state = { phase: "connected", role: "viewer" };
    await openWith({ ...NOTE, role: "viewer", ownerId: "u2", permissions: VIEWER_PERMS }, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    expect(screen.getByTestId("note-editor")).toHaveAttribute("data-tag-entry", "false");
    openHeaderMenu();
    await screen.findByRole("menuitem", { name: /Copy link/ });
    expect(screen.queryByRole("menuitem", { name: "Add tag" })).toBeNull();
  });

  it("the tag entry hands #name batches to the tag API and reads the note's current tags", async () => {
    await openWith(NOTE, [AWS]);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    await waitFor(() => expect(screen.getByTestId("mock-current-tag-names")).toHaveTextContent("AWS"));
    const base = fetch as unknown as typeof fetch;
    const bodies: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `/api/notes/${NOTE.id}/tags` && init?.method === "POST") {
        bodies.push(String(init.body));
        const tag = { id: "t9", name: "Alpha", color: "purple" };
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tags: [AWS, tag], tag, attached: true }) }));
      }
      return base(input, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "mock-apply-hash" }));
    await waitFor(() => expect(bodies).toEqual([JSON.stringify({ name: "Alpha" })]));
    await screen.findByText("Tags added: Alpha");
  });

  it("an edit share and a viewer get no #name batch entry either", async () => {
    collab.state = { phase: "connected", role: "editor" };
    await openWith({ ...NOTE, role: "editor", ownerId: "u2", permissions: EDITOR_PERMS }, []);
    await waitFor(() => expect(calls).toContain("GET /api/notes"));
    expect(screen.queryByRole("button", { name: "mock-apply-hash" })).toBeNull();
  });

  it("a viewer gets the pills only", async () => {
    collab.state = { phase: "connected", role: "viewer" };
    await openWith({ ...NOTE, role: "viewer", ownerId: "u2", permissions: VIEWER_PERMS }, [AWS]);
    const top = screen.getByTestId("mock-content-top");
    await waitFor(() => expect(within(top).getByText("AWS")).toBeInTheDocument());
    expect(within(top).queryByRole("button")).toBeNull();
  });
});
