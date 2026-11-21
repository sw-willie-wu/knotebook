import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FavoriteDto, FolderDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { dismissAllToasts, toast, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { adminRole, groupDto } from "@/test/fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder } from "@/test/folder-fixtures";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";


afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const ME: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: "tester",
  displayName: "Tester",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const G1: GroupDto = groupDto({ id: "g1", name: "G1" }, adminRole());
const G2: GroupDto = groupDto({ id: "g2", name: "G2" }, adminRole());
const P1 = personalNote({ id: "p1", title: "p1" });
const P2 = personalNote({ id: "p2", title: "p2" });
const P3 = personalNote({ id: "p3", title: "p3" });
const G1A = groupNote({ id: "g1a", title: "g1a", group: G1 });
const G1B = groupNote({ id: "g1b", title: "g1b", group: G1 });
const G2A = groupNote({ id: "g2a", title: "g2a", group: G2 });
const S1 = sharedNote({ id: "s1", title: "s1", role: "viewer" });
const ALL_NOTES = [P1, P2, P3, G1A, G1B, G2A, S1];
const fav = (noteId: string, favoritedAt: string): FavoriteDto => ({ noteId, favoritedAt });

/** `notes` is a mutable box: after changing `box.notes`, invalidate to refetch the new list. `pending: true` makes `GET /api/notes` never respond. */
function stubFetch(box: { notes: NoteDto[]; groups?: GroupDto[]; folders?: FolderDto[]; favorites?: FavoriteDto[]; pending?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") {
        const body = box.folders === undefined ? FOLDER_LIST_EMPTY : { folders: box.folders };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url === "/api/notes" && method === "GET") {
        if (box.pending) return new Promise<Response>(() => {});
        return Promise.resolve(fakeResponse(box.notes));
      }
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse(box.groups ?? [G1, G2]));
      if (url === "/api/favorites" && method === "GET") return Promise.resolve(fakeResponse(box.favorites ?? []));
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** Controllable matchMedia (`stubControllableMatchMedia` in `AppShell.tabs.test.tsx` is not exported, so this copies it); `vi.unstubAllGlobals()` in `afterEach` restores it. */
function stubMatchMedia(narrow: boolean) {
  const mql = {
    matches: narrow,
    media: OVERLAY_QUERY,
    addEventListener: () => {},
    removeEventListener: () => {},
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  // Only OVERLAY_QUERY returns an mql; every other query (e.g. WIDE_POINTER_QUERY) does not match.
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => (query === OVERLAY_QUERY ? mql : { ...mql, matches: false })),
  );
  return mql;
}

interface RenderOpts {
  tab?: SidebarTab;
  queryClient?: QueryClient;
  drawer?: boolean;
  toaster?: boolean;
  outside?: ReactNode;
}

