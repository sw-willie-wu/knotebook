import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, TrashItemDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { hoverReveal } from "@/components/ui/reveal";
import { OWNER_PERMS } from "@/test/fixtures";
import { TRASH_ME, trashItem, trashList } from "@/test/trash-fixtures";
import { trashDetailLine } from "@/lib/trash-display";
import { TrashPanel } from "./TrashPanel";

// Wraps only to count which rows recompute their second line; behavior unchanged.
vi.mock("@/lib/trash-display", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trash-display")>();
  return { ...actual, trashDetailLine: vi.fn(actual.trashDetailLine) };
});


afterEach(() => {
  localStorage.clear();
});

/** Session stub: a full UserDto whose handle/displayName match `TRASH_ME` (the empty-trash dialog's "includes other members" compares handles). */
const USER: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: TRASH_ME.handle,
  displayName: TRASH_ME.displayName,
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const AMY = { handle: "amy", displayName: "Amy" };
const RD = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" };

const P1 = trashItem({ id: "p1", title: "p1" }, { deletedDaysAgo: 0 });
const P2 = trashItem({ id: "p2", title: "p2" }, { deletedDaysAgo: 1 });
const W1 = trashItem({ id: "w1", title: "w1", group: RD, deletedBy: AMY }, { deletedDaysAgo: 2 });
/** Notes inside folders: personal A > B, group 研發組 > 團隊週報. */
const PF = trashItem({ id: "pf", title: "pf", folderPath: ["A", "B"] });
const WF = trashItem({ id: "wf", title: "wf", group: { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "研發組" }, deletedBy: AMY, folderPath: ["團隊週報"] });

/** NoteDto returned on restore success (only id must be right; `useRestoreTrash` uses it to overwrite the persistent layer). */
function restoredNote(item: TrashItemDto): NoteDto {
  return {
    id: item.id,
    title: item.title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: item.id,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
    folderId: null,
  };
}

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

type Reply = { status: number; body: unknown };

interface ServerOpts {
  items?: TrashItemDto[];
  truncated?: boolean;
  /** `GET /api/trash`: `"pending"` never responds; a number is the error status code. */
  list?: "pending" | number;
  /** Default: every listed note restores successfully, the rest are skipped, and restored ones leave the list. */
  restore?: (ids: string[]) => Reply;
  /** Same default for purge. `call` is 1-based. */
  purge?: (ids: string[], call: number) => Reply;
  /** When given, restore/purge default replies wait for it to resolve (to test the in-flight state). */
  hold?: Promise<void>;
}

function stubServer(opts: ServerOpts = {}) {
  let items = [...(opts.items ?? [])];
  const calls: { method: string; url: string; body: unknown }[] = [];
  let purgeCall = 0;
  const take = (ids: string[]) => {
    const hit = items.filter((item) => ids.includes(item.id));
    items = items.filter((item) => !ids.includes(item.id));
    const skipped = ids.filter((id) => !hit.some((item) => item.id === id)).map((id) => ({ id, reason: "not_in_trash" }));
    return { hit, skipped };
  };
  const after = (make: () => Response) => (opts.hold ? opts.hold.then(make) : Promise.resolve(make()));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/trash" && method === "GET") {
        if (opts.list === "pending") return new Promise<Response>(() => {});
        if (typeof opts.list === "number") return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, opts.list));
        return Promise.resolve(fakeResponse(trashList(items, { truncated: opts.truncated ?? false })));
      }
      if (url === "/api/trash/restore" && method === "POST") {
        const ids = (body as { ids: string[] }).ids;
        const reply = opts.restore?.(ids);
        if (reply) return Promise.resolve(fakeResponse(reply.body, reply.status));
        return after(() => {
          const { hit, skipped } = take(ids);
          return fakeResponse({ restored: hit.map(restoredNote), skipped });
        });
      }
      if (url === "/api/trash/purge" && method === "POST") {
        const ids = (body as { ids: string[] }).ids;
        purgeCall += 1;
        const reply = opts.purge?.(ids, purgeCall);
        if (reply) {
          if (reply.status < 400) take(ids);
          return Promise.resolve(fakeResponse(reply.body, reply.status));
        }
        return after(() => {
          const { hit, skipped } = take(ids);
          return fakeResponse({ purged: hit.map((item) => item.id), skipped });
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return {
    calls,
    posts: (path: string) => calls.filter((call) => call.method === "POST" && call.url === path).map((call) => call.body),
    /** Takes effect on the next GET. */
    setItems: (next: TrashItemDto[]) => {
      items = [...next];
    },
  };
}

function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="selecting">{String(selection.active)}</span>
      <span data-testid="selected-count">{selection.keys.size}</span>
      <button type="button" data-testid="toggle-p1" onClick={() => updateSelection({ type: "toggle", key: "note:p1" })}>
        toggle p1
      </button>
    </>
  );
}

