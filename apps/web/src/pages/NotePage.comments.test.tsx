import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import * as Y from "yjs";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import type { CollabState } from "@/collab/connection";
import { ThemeProvider } from "@/theme";
import { ActiveNoteProvider } from "@/lib/active-note";
import { AppShellLayout } from "@/components/AppShellLayout";
import { OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { pressTrigger } from "@/test/menu-trigger";
import { cid, comment, createLiveSource } from "@/test/comment-fixtures";

// The editor is a stand-in (as in NotePage.test.tsx); it shows both right-hand panel states and opens them.
vi.mock("@/components/NoteEditor", async () => {
  const { useVersions } = await import("@/lib/versions-context");
  const { useComments } = await import("@/lib/comments-context");
  function NoteEditorMock({ headerSlot }: { headerSlot?: React.ReactNode }) {
    const versions = useVersions();
    const comments = useComments();
    return (
      <div data-testid="note-editor">
        {headerSlot}
        <span data-testid="panels">
          {JSON.stringify({ versions: versions.enabled, comments: comments.enabled, versionsOpen: versions.panelOpen, commentsMode: comments.mode, target: comments.target })}
        </span>
        <button type="button" onClick={() => versions.open()}>mock-open-versions</button>
        <button type="button" onClick={() => comments.open()}>mock-open-comments</button>
      </div>
    );
  }
  return { NoteEditor: NoteEditorMock };
});

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => 600 }));

const collab = vi.hoisted(() => ({
  doc: undefined as unknown as Y.Doc,
  state: { phase: "connected", role: "owner" } as CollabState,
  provider: undefined as unknown as { on: (...a: never[]) => void; off: (...a: never[]) => void; synced: boolean },
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ noteId }: { noteId: string | undefined }) => ({
    state: collab.state,
    doc: collab.doc,
    provider: collab.provider,
    synced: true,
    syncedFor: noteId ?? null,
  }),
}));

const { default: NotePage } = await import("./NotePage");

const USER: UserDto = {
  id: "u-alice",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const ownerNote: NoteDto = {
  id: NOTE_ID,
  title: "My Note",
  ownerId: "u-alice",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "alice",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function stubFetch(note: NoteDto) {
  const comments = `/api/notes/${NOTE_ID}/comments`;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url === `${comments}/read`) return json(null, 204);
      if (method !== "GET") return json({}, 204);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/auth/config") return json({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true });
      if (url === "/api/groups" || url === "/api/favorites" || url === "/api/notes") return json([]);
      if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
      if (url === `${comments}?limit=50`) return json({ comments: [comment(1, { noteId: NOTE_ID, body: "hello from bob" })], olderCursor: null, newerCursor: null });
      if (url.startsWith(`/api/notes/${NOTE_ID}/versions`)) return json({ versions: [], current: { baseSeq: null, base: null, dirty: false, nextSeq: 1, autoEnabled: true }, nextBefore: null });
      if (url.endsWith("/backlinks")) return json({ backlinks: [] });
      if (url.startsWith("/api/notes/") && !url.slice("/api/notes/".length).includes("/")) return json(note);
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    }),
  );
}

// The mocked collab state is read on render: a navigation re-renders the page.
const nav: { go: (to: string) => void } = { go: () => {} };

function SearchProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  nav.go = (to) => navigate(to);
  return <span data-testid="search">{location.search}</span>;
}

function renderPage(entry = "/notes/my-note") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <ActiveNoteProvider>
            <SearchProbe />
            <Routes>
              <Route element={<AppShellLayout />}>
                <Route path="/notes/:ref" element={<NotePage />} />
                <Route path="/n/:handle/:slug" element={<NotePage />} />
              </Route>
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const panels = () => JSON.parse(screen.getByTestId("panels").textContent!) as { versions: boolean; comments: boolean; versionsOpen: boolean; commentsMode: string | null; target: string | null };

