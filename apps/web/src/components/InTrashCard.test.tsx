import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_YDOC_UPDATE_B64, type NoteDto, type TrashPreviewDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { SidebarTabProvider, useSidebarTabState } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import * as toastModule from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { trashItem } from "@/test/trash-fixtures";
import { InTrashCard } from "./InTrashCard";

vi.mock("@/components/TrashPreviewEditor", () => ({
  TrashPreviewEditor: ({ noteId, ydoc }: { noteId: string; ydoc: string }) => (
    <div data-testid="mock-trash-preview-editor" data-note-id={noteId} data-ydoc={ydoc}>
      preview content
    </div>
  ),
}));

// The part wired into NotePage is in pages/NotePage.test.tsx; /trash/:id is in pages/TrashPreviewPage.test.tsx.

afterEach(() => {
  localStorage.clear();
});

const NOTE_ID = "n1";

const PREVIEW: TrashPreviewDto = {
  ...trashItem({ id: NOTE_ID, title: "Trashed Note", folderPath: ["Work"] }, { deletedDaysAgo: 1 }),
  ydoc: EMPTY_YDOC_UPDATE_B64,
};

const RESTORED: NoteDto = {
  id: NOTE_ID,
  title: "Trashed Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "trashed",
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

interface StubOpts {
  preview?: { status: number; body: unknown } | "pending";
  restore?: { status: number; body: unknown };
  purge?: { status: number; body: unknown };
  hold?: Promise<void>;
}

function stubServer(opts: StubOpts = {}) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === `/api/trash/${NOTE_ID}` && method === "GET") {
        if (opts.preview === "pending") return new Promise<Response>(() => {});
        const reply = opts.preview ?? { status: 200, body: PREVIEW };
        return Promise.resolve(fakeResponse(reply.body, reply.status));
      }
      if (url === "/api/trash/restore" && method === "POST") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        const reply = opts.restore ?? { status: 200, body: { restored: [RESTORED], skipped: [] } };
        const make = () => fakeResponse(reply.body, reply.status);
        return opts.hold ? opts.hold.then(make) : Promise.resolve(make());
      }
      if (url === "/api/trash/purge" && method === "POST") {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        const reply = opts.purge ?? { status: 200, body: { purged: [NOTE_ID], skipped: [] } };
        const make = () => fakeResponse(reply.body, reply.status);
        return opts.hold ? opts.hold.then(make) : Promise.resolve(make());
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return {
    posts: (path: string) => posts.filter((p) => p.url === path).map((p) => p.body),
  };
}

function TabProbe() {
  const { tab } = useSidebarTabState();
  return <span data-testid="tab-probe">{tab}</span>;
}

function renderCard(props: { showGoToTrash?: boolean } = {}) {
  const onRestored = vi.fn();
  const onPurged = vi.fn();
  const onNotFound = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SidebarDrawerContext.Provider value={{ setOpen: vi.fn() }}>
        <SidebarTabProvider>
          <InTrashCard
            noteId={NOTE_ID}
            onRestored={onRestored}
            onPurged={onPurged}
            onNotFound={onNotFound}
            showGoToTrash={props.showGoToTrash}
          />
          <TabProbe />
        </SidebarTabProvider>
      </SidebarDrawerContext.Provider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { onRestored, onPurged, onNotFound, queryClient };
}

/** Radix Toast Root (`<li>`): the variant class is on it. */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

const restoreButton = () => screen.getByRole("button", { name: "Restore" });
const purgeButton = () => screen.getByRole("button", { name: "Delete permanently" });