function renderPanel(opts: RenderOpts = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shellProps = opts.drawer ? { "data-sidebar-drawer": "" } : {};
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div data-sidebar-instance="" {...shellProps}>
              <div role="tabpanel">
                <NoteList />
              </div>
            </div>
            {opts.outside}
            {opts.toaster && <Toaster />}
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const panel = () => screen.getByRole("tabpanel");
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const checkbox = (id: string) => panel().querySelector(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;
const checkedIds = () =>
  Array.from(panel().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.selectionKey?.replace(/^note:/, ""));
const selectButton = () => within(header()).getByRole("button", { name: "Select" });
const headerButtonNames = () => within(header()).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

async function enterSelect(): Promise<void> {
  const select = await within(header()).findByRole("button", { name: "Select" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.click(select);
  await within(header()).findByText("0 selected");
  await within(panel()).findAllByRole("checkbox");
}

async function renderSelecting(opts: RenderOpts & { notes?: NoteDto[]; groups?: GroupDto[]; folders?: FolderDto[]; favorites?: FavoriteDto[] } = {}) {
  const box = { notes: opts.notes ?? ALL_NOTES, groups: opts.groups, folders: opts.folders, favorites: opts.favorites };
  stubFetch(box);
  const view = renderPanel(opts);
  await enterSelect();
  return { ...view, box };
}

const pressEsc = (target: Element | Document = document.body, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key: "Escape", ...init });
const selecting = () => within(header()).queryByRole("button", { name: "Done" }) !== null;

describe("normal-tab select mode", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("header Select button", () => {
    it("my notes shows Select then New personal note; Select is a 24px icon button with title and data-sidebar-select", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel();
      await within(panel()).findByRole("link", { name: "p1" });
      expect(headerButtonNames()).toEqual(["Select", "New folder", "New personal note"]);
      const select = selectButton();
      expect(select).toHaveAttribute("title", "Select");
      expect(select).toHaveAttribute("data-sidebar-select", "");
      expect(select.querySelector('svg[data-icon="select"]')).not.toBeNull();
      expect(select).toHaveClass("h-6", "w-6");
      expect(select).toBeEnabled();
    });

    it("recent has only Select", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel({ tab: "recent" });
      await within(panel()).findAllByRole("link");
      expect(headerButtonNames()).toEqual(["Select"]);
      expect(selectButton()).toBeEnabled();
    });

    it("shared with me shows Select and New folder", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel({ tab: "shared" });
      await within(panel()).findByRole("link", { name: /^s1/ });
      expect(headerButtonNames()).toEqual(["Select", "New folder"]);
      expect(selectButton()).toBeEnabled();
    });

    it("groups shows Select and New group", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel({ tab: "workspace" });
      await within(panel()).findByRole("button", { name: "G1" });
      expect(headerButtonNames()).toEqual(["Select", "New group"]);
      expect(selectButton()).toBeEnabled();
    });

    it("0 notes -> disabled", async () => {
      stubFetch({ notes: [], groups: [] });
      renderPanel();
      await within(panel()).findByText("No notes yet.");
      expect(selectButton()).toBeDisabled();
    });

    it("only an empty group -> disabled", async () => {
      stubFetch({ notes: [P1] });
      renderPanel({ tab: "workspace" });
      await within(panel()).findByRole("button", { name: "G1" });
      expect(selectButton()).toBeDisabled();
    });

    it("notes loading -> disabled", async () => {
      stubFetch({ notes: ALL_NOTES, pending: true });
      renderPanel();
      expect(await within(panel()).findByText("Loading…")).toBeInTheDocument();
      expect(selectButton()).toBeDisabled();
    });
  });

  it("entering: 0 selected, Select all / Done; all checkboxes unticked; no links, no kebab menu, no New personal note; focus on Done", async () => {
    stubFetch({ notes: ALL_NOTES });
    renderPanel();
    await within(panel()).findByRole("link", { name: "p1" });
    fireEvent.click(selectButton());
    expect(await within(header()).findByText("0 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    const done = within(header()).getByRole("button", { name: "Done" });
    const boxes = await within(panel()).findAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(within(panel()).queryAllByRole("link")).toHaveLength(0);
    expect(within(panel()).queryByRole("button", { name: "Note actions for p1" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: "New personal note" })).toBeNull();
    expect(done).toHaveFocus();
  });

  it("two instances (static card + drawer) share the selection: only the instance that started it moves focus (entering -> its Done, finishing -> its Select)", async () => {
    stubFetch({ notes: ALL_NOTES });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              {["static", "drawer"].map((id) => (
                <div key={id} data-testid={id} data-sidebar-instance="">
                  <div role="tabpanel">
                    <NoteList />
                  </div>
                </div>
              ))}
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Start from the first copy in the DOM: React runs layout effects in tree order, so if both copies focused, focus would land on the later-mounted second copy.
    const first = screen.getByTestId("static");
    await within(first).findByRole("link", { name: "p1" });
    fireEvent.click(within(first).getByRole("button", { name: "Select" }));
    const done = await within(first).findByRole("button", { name: "Done" });
    await within(screen.getByTestId("drawer")).findByRole("button", { name: "Done" });
    expect(done).toHaveFocus();

    fireEvent.click(done);
    expect(await within(first).findByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("click row text: ticked, 1 selected, bg-brand-soft; clicking again unticks", async () => {
    await renderSelecting();
    fireEvent.click(within(panel()).getByText("p1"));
    expect(checkbox("p1")).toBeChecked();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(checkbox("p1").closest("label")).toHaveClass("bg-brand-soft");
    fireEvent.click(within(panel()).getByText("p1"));
    expect(checkbox("p1")).not.toBeChecked();
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();
    expect(checkbox("p1").closest("label")).not.toHaveClass("bg-brand-soft");
  });

  it("Shift: click p1 then Shift-click p3 -> three notes ticked", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p3"), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "p3"]);
  });

  it("Ctrl: click p1 then Ctrl-click p3 -> only p1 and p3", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p3"), { ctrlKey: true });
    expect(checkedIds()).toEqual(["p1", "p3"]);
  });

  it("clicking row text with a modifier (Firefox does not forward it to the checkbox; the label toggles itself): Shift selects a range, Ctrl toggles once", async () => {
    await renderSelecting();
    const title = (id: string) => within(checkbox(id).closest("label") as HTMLElement).getByText(id, { exact: true });
    fireEvent.click(checkbox("p1"));
    fireEvent.click(title("p3"), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "p3"]);
    fireEvent.click(title("p2"), { ctrlKey: true });
    expect(checkedIds()).toEqual(["p1", "p3"]);
  });

  it("group tab: group rows are button[aria-expanded] without a checkbox; only the three notes have checkboxes; no group plus button or kebab menu", async () => {
    await renderSelecting({ tab: "workspace" });
    for (const name of ["G1", "G2"]) {
      const row = within(panel()).getByRole("button", { name });
      expect(row).toHaveAttribute("aria-expanded", "true");
      // the group row (the one holding the main button) has no checkbox; child notes sit in the guide-line container below it
      expect(row.parentElement?.querySelector("input")).toBeNull();
    }
    expect(within(panel()).getAllByRole("checkbox")).toHaveLength(3);
    expect(checkedIds()).toEqual([]);
    expect(within(panel()).queryByRole("button", { name: "New note in G1" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Group actions for G1" })).toBeNull();
  });

  it("collapse and select all: select all ticks only visible notes; after expanding the label returns to Select all; selecting all again ticks three; deselect all", async () => {
    await renderSelecting({ tab: "workspace" });
    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(within(panel()).getByRole("button", { name: "G1" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["g2a"]);
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Deselect all" })).toBeInTheDocument();

    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["g1a", "g1b", "g2a"]);
    expect(within(header()).getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole("button", { name: "Deselect all" }));
    expect(checkedIds()).toEqual([]);
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();
  });

  it("still counted after collapsing: tick g1a, collapse -> 1 selected; a Shift anchor outside the visible order degrades to a single-row toggle", async () => {
    await renderSelecting({ tab: "workspace" });
    fireEvent.click(checkbox("g1a"));
    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(checkbox("g1a")).toBeNull();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();

    fireEvent.click(checkbox("g2a"), { shiftKey: true });
    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(checkedIds()).toEqual(["g1a", "g2a"]);
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
  });

  describe("Esc and Done", () => {
    it("Esc on a checkbox -> normal header, focus on Select; Done does the same; entering again shows 0 selected", async () => {
      await renderSelecting();
      checkbox("p1").focus();
      pressEsc(checkbox("p1"));
      expect(await within(header()).findByRole("button", { name: "Select" })).toHaveFocus();
      expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);

      await enterSelect();
      fireEvent.click(checkbox("p2"));
      expect(within(header()).getByText("1 selected")).toBeInTheDocument();
      fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
      expect(await within(header()).findByRole("button", { name: "Select" })).toHaveFocus();
      expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);

      await enterSelect();
      expect(within(header()).getByText("0 selected")).toBeInTheDocument();
      expect(checkedIds()).toEqual([]);
    });

    it("an already-handled Esc (document capture calls preventDefault first, simulating the Radix drawer) -> still selecting; a plain Esc leaves once it is removed", async () => {
      await renderSelecting();
      const swallow = (event: KeyboardEvent) => event.preventDefault();
      document.addEventListener("keydown", swallow, { capture: true });
      try {
        pressEsc();
        expect(selecting()).toBe(true);
      } finally {
        document.removeEventListener("keydown", swallow, { capture: true });
      }
      pressEsc();
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("a dialog other than the drawer is open -> still selecting; a plain Esc leaves once it is removed", async () => {
      await renderSelecting();
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);
      try {
        pressEsc();
        expect(selecting()).toBe(true);
      } finally {
        dialog.remove();
      }
      pressEsc();
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("focus outside the sidebar (wide screen, body) -> leaves select mode, focus on Select", async () => {
      await renderSelecting();
      document.body.focus();
      pressEsc(document.body);
      expect(await within(header()).findByRole("button", { name: "Select" })).toHaveFocus();
    });

    it("Esc in an input in the main content -> still selecting, focus stays on the input; Esc on body leaves", async () => {
      await renderSelecting({
        outside: (
          <main>
            <input aria-label="probe" />
          </main>
        ),
      });
      const probe = screen.getByRole("textbox", { name: "probe" });
      probe.focus();
      pressEsc(probe);
      expect(selecting()).toBe(true);
      expect(probe).toHaveFocus();

      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("consumed event: Esc on a checkbox leaves select mode and the same event object is defaultPrevented", async () => {
      await renderSelecting();
      const target = checkbox("p1");
      const event = createEvent.keyDown(target, { key: "Escape" });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("narrow screen with only the static card (drawer closed) -> still selecting; after returning to a wide screen a plain Esc leaves", async () => {
      const mql = stubMatchMedia(true);
      await renderSelecting();
      pressEsc(document.body);
      expect(selecting()).toBe(true);

      mql.matches = false;
      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("narrow screen with the drawer copy visible: Esc on body leaves", async () => {
      stubMatchMedia(true);
      await renderSelecting({ drawer: true });
      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("Esc during IME composition -> still selecting; a plain Esc leaves", async () => {
      await renderSelecting();
      pressEsc(document.body, { isComposing: true });
      expect(selecting()).toBe(true);

      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("with a toast open: the first Esc only closes the toast and keeps selecting; the second leaves", async () => {
      await renderSelecting({ toaster: true });
      act(() => {
        toast({ title: "x" });
      });
      const item = await screen.findByText("x", { exact: true });
      const toastLi = item.closest("li") as HTMLElement;
      expect(toastLi).toHaveAttribute("data-state", "open");

      // Real browsers run microtasks between listeners: Radix's toast-close update commits before SelectHeader's bubble listener (so whether a toast was open must be recorded in the window
      // capture listener). jsdom's synchronous fireEvent dispatch does not flush, so a flushSync on body simulates that moment.
      const flush = () => {
        flushSync(() => {});
      };
      document.body.addEventListener("keydown", flush);
      try {
        pressEsc(document.body);
      } finally {
        document.body.removeEventListener("keydown", flush);
      }
      await waitFor(() => expect(screen.queryByText("x", { exact: true })?.closest("li")?.getAttribute("data-state") ?? "gone").not.toBe("open"));
      expect(selecting()).toBe(true);

      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });
  });

  it("Esc listener cleanup: selecting adds two keydown listeners (window capture + document bubble), and both are gone after finishing and after unmount", async () => {
    const live = new Set<string>();
    const ids = new Map<unknown, number>();
    const spies = [window, document].map((target) => {
      const name = target === window ? "W" : "D";
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      const tag = (listener: unknown, options: unknown) => {
        if (!ids.has(listener)) ids.set(listener, ids.size + 1);
        const capture = typeof options === "object" && options !== null ? Boolean((options as EventListenerOptions).capture) : Boolean(options);
        return `${name}:${capture ? "capture" : "bubble"}#${ids.get(listener)}`;
      };
      return [
        vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "keydown") live.add(tag(listener, options));
          add(type, listener, options);
        }),
        vi.spyOn(target, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
          if (type === "keydown") live.delete(tag(listener, options));
          remove(type, listener, options);
        }),
      ];
    });
    try {
      stubFetch({ notes: ALL_NOTES });
      const view = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <ActiveNoteProvider>
              <SidebarTabProvider>
                <div data-sidebar-instance="">
                  <div role="tabpanel">
                    <NoteList />
                  </div>
                </div>
              </SidebarTabProvider>
            </ActiveNoteProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await within(panel()).findByRole("link", { name: "p1" });
      const base = new Set(live);
      // Count only window capture and document bubble: each normal row's kebab menu (Radix Menu) attaches a document-capture listener that is replaced by a new function when the row remounts.
      const extra = () =>
        [...live]
          .filter((key) => !base.has(key) && /^(W:capture|D:bubble)#/.test(key))
          .map((key) => key.replace(/#\d+$/, ""))
          .sort();

      await enterSelect();
      expect(extra()).toEqual(["D:bubble", "W:capture"]);
      fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
      await within(header()).findByRole("button", { name: "Select" });
      expect(extra()).toEqual([]);

      await enterSelect();
      expect(extra()).toEqual(["D:bubble", "W:capture"]);
      view.unmount();
      expect(extra()).toEqual([]);
    } finally {
      for (const spy of spies.flat()) spy.mockRestore();
    }
  });

  it("recent tab: both lines (title + location) are inside the label", async () => {
    await renderSelecting({ tab: "recent" });
    const label = checkbox("g1a").closest("label") as HTMLElement;
    expect(label).toHaveTextContent("g1a");
    expect(label).toHaveTextContent("Groups › G1");
    expect(checkbox("p1").closest("label")).toHaveTextContent("My notes");
  });

  it("favorites tab select mode: the checkbox tree has two-line rows in the usual order", async () => {
    await renderSelecting({
      tab: "favorites",
      favorites: [fav("g1a", "2026-03-03T00:00:00.000Z"), fav("p2", "2026-03-02T00:00:00.000Z"), fav("s1", "2026-03-01T00:00:00.000Z")],
    });
    const rows = Array.from(panel().querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-selection-key]')).map((input) =>
      input.dataset.selectionKey?.replace(/^note:/, ""),
    );
    expect(rows).toEqual(["g1a", "p2", "s1"]);
    const label = checkbox("g1a").closest("label") as HTMLElement;
    expect(label).toHaveTextContent("g1a");
    expect(label).toHaveTextContent("Groups › G1");
    expect(label.className).toContain("items-start");
    expect(checkbox("p2").closest("label")).toHaveTextContent("My notes");
  });

  it("favorites tab: the header has only Select, enabled when there are rows", async () => {
    stubFetch({ notes: ALL_NOTES, favorites: [fav("p1", "2026-03-01T00:00:00.000Z")] });
    renderPanel({ tab: "favorites" });
    await within(panel()).findAllByRole("link");
    expect(headerButtonNames()).toEqual(["Select"]);
    expect(selectButton()).toBeEnabled();
  });

  it("favorites tab without rows -> Select disabled", async () => {
    stubFetch({ notes: ALL_NOTES, favorites: [] });
    renderPanel({ tab: "favorites" });
    await within(panel()).findByText(/No favorites yet/);
    expect(selectButton()).toBeDisabled();
  });

  it("shared with me: row s1 shows no role text", async () => {
    await renderSelecting({ tab: "shared" });
    expect(checkbox("s1").closest("label")).not.toHaveTextContent("Viewer");
  });

  it("a note that disappears after a refetch does not count", async () => {
    const { queryClient, box } = await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p2"));
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
    box.notes = ALL_NOTES.filter((note) => note.id !== "p2");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
    expect(await within(header()).findByText("1 selected")).toBeInTheDocument();
    expect(checkbox("p2")).toBeNull();
  });

  it("refetch while selecting leaves nothing tickable (group tab has only empty groups): still the select header and checkbox tree, group rows have no plus button or kebab menu", async () => {
    const { queryClient, box } = await renderSelecting({ tab: "workspace" });
    fireEvent.click(checkbox("g1a"));
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    box.notes = ALL_NOTES.filter((note) => note.groupId === null);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
    expect(await within(header()).findByText("0 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "G1" })).toHaveAttribute("aria-expanded", "true");
    expect(within(panel()).queryByRole("button", { name: "New note in G1" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Group actions for G1" })).toBeNull();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
    expect(await within(panel()).findByRole("button", { name: "Group actions for G1" })).toBeInTheDocument();
  });

  it("refetch while selecting leaves no nodes at all (my notes emptied): select header plus the usual empty-state text, no checkboxes", async () => {
    const { queryClient, box } = await renderSelecting();
    fireEvent.click(checkbox("p1"));
    box.notes = ALL_NOTES.filter((note) => note.groupId !== null || note.role !== "owner");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
    expect(await within(panel()).findByText("No personal notes yet.")).toBeInTheDocument();
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("the scroll container is not replaced and the scroll position is kept (on entering and finishing)", async () => {
    stubFetch({ notes: ALL_NOTES });
    renderPanel();
    await within(panel()).findByRole("link", { name: "p1" });
    const container = list();
    container.scrollTop = 120;
    expect(container.scrollTop).toBe(120);
    await enterSelect();
    expect(list()).toBe(container);
    expect(container.scrollTop).toBe(120);
    fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
    await within(panel()).findByRole("link", { name: "p1" });
    expect(list()).toBe(container);
    expect(container.scrollTop).toBe(120);
  });

  it("zh-TW: 已選 0 項, 全選, 完成; the select button's aria-label is 選取", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      stubFetch({ notes: ALL_NOTES });
      renderPanel();
      await within(panel()).findByRole("link", { name: "p1" });
      fireEvent.click(within(header()).getByRole("button", { name: "選取" }));
      expect(await within(header()).findByText("已選 0 項")).toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "全選" })).toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "完成" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("select mode with folders", () => {
  const FA = personalNote({ id: "fa1", title: "fa1", folderId: "A" });
  const FA2 = personalNote({ id: "fa2", title: "fa2", folderId: "A1" });
  const ROOT = personalNote({ id: "root3", title: "root3" });
  const FOLDERS = [folderDto({ id: "A", name: "A" }), folderDto({ id: "A1", name: "A1", parentId: "A" })];

  function stubFolders() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify({ folders: FOLDERS }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([FA, FA2, ROOT]));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  const folderRow = (id: string) => panel().querySelector(`[data-node-kind="folder"][data-node-id="${id}"]`) as HTMLElement | null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFolderSortForTests();
  });

  it("my notes: folder A's row has a button[aria-expanded] and checkbox folder:A, as does fa1 under A; after collapsing A, select all ticks the visible A and root3", async () => {
    stubFolders();
    renderPanel();
    await enterSelect();
    await waitFor(() => expect(checkbox("fa1")).not.toBeNull());
    const row = folderRow("A")!;
    const toggle = row.querySelector(":scope > div > button[aria-expanded]") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(row.firstElementChild!.querySelector('input[type="checkbox"][data-selection-key="folder:A"]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(localStorage.getItem("sidebar.collapsed.folder:A")).toBe("1");
    expect(checkbox("fa1")).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["folder:A", "root3"]);
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
  });

  it("recent tab in select mode: fa2's second line has the full folder path as its title", async () => {
    stubFolders();
    renderPanel({ tab: "recent" });
    await enterSelect();
    await waitFor(() => expect(checkbox("fa2")).not.toBeNull());
    const line = checkbox("fa2").closest("label")!.querySelector('[title="My notes › A › A1"]');
    expect(line).toHaveTextContent("My notes › A › A1");
  });
});

describe("select mode with tickable folders", () => {
  // My notes: A > { q1, q2 }, B (empty), root q3. Visible order: folder:A, q1, q2, folder:B, q3.
  const FA = folderDto({ id: "A", name: "A" });
  const FB = folderDto({ id: "B", name: "B" });
  const Q1 = personalNote({ id: "q1", title: "q1", folderId: "A" });
  const Q2 = personalNote({ id: "q2", title: "q2", folderId: "A" });
  const Q3 = personalNote({ id: "q3", title: "q3" });
  const MINE = { notes: [Q1, Q2, Q3], groups: [] as GroupDto[], folders: [FA, FB] };

  const folderRow = (id: string) => panel().querySelector(`[data-node-kind="folder"][data-node-id="${id}"]`) as HTMLElement;
  const folderBox = (id: string) => panel().querySelector(`input[type="checkbox"][data-selection-key="folder:${id}"]`) as HTMLInputElement | null;
  /** Collapse button inside the folder row (the row's first child); not tied to being a direct child of the row (the first test asserts it is outside the label). */
  const chevron = (id: string) => folderRow(id).firstElementChild!.querySelector("button[aria-expanded]") as HTMLButtonElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFolderSortForTests();
  });

  it("folder row: checkbox folder:A (accessible name A) and a separate button[aria-expanded] (accessible name A, outside the label); clicking the chevron only collapses, clicking the name ticks", async () => {
    await renderSelecting(MINE);
    const toggle = chevron("A");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("A");
    expect(toggle.closest("label")).toBeNull();
    const box = folderBox("A")!;
    expect(within(folderRow("A")).getByRole("checkbox", { name: "A" })).toBe(box);
    const label = box.closest("label") as HTMLElement;
    expect(folderRow("A").firstElementChild).toContainElement(label);
    expect(label.querySelector('svg[data-icon="folder"]')).not.toBeNull();

    fireEvent.click(toggle);
    expect(chevron("A")).toHaveAttribute("aria-expanded", "false");
    expect(folderBox("A")).not.toBeChecked();
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();

    fireEvent.click(within(label).getByText("A"));
    expect(folderBox("A")).toBeChecked();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(label).toHaveClass("bg-brand-soft");
  });

  it("tick A -> 1 selected; also tick q1 inside A -> 2 selected (the header does not deduplicate)", async () => {
    await renderSelecting(MINE);
    fireEvent.click(folderBox("A")!);
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(checkbox("q1"));
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["folder:A", "q1"]);
  });

  it("select all after collapsing A ticks A, B and q3 but not A's children (q1 and q2 are unticked after expanding)", async () => {
    await renderSelecting(MINE);
    fireEvent.click(chevron("A"));
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["folder:A", "folder:B", "q3"]);
    expect(within(header()).getByText("3 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Deselect all" })).toBeInTheDocument();
    fireEvent.click(chevron("A"));
    expect(checkbox("q1")).not.toBeChecked();
    expect(checkbox("q2")).not.toBeChecked();
    expect(within(header()).getByText("3 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
  });

  it("select-row checkboxes are custom-drawn (note rows and folder rows): appearance-none, no accent-brand", async () => {
    await renderSelecting(MINE);
    const boxes = [checkbox("q2"), folderBox("B")!];
    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(box).toHaveClass("appearance-none");
      expect(box).not.toHaveClass("accent-brand");
    }
  });

  it("Shift range includes folder rows: q2 then Shift q3 = q2, B, q3; Shift-clicking a folder name (the label toggles itself) also selects a range", async () => {
    await renderSelecting(MINE);
    fireEvent.click(checkbox("q2"));
    fireEvent.click(checkbox("q3"), { shiftKey: true });
    expect(checkedIds()).toEqual(["q2", "folder:B", "q3"]);

    // select all + deselect all clears the selection and the Shift anchor
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    fireEvent.click(within(header()).getByRole("button", { name: "Deselect all" }));
    expect(checkedIds()).toEqual([]);
    fireEvent.click(checkbox("q1"));
    fireEvent.click(within(folderBox("B")!.closest("label") as HTMLElement).getByText("B"), { shiftKey: true });
    expect(checkedIds()).toEqual(["q1", "q2", "folder:B"]);
  });

  it("group tab: group rows are not tickable; folder GF under a group is", async () => {
    const GF = groupFolder({ id: "GF", name: "GF", groupId: G1.id });
    const inGF = groupNote({ id: "g1f", title: "g1f", group: G1, folderId: "GF" });
    await renderSelecting({ tab: "workspace", notes: [inGF, G1B, G2A], folders: [GF] });
    for (const name of ["G1", "G2"]) {
      const row = within(panel()).getByRole("button", { name, expanded: true });
      expect(row.parentElement?.querySelector("input")).toBeNull();
    }
    expect(panel().querySelector('[data-selection-key^="group:"]')).toBeNull();
    expect(within(panel()).getAllByRole("checkbox")).toHaveLength(4);
    fireEvent.click(folderBox("GF")!);
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["folder:GF"]);
  });

  it("my notes with only an empty folder (no personal notes) -> Select is enabled and entering shows a folder checkbox", async () => {
    await renderSelecting({ notes: [S1], groups: [], folders: [FB] });
    expect(within(panel()).getAllByRole("checkbox")).toEqual([folderBox("B")]);
  });
});

describe("select mode with row stars", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["myNotes", "recent", "shared", "workspace"] as const)("%s: normal rows have stars; after entering select mode there are no star buttons", async (tab) => {
    stubFetch({ notes: ALL_NOTES, favorites: [fav("p1", "2026-03-01T00:00:00.000Z")] });
    renderPanel({ tab });
    await within(panel()).findAllByRole("button", { name: "Favorite" });
    await enterSelect();
    expect(within(panel()).queryAllByRole("button", { name: "Favorite", hidden: true })).toHaveLength(0);
    expect(within(panel()).queryAllByRole("checkbox").length).toBeGreaterThan(0);
  });
});