function renderPanel() {
  localStorage.setItem("sidebar.tab", "trash");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the session into the cache: the empty dialog's "includes other members" compares handles, so it must not race the list arrival.
  queryClient.setQueryData(SESSION_QUERY_KEY, USER);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div role="tabpanel">
              <TrashPanel />
            </div>
            <SelectionProbe />
            <input aria-label="outside" />
          </SidebarTabProvider>
          <Toaster />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const panel = () => screen.getByRole("tabpanel", { hidden: true });
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const row = (id: string) => panel().querySelector(`li[data-node-id="${id}"]`) as HTMLElement;
const detail = (id: string) => row(id).querySelector(".text-muted-foreground") as HTMLElement;

/** Radix Toast Root (`<li>`): the variant classes sit on it. */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

async function openRowMenu(title: string): Promise<HTMLElement> {
  // Radix DropdownMenu's trigger listens only to pointerdown.
  fireEvent.pointerDown(within(panel()).getByRole("button", { name: `Actions for ${title}` }), { button: 0 });
  return screen.findByRole("menu");
}

const BUSY = "The server is busy. Please try again shortly.";

describe("TrashPanel (normal)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("header: Trash, 3 notes, with Select (24px icon button) and Empty (red text) enabled", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 3 notes"));

    const select = within(header()).getByRole("button", { name: "Select" });
    expect(select).toHaveAttribute("title", "Select");
    expect(select.querySelector('svg[data-icon="select"]')).not.toBeNull();
    expect(select).toHaveClass("h-6", "w-6");
    expect(select).toBeEnabled();
    const empty = within(header()).getByRole("button", { name: "Empty" });
    expect(empty).toHaveClass("text-destructive");
    expect(empty).toBeEnabled();

    fireEvent.click(select);
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
  });

  it("0 notes: both buttons disabled, The trash is empty., no rows", async () => {
    stubServer({ items: [] });
    renderPanel();
    expect(await within(panel()).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(header()).toHaveTextContent("Trash · 0 notes");
    expect(within(header()).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
    expect(within(panel()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("loading: title Trash, both buttons disabled", async () => {
    stubServer({ list: "pending" });
    renderPanel();
    expect(await within(panel()).findByText("Loading…", { exact: true })).toBeInTheDocument();
    expect(within(header()).getByText("Trash", { exact: true })).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
  });

  it("pressing Select again in select mode does not resend start (ticked notes are not cleared)", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 3 notes"));
    const select = within(header()).getByRole("button", { name: "Select" });
    fireEvent.click(select);
    fireEvent.click(screen.getByTestId("toggle-p1"));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");

    // In select mode the header swaps to the selected-count form: the Select button is unmounted, so a click on it cannot send start.
    expect(select.isConnected).toBe(false);
    expect(within(header()).queryByRole("button", { name: "Select" })).toBeNull();
    fireEvent.click(select);
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");
  });

  it("two sections: My notes first, server order within a section; with only one section the other's heading is not rendered", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    const headings = within(panel()).getAllByRole("heading", { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(["My notes", "Groups"]);
    const personal = within(panel()).getByRole("list", { name: "My notes" });
    expect([...personal.querySelectorAll("li[data-node-id]")].map((li) => li.getAttribute("data-node-id"))).toEqual(["p1", "p2"]);
    const workspace = within(panel()).getByRole("list", { name: "Groups" });
    expect([...workspace.querySelectorAll("li[data-node-id]")].map((li) => li.getAttribute("data-node-id"))).toEqual(["w1"]);
  });

  it("only personal items -> no Groups heading", async () => {
    stubServer({ items: [P1, P2] });
    renderPanel();
    await waitFor(() => expect(row("p2")).not.toBeNull());
    expect(within(panel()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["My notes"]);
  });

  it("only group items -> no My notes heading; the empty dialog has no My notes row either", async () => {
    stubServer({ items: [W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(panel()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Groups"]);
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Groups: 1 note (including some deleted by other members)",
    ]);
  });

  it("row: second line, title, links to /trash/:id in normal mode, data-node-*", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(detail("p1")).toHaveTextContent(/^3 days left$/);
    expect(detail("w1")).toHaveTextContent(/^R&D · Deleted by Amy · 3 days left$/);
    expect(row("p1").getAttribute("title")).toContain("Moved to the trash");
    const links = within(panel()).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/trash/p1", "/trash/p2", "/trash/w1"]);
    for (const id of ["p1", "p2", "w1"]) {
      expect(row(id)).toHaveAttribute("data-node-kind", "note");
      expect(row(id)).toHaveAttribute("data-node-id", id);
    }
  });

  it("trash rows have no favorite star", async () => {
    stubServer({ items: [P1, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(panel()).queryAllByRole("button", { name: "Favorite", hidden: true })).toHaveLength(0);
  });

  // Folders: the second-line element carries the location segment as its title; root level (empty segment) has none.
  it("personal [A, B]: second-line text unchanged, the element's title is the folder path", async () => {
    stubServer({ items: [PF, P1] });
    renderPanel();
    await waitFor(() => expect(row("pf")).not.toBeNull());
    expect(detail("pf")).toHaveTextContent(/^A › B · 3 days left$/);
    expect(detail("pf")).toHaveAttribute("title", "A › B");
  });

  it("group [folder]: title is the group name and folder path", async () => {
    stubServer({ items: [WF] });
    renderPanel();
    await waitFor(() => expect(row("wf")).not.toBeNull());
    expect(detail("wf")).toHaveTextContent(/^研發組 › 團隊週報 · Deleted by Amy · 3 days left$/);
    expect(detail("wf")).toHaveAttribute("title", "研發組 › 團隊週報");
  });

  it("personal root level: the second line has no title attribute", async () => {
    stubServer({ items: [PF, P1] });
    renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    expect(detail("p1")).toHaveTextContent(/^3 days left$/);
    expect(detail("p1")).not.toHaveAttribute("title");
  });

  it("row actions: the restore button appears on hover with an icon; the kebab menu has two items with icons and a red permanent delete", async () => {
    stubServer({ items: [P1, P2, W1] });
    renderPanel();
    const restore = await within(panel()).findByRole("button", { name: "Restore p1" });
    expect(restore).toHaveClass(...hoverReveal("noterow").split(" "));
    expect(restore).toHaveClass("h-6", "w-6");
    expect(restore).toHaveAttribute("title", "Restore");
    expect(restore.querySelector('svg[data-icon="restore"]')).not.toBeNull();
    expect(within(panel()).getByRole("button", { name: "Actions for p1" })).toHaveClass(...hoverReveal("noterow").split(" "));

    const menu = await openRowMenu("p1");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Restore", "Delete permanently"]);
    expect(items[0].querySelector('svg[data-icon="restore"]')).not.toBeNull();
    expect(items[1].querySelector('svg[data-icon="trash"]')).not.toBeNull();
    expect(items[1]).toHaveClass("text-destructive");
  });

  it("restore: POSTs ids, toasts, refetches the list, focus returns to the list", async () => {
    const server = stubServer({ items: [P1, P2, W1] });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));

    await waitFor(() => expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Restored 1 note")).not.toHaveClass("bg-destructive");
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(header()).toHaveTextContent("Trash · 2 notes");
    await waitFor(() => expect(list()).toHaveFocus());
  });

  it("restore all skipped: Restored 0 notes, 1 no longer in the trash (destructive)", async () => {
    stubServer({ items: [P1], restore: (ids) => ({ status: 200, body: { restored: [], skipped: ids.map((id) => ({ id, reason: "not_in_trash" })) } }) });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
  });

  it("focus moved outside the panel while restore awaits its response -> not pulled back to the list on completion", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({ items: [P1, P2], hold });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    const outside = screen.getByRole("textbox", { name: "outside" });
    outside.focus();
    await act(async () => {
      release();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(outside).toHaveFocus();
  });

  it("focus inside the panel (on a row's restore button) -> returns to the list after restore completes", async () => {
    stubServer({ items: [P1, P2] });
    renderPanel();
    const restore = await within(panel()).findByRole("button", { name: "Restore p1" });
    restore.focus();
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(list()).toHaveFocus());
  });

  it("double-clicking restore sends once; the kebab menu's Restore takes the same path", async () => {
    const server = stubServer({ items: [P1, P2] });
    renderPanel();
    const restore = await within(panel()).findByRole("button", { name: "Restore p1" });
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await act(async () => {});
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]);

    const menu = await openRowMenu("p2");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }, { ids: ["p2"] }]));
  });

  it("restore failure (first batch fails): error title, no 'Restored 0 notes' description", async () => {
    stubServer({ items: [P1], restore: () => ({ status: 500, body: { error: { code: "internal", message: "x" } } }) });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    const title = "Something went wrong. Please try again.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(screen.queryByText(/^Restored \d+ notes?/)).toBeNull();
  });

  it("single permanent delete: confirm dialog, cancel sends nothing and returns focus to the kebab menu button, confirm sends, focus returns to the list", async () => {
    const server = stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    const trigger = within(panel()).getByRole("button", { name: "Actions for p1" });

    let menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    let dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    expect(within(dialog).getByText("The notes and their attachments will be permanently deleted. This can't be undone.", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    await waitFor(() => expect(trigger).toHaveFocus());

    menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1"] }]));
    expect(await screen.findByText("Permanently deleted 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(list()).toHaveFocus());
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1"] }]);
  });

  it("confirm button disabled while in flight, dialog closes after the response", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({ items: [P1], hold });
    renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    const menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancel after sending but before the response and open the dialog for another row -> the first response does not close the second dialog", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({ items: [P1, P2], hold });
    renderPanel();
    await waitFor(() => expect(row("p2")).not.toBeNull());
    let menu = await openRowMenu("p1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    let dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1"] }]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    menu = await openRowMenu("p2");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    await act(async () => {
      release();
    });
    expect(await screen.findByText("Permanently deleted 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Permanently delete 1 note?" })).toBe(dialog);
  });

  it("empty: the dialog's per-section counts and 'includes other members' are judged per section; confirming sends all ids on the list (list order)", async () => {
    const server = stubServer({ items: [P1, P2, W1] });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    const empty = within(header()).getByRole("button", { name: "Empty" });

    fireEvent.click(empty);
    let dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText("3 notes and their attachments will be permanently deleted. This can't be undone.", { exact: true })).toBeInTheDocument();
    const lines = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual(["My notes: 2 notes", "Groups: 1 note (including some deleted by other members)"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    await waitFor(() => expect(empty).toHaveFocus());

    fireEvent.click(empty);
    dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p1", "p2", "w1"] }]));
    expect(await screen.findByText("Permanently deleted 3 notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(panel()).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(list()).toHaveFocus());
  });

  it("list refetched to 0 notes while the empty dialog is open -> confirming sends no request, reports no 0-note result, and just closes the dialog", async () => {
    const server = stubServer({ items: [P1] });
    const { queryClient } = renderPanel();
    await waitFor(() => expect(row("p1")).not.toBeNull());
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    server.setItems([]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    // react-query notifies observers via setTimeout(0), so wait for the next macrotask before the redraw.
    expect(await within(dialog).findByText("0 notes and their attachments will be permanently deleted. This can't be undone.", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(screen.queryByText(/^Permanently deleted/)).toBeNull();
  });

  it("cancel after sending the empty request but before the response, then reopen the dialog -> the first response does not close the new dialog", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({ items: [P1, P2], hold });
    renderPanel();
    await waitFor(() => expect(row("p2")).not.toBeNull());
    const empty = within(header()).getByRole("button", { name: "Empty" });
    fireEvent.click(empty);
    let dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(empty);
    dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    await act(async () => {
      release();
    });
    expect(await screen.findByText("Permanently deleted 2 notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(row("p1")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Empty the trash?" })).toBe(dialog);
  });

  it("empty with 250 notes (all personal, deleted by me): two batches of 200 + 50; the dialog has no Groups row", async () => {
    const many = Array.from({ length: 250 }, (_, i) => trashItem({ id: `n${String(i).padStart(3, "0")}`, title: `n${i}` }));
    const server = stubServer({ items: many });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 250 notes"));
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["My notes: 250 notes"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(server.posts("/api/trash/purge")).toHaveLength(2));
    const [a, b] = server.posts("/api/trash/purge") as { ids: string[] }[];
    expect(a.ids).toEqual(many.slice(0, 200).map((item) => item.id));
    expect(b.ids).toEqual(many.slice(200).map((item) => item.id));
    expect(await screen.findByText("Permanently deleted 250 notes", { exact: true })).toBeInTheDocument();
  });

  it("one personal note whose deleter account was removed (deletedBy: null) -> the My notes row shows 'includes other members'", async () => {
    const orphan = trashItem({ id: "p3", title: "p3", deletedBy: null }, { deletedDaysAgo: 3 });
    stubServer({ items: [P1, orphan] });
    renderPanel();
    await waitFor(() => expect(row("p3")).not.toBeNull());
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "My notes: 2 notes (including some deleted by other members)",
    ]);
  });

  it("failure midway (250 notes, second batch 409): dialog closes, the error toast reports 200 done, no success-style toast", async () => {
    const many = Array.from({ length: 250 }, (_, i) => trashItem({ id: `n${String(i).padStart(3, "0")}`, title: `n${i}` }));
    const server = stubServer({
      items: many,
      purge: (ids, call) =>
        call === 1
          ? { status: 200, body: { purged: ids, skipped: [] } }
          : { status: 409, body: { error: { code: "server_busy", message: "x" } } },
    });
    renderPanel();
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 250 notes"));
    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText(BUSY, { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/purge")).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const root = toastRoot(BUSY);
    expect(root).toHaveClass("bg-destructive");
    expect(within(root).getByText("Permanently deleted 200 notes", { exact: true })).toBeInTheDocument();
    // "Permanently deleted ..." appears only in the error toast's description; there is no separate success toast.
    expect(screen.getAllByText(/^Permanently deleted \d+ notes?$/)).toHaveLength(1);
    await waitFor(() => expect(header()).toHaveTextContent("Trash · 50 notes"));
  });

  it("GET /api/trash 500 -> role=alert", async () => {
    stubServer({ list: 500 });
    renderPanel();
    expect(await within(panel()).findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
  });

  it("background refetch fails (cache still has the old list) -> role=alert, both buttons disabled", async () => {
    const opts: ServerOpts = { items: [P1, W1] };
    stubServer(opts);
    const { queryClient } = renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeEnabled();
    opts.list = 500;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await within(panel()).findByRole("alert")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(within(header()).getByRole("button", { name: "Empty" })).toBeDisabled();
  });

  it("truncated: a grey line at the end of the list; none when false", async () => {
    stubServer({ items: [P1, W1], truncated: true });
    renderPanel();
    const note = await within(list()).findByText("Only the 1,000 most recently deleted notes are listed.", { exact: true });
    expect(list().lastElementChild).toBe(note);
  });

  it("truncated false: no such line", async () => {
    stubServer({ items: [P1, W1], truncated: false });
    renderPanel();
    await waitFor(() => expect(row("w1")).not.toBeNull());
    expect(within(list()).queryByText("Only the 1,000 most recently deleted notes are listed.")).toBeNull();
  });

  it("zh-TW: title, group second line, empty button and the dialog's section lines", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      stubServer({ items: [P1, P2, W1] });
      renderPanel();
      await waitFor(() => expect(header()).toHaveTextContent("垃圾桶 · 3 篇"));
      expect(detail("w1")).toHaveTextContent(/^R&D · Amy 刪除 · 剩 3 天$/);
      const empty = within(header()).getByRole("button", { name: "清空" });
      fireEvent.click(empty);
      const dialog = await screen.findByRole("dialog", { name: "清空垃圾桶？" });
      expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["我的筆記 2 篇", "群組 1 篇（含其他成員刪除的）"]);
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("zh-TW: the personal section heading and list name are the same as the sidebar tab's name", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      stubServer({ items: [P1, W1] });
      renderPanel();
      await waitFor(() => expect(row("w1")).not.toBeNull());
      expect(within(panel()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["我的筆記", "群組"]);
      expect(within(panel()).getByRole("list", { name: "我的筆記" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  // While a row's restore is in flight, the dialog's permanent-delete confirm would be silently swallowed by `exclusive` if it were enabled, so it is disabled instead.
  it("row restore in flight: the single permanent-delete dialog's confirm is disabled and sends nothing when pressed; after restore returns it is enabled and sends once", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({ items: [P1, P2], hold });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    await waitFor(() => expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]));

    const menu = await openRowMenu("p2");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    await act(async () => {});
    expect(server.posts("/api/trash/purge")).toEqual([]);

    await act(async () => {
      release();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p2"] }]);
  });

  it("row restore in flight: the empty dialog's confirm is disabled; enabled again after restore returns", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer({ items: [P1, P2], hold });
    renderPanel();
    fireEvent.click(await within(panel()).findByRole("button", { name: "Restore p1" }));
    await waitFor(() => expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]));

    fireEvent.click(within(header()).getByRole("button", { name: "Empty" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    await waitFor(() => expect(confirm).toBeDisabled());

    await act(async () => {
      release();
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(server.posts("/api/trash/purge")).toEqual([]);
  });
});

const W2 = trashItem({ id: "w2", title: "w2", group: RD, deletedBy: AMY }, { deletedDaysAgo: 3 });
const checkbox = (id: string) => row(id).querySelector('input[type="checkbox"]') as HTMLInputElement;
const rowLabel = (id: string) => row(id).querySelector("label") as HTMLLabelElement;
const checkedIds = () => ["p1", "p2", "w1", "w2"].filter((id) => checkbox(id).checked);

async function renderSelecting() {
  const server = stubServer({ items: [P1, P2, W1, W2] });
  const rendered = renderPanel();
  await waitFor(() => expect(row("w2")).not.toBeNull());
  fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
  return { server, ...rendered };
}

describe("TrashPanel (select mode)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("entering: 0 selected, select all, done; one unticked checkbox per row, no restore or kebab menu; focus on done", async () => {
    await renderSelecting();
    const title = within(header()).getByText("0 selected", { exact: true });
    expect(title.closest("span.flex")).toHaveClass("text-brand-on-soft");
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    const done = within(header()).getByRole("button", { name: "Done" });
    expect(within(header()).queryByRole("button", { name: "Select" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: "Empty" })).toBeNull();

    const boxes = within(panel()).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(checkbox("p1")).toHaveClass("appearance-none");
    // Select mode rows toggle checkboxes rather than linking to the preview.
    expect(within(panel()).queryAllByRole("link")).toHaveLength(0);
    expect(within(panel()).queryByRole("button", { name: "Restore p1" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Actions for p1" })).toBeNull();
    expect(done).toHaveFocus();
  });

  it("select-mode rows' second line: inside a folder it carries the full path title, at root it does not", async () => {
    stubServer({ items: [PF, P1, WF] });
    renderPanel();
    await waitFor(() => expect(row("wf")).not.toBeNull());
    fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(checkbox("pf")).not.toBeNull());
    expect(detail("pf").tagName).toBe("SPAN");
    expect(detail("pf")).toHaveTextContent(/^A › B · 3 days left$/);
    expect(detail("pf")).toHaveAttribute("title", "A › B");
    expect(detail("wf")).toHaveAttribute("title", "研發組 › 團隊週報");
    expect(detail("p1")).not.toHaveAttribute("title");
  });

  it("clicking the row (label text) toggles: ticked, header 1 selected, row background; clicking again unticks", async () => {
    await renderSelecting();
    fireEvent.click(within(rowLabel("p1")).getByText("p1", { exact: true }));
    expect(checkbox("p1")).toBeChecked();
    expect(within(header()).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(rowLabel("p1")).toHaveClass("bg-brand-soft", "text-brand-on-soft", "font-medium", "select-none");
    expect(rowLabel("p1").querySelector("span.text-muted-foreground")).toHaveClass("font-normal");
    expect(rowLabel("p2")).not.toHaveClass("bg-brand-soft");
    expect(rowLabel("p2")).toHaveClass("hover:bg-brand-soft", "hover:text-brand-on-soft");

    fireEvent.click(within(rowLabel("p1")).getByText("p1", { exact: true }));
    expect(checkbox("p1")).not.toBeChecked();
    expect(within(header()).getByText("0 selected", { exact: true })).toBeInTheDocument();
    expect(rowLabel("p1")).not.toHaveClass("bg-brand-soft");
  });

  it("trash select-row checkboxes are custom-drawn: appearance-none, no accent-brand", async () => {
    await renderSelecting();
    expect(checkbox("p1")).toHaveClass("appearance-none");
    expect(checkbox("p1")).not.toHaveClass("accent-brand");
  });

  it("Shift across sections: click p1 then Shift-click w1 -> p1, p2, w1 ticked, w2 unticked", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("w1"), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "w1"]);
    expect(within(header()).getByText("3 selected", { exact: true })).toBeInTheDocument();
  });

  it("clicking row text with a modifier (Firefox does not forward it to the checkbox; the label toggles itself): Shift selects a range, Ctrl toggles once", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(within(rowLabel("w1")).getByText("w1", { exact: true }), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "w1"]);
    fireEvent.click(within(rowLabel("p2")).getByText("p2", { exact: true }), { ctrlKey: true });
    expect(checkedIds()).toEqual(["p1", "w1"]);
  });

  it("Ctrl-click behaves like a plain click: p1 then Ctrl-click w1 -> only p1 and w1", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("w1"), { ctrlKey: true });
    expect(checkedIds()).toEqual(["p1", "w1"]);
    expect(within(header()).getByText("2 selected", { exact: true })).toBeInTheDocument();
  });

  it("select all -> all ticked and the label becomes deselect all -> pressing again unticks all and the label reverts", async () => {
    await renderSelecting();
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["p1", "p2", "w1", "w2"]);
    expect(within(header()).getByText("4 selected", { exact: true })).toBeInTheDocument();
    expect(within(header()).queryByRole("button", { name: "Select all" })).toBeNull();

    fireEvent.click(within(header()).getByRole("button", { name: "Deselect all" }));
    expect(checkedIds()).toEqual([]);
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
  });

  it("Esc: back to the normal header, checkboxes vanish, focus on Select", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    // This Esc only ends select mode: preventDefault is called (fireEvent returns false), and the search-clear Esc listener yields when it sees defaultPrevented.
    expect(fireEvent.keyDown(checkbox("p1"), { key: "Escape" })).toBe(false);
    const select = within(header()).getByRole("button", { name: "Select" });
    expect(select).toHaveFocus();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(header()).toHaveTextContent("Trash · 4 notes");
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
  });

  it("Done: same as Esc; selection is cleared on re-entering (0 selected)", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
    const select = within(header()).getByRole("button", { name: "Select" });
    expect(select).toHaveFocus();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");

    fireEvent.click(select);
    expect(within(header()).getByText("0 selected", { exact: true })).toBeInTheDocument();
    expect(checkedIds()).toEqual([]);
  });

  it("keyboard: a click (Space) on a checkbox toggles it; every checkbox is in the Tab order", async () => {
    await renderSelecting();
    for (const box of within(panel()).getAllByRole("checkbox")) expect(box.tabIndex).toBe(0);
    checkbox("p2").focus();
    expect(checkbox("p2")).toHaveFocus();
    fireEvent.click(checkbox("p2"));
    expect(checkedIds()).toEqual(["p2"]);
    fireEvent.click(checkbox("p2"));
    expect(checkedIds()).toEqual([]);
  });

  it("keys missing after a list refetch are not counted in the selected N count", async () => {
    const { server, queryClient } = await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p2"));
    expect(within(header()).getByText("2 selected", { exact: true })).toBeInTheDocument();

    server.setItems([P1, W1, W2]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await within(header()).findByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(row("p2")).toBeNull();
    // The key is still in the provider (it counts again if a refetch brings the note back); it is just not counted now.
    expect(screen.getByTestId("selected-count")).toHaveTextContent("2");
  });

  it("list refetched to 0 notes while selecting -> select all disabled", async () => {
    const { server, queryClient } = await renderSelecting();
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeEnabled();
    server.setItems([]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await within(panel()).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeDisabled();
  });

  // With 1000 notes every tick would redraw all rows and recompute dates; only rows whose tick state changed recompute the second line.
  it("ticking a row recomputes only that row; a Shift range recomputes only the newly ticked rows", async () => {
    await renderSelecting();
    const detailCalls = vi.mocked(trashDetailLine);
    detailCalls.mockClear();
    fireEvent.click(checkbox("p1"));
    expect(checkbox("p1")).toBeChecked();
    expect(detailCalls.mock.calls.map(([item]) => item.id)).toEqual(["p1"]);

    detailCalls.mockClear();
    fireEvent.click(checkbox("w1"), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "w1"]);
    expect(detailCalls.mock.calls.map(([item]) => item.id)).toEqual(["p2", "w1"]);
  });
});
