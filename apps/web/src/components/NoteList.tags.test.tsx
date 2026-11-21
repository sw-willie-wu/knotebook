import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FolderDto, GroupDto, NoteDto, NoteTagDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { SidebarTabList } from "@/components/sidebar/SidebarTabList";
import { __resetCollapseForTests, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { __resetTagFilterForTests, toggleTagFilter } from "@/components/sidebar/tag-filter";
import { adminRole, groupDto } from "@/test/fixtures";
import { folderDto } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { NoteList } from "./NoteList";

const WORK: NoteTagDto = { id: "t-work", name: "Work", color: "blue" };
const TODO: NoteTagDto = { id: "t-todo", name: "To do", color: "red" };
const BOOKS: NoteTagDto = { id: "t-books", name: "Books", color: "green" };
const IDEAS: NoteTagDto = { id: "t-ideas", name: "Ideas", color: "purple" };
const SPECS: NoteTagDto = { id: "t-specs", name: "Specs", color: "orange" };
const SYNC: NoteTagDto = { id: "t-sync", name: "Sync", color: "pink" };

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Alpha Team" }, adminRole());
const GROUP_B: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Beta Club" }, adminRole());
const GROUP_C: GroupDto = groupDto({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Plain Group" }, adminRole());

const ME = { id: "u1", email: "me@example.com", handle: "owner-one", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };

function stubApi(notes: NoteDto[], opts: { groups?: GroupDto[]; folders?: FolderDto[] } = {}) {
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notes") return json(notes);
      if (url === "/api/groups") return json(opts.groups ?? []);
      if (url === "/api/folders") return json({ folders: opts.folders ?? [] });
      if (url === "/api/favorites") return json([]);
      if (url === "/api/auth/me") return json(ME);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderList(tab: SidebarTab) {
  localStorage.setItem("sidebar.tab", tab);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <SidebarTabList idBase="t" />
            <div role="tabpanel">
              <NoteList />
            </div>
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

// An open Radix menu marks everything outside it aria-hidden, so role queries on the panel would fail then.
const panel = () => document.querySelector('[role="tabpanel"]') as HTMLElement;
const funnel = () => within(panel()).queryByRole("button", { name: /^Filter by tag/ });
const rowTitles = () => Array.from(panel().querySelectorAll('[data-node-kind="note"] a')).map((a) => a.textContent);
const bar = () => panel().querySelector("[data-tag-filter-bar]") as HTMLElement | null;

async function openMenu(): Promise<HTMLElement> {
  const button = await within(panel()).findByRole("button", { name: /^Filter by tag/ });
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.click(button);
  const menu = await screen.findByRole("menu");
  // The items come from a lazy chunk; wait so each case doesn't rely on an earlier one having loaded it.
  await within(menu).findAllByRole("menuitemcheckbox");
  return menu;
}

function tick(name: string) {
  return screen.getByRole("menuitemcheckbox", { name: new RegExp(`^${name}`) });
}

const ALPHA = personalNote({ id: "n-alpha", title: "Alpha plan", tags: [WORK, TODO] });
const BRAVO = personalNote({ id: "n-bravo", title: "Bravo log", tags: [WORK] });
const CHARLIE = personalNote({ id: "n-charlie", title: "Charlie notes", tags: [BOOKS] });
const DELTA = personalNote({ id: "n-delta", title: "Delta plain" });

describe("sidebar tags", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    __resetCollapseForTests();
    __resetFolderSortForTests();
    __resetTagFilterForTests();
  });

  it("a row shows up to three dots in added order, as role=img named 'Tags: A, B, C, D' with the same title", async () => {
    const four = personalNote({ id: "n-four", title: "Four tags", tags: [WORK, TODO, BOOKS, IDEAS] });
    stubApi([four]);
    renderList("myNotes");
    const dots = await within(panel()).findByRole("img", { name: "Tags: Work, To do, Books, Ideas" });
    expect(dots).toHaveAttribute("title", "Tags: Work, To do, Books, Ideas");
    const colors = Array.from(dots.querySelectorAll("[data-tag-color]")).map((el) => el.getAttribute("data-tag-color"));
    expect(colors).toEqual(["blue", "red", "green"]);
  });

  it("the dots are the last item of the row, after the row menu, in a slot every row has", async () => {
    stubApi([sharedNote({ id: "n-shared", title: "Shared one", tags: [BOOKS, IDEAS] }), sharedNote({ id: "n-untagged", title: "No tags here", tags: [] })]);
    renderList("shared");
    const dots = await within(panel()).findByRole("img", { name: "Tags: Books, Ideas" });
    const row = dots.closest("li")!;
    const order = Array.from(row.children);
    const menu = order.find((el) => el.getAttribute("aria-label")?.startsWith("Note actions") === true)!;
    const slot = dots.parentElement!;
    expect(order.indexOf(menu)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(menu)).toBeLessThan(order.indexOf(slot));
    expect(order.at(-1)).toBe(slot);
    const untagged = (await within(panel()).findByRole("link", { name: "No tags here" })).closest("li")!;
    expect(untagged.lastElementChild!.className).toBe(slot.className);
  });

  it("a row without tags has no dots element", async () => {
    stubApi([DELTA]);
    renderList("myNotes");
    await within(panel()).findByRole("link", { name: "Delta plain" });
    expect(panel().querySelector("[data-tag-dots]")).toBeNull();
    expect(funnel()).toBeNull();
    expect(bar()).toBeNull();
  });

  it("the funnel button shows on My notes only when one of its notes has a tag, and never on Recent, Favorites, Shared with me or Trash", async () => {
    stubApi([ALPHA, sharedNote({ id: "n-shared", title: "Shared one", tags: [BOOKS] })]);
    renderList("myNotes");
    expect(await within(panel()).findByRole("button", { name: "Filter by tag" })).toBeInTheDocument();
    for (const tab of ["Recent", "Favorites", "Shared with me", "Trash"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(funnel()).toBeNull();
    }
    cleanup();
    stubApi([personalNote({ id: "n-plain", title: "Plain" }), sharedNote({ id: "n-shared", title: "Shared one", tags: [BOOKS] })]);
    renderList("myNotes");
    await within(panel()).findByRole("link", { name: "Plain" });
    expect(funnel()).toBeNull();
  });

  it("the menu is titled 'Filter by tag · My notes', lists each tag with its dot and note count, and ends with 'Only notes with all of them are listed'", async () => {
    stubApi([ALPHA, BRAVO, CHARLIE, DELTA]);
    renderList("myNotes");
    const menu = await openMenu();
    expect(await within(menu).findByText("Filter by tag · My notes")).toBeInTheDocument();
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((item) => item.textContent)).toEqual(["Books1", "To do1", "Work2"]);
    expect(items[2]!.querySelector('[data-tag-color="blue"]')).not.toBeNull();
    expect(within(menu).getByText("Only notes with all of them are listed")).toBeInTheDocument();
    expect(menu.lastElementChild).toHaveTextContent("Only notes with all of them are listed");
  });

  it("choosing two tags keeps only notes having both; the button shows 2; the bar shows two chips, Clear and '1 note'", async () => {
    stubApi([ALPHA, BRAVO, CHARLIE, DELTA]);
    renderList("myNotes");
    await openMenu();
    expect(rowTitles()).toEqual(["Alpha plan", "Bravo log", "Charlie notes", "Delta plain"]);
    fireEvent.click(tick("Work"));
    expect(rowTitles()).toEqual(["Alpha plan", "Bravo log"]);
    fireEvent.click(tick("To do"));
    expect(rowTitles()).toEqual(["Alpha plan"]);
    const button = within(panel()).getByRole("button", { name: "Filter by tag, 2 applied", hidden: true });
    expect(button).toHaveTextContent("2");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const filterBar = bar()!;
    expect(within(filterBar).getByRole("button", { name: "Remove Work from the filter", hidden: true })).toBeInTheDocument();
    expect(within(filterBar).getByRole("button", { name: "Remove To do from the filter", hidden: true })).toBeInTheDocument();
    expect(within(filterBar).getByRole("button", { name: "Clear", hidden: true })).toBeInTheDocument();
    // Chips follow the order they were ticked, not the menu's alphabetical order.
    expect(Array.from(filterBar.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["Work", "To do"]);
    expect(filterBar).toHaveTextContent("1 note");
  });

  it("the × on a chip removes only that tag", async () => {
    stubApi([ALPHA, BRAVO, CHARLIE]);
    renderList("myNotes");
    await within(panel()).findByRole("link", { name: "Alpha plan" });
    act(() => {
      toggleTagFilter("myNotes", WORK.id);
      toggleTagFilter("myNotes", TODO.id);
    });
    expect(rowTitles()).toEqual(["Alpha plan"]);
    fireEvent.click(within(bar()!).getByRole("button", { name: "Remove To do from the filter" }));
    expect(rowTitles()).toEqual(["Alpha plan", "Bravo log"]);
    expect(within(bar()!).queryByRole("button", { name: "Remove To do from the filter" })).toBeNull();
    fireEvent.click(within(bar()!).getByRole("button", { name: "Clear" }));
    expect(bar()).toBeNull();
    expect(rowTitles()).toHaveLength(3);
  });

  it("a folder holding a match is shown open even when collapsed; a folder without matches is hidden", async () => {
    const withMatch = folderDto({ id: "f-match", name: "Has match" });
    const without = folderDto({ id: "f-none", name: "No match" });
    const inMatch = personalNote({ id: "n-in", title: "Inside tagged", folderId: withMatch.id, tags: [WORK] });
    const inNone = personalNote({ id: "n-out", title: "Inside plain", folderId: without.id });
    stubApi([inMatch, inNone, BRAVO], { folders: [withMatch, without] });
    renderList("myNotes");
    await within(panel()).findByRole("button", { name: "Has match" });
    act(() => setCollapsed("folder:f-match", true));
    expect(within(panel()).queryByRole("link", { name: "Inside tagged" })).toBeNull();
    act(() => toggleTagFilter("myNotes", WORK.id));
    expect(within(panel()).getByRole("link", { name: "Inside tagged" })).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "No match" })).toBeNull();
    expect(localStorage.getItem("sidebar.collapsed.folder:f-match")).toBe("1");
    act(() => clearFilter());
    expect(within(panel()).queryByRole("link", { name: "Inside tagged" })).toBeNull();
  });

  it("a collapsed group is shown open while a filter on it is on", async () => {
    const aNote = groupNote({ id: "g-a1", title: "Alpha spec", group: GROUP_A, tags: [SPECS] });
    const aPlain = groupNote({ id: "g-a2", title: "Alpha plain", group: GROUP_A });
    stubApi([aNote, aPlain], { groups: [GROUP_A] });
    renderList("workspace");
    await within(panel()).findByRole("button", { name: "Alpha Team" });
    act(() => setCollapsed(`group:${GROUP_A.id}`, true));
    expect(rowTitles()).toEqual([]);
    act(() => toggleTagFilter("workspace", SPECS.id, GROUP_A.id));
    expect(rowTitles()).toEqual(["Alpha spec"]);
  });

  it("closing a folder while filtering lasts until the filter changes and never touches the saved collapse state", async () => {
    const folder = folderDto({ id: "f-match", name: "Has match" });
    const inside = personalNote({ id: "n-in", title: "Inside tagged", folderId: folder.id, tags: [WORK] });
    stubApi([inside, BRAVO], { folders: [folder] });
    renderList("myNotes");
    await within(panel()).findByRole("button", { name: "Has match" });
    act(() => toggleTagFilter("myNotes", WORK.id));
    const toggle = within(panel()).getByRole("button", { name: "Has match" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(panel()).queryByRole("link", { name: "Inside tagged" })).toBeNull();
    expect(Object.keys(localStorage).filter((key) => key.startsWith("sidebar.collapsed."))).toEqual([]);
    act(() => toggleTagFilter("myNotes", WORK.id));
    act(() => toggleTagFilter("myNotes", WORK.id));
    expect(within(panel()).getByRole("link", { name: "Inside tagged" })).toBeInTheDocument();
  });

  it("selection mode: a collapsed folder is shown open under a filter and has no checkbox; after closing it, select all skips the notes inside", async () => {
    const folder = folderDto({ id: "f-match", name: "Has match" });
    const inside = personalNote({ id: "n-in", title: "Inside tagged", folderId: folder.id, tags: [WORK] });
    stubApi([inside, BRAVO, CHARLIE], { folders: [folder] });
    renderList("myNotes");
    await within(panel()).findByRole("button", { name: "Has match" });
    act(() => setCollapsed("folder:f-match", true));
    act(() => toggleTagFilter("myNotes", WORK.id));
    fireEvent.click(within(panel()).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(panel().querySelector('input[data-selection-key="note:n-in"]')).not.toBeNull());
    expect(panel().querySelector('input[data-selection-key="folder:f-match"]')).toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Has match" }));
    expect(panel().querySelector('input[data-selection-key="note:n-in"]')).toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Select all" }));
    expect(within(panel()).getByText("1 selected")).toBeInTheDocument();
    expect(Array.from(panel().querySelectorAll<HTMLInputElement>("input[data-selection-key]")).filter((i) => i.checked).map((i) => i.dataset.selectionKey)).toEqual(["note:n-bravo"]);
  });

  it("selection mode: a Shift range over a folder closed during the filter skips the notes inside it", async () => {
    const open = folderDto({ id: "f-a", name: "A open" });
    const closed = folderDto({ id: "f-b", name: "B closed" });
    const first = personalNote({ id: "n-first", title: "First", folderId: open.id, tags: [WORK] });
    const hidden = personalNote({ id: "n-hidden", title: "Hidden", folderId: closed.id, tags: [WORK] });
    stubApi([first, hidden, BRAVO], { folders: [open, closed] });
    renderList("myNotes");
    await within(panel()).findByRole("button", { name: "A open" });
    act(() => toggleTagFilter("myNotes", WORK.id));
    fireEvent.click(within(panel()).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(panel().querySelector('input[data-selection-key="note:n-first"]')).not.toBeNull());
    fireEvent.click(within(panel()).getByRole("button", { name: "B closed" }));
    fireEvent.click(panel().querySelector('input[data-selection-key="note:n-first"]') as HTMLInputElement);
    fireEvent.click(panel().querySelector('input[data-selection-key="note:n-bravo"]') as HTMLInputElement, { shiftKey: true });
    expect(Array.from(panel().querySelectorAll<HTMLInputElement>("input[data-selection-key]")).filter((i) => i.checked).map((i) => i.dataset.selectionKey)).toEqual(["note:n-first", "note:n-bravo"]);
    expect(within(panel()).getByText("2 selected")).toBeInTheDocument();
  });

  it("selection mode on Groups: a collapsed group is shown open under a filter and select all is available", async () => {
    const aNote = groupNote({ id: "g-a1", title: "Alpha spec", group: GROUP_A, tags: [SPECS] });
    const aPlain = groupNote({ id: "g-a2", title: "Alpha plain", group: GROUP_A });
    stubApi([aNote, aPlain], { groups: [GROUP_A] });
    renderList("workspace");
    await within(panel()).findByRole("button", { name: "Alpha Team" });
    act(() => setCollapsed(`group:${GROUP_A.id}`, true));
    act(() => toggleTagFilter("workspace", SPECS.id, GROUP_A.id));
    fireEvent.click(within(panel()).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(panel().querySelector('input[data-selection-key="note:g-a1"]')).not.toBeNull());
    expect(panel().querySelector('input[data-selection-key="note:g-a2"]')).toBeNull();
    fireEvent.click(within(panel()).getByRole("button", { name: "Select all" }));
    expect(within(panel()).getByText("1 selected")).toBeInTheDocument();
  });

  it("no match shows 'No notes have all of these tags.'", async () => {
    stubApi([BRAVO, CHARLIE]);
    renderList("myNotes");
    await within(panel()).findByRole("link", { name: "Bravo log" });
    act(() => {
      toggleTagFilter("myNotes", WORK.id);
      toggleTagFilter("myNotes", BOOKS.id);
    });
    expect(within(panel()).getByText("No notes have all of these tags.")).toBeInTheDocument();
    expect(bar()).toHaveTextContent("0 notes");
  });

  describe("Groups tab", () => {
    const aNote = groupNote({ id: "g-a1", title: "Alpha spec", group: GROUP_A, tags: [SPECS, SYNC] });
    const aNote2 = groupNote({ id: "g-a2", title: "Alpha sync", group: GROUP_A, tags: [SYNC] });
    const bNote = groupNote({ id: "g-b1", title: "Beta book", group: GROUP_B, tags: [BOOKS] });
    const cNote = groupNote({ id: "g-c1", title: "Plain thing", group: GROUP_C });

    it("one section per group with tags, none for a group without tags; choosing a tag hides the other groups and shows the hint; the bar starts with the group name", async () => {
      stubApi([aNote, aNote2, bNote, cNote], { groups: [GROUP_A, GROUP_B, GROUP_C] });
      renderList("workspace");
      const menu = await openMenu();
      expect(within(menu).getByText("Filter by tag · Groups")).toBeInTheDocument();
      expect(within(menu).getByRole("group", { name: "Alpha Team" })).toBeInTheDocument();
      expect(within(menu).getByRole("group", { name: "Beta Club" })).toBeInTheDocument();
      expect(within(menu).queryByText("Plain Group")).toBeNull();
      expect(within(menu).getByText("One group at a time; groups without tags aren't listed")).toBeInTheDocument();
      fireEvent.click(tick("Sync"));
      expect(panel().querySelector('[data-node-kind="group"][data-node-id="' + GROUP_B.id + '"]')).toBeNull();
      expect(panel().querySelector('[data-node-kind="group"][data-node-id="' + GROUP_C.id + '"]')).toBeNull();
      expect(rowTitles()).toEqual(["Alpha spec", "Alpha sync"]);
      expect(panel().querySelector("[data-tag-filter-hint]")).toHaveTextContent("Showing only Alpha Team; other groups are hidden while filtering");
      expect(bar()!.firstElementChild).toHaveTextContent("Alpha Team");
    });

    it("with a filter on, other groups' rows are dimmed and choosing one switches group", async () => {
      stubApi([aNote, aNote2, bNote], { groups: [GROUP_A, GROUP_B] });
      renderList("workspace");
      const menu = await openMenu();
      fireEvent.click(tick("Specs"));
      const beta = within(menu).getByRole("group", { name: "Beta Club" });
      const alpha = within(menu).getByRole("group", { name: "Alpha Team" });
      expect(beta).toHaveClass("opacity-50");
      expect(alpha).not.toHaveClass("opacity-50");
      fireEvent.click(tick("Books"));
      expect(rowTitles()).toEqual(["Beta book"]);
      expect(within(panel()).getByRole("button", { name: "Filter by tag, 1 applied", hidden: true })).toBeInTheDocument();
      expect(tick("Specs")).toHaveAttribute("aria-checked", "false");
      expect(bar()!.firstElementChild).toHaveTextContent("Beta Club");
    });
  });

  it("phone: the sheet has Clear and Done; ticking applies at once and Done closes it", async () => {
    stubLayoutTier("phone");
    stubApi([ALPHA, BRAVO, CHARLIE]);
    renderList("myNotes");
    const menu = await openMenu();
    expect(menu).toHaveAttribute("data-menu-sheet");
    fireEvent.click(tick("Work"));
    expect(rowTitles()).toEqual(["Alpha plan", "Bravo log"]);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Clear" }));
    expect(rowTitles()).toHaveLength(3);
    expect(bar()).toBeNull();
    fireEvent.click(tick("Work"));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(rowTitles()).toEqual(["Alpha plan", "Bravo log"]);
  });

  it("a selected tag that disappears from the notes (renamed away, merged or deleted) stops filtering", async () => {
    stubApi([ALPHA, BRAVO]);
    const { queryClient } = renderList("myNotes");
    await within(panel()).findByRole("link", { name: "Alpha plan" });
    act(() => toggleTagFilter("myNotes", TODO.id));
    expect(rowTitles()).toEqual(["Alpha plan"]);
    // The tag is merged away: the next list has no note carrying it.
    await act(async () => {
      queryClient.setQueryData<NoteDto[]>(["notes"], [{ ...ALPHA, tags: [WORK] }, BRAVO]);
    });
    await waitFor(() => expect(rowTitles()).toEqual(["Alpha plan", "Bravo log"]));
    expect(bar()).toBeNull();
    expect(within(panel()).queryByText("No notes have all of these tags.")).toBeNull();
    expect(within(panel()).getByRole("button", { name: "Filter by tag" })).toBeInTheDocument();
  });

  it("selection mode lists only the filtered rows", async () => {
    stubApi([ALPHA, BRAVO, CHARLIE]);
    renderList("myNotes");
    await within(panel()).findByRole("link", { name: "Alpha plan" });
    act(() => toggleTagFilter("myNotes", WORK.id));
    fireEvent.click(within(panel()).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(panel().querySelectorAll("[data-selection-key]")).toHaveLength(2));
    expect(within(panel()).queryByText("Charlie notes")).toBeNull();
  });
});

function clearFilter() {
  toggleTagFilter("myNotes", WORK.id);
}
