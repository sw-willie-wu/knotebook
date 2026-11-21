import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { FolderDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { SidebarTabList } from "@/components/sidebar/SidebarTabList";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { NoteList } from "@/components/NoteList";
import { adminRole, groupDto } from "@/test/fixtures";
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
import { pressTrigger } from "@/test/menu-trigger";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
  vi.unstubAllGlobals();
});

const ME = { id: "u1", email: "a@example.com", handle: "tester", displayName: "Ann", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;
const G: GroupDto = groupDto({ id: "G", name: "Research" }, adminRole());
const H: GroupDto = groupDto({ id: "H", name: "Ops" }, adminRole());

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stub(data: { notes: NoteDto[]; folders?: FolderDto[]; groups?: GroupDto[] }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/notes") return Promise.resolve(json(data.notes));
      if (url === "/api/folders") return Promise.resolve(json({ folders: data.folders ?? [] }));
      if (url === "/api/groups") return Promise.resolve(json(data.groups ?? []));
      if (url === "/api/favorites") return Promise.resolve(json([]));
      if (url === "/api/auth/me") return Promise.resolve(json(ME));
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "x" } }), { status: 404 }));
    }),
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="loc">{location.pathname}</output>;
}

function renderList(tab: SidebarTab) {
  localStorage.setItem("sidebar.tab", tab);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <LocationProbe />
            <SidebarTabList idBase="t" />
            <div role="tabpanel">
              <NoteList />
            </div>
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const header = () => screen.getByRole("tabpanel").querySelector("[data-sidebar-header]") as HTMLElement;
const row = (kind: "folder" | "group", id: string) => {
  const node = screen.getByRole("tabpanel").querySelector(`[data-node-kind="${kind}"][data-node-id="${id}"]`) as HTMLElement;
  return node.firstElementChild as HTMLElement;
};
const buttonNames = (el: HTMLElement): string[] => within(el).queryAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "").filter(Boolean);
const linkNames = (el: HTMLElement): string[] => within(el).queryAllByRole("link").map((b) => b.getAttribute("aria-label") ?? "");
const before = (a: HTMLElement, b: HTMLElement): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const ROADEYE = folderDto({ id: "F1", name: "roadeye" });
const DECISIONS = folderDto({ id: "F2", name: "decisions", parentId: "F1" });
const TRAVEL = folderDto({ id: "F3", name: "Travel" });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("sidebar index entry points", () => {
  it("a folder whose subtree has knowledge shows Open the index of <name> before the new-note button, linking to /knowledge/f/<id>", async () => {
    stub({ notes: [personalNote({ id: "n1", title: "D1", folderId: "F2", hasKnowledge: true })], folders: [ROADEYE, DECISIONS, TRAVEL] });
    renderList("myNotes");
    const link = await screen.findByRole("link", { name: "Open the index of roadeye" });
    expect(link).toHaveAttribute("href", "/knowledge/f/F1");
    const newNote = within(row("folder", "F1")).getByRole("button", { name: "New note in roadeye" });
    expect(before(link, newNote)).toBe(true);
    expect(screen.getByRole("link", { name: "Open the index of decisions" })).toHaveAttribute("href", "/knowledge/f/F2");
  });

  it("a folder without knowledge has no index button and no Open index menu item; its row has the same buttons as before", async () => {
    stub({ notes: [personalNote({ id: "n1", title: "D1", folderId: "F2", hasKnowledge: true })], folders: [ROADEYE, DECISIONS, TRAVEL] });
    renderList("myNotes");
    await screen.findByRole("link", { name: "Open the index of roadeye" });
    expect(linkNames(row("folder", "F3"))).toEqual([]);
    expect(buttonNames(row("folder", "F3"))).toEqual(["New note in Travel", "Folder menu for Travel"]);
    pressTrigger(screen.getByRole("button", { name: "Folder menu for Travel" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Open index" })).toBeNull();
  });

  it("no knowledge anywhere leaves every row and the title row exactly as before", async () => {
    stub({ notes: [personalNote({ id: "n1", title: "D1", folderId: "F2" })], folders: [ROADEYE, DECISIONS] });
    renderList("myNotes");
    await screen.findByRole("button", { name: "Folder menu for roadeye" });
    expect(screen.queryAllByRole("link", { name: /Open the index/ })).toEqual([]);
    expect(buttonNames(row("folder", "F1"))).toEqual(["New note in roadeye", "Folder menu for roadeye"]);
  });

  it("a group with knowledge shows the index button before the new-folder button and Open index in its menu", async () => {
    stub({
      notes: [groupNote({ id: "n1", title: "G1", group: G, hasKnowledge: true })],
      groups: [G, H],
    });
    renderList("workspace");
    const link = await screen.findByRole("link", { name: "Open the index of Research" });
    expect(link).toHaveAttribute("href", "/knowledge/g/G");
    expect(before(link, within(row("group", "G")).getByRole("button", { name: "New folder in Research" }))).toBe(true);
    expect(screen.queryByRole("link", { name: "Open the index of Ops" })).toBeNull();
    expect(buttonNames(row("group", "H"))).toEqual(["New folder in Ops", "New note in Ops", "Group actions for Ops"]);
    pressTrigger(screen.getByRole("button", { name: "Group actions for Research" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Members & settings", "Open index", "Rename", "Delete group"]);
  });

  it("a group folder with knowledge gets its own index button; the group's index button is the group row's", async () => {
    const gf = groupFolder({ id: "GF", name: "Specs", groupId: "G" });
    stub({ notes: [groupNote({ id: "n1", title: "G1", group: G, folderId: "GF", hasKnowledge: true })], folders: [gf], groups: [G] });
    renderList("workspace");
    expect(await screen.findByRole("link", { name: "Open the index of Specs" })).toHaveAttribute("href", "/knowledge/f/GF");
    expect(screen.getByRole("link", { name: "Open the index of Research" })).toHaveAttribute("href", "/knowledge/g/G");
  });

  it("My notes shows the index button first in the title row only when a personal note has knowledge; other tabs never do", async () => {
    stub({ notes: [personalNote({ id: "n1", title: "Loose", hasKnowledge: true })] });
    const view = renderList("myNotes");
    const link = await screen.findByRole("link", { name: "Open the index of My notes" });
    expect(link).toHaveAttribute("href", "/knowledge/me");
    expect(header().querySelector("a, button")).toBe(link);
    view.unmount();

    stub({ notes: [personalNote({ id: "n1", title: "Loose", hasKnowledge: true })], groups: [G] });
    renderList("workspace");
    await screen.findByRole("button", { name: "New group" });
    expect(within(header()).queryByRole("link")).toBeNull();
  });

  it("My notes has no index button when only group notes have knowledge", async () => {
    stub({ notes: [groupNote({ id: "n1", title: "G1", group: G, hasKnowledge: true }), personalNote({ id: "n2", title: "p" })], groups: [G] });
    renderList("myNotes");
    await screen.findByText("p");
    expect(within(header()).queryByRole("link")).toBeNull();
  });

  it("the index buttons carry the hover-reveal classes for their row scope", async () => {
    stub({
      notes: [personalNote({ id: "n1", title: "D1", folderId: "F1", hasKnowledge: true }), groupNote({ id: "n2", title: "G1", group: G, hasKnowledge: true })],
      folders: [ROADEYE],
      groups: [G],
    });
    const view = renderList("myNotes");
    expect(await screen.findByRole("link", { name: "Open the index of roadeye" })).toHaveClass("group-hover/folderrow:opacity-100", "group-has-[:focus-visible]/folderrow:opacity-100", "opacity-0");
    expect(screen.getByRole("link", { name: "Open the index of My notes" })).toHaveClass("group-hover/tabheader:opacity-100", "group-has-[:focus-visible]/tabheader:opacity-100");
    view.unmount();
    renderList("workspace");
    expect(await screen.findByRole("link", { name: "Open the index of Research" })).toHaveClass("group-hover/grouprow:opacity-100");
  });

  it("Open index in the folder menu navigates to the folder index, after Rename and before the separator", async () => {
    stub({ notes: [personalNote({ id: "n1", title: "D1", folderId: "F1", hasKnowledge: true })], folders: [ROADEYE] });
    renderList("myNotes");
    await screen.findByRole("link", { name: "Open the index of roadeye" });
    pressTrigger(screen.getByRole("button", { name: "Folder menu for roadeye" }));
    const menu = await screen.findByRole("menu");
    const names = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) => (el.getAttribute("role") === "separator" ? "—" : (el.textContent ?? "")));
    expect(names.slice(0, 5)).toEqual(["New note", "New subfolder", "Rename", "Open index", "—"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open index" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/knowledge/f/F1"));
  });

  it("a read-only member's folder menu with an index has Open index followed by the separator before Sort by", async () => {
    const readOnly = groupFolder({ id: "GF", name: "Specs", groupId: "G", edit: false });
    stub({ notes: [groupNote({ id: "n1", title: "G1", group: G, folderId: "GF", hasKnowledge: true })], folders: [readOnly], groups: [G] });
    renderList("workspace");
    await screen.findByRole("link", { name: "Open the index of Specs" });
    pressTrigger(screen.getByRole("button", { name: "Folder menu for Specs" }));
    const menu = await screen.findByRole("menu");
    const names = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"], [role="group"] > [id], div[id]:not([role])')).map((el) =>
      el.getAttribute("role") === "separator" ? "—" : (el.textContent ?? ""),
    );
    expect(names.slice(0, 3)).toEqual(["Open index", "—", "Sort by"]);
  });
});
