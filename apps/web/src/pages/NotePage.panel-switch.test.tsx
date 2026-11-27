import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import * as Y from "yjs";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import type { CollabState } from "@/collab/connection";
import { ThemeProvider } from "@/theme";
import { ActiveNoteProvider } from "@/lib/active-note";
import { AppShellLayout } from "@/components/AppShellLayout";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { pressTrigger } from "@/test/menu-trigger";
import { comment, createLiveSource } from "@/test/comment-fixtures";

// Its own file: the sheets' lazy chunks must not have been rendered yet by an earlier test.

vi.mock("@/components/NoteEditor", () => ({
  NoteEditor: ({ headerSlot }: { headerSlot?: React.ReactNode }) => <div data-testid="note-editor">{headerSlot}</div>,
}));

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

function stubFetch() {
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
      if (url.startsWith("/api/notes/") && !url.slice("/api/notes/".length).includes("/")) return json(ownerNote);
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    }),
  );
}

describe("NotePage panel switch", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    collab.doc = new Y.Doc();
    collab.state = { phase: "connected", role: "owner" };
    collab.provider = Object.assign(createLiveSource(), { synced: true });
  });
  afterEach(() => {
    collab.doc.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("phone: the first switch from the comments sheet to the version history shows the version history sheet in the same commit", async () => {
    stubLayoutTier("phone");
    stubFetch();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <ActiveNoteProvider>
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
    pressTrigger(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Comments" }));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    // Stands in for the time spent reading the comments: the module finishes loading and its callbacks run.
    await act(async () => {
      await import("@/components/versions/VersionsLazy");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(within(within(sheet).getByRole("group", { name: "Note panels" })).getByRole("button", { name: "Version history" }));
    expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Version history" })).toBeInTheDocument();
  });
});
