import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { withCanonicalizedFrom } from "@/lib/real-location";
import { SIDEBAR_TABS } from "@/lib/sidebar-tab";
import { stubLayoutTier } from "@/test/layout-tier";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { trashList } from "@/test/trash-fixtures";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { NoteBrowseBar } from "./NoteBrowseBar";
import { pressTrigger } from "@/test/menu-trigger";


afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
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
  id: "88888888-8888-8888-8888-888888888888",
  title: "Alpha Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "alpha-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function stubFetch(notes: NoteDto[]) {
  const created: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/folders") return Promise.resolve(fakeResponse(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      if (url === "/api/notes" && method === "POST") {
        created.push(init?.body ?? null);
        return Promise.resolve(fakeResponse({ ...NOTE, id: "99999999-9999-9999-9999-999999999999", slug: "untitled-99999999", title: "Untitled" }, 201));
      }
      if (url === "/api/trash") return Promise.resolve(fakeResponse(trashList([], { retentionDays: 7 })));
      if (url === "/api/favorites") return Promise.resolve(fakeResponse([]));
      if (url === "/api/notifications/unread-count") return Promise.resolve(fakeResponse({ count: 0 }));
      if (url.startsWith("/api/search?")) return Promise.resolve(fakeResponse({ hits: [], nextCursor: null }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return created;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAt(path: string | string[], children: ReactNode = <LocationProbe />) {
  const entries = Array.isArray(path) ? path : [path];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
          <ActiveNoteProvider>
            <Routes>
              <Route
                path="*"
                element={
                  <AppShell>{children}</AppShell>
                }
              />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** On note routes the aside is inert and hidden, so role queries need `hidden: true`. */
function aside(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>("aside[data-sidebar-instance]");
  if (node === null) throw new Error("aside missing");
  return node;
}

const BAR = "[data-phone-list-bar]";
const FABS = "[data-phone-list-fabs]";

async function openSearchLayer(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Search notes" }));
  const input = (await screen.findByRole("textbox", { name: "Search notes" })) as HTMLInputElement;
  expect(input).toHaveFocus();
  return input;
}

describe("AppShell - phone list screen", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubLayoutTier("phone");
  });

  it("`/`: sidebar full width, in document flow (not fixed), at least one viewport tall, no rounded corners or border; main content hidden; no inert, no drag handle", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const node = aside(container);
    await screen.findByRole("tablist");
    expect(node).not.toHaveAttribute("inert");
    for (const name of ["max-sm:flex", "max-sm:w-full", "max-sm:min-h-svh", "max-sm:rounded-none", "max-sm:border-0"]) {
      expect(node).toHaveClass(name);
    }
    expect(node.className).not.toMatch(/max-sm:(fixed|inset-0)\b/);
    expect(container.querySelector("main")).toHaveClass("max-sm:hidden");
    expect(within(node).queryByRole("separator")).toBeNull();
    expect(node.style.width).toBe("");
  });

  it("note route: sidebar stays in the DOM (not unmounted) but inert", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    const node = aside(container);
    expect(node).toHaveAttribute("inert");
    expect(node).toHaveClass("hidden");
  });

  it("non-note route (/groups/...) is still the list: sidebar not inert, full-width classes applied", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/groups/g1");
    const node = aside(container);
    expect(node).not.toHaveAttribute("inert");
    expect(node).toHaveClass("max-sm:flex", "max-sm:min-h-svh");
  });

  it("top bar: avatar button opens the user menu which has Settings; Knotebook wordmark in the middle; no menu-row name text", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const trigger = await within(aside(container)).findByRole("button", { name: "Ann" });
    expect(trigger).toHaveClass("h-11", "w-11");
    expect(trigger.textContent).toBe("A");
    expect(within(aside(container)).getByText("Knotebook")).toBeInTheDocument();
    pressTrigger(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
  });

  it("top bar is 48 high plus the top safe area; no user row at the bottom (the avatar button exists once, in the top bar)", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await within(aside(container)).findByRole("button", { name: "Ann" });
    expect(within(aside(container)).getAllByRole("button", { name: "Ann" })).toHaveLength(1);
    const top = container.querySelector("[data-phone-top-bar]");
    expect(top?.className).toContain("env(safe-area-inset-top)");
    expect(top?.firstElementChild).toHaveClass("h-12");
    // Title left, avatar right: title's left edge 16px from the screen edge (same as row text start); avatar's visual right edge 16px (hit area 44, visual 32, so right padding 10px).
    expect(top?.firstElementChild).toHaveClass("justify-between", "pl-4", "pr-2.5");
    expect(top?.firstElementChild?.firstElementChild).toHaveTextContent("Knotebook");
    // The bell sits just left of the avatar, as its own button.
    const right = top?.firstElementChild?.lastElementChild;
    expect(right?.children).toHaveLength(2);
    expect(right?.firstElementChild).toBe(screen.getByRole("button", { name: "Notifications" }));
    expect(right?.lastElementChild).toBe(screen.getByRole("button", { name: "Ann" }));
    // The full-width list covers the frame: left/right (landscape notch) are handled by the list itself, top/bottom by the top and bottom bars, not repeated at this level.
    const list = aside(container);
    expect(list).toHaveClass("max-sm:pl-[env(safe-area-inset-left)]", "max-sm:pr-[env(safe-area-inset-right)]");
    expect(list.className).not.toMatch(/max-sm:p[tb]-\[env/);
  });

  it("tab row: one button per tab, icon only (no text), h-11, no horizontal scroll", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const tablist = await screen.findByRole("tablist");
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(SIDEBAR_TABS.length);
    for (const tab of tabs) {
      expect(tab.textContent).toBe("");
      expect(tab).toHaveClass("h-11", "flex-1");
    }
    expect(tablist.className).not.toContain("overflow-x");
  });

  it("not searching: no search row or search box at the list bottom; round Search bottom-left and round New note bottom-right (each 56px, 16px from the edge plus safe area, fixed)", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    expect(container.querySelector(BAR)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search notes" })).toBeNull();
    expect(screen.queryByText("Ctrl K")).toBeNull();
    const fabs = container.querySelector(FABS) as HTMLElement;
    const search = within(fabs).getByRole("button", { name: "Search notes" });
    const create = within(fabs).getByRole("button", { name: "New note" });
    for (const fab of [search, create]) {
      expect(fab).toHaveClass("fixed", "h-14", "w-14", "rounded-full", "shadow-lg", "bottom-[calc(1rem+env(safe-area-inset-bottom))]");
    }
    expect(search).toHaveClass("left-[calc(1rem+env(safe-area-inset-left))]", "border", "bg-card/95", "supports-[backdrop-filter]:backdrop-blur-xs");
    expect(create).toHaveClass("right-[calc(1rem+env(safe-area-inset-right))]");
    expect(create.textContent).toBe("");
  });

  it("pressing New note creates a personal note and navigates to it", async () => {
    const created = stubFetch([NOTE]);
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "New note" }));
    await waitFor(() => expect(created).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/untitled-99999999"));
  });

  it("pressing Search: tab row and list are replaced by the search layer (empty text shows a hint), the search row (box + Cancel) appears, the two floating buttons disappear", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    const input = await openSearchLayer();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(container.querySelector(FABS)).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByTestId("phone-search-hint")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(container.querySelector(BAR)).toContainElement(input);
    expect(input).toHaveClass("h-11", "text-base");
  });

  it("typing shows results; Cancel clears and leaves the search layer, back to the tab row and New note", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const input = await openSearchLayer();
    fireEvent.change(input, { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    expect(await within(results).findByRole("link", { name: /^Alpha Note/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("tablist");
    expect(screen.queryByRole("textbox", { name: "Search notes" })).toBeNull();
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("blur doesn't close the search layer (with or without text); Esc closes it and clears", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const input = await openSearchLayer();
    fireEvent.change(input, { target: { value: "al" } });
    fireEvent.blur(input);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("sidebar-search")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByTestId("phone-search-hint")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "al" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
  });

  it("crossing above 640 collapses the search layer; it isn't open again after going back to phone", async () => {
    stubFetch([NOTE]);
    const tier = stubLayoutTier("phone");
    renderAt("/");
    await openSearchLayer();
    expect(screen.queryByRole("tablist")).toBeNull();

    act(() => tier.setLayoutTier("overlay"));
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
    act(() => tier.setLayoutTier("phone"));
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
  });

  it("selection mode: the bottom bar is replaced by the selection action bar", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const panel = await screen.findByRole("tabpanel");
    fireEvent.click(await within(panel).findByRole("button", { name: "Select" }));
    await within(aside(container)).findByText("0 selected");
    await waitFor(() => expect(container.querySelector("[data-select-action-bar]")).not.toBeNull());
    expect(container.querySelector(BAR)).toBeNull();
    expect(container.querySelector(FABS)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search notes" })).toBeNull();
  });

  it("trash tab: no New note, Search button remains", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    fireEvent.click(await screen.findByRole("tab", { name: "Trash" }));
    await screen.findByTestId("trash-footer");
    const fabs = container.querySelector(FABS) as HTMLElement;
    expect(within(fabs).queryByRole("button", { name: "New note" })).toBeNull();
    expect(within(fabs).getByRole("button", { name: "Search notes" })).toBeInTheDocument();
  });

  it("list scroll container has overscroll-y-contain (Android standalone window: pull-down doesn't trigger a reload)", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    expect(container.querySelector("[data-sidebar-list]")).toHaveClass("overscroll-y-contain");
  });

  it("Ctrl+K on a note route: back to the list and focus the bottom search box; on the list: focus directly, preventDefault", async () => {
    stubFetch([NOTE]);
    renderAt("/n/tester/alpha-note");
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");
    expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();

    input.blur();
    expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
    expect(input).toHaveFocus();
  });

  it("Ctrl+K in selection mode: selection ends first, the bottom search box returns and gets focus", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const panel = await screen.findByRole("tabpanel");
    fireEvent.click(await within(panel).findByRole("button", { name: "Select" }));
    await waitFor(() => expect(container.querySelector("[data-select-action-bar]")).not.toBeNull());
    expect(screen.queryByRole("textbox", { name: "Search notes" })).toBeNull();

    expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(container.querySelector("[data-select-action-bar]")).toBeNull();
  });

  it("opening the search layer from the browse bar search button on a note route: sidebar covers the note full width, not inert, URL unchanged; blur with text (keyboard dismissed, blur before tapping a result) keeps it open and results visible", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    const node = aside(container);
    expect(node).toHaveAttribute("inert");
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(node).not.toHaveAttribute("inert");
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");
    const input = within(node).getByRole("textbox", { name: "Search notes" });
    expect(node).toHaveClass("max-sm:flex", "max-sm:min-h-svh");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.blur(input);
    expect(node).not.toHaveAttribute("inert");
    const results = await screen.findByTestId("sidebar-search");
    expect(await within(results).findByRole("link", { name: /^Alpha Note/ })).toBeInTheDocument();
  });

  it("focus, type and click a result on the list (no blur): after entering the note route the search layer closes, sidebar hidden and inert", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const input = await openSearchLayer();
    fireEvent.change(input, { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    fireEvent.click(await within(results).findByRole("link", { name: /^Alpha Note/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    const node = aside(container);
    await waitFor(() => expect(node).toHaveAttribute("inert"));
    expect(node).not.toHaveClass("max-sm:min-h-svh");
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel", hidden: true })).toBeNull();
  });

  it("Cancel/Esc closing the search layer on the list: focus returns to the bottom-left Search button (not body)", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const input = await openSearchLayer();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const fab = await screen.findByRole("button", { name: "Search notes" });
    await waitFor(() => expect(fab).toHaveFocus());

    const again = await openSearchLayer();
    expect(again).not.toBe(input);
    fireEvent.keyDown(again, { key: "Escape" });
    const fab2 = await screen.findByRole("button", { name: "Search notes" });
    await waitFor(() => expect(fab2).toHaveFocus());
  });

  it("floating-tier drawer left open: closed when narrowing to phone (no stale drawer and backdrop over the full-width list)", async () => {
    const tier = stubLayoutTier("overlay");
    stubFetch([NOTE]);
    renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <SidebarDrawerButton />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    await screen.findByRole("dialog", { name: "Navigation" });
    act(() => tier.setLayoutTier("phone"));
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
  });

  it("phone tab tap: doesn't open the drawer; on a note route a tab tap returns to the list", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    const tab = within(aside(container)).getByRole("tab", { name: "Groups", hidden: true });
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
  });
});

describe("AppShell - non-phone stays unchanged", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  it.each(["docked", "overlay"] as const)("%s: top search box (13px, Ctrl K badge), bottom user row, no bottom bar and no avatar shape", async (tier) => {
    stubLayoutTier(tier);
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(input).toHaveClass("h-8", "text-[13px]");
    expect(screen.getByText("Ctrl K")).toBeInTheDocument();
    expect(container.querySelector(BAR)).toBeNull();
    expect(container.querySelector("[data-phone-top-bar]")).toBeNull();
    expect((await screen.findByRole("button", { name: "Ann" })).textContent).toContain("Ann");
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("focusing the search box in the docked tier doesn't enter the search layer (tab row remains)", async () => {
    stubLayoutTier("docked");
    stubFetch([NOTE]);
    renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("floating tier on a note route: sidebar aside is not inert (drawer flow unaffected by phone rules)", async () => {
    stubLayoutTier("overlay");
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    expect(aside(container)).not.toHaveAttribute("inert");
  });
});

describe("AppShell - phone note page browse bar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubLayoutTier("phone");
  });

  const OTHER: NoteDto = { ...NOTE, id: "77777777-7777-7777-7777-777777777777", title: "Beta Note", slug: "beta-note" };

  function renderNote(path = "/n/tester/alpha-note") {
    return renderAt(
      path,
      <>
        <LocationProbe />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
  }

  it("search box button: the search layer covers the note (URL unchanged, sidebar not inert, search box focused); Cancel returns to the same note", async () => {
    stubFetch([NOTE]);
    // jsdom ignores CSS: simulate the browser being unable to focus hidden (inert) elements, so the test can tell whether the search layer is really opened before focusing.
    const originalFocus = HTMLElement.prototype.focus;
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, ...args) {
      if (this.closest("[inert]") !== null) return;
      originalFocus.apply(this, args);
    });
    onTestFinished(() => focusSpy.mockRestore());
    const { container } = renderNote();
    const node = aside(container);
    expect(node).toHaveAttribute("inert");
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(node).not.toHaveAttribute("inert");
    expect(node).toHaveClass("max-sm:flex", "max-sm:min-h-svh");
    const input = within(node).getByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");
    expect(screen.queryByTestId("note-browse-bar")).toBeNull();

    expect(container.querySelector("main")).toHaveAttribute("inert");

    fireEvent.click(within(node).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(node).toHaveAttribute("inert"));
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");
    expect(container.querySelector("main")).not.toHaveAttribute("inert");
    await waitFor(() => expect(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" })).toHaveFocus());
  });

  it("system back with the search layer open on a note: back to the list, search layer closed, search box not focused", async () => {
    stubFetch([NOTE]);
    function Back() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(-1)}>
          history-back
        </button>
      );
    }
    renderAt(
      ["/", "/n/tester/alpha-note"],
      <>
        <LocationProbe />
        <Back />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    const input = screen.getByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "history-back" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
    expect(input).not.toHaveFocus();
  });

  it("Ctrl+K with the search layer open on a note: focuses the search box directly, doesn't go back to the list", async () => {
    stubFetch([NOTE]);
    renderNote();
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    const input = screen.getByRole("textbox", { name: "Search notes" });
    input.blur();
    expect(input).not.toHaveFocus();
    expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
    expect(input).toHaveFocus();
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");
  });

  it("on a note route with the search layer open, clicking a result for another note: search layer closes, sidebar hidden", async () => {
    stubFetch([NOTE, OTHER]);
    const { container } = renderNote();
    const node = aside(container);
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    const input = within(node).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "beta" } });
    const results = await screen.findByTestId("sidebar-search");
    fireEvent.click(await within(results).findByRole("link", { name: /^Beta Note/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/beta-note"));
    await waitFor(() => expect(node).toHaveAttribute("inert"));
    expect(node).not.toHaveClass("max-sm:min-h-svh");
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
  });

  it("clicking a result that is the current note with the search layer open: search layer also closes", async () => {
    stubFetch([NOTE]);
    const { container } = renderNote();
    const node = aside(container);
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    fireEvent.change(within(node).getByRole("textbox", { name: "Search notes" }), { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    fireEvent.click(await within(results).findByRole("link", { name: /^Alpha Note/ }));
    await waitFor(() => expect(node).toHaveAttribute("inert"));
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
  });

  it("same note with a changed URL (canonical redirect after rename) isn't a page change: search layer stays", async () => {
    stubFetch([NOTE]);
    function Rename() {
      const navigate = useNavigate();
      const location = useLocation();
      return (
        <button
          type="button"
          onClick={() => navigate("/n/tester/alpha-renamed", { replace: true, state: withCanonicalizedFrom(location.state, location.pathname) })}
        >
          rename-in-place
        </button>
      );
    }
    const { container } = renderAt(
      "/n/tester/alpha-note",
      <>
        <LocationProbe />
        <Rename />
        <NoteBrowseBar note={NOTE} />
      </>,
    );
    const node = aside(container);
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" }));
    expect(node).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "rename-in-place" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-renamed"));
    expect(node).not.toHaveAttribute("inert");
  });

  it("'New note' creates and navigates to the new note (same createNote flow)", async () => {
    const created = stubFetch([NOTE]);
    renderNote();
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "New note" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/untitled-99999999"));
    expect(created).toHaveLength(1);
  });
});
