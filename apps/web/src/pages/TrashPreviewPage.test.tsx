import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { EMPTY_YDOC_UPDATE_B64, type NoteDto, type TrashPreviewDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { trashItem } from "@/test/trash-fixtures";
import TrashPreviewPage from "./TrashPreviewPage";

vi.mock("@/components/TrashPreviewEditor", () => ({
  TrashPreviewEditor: ({ noteId }: { noteId: string }) => <div data-testid="mock-trash-preview-editor">{noteId}</div>,
}));

const NOTE_ID = "11111111-1111-4111-8111-111111111111";

const PREVIEW: TrashPreviewDto = {
  ...trashItem({ id: NOTE_ID, title: "Old Draft" }, { deletedDaysAgo: 0 }),
  ydoc: EMPTY_YDOC_UPDATE_B64,
};

const RESTORED: NoteDto = {
  id: NOTE_ID,
  title: "Old Draft",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "old-draft",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
  folderId: null,
};

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function LocationProbe() {
  const { pathname } = useLocation();
  const { activeNoteId } = useActiveNote();
  return (
    <>
      <span data-testid="pathname">{pathname}</span>
      <span data-testid="active-note">{activeNoteId ?? ""}</span>
    </>
  );
}

function renderPage(entry = `/trash/${NOTE_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <ActiveNoteProvider>
          <SidebarDrawerContext.Provider value={{ setOpen: vi.fn() }}>
            <SidebarTabProvider>
              <Routes>
                <Route path="/trash/:id" element={<TrashPreviewPage />} />
                <Route path="/n/:handle/:slug" element={<div>restored note view</div>} />
                <Route path="/" element={<div>home landing</div>} />
              </Routes>
              <LocationProbe />
            </SidebarTabProvider>
          </SidebarDrawerContext.Provider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}

describe("TrashPreviewPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("loads preview from /api/trash/:id, sets activeNoteId, and omits Go to trash button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === `/api/trash/${NOTE_ID}`) return Promise.resolve(fakeResponse(PREVIEW));
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );

    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "Old Draft" })).toBeInTheDocument();
    expect(screen.getByTestId("mock-trash-preview-editor")).toHaveTextContent(NOTE_ID);
    expect(screen.getByTestId("active-note")).toHaveTextContent(NOTE_ID);
    expect(screen.queryByRole("button", { name: "Go to trash" })).toBeNull();
  });

  it("restore navigates to the restored note's canonical URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === `/api/trash/${NOTE_ID}` && method === "GET") return Promise.resolve(fakeResponse(PREVIEW));
        if (url === "/api/trash/restore" && method === "POST") return Promise.resolve(fakeResponse({ restored: [RESTORED], skipped: [] }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    renderPage();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(screen.getByTestId("pathname")).toHaveTextContent("/n/tester/old-draft"));
    expect(screen.getByText("restored note view")).toBeInTheDocument();
  });

  it("delete permanently confirms, purges, and navigates home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === `/api/trash/${NOTE_ID}` && method === "GET") return Promise.resolve(fakeResponse(PREVIEW));
        if (url === "/api/trash/purge" && method === "POST") return Promise.resolve(fakeResponse({ purged: [NOTE_ID], skipped: [] }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    renderPage();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/"));
    expect(screen.getByText("home landing")).toBeInTheDocument();
  });

  it("initial 404 shows invalid-link toast and redirects home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === `/api/trash/${NOTE_ID}`) return Promise.resolve(fakeResponse({ error: { code: "not_found", message: "x" } }, 404));
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/"));
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
  });

  it("404 after loaded (e.g. purged from sidebar) navigates home without an invalid-link toast", async () => {
    let gone = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === `/api/trash/${NOTE_ID}`) {
          return Promise.resolve(
            gone ? fakeResponse({ error: { code: "not_found", message: "x" } }, 404) : fakeResponse(PREVIEW),
          );
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );

    const { queryClient } = renderPage();
    await screen.findByTestId("mock-trash-preview-editor");

    gone = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });

    await waitFor(() => expect(screen.getByTestId("pathname").textContent).toBe("/"));
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).toBeNull();
  });

  it("404 after loaded when sidebar restore seeded ['note', id] navigates to the restored note's canonical URL", async () => {
    let gone = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === `/api/trash/${NOTE_ID}`) {
          return Promise.resolve(
            gone ? fakeResponse({ error: { code: "not_found", message: "x" } }, 404) : fakeResponse(PREVIEW),
          );
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );

    const { queryClient } = renderPage();
    await screen.findByTestId("mock-trash-preview-editor");

    gone = true;
    await act(async () => {
      queryClient.setQueryData(["note", NOTE_ID], RESTORED);
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });

    await waitFor(() => expect(screen.getByTestId("pathname")).toHaveTextContent("/n/tester/old-draft"));
    expect(screen.getByText("restored note view")).toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).toBeNull();
  });
});