describe("InTrashCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("while loading, renders only one heading named 'This note is in the trash'", () => {
    stubServer({ preview: "pending" });
    renderCard();

    expect(screen.getAllByRole("heading", { name: "This note is in the trash" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("renders title, read-only badge, trash banner with retention info, preview content, and three actions", async () => {
    stubServer();
    renderCard();

    expect(await screen.findByRole("heading", { level: 1, name: "Trashed Note" })).toBeInTheDocument();
    expect(screen.getByText("Read-only", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "This note is in the trash" })).toBeInTheDocument();
    expect(screen.getByTestId("trash-preview-banner")).toHaveTextContent(/Work · 3 days left/);
    expect(screen.getByTestId("mock-trash-preview-editor")).toHaveAttribute("data-note-id", NOTE_ID);
    expect(restoreButton()).toBeEnabled();
    expect(purgeButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Go to trash" })).toBeEnabled();
  });

  it("hides Go to trash button when showGoToTrash is false", async () => {
    stubServer();
    renderCard({ showGoToTrash: false });
    await screen.findByTestId("mock-trash-preview-editor");
    expect(screen.queryByRole("button", { name: "Go to trash" })).toBeNull();
  });

  it("restore success: sends {ids:[n1]}, passes restored NoteDto to onRestored, no toast", async () => {
    const server = stubServer();
    const toastSpy = vi.spyOn(toastModule, "toast");
    onTestFinished(() => toastSpy.mockRestore());
    const { onRestored } = renderCard();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(restoreButton());

    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(RESTORED));
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: [NOTE_ID] }]);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("while restoring, Restore and Delete permanently are disabled and recover on completion", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({ hold });
    const { onRestored } = renderCard();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(restoreButton());
    await waitFor(() => expect(restoreButton()).toBeDisabled());
    expect(purgeButton()).toBeDisabled();
    expect(onRestored).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restoreButton()).toBeEnabled());
  });

  it("restore all skipped: destructive toast, onRestored called with null", async () => {
    stubServer({ restore: { status: 200, body: { restored: [], skipped: [{ id: NOTE_ID, reason: "not_in_trash" }] } } });
    const { onRestored } = renderCard();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(restoreButton());

    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(null));
  });

  it("restore failure (500): error toast, onRestored not called, button usable again", async () => {
    stubServer({ restore: { status: 500, body: { error: { code: "internal", message: "x" } } } });
    const { onRestored } = renderCard();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(restoreButton());

    const title = "Something went wrong. Please try again.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    await waitFor(() => expect(restoreButton()).toBeEnabled());
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("delete permanently: opens confirm dialog, cancel sends nothing, confirm purges and calls onPurged", async () => {
    const server = stubServer();
    const { onPurged } = renderCard();
    await screen.findByTestId("mock-trash-preview-editor");

    fireEvent.click(purgeButton());
    let dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(onPurged).not.toHaveBeenCalled();

    fireEvent.click(purgeButton());
    dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(onPurged).toHaveBeenCalledTimes(1));
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: [NOTE_ID] }]);
    expect(await screen.findByText("Permanently deleted 1 note", { exact: true })).toBeInTheDocument();
  });

  it("preview fetch 500: shows error alert in body while Restore and Delete permanently remain usable", async () => {
    stubServer({ preview: { status: 500, body: { error: { code: "internal", message: "x" } } } });
    renderCard();

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(restoreButton()).toBeEnabled();
    expect(purgeButton()).toBeEnabled();
  });

  it("preview fetch 404: invokes onNotFound with afterLoad=false", async () => {
    stubServer({ preview: { status: 404, body: { error: { code: "not_found", message: "No note with that id." } } } });
    const { onNotFound } = renderCard();

    await waitFor(() => expect(onNotFound).toHaveBeenCalledWith({ afterLoad: false }));
  });

  it("go to trash: via actions' showTab, localStorage and the same provider's state are both trash", async () => {
    stubServer();
    renderCard();
    await screen.findByTestId("mock-trash-preview-editor");
    expect(screen.getByTestId("tab-probe")).toHaveTextContent("myNotes");

    fireEvent.click(screen.getByRole("button", { name: "Go to trash" }));

    expect(localStorage.getItem("sidebar.tab")).toBe("trash");
    await waitFor(() => expect(screen.getByTestId("tab-probe")).toHaveTextContent("trash"));
  });
});