describe("NotePage comments", () => {
  let live: ReturnType<typeof createLiveSource>;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    collab.doc = new Y.Doc();
    collab.state = { phase: "connected", role: "owner" };
    live = createLiveSource();
    collab.provider = Object.assign(live, { synced: true });
  });
  afterEach(() => {
    collab.doc.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("only one right-hand panel at a time: opening comments closes the version history and the other way round; the note's provider carries the live messages", async () => {
    stubLayoutTier("docked");
    stubFetch(ownerNote);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "mock-open-versions" }));
    expect(panels()).toMatchObject({ versionsOpen: true, commentsMode: null });
    fireEvent.click(screen.getByRole("button", { name: "mock-open-comments" }));
    expect(panels()).toMatchObject({ versionsOpen: false, commentsMode: "panel" });
    fireEvent.click(screen.getByRole("button", { name: "mock-open-versions" }));
    expect(panels()).toMatchObject({ versionsOpen: true, commentsMode: null });
    expect(live.count("stateless")).toBe(1);
    expect(live.count("synced")).toBeGreaterThanOrEqual(1);
  });

  it("a viewer has comments but no version history", async () => {
    stubLayoutTier("docked");
    collab.state = { phase: "connected", role: "viewer" };
    stubFetch({ ...ownerNote, role: "viewer", ownerId: "u-bob", ownerHandle: "bob", permissions: VIEWER_PERMS });
    renderPage();
    await screen.findByTestId("panels");
    await waitFor(() => expect(panels()).toMatchObject({ versions: false, comments: true }));
  });

  it("phone: ⋮ 'Comments' opens the full-page sheet with the thread; Back closes it", async () => {
    stubLayoutTier("phone");
    stubFetch(ownerNote);
    renderPage();
    await screen.findByTestId("panels");
    pressTrigger(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comments" }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(await within(sheet).findByText("hello from bob")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull());
    expect(panels().commentsMode).toBeNull();
  });

  it("phone: the switch at the top of the sheet moves between the comments and the version history; focus stays in the open sheet and the unsent comment comes back", async () => {
    stubLayoutTier("phone");
    stubFetch(ownerNote);
    renderPage();
    await screen.findByTestId("panels");
    const more = screen.getByRole("button", { name: "More" });
    pressTrigger(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comments" }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    const switcher = within(sheet).getByRole("group", { name: "Note panels" });
    expect(within(switcher).getByRole("button", { name: "Comments" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Comment" }), { target: { value: "half a thought" } });
    const menuFocus = vi.spyOn(more, "focus");

    fireEvent.click(within(switcher).getByRole("button", { name: "Version history" }));
    const versionsSheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(panels()).toMatchObject({ commentsMode: null });
    const back = within(versionsSheet).getByRole("group", { name: "Note panels" });
    expect(within(back).getByRole("button", { name: "Version history" })).toHaveAttribute("aria-pressed", "true");
    // The closed sheet hands focus back a task later; it must not pull it out of the open one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(versionsSheet.contains(document.activeElement)).toBe(true);
    expect(menuFocus).not.toHaveBeenCalled();

    fireEvent.click(within(back).getByRole("button", { name: "Comments" }));
    const again = await screen.findByRole("dialog", { name: "Comments" });
    expect(screen.queryByRole("dialog", { name: "Version history" })).toBeNull();
    expect(within(again).getByRole("textbox", { name: "Comment" })).toHaveValue("half a thought");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(again.contains(document.activeElement)).toBe(true);
    expect(menuFocus).not.toHaveBeenCalled();
  });

  it("phone: a viewer's comments sheet has no switch (no version history)", async () => {
    stubLayoutTier("phone");
    collab.state = { phase: "connected", role: "viewer" };
    stubFetch({ ...ownerNote, role: "viewer", ownerId: "u-bob", ownerHandle: "bob", permissions: VIEWER_PERMS });
    renderPage();
    await screen.findByTestId("panels");
    pressTrigger(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comments" }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(await within(sheet).findByText("hello from bob")).toBeInTheDocument();
    expect(within(sheet).queryByRole("group", { name: "Note panels" })).toBeNull();
  });

  it.each([
    ["connected without access", { phase: "connected", role: "none" } as CollabState],
    ["kicked", { phase: "kicked" } as CollabState],
  ])("losing access (%s) closes the open comments and removes their text", async (_name, lost) => {
    stubLayoutTier("phone");
    stubFetch(ownerNote);
    renderPage();
    await screen.findByTestId("panels");
    pressTrigger(screen.getByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comments" }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(await within(sheet).findByText("hello from bob")).toBeInTheDocument();
    collab.state = lost;
    act(() => nav.go("/notes/my-note?x=1"));
    await waitFor(() => expect(screen.queryByText("hello from bob")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
  });

  it("?comment=<id> opens the comments at that comment and drops the parameter; other search parameters stay", async () => {
    stubLayoutTier("docked");
    stubFetch(ownerNote);
    renderPage(`/notes/my-note?x=1&comment=${cid(3).toUpperCase()}`);
    await waitFor(() => expect(panels()).toMatchObject({ commentsMode: "panel", target: cid(3) }));
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent(/^\?x=1$/));
  });

  it("?comment= that isn't a comment id is dropped without opening anything", async () => {
    stubLayoutTier("docked");
    stubFetch(ownerNote);
    renderPage("/notes/my-note?comment=%22%5D");
    await screen.findByTestId("panels");
    await waitFor(() => expect(screen.getByTestId("search")).toBeEmptyDOMElement());
    expect(panels().commentsMode).toBeNull();
  });
});
