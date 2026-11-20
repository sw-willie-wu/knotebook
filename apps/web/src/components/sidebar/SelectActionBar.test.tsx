import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import type { FavoriteDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import type { CollabState } from "@/collab/connection";
import { ActiveNoteProvider } from "@/lib/active-note";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import { adminRole, customRole, groupDto } from "@/test/fixtures";
import { clickOutside } from "@/test/outside-click";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import type { FolderDto } from "@knotebook/shared";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { mockWidePointer } from "@/test/wide-pointer";
import { __resetTagFilterForTests, toggleTagFilter } from "@/components/sidebar/tag-filter";

// Two shells (like AppShell's static card and drawer) share one selection; actions are always started from the second (shell 1), otherwise focus would land on the first.

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetTagFilterForTests();
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

const GA: GroupDto = groupDto({ id: "ga", name: "A" }, adminRole());
const GB: GroupDto = groupDto({ id: "gb", name: "B" }, customRole({ permissions: { ...customRole().permissions, create: true } }));
const P1 = personalNote({ id: "p1", title: "p1" });
const P2 = personalNote({ id: "p2", title: "p2" });
const P3 = personalNote({ id: "p3", title: "p3" });
const GA1 = groupNote({ id: "ga1", title: "ga1", group: GA });
const GA2 = groupNote({ id: "ga2", title: "ga2", group: GA });
/** Can delete but not edit. */
const GA3 = groupNote({ id: "ga3", title: "ga3", group: GA, edit: false });
/** Cannot delete. */
const GA4 = groupNote({ id: "ga4", title: "ga4", group: GA, delete: false });
const S1 = sharedNote({ id: "s1", title: "s1", role: "viewer" });
const ALL = [P1, P2, P3, GA1, GA2, GA3, GA4, S1];
const FAVORITES: FavoriteDto[] = [
  { noteId: "p2", favoritedAt: "2026-03-03T00:00:00.000Z" },
  { noteId: "ga1", favoritedAt: "2026-03-02T00:00:00.000Z" },
  { noteId: "p1", favoritedAt: "2026-03-01T00:00:00.000Z" },
];

interface Call {
  key: string;
  body: unknown;
}

/**
 * Fake server: lists and groups follow `box`; DELETE/move/copy succeed by default and change `box.notes` (visible on the next GET), restore returns the deleted notes.
 * `fail(key, status, code)` makes one endpoint fail; `hold(key)` makes one wait until released (returns the release function).
 */
function stubServer(initial: { notes?: NoteDto[]; groups?: GroupDto[]; folders?: FolderDto[]; favorites?: FavoriteDto[] } = {}) {
  const box = { notes: [...(initial.notes ?? ALL)], groups: initial.groups ?? [GA], folders: [...(initial.folders ?? [])], favorites: [...(initial.favorites ?? [])] };
  const trashed = new Map<string, NoteDto>();
  const calls: Call[] = [];
  const failures = new Map<string, { status: number; code: string }>();
  const gates = new Map<string, Promise<void>>();
  const listeners: ((key: string) => void)[] = [];

  /** Ids of a folder subtree (including itself). */
  function subtree(folderId: string): Set<string> {
    const out = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of box.folders) {
        if (folder.parentId !== null && out.has(folder.parentId) && !out.has(folder.id)) {
          out.add(folder.id);
          grew = true;
        }
      }
    }
    return out;
  }

  function perform(method: string, url: string, body: unknown): Response {
    const key = `${method} ${url}`;
    const failure = failures.get(key);
    if (failure) return fakeResponse({ error: { code: failure.code, message: "x" } }, failure.status);
    const [, , resource, rawId] = url.split("/");
    const id = decodeURIComponent(rawId ?? "");
    if (resource === "favorites") {
      if (method === "DELETE") box.favorites = box.favorites.filter((favorite) => favorite.noteId !== id);
      return fakeResponse(undefined, 204);
    }
    if (resource === "folders") {
      const folder = box.folders.find((f) => f.id === id);
      if (!folder) return fakeResponse({ error: { code: "folder_not_found", message: "x" } }, 404);
      if (method === "PATCH") {
        const moved: FolderDto = { ...folder, parentId: (body as { parentId: string | null }).parentId };
        box.folders = box.folders.map((f) => (f.id === id ? moved : f));
        return fakeResponse(moved);
      }
      if (method === "DELETE") {
        const ids = subtree(id);
        const inside = box.notes.filter((n) => n.folderId !== null && ids.has(n.folderId));
        box.folders = box.folders.filter((f) => !ids.has(f.id));
        // Shared with me: a folder is only the user's own grouping; after removal its contents go back to the top level and not to the trash.
        if (folder.space.kind === "shared") {
          box.notes = box.notes.map((n) => (inside.includes(n) ? { ...n, folderId: null } : n));
          return fakeResponse({ trashedNoteIds: [], deletedFolderIds: [...ids] });
        }
        box.notes = box.notes.filter((n) => !inside.includes(n));
        for (const n of inside) trashed.set(n.id, n);
        return fakeResponse({ trashedNoteIds: inside.map((n) => n.id), deletedFolderIds: [...ids] });
      }
    }
    const note = box.notes.find((n) => n.id === id);
    if (method === "DELETE" && note) {
      box.notes = box.notes.filter((n) => n.id !== id);
      trashed.set(id, note);
      return fakeResponse(undefined, 204);
    }
    if (method === "PUT" && url.endsWith("/folder") && note) {
      const placed: NoteDto = { ...note, folderId: (body as { folderId: string | null }).folderId };
      box.notes = box.notes.map((n) => (n.id === id ? placed : n));
      return fakeResponse(placed);
    }
    if (url.endsWith("/move") && note) {
      const { groupId, folderId } = body as { groupId: string; folderId?: string };
      const group = box.groups.find((g) => g.id === groupId) as GroupDto;
      const moved: NoteDto = {
        ...note,
        ownerId: null,
        ownerHandle: null,
        role: "editor",
        groupId: group.id,
        group: { id: group.id, name: group.name },
        folderId: folderId ?? null,
      };
      box.notes = box.notes.map((n) => (n.id === id ? moved : n));
      return fakeResponse(moved);
    }
    if (url.endsWith("/copy") && note) {
      const groupId = (body as { groupId?: string }).groupId;
      const group = box.groups.find((g) => g.id === groupId);
      const copy: NoteDto = group
        ? { ...note, id: `${id}-copy`, ownerId: null, ownerHandle: null, groupId: group.id, group: { id: group.id, name: group.name } }
        : personalNote({ id: `${id}-copy`, title: `${note.title} copy` });
      box.notes = [...box.notes, copy];
      return fakeResponse(copy);
    }
    if (url === "/api/trash/restore") {
      const restored = (body as { ids: string[] }).ids.flatMap((rid) => {
        const hit = trashed.get(rid);
        return hit ? [hit] : [];
      });
      box.notes = [...box.notes, ...restored];
      return fakeResponse({ restored, skipped: [] });
    }
    return fakeResponse({ error: { code: "not_found", message: "x" } }, 404);
  }

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "GET") {
        if (url === "/api/folders") return Promise.resolve(fakeResponse(box.folders.length === 0 ? FOLDER_LIST_EMPTY : { folders: box.folders }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse(box.notes));
        if (url === "/api/groups") return Promise.resolve(fakeResponse(box.groups));
        if (url === "/api/favorites") return Promise.resolve(fakeResponse(box.favorites));
        if (url === "/api/auth/me") return Promise.resolve(fakeResponse(ME));
        return Promise.resolve(fakeResponse({ error: { code: "not_found", message: "x" } }, 404));
      }
      const key = `${method} ${url}`;
      calls.push({ key, body });
      for (const listener of listeners) listener(key);
      const gate = gates.get(key);
      return gate ? gate.then(() => perform(method, url, body)) : Promise.resolve(perform(method, url, body));
    }),
  );

  return {
    box,
    /** Non-GET requests (in send order). */
    keys: () => calls.map((call) => call.key),
    bodies: (key: string) => calls.filter((call) => call.key === key).map((call) => call.body),
    fail: (key: string, status: number, code: string) => {
      failures.set(key, { status, code });
    },
    hold: (key: string): (() => Promise<void>) => {
      let open = () => {};
      gates.set(
        key,
        new Promise<void>((resolve) => {
          open = resolve;
        }),
      );
      return async () => {
        await act(async () => {
          open();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
    },
    onRequest: (listener: (key: string) => void) => {
      listeners.push(listener);
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

interface RenderOpts {
  tab?: SidebarTab;
  controls?: NotePageControls;
  path?: string;
  outside?: ReactNode;
}

/** Stand-in for NotePage: `controls` can be swapped mid-test (the same NotePage instance changing note = the same leavingRef with a new noteId), and it gives the test a navigate. */
interface PageHost {
  setControls: (controls: NotePageControls) => void;
  navigate: NavigateFunction;
}

function ControlsHost({ initial, host, children }: { initial: NotePageControls; host: { current: PageHost | null }; children: ReactNode }) {
  const [controls, setControls] = useState(initial);
  const navigate = useNavigate();
  host.current = { setControls, navigate };
  return <NotePageControlsContext.Provider value={controls}>{children}</NotePageControlsContext.Provider>;
}

function renderShells(opts: RenderOpts = {}) {
  const host: { current: PageHost | null } = { current: null };
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shells = (
    <SidebarTabProvider>
      {[0, 1].map((index) => (
        <div key={index} data-sidebar-instance="" data-testid={`shell-${index}`}>
          <div role="tabpanel" tabIndex={0}>
            <NoteList />
          </div>
          <SidebarFooter searching={false} onCreateNote={() => {}} newNotePending={false} />
        </div>
      ))}
      {opts.outside}
    </SidebarTabProvider>
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[opts.path ?? "/"]}>
        <ActiveNoteProvider>
          {opts.controls ? (
            <ControlsHost initial={opts.controls} host={host}>
              {shells}
            </ControlsHost>
          ) : (
            shells
          )}
          <LocationProbe />
          <Toaster />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, host };
}

const shell = (index: number) => screen.getByTestId(`shell-${index}`);
const shellHeader = (index: number) => shell(index).querySelector("[data-sidebar-header]") as HTMLElement;
const bar = (index = 1) => shell(index).querySelector("[data-select-action-bar]") as HTMLElement;
/** While a dialog is open the background is aria-hidden, so always use hidden: true. */
const barButton = (name: string | RegExp, index = 1) => within(bar(index)).getByRole("button", { name, hidden: true });
const selectButton = (index = 1) => within(shellHeader(index)).queryByRole("button", { name: "Select", hidden: true });
const doneButton = (index = 1) => within(shellHeader(index)).getByRole("button", { name: "Done", hidden: true });
const box = (id: string, index = 1) => shell(index).querySelector(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;
const checkedIds = (index = 1) =>
  Array.from(shell(index).querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.selectionKey?.replace(/^note:/, ""));
const location = () => screen.getByTestId("location").textContent;
const toastRoot = (title: string) => screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
const selecting = (index = 1) => within(shellHeader(index)).queryByRole("button", { name: "Done", hidden: true }) !== null;
const tick = (...ids: string[]) => {
  for (const id of ids) fireEvent.click(box(id));
};
const settleTimers = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function enterSelecting(index = 1): Promise<void> {
  await waitFor(() => expect(selectButton(index)).toBeEnabled());
  fireEvent.click(selectButton(index) as HTMLElement);
  await within(shellHeader(index)).findByText("0 selected");
  await waitFor(() => expect(shell(index).querySelector('input[type="checkbox"]')).not.toBeNull());
  await waitFor(() => expect(bar(index)).not.toBeNull());
}

async function pickDestination(name: string): Promise<HTMLElement> {
  const picker = await screen.findByRole("dialog", { name: /^(Move to|Copy to)$/ });
  fireEvent.click(within(picker).getByRole("button", { name }));
  return screen.findByRole("dialog", { name: /^(Move into group|Copy to my notes|Copy into group|Make a copy)$/ });
}

describe("SelectActionBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  describe("buttons per tab", () => {
    it("my notes: Move to, Copy to, Delete 0 selected items; all disabled with 0 notes; pressable after ticking one; styling; no New note at the bottom", async () => {
      stubServer();
      renderShells();
      await enterSelecting();
      expect(within(bar()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
        "Move to",
        "Copy to",
        "Delete 0 selected items",
      ]);
      for (const name of ["Move to", "Copy to", "Delete 0 selected items"]) expect(barButton(name)).toBeDisabled();
      tick("p1");
      expect(barButton("Move to")).toBeEnabled();
      expect(barButton("Copy to")).toBeEnabled();
      const del = barButton("Delete 1 selected item");
      expect(del).toBeEnabled();
      expect(del).toHaveAttribute("title", "Delete 1 selected item");
      expect(barButton("Move to").querySelector('svg[data-icon="folder-input"]')).not.toBeNull();
      expect(barButton("Copy to").querySelector('svg[data-icon="copy"]')).not.toBeNull();
      expect(del.querySelector('svg[data-icon="trash"]')).not.toBeNull();
      expect(del).toHaveClass("text-destructive", "border", "hover:bg-destructive/10");
      // Not outline (its hover fills brand-deep and its active mixes brand-deep; hover:bg is overridden by twMerge, so the whole class string is checked).
      expect(del.className).not.toContain("brand-deep");
      expect(del.className).not.toContain("hover:border-transparent");
      expect(within(shell(1)).queryByRole("button", { name: "New note" })).toBeNull();
      // Layout contract: on narrow each button holds only an icon (no visible text) with the accessible name from aria-label; the two can shrink (min-w-0) and share the remaining row width, title carries the full text.
      for (const name of ["Move to", "Copy to"]) {
        const button = barButton(name);
        expect(button).toHaveClass("min-w-0", "flex-1", "px-1.5");
        expect(button).toHaveAttribute("title", name);
        expect(button).toHaveAttribute("aria-label", name);
        expect(button.textContent).toBe("");
        expect(button.querySelector("svg")).not.toHaveClass("hidden");
      }
      expect(del.textContent).toBe("");
      expect(del).toHaveClass("w-9", "shrink-0");
    });

    // Favorites: the first is Remove from favorites, no Move to; the same in both forms.
    it.each(["narrow", "wide"] as const)("favorites (%s): Remove from favorites, Copy to, Delete; no Move to; pressable after ticking", async (form) => {
      mockWidePointer(form === "wide");
      stubServer({ favorites: FAVORITES });
      renderShells({ tab: "favorites" });
      await enterForm(form);
      const names = () => within(bar()).getAllByRole("button", { hidden: true }).map((b) => b.getAttribute("aria-label") ?? b.textContent);
      expect(names()).toEqual(["Remove from favorites", "Copy to", "Delete 0 selected items"]);
      for (const name of names()) expect(barButton(name as string)).toBeDisabled();
      tick("p2");
      expect(barButton("Remove from favorites")).toBeEnabled();
      expect(barButton("Copy to")).toBeEnabled();
      expect(barButton("Delete 1 selected item")).toBeEnabled();
      expect(within(bar()).queryByRole("button", { name: "Move to", hidden: true })).toBeNull();
      for (const button of within(bar()).getAllByRole("button", { hidden: true })) expect(button.textContent).toBe("");
    });

    it("favorites: a note that cannot be deleted can still be removed from favorites, Delete stays disabled", async () => {
      stubServer({ favorites: [{ noteId: "ga4", favoritedAt: "2026-03-01T00:00:00.000Z" }] });
      renderShells({ tab: "favorites" });
      await enterSelecting();
      tick("ga4");
      expect(barButton("Remove from favorites")).toBeEnabled();
      expect(barButton("Delete 1 selected item")).toBeDisabled();
    });

    it("favorites: the Copy to destinations have no \"make a copy\" upper half", async () => {
      stubServer({ favorites: FAVORITES });
      renderShells({ tab: "favorites" });
      await enterSelecting();
      tick("p2");
      fireEvent.click(barButton("Copy to"));
      const picker = await screen.findByRole("dialog", { name: "Copy to" });
      expect(within(picker).queryByRole("button", { name: "Make a copy" })).toBeNull();
      expect(within(picker).getByRole("button", { name: "My notes" })).toBeInTheDocument();
    });

    // Group and shared-with-me tabs add Move to; the delete button of shared-with-me exists only when the selection is all folders (not with 0 items).
    it.each([
      ["recent" as const, ["Copy to", "Delete 0 selected items"]],
      ["workspace" as const, ["Move to", "Copy to", "Delete 0 selected items"]],
      ["shared" as const, ["Move to", "Copy to"]],
    ])("%s: %j", async (tab, names) => {
      stubServer();
      renderShells({ tab });
      await enterSelecting();
      expect(within(bar()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(names);
    });
  });

  it("no group to move into (only B, which can create only): Move to is disabled", async () => {
    stubServer({ groups: [GB] });
    renderShells();
    await enterSelecting();
    tick("p1");
    await waitFor(() => expect(barButton("Copy to")).toBeEnabled());
    expect(barButton("Move to")).toBeDisabled();
  });

  it("move: tick p2 then p1, pick A: the confirm shows the note count and the four general sentences, requests are sent in order, then toast, selection ends and focus is on the same shell's Select", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p2", "p1");
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    expect(confirm).toHaveAccessibleName("Move into group");
    expect(confirm).toHaveAccessibleDescription('Move 2 notes into "A"?');
    expect(within(confirm).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Any per-person sharing is removed; anyone not in the group loses access.",
      "Any public links are turned off.",
      "Their addresses change to /g/…; the old addresses forward to the new ones for a month.",
      "You will no longer own them — what you can do with them then depends on your role in the group.",
      "Their version history is cleared and doesn't come back.",
    ]);
    const submit = within(confirm).getByRole("button", { name: "Move into group" });
    expect(submit).toHaveClass("bg-destructive");
    fireEvent.click(submit);
    expect(await screen.findByText('Moved 2 notes into "A"', { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p1/move", "POST /api/notes/p2/move"]);
    expect(server.bodies("POST /api/notes/p1/move")).toEqual([{ groupId: "ga" }]);
    await waitFor(() => expect(selecting()).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selectButton(1)).toHaveFocus();
    await settleTimers();
    expect(selectButton(1)).toHaveFocus();
  });

  it("after choosing the destination: the button that opened the picker gets no focus call and focus is inside the confirm dialog", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    const moveTo = barButton("Move to");
    fireEvent.click(moveTo);
    const picker = await screen.findByRole("dialog", { name: "Move to" });
    const spy = vi.fn();
    moveTo.addEventListener("focus", spy);
    fireEvent.click(within(picker).getByRole("button", { name: "A" }));
    const confirm = await screen.findByRole("dialog", { name: "Move into group" });
    await settleTimers();
    expect(spy).toHaveBeenCalledTimes(0);
    expect(confirm.contains(document.activeElement)).toBe(true);
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("snapshot: after the first request returns the list has one note fewer, the description still says 2 notes while sending and the second request is still sent", async () => {
    const server = stubServer();
    const releaseP2 = server.hold("POST /api/notes/p2/move");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    fireEvent.click(within(confirm).getByRole("button", { name: "Move into group" }));
    await waitFor(() => expect(server.keys()).toEqual(["POST /api/notes/p1/move", "POST /api/notes/p2/move"]));
    // p1 has moved into the group; after the list refetch it is no longer in my notes.
    await waitFor(() => expect(box("p1")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Move into group" })).toHaveAccessibleDescription('Move 2 notes into "A"?');
    await releaseP2();
    expect(await screen.findByText('Moved 2 notes into "A"', { exact: true })).toBeInTheDocument();
  });

  it("move hits a server skip (403): 1 succeeded, 1 skipped, selection ends", async () => {
    const server = stubServer();
    server.fail("POST /api/notes/p2/move", 403, "forbidden");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Move to"));
    fireEvent.click(within(await pickDestination("A")).getByRole("button", { name: "Move into group" }));
    expect(await screen.findByText('Moved 1 note into "A", 1 skipped (no permission, or it no longer exists)', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
  });

  it("copy to my notes: confirm dialog, body {}, toast", async () => {
    const server = stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("My notes");
    expect(confirm).toHaveAccessibleName("Copy to my notes");
    expect(confirm).toHaveAccessibleDescription(
      "This creates a copy in My notes; the original stays as it is. AI edit history, version history and backlinks are not copied.",
    );
    const submit = within(confirm).getByRole("button", { name: "Copy to my notes" });
    expect(submit).not.toHaveClass("bg-destructive");
    fireEvent.click(submit);
    expect(await screen.findByText("Copied 1 note to My notes", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/notes/ga1/copy")).toEqual([{}]);
    await waitFor(() => expect(selecting()).toBe(false));
  });

  // In the group tab with a single group A, the upper half of Copy to is A itself (make a copy) and the lower half no longer lists A -> copy from my notes to A (same confirm text and body).
  it("copy to a group: body {groupId}, toast", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("A");
    expect(confirm).toHaveAccessibleName("Copy into group");
    expect(confirm).toHaveAccessibleDescription(
      'This creates 2 copies in "A"; the originals stay as they are. AI edit history, version history and backlinks are not copied.',
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Copy into group" }));
    expect(await screen.findByText('Copied 2 notes into "A"', { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/notes/p1/copy")).toEqual([{ groupId: "ga" }]);
    expect(server.bodies("POST /api/notes/p2/copy")).toEqual([{ groupId: "ga" }]);
  });

  it("delete: no confirmation, two DELETEs in list order, toast + Undo restores the whole batch", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p2", "p1");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
    expect(toastRoot("Moved 2 notes to the trash")).not.toHaveClass("bg-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/trash/restore")).toEqual([{ ids: ["p1", "p2"] }]);
  });

  /** Two tagged notes and two plain ones; a plain one is ticked before the filter goes on, then select all runs under the filter. */
  async function filterAndSelectAll() {
    const work = { id: "t-work", name: "Work", color: "blue" as const };
    const server = stubServer({
      notes: [
        personalNote({ id: "mt-1", title: "mt-1", tags: [work] }),
        personalNote({ id: "mt-2", title: "mt-2", tags: [work] }),
        personalNote({ id: "mp-1", title: "mp-1" }),
        personalNote({ id: "mp-2", title: "mp-2" }),
      ],
    });
    renderShells({ tab: "myNotes" });
    await enterSelecting();
    await waitFor(() => expect(box("mt-1")).not.toBeNull());
    tick("mp-1");
    act(() => toggleTagFilter("myNotes", work.id));
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "Select all", hidden: true }));
    expect(checkedIds()).toEqual(["mt-1", "mt-2"]);
    return server;
  }

  it("under a tag filter, move sends only the matching ticked notes", async () => {
    const server = await filterAndSelectAll();
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    expect(confirm).toHaveAccessibleDescription('Move 2 notes into "A"?');
    fireEvent.click(within(confirm).getByRole("button", { name: "Move into group" }));
    expect(await screen.findByText('Moved 2 notes into "A"', { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/mt-1/move", "POST /api/notes/mt-2/move"]);
    __resetTagFilterForTests();
  });

  it("under a tag filter, copy sends only the matching ticked notes", async () => {
    const server = await filterAndSelectAll();
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("A");
    expect(confirm).toHaveAccessibleDescription(expect.stringContaining('This creates 2 copies in "A"'));
    fireEvent.click(within(confirm).getByRole("button", { name: "Copy into group" }));
    expect(await screen.findByText('Copied 2 notes into "A"', { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/mt-1/copy", "POST /api/notes/mt-2/copy"]);
    __resetTagFilterForTests();
  });

  it("under a tag filter a folder ticked earlier is not deleted with the notes the filter hides; only the matching notes are sent", async () => {
    const work = { id: "t-work", name: "Work", color: "blue" as const };
    const inA = personalNote({ id: "fa-tagged", title: "fa-tagged", folderId: "A", tags: [work] });
    const inAPlain = personalNote({ id: "fa-plain", title: "fa-plain", folderId: "A" });
    const rootTagged = personalNote({ id: "fr-tagged", title: "fr-tagged", tags: [work] });
    const rootPlain = personalNote({ id: "fr-plain", title: "fr-plain" });
    const server = stubServer({ notes: [inA, inAPlain, rootTagged, rootPlain], folders: [folderDto({ id: "A", name: "A" })], groups: [] });
    renderShells({ tab: "myNotes" });
    await enterSelecting();
    await waitFor(() => expect(box("fa-tagged")).not.toBeNull());
    fireEvent.click(shell(1).querySelector('input[data-selection-key="folder:A"]') as HTMLInputElement);
    tick("fr-plain");
    act(() => toggleTagFilter("myNotes", work.id));
    expect(shell(1).querySelector('input[data-selection-key="folder:A"]')).toBeNull();
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "Select all", hidden: true }));
    expect(checkedIds()).toEqual(["fa-tagged", "fr-tagged"]);
    expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/fa-tagged", "DELETE /api/notes/fr-tagged"]);
    __resetTagFilterForTests();
    __resetFolderSortForTests();
  });

  it("delete is sent in tree order (folders first): server order [root fp3, fp1 inside folder A] gives DELETE fp1 then fp3", async () => {
    const fp3 = personalNote({ id: "fp3", title: "fp3" });
    const fp1 = personalNote({ id: "fp1", title: "fp1", folderId: "A" });
    const server = stubServer({ notes: [fp3, fp1], folders: [folderDto({ id: "A", name: "A" })] });
    renderShells();
    await enterSelecting();
    await waitFor(() => expect(box("fp1")).not.toBeNull());
    tick("fp3", "fp1");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/fp1", "DELETE /api/notes/fp3"]);
    __resetFolderSortForTests();
  });

  it("delete in the recent tab with a shared note mixed in: only p1 is sent, the toast reports 1 skipped, Undo is present", async () => {
    const server = stubServer();
    renderShells({ tab: "recent" });
    await enterSelecting();
    tick("p1", "s1");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 1 note to the trash, 1 skipped (no permission, or it no longer exists)", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/p1"]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  /** Simulates Chromium: an element holding focus loses it synchronously (blur and focusout still fire) the moment it is written disabled. jsdom does not do this itself. */
  function blurOnDisable(): () => void {
    const original = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (name === "disabled" && this === document.activeElement) (this as HTMLElement).blur();
      return original.call(this, name, value);
    };
    return () => {
      Element.prototype.setAttribute = original;
    };
  }

  it("recent tab all deleted and the list empty: focus does not fall to body but lands on the panel (in a browser that blurs synchronously on disable)", async () => {
    const restore = blurOnDisable();
    try {
      stubServer({ notes: [personalNote({ id: "d1", title: "d1" }), personalNote({ id: "d2", title: "d2" })] });
      renderShells({ tab: "recent" });
      await enterSelecting();
      await waitFor(() => expect(box("d1")).not.toBeNull());
      tick("d1", "d2");
      fireEvent.click(barButton("Delete 2 selected items"));
      expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
      await waitFor(() => expect(selectButton(1)).toBeDisabled());
      await waitFor(() => expect(within(screen.getByTestId("shell-1")).getByRole("tabpanel")).toHaveFocus());
      expect(document.body).not.toHaveFocus();
    } finally {
      restore();
    }
  });

  it("the Select button blurs without being disabled, or the user moved focus elsewhere: focus is not stolen", async () => {
    stubServer({ notes: [personalNote({ id: "d1", title: "d1" })] });
    renderShells({ tab: "recent" });
    const other = document.createElement("button");
    document.body.appendChild(other);
    try {
      await waitFor(() => expect(selectButton(1)).toBeEnabled());
      const button = selectButton(1) as HTMLButtonElement;
      const panel = within(screen.getByTestId("shell-1")).getByRole("tabpanel");
      // Blurred while the button is still usable (clicking elsewhere): focus stays on body, not handed to the panel.
      button.focus();
      button.blur();
      await act(async () => {
        await Promise.resolve();
      });
      expect(panel).not.toHaveFocus();
      // Focus was moved to another element by the user, and the button is disabled afterwards: nothing moves.
      button.focus();
      other.focus();
      button.setAttribute("disabled", "");
      await act(async () => {
        await Promise.resolve();
      });
      expect(other).toHaveFocus();
    } finally {
      other.remove();
    }
  });

  it("a disabled Select button emits focusout: with a non-null relatedTarget, or with focus already on another element, focus is not stolen in either case", async () => {
    stubServer({ notes: [personalNote({ id: "d1", title: "d1" })] });
    renderShells({ tab: "recent" });
    const other = document.createElement("button");
    document.body.appendChild(other);
    try {
      await waitFor(() => expect(selectButton(1)).toBeEnabled());
      const button = selectButton(1) as HTMLButtonElement;
      const panel = within(screen.getByTestId("shell-1")).getByRole("tabpanel");
      const flush = () =>
        act(async () => {
          await Promise.resolve();
        });
      // The button was disabled without holding focus (no blur fires), focus is on body.
      button.setAttribute("disabled", "");
      // Focus is on body and focusout carries a relatedTarget: focus is moving elsewhere, so it is not handed to the panel.
      button.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: other }));
      await flush();
      expect(panel).not.toHaveFocus();
      expect(document.body).toHaveFocus();
      // relatedTarget is empty but focus is already on another element: nothing moves.
      other.focus();
      button.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      await flush();
      expect(other).toHaveFocus();
      // Contrast: empty relatedTarget and focus on body hands focus to the panel.
      other.blur();
      button.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      await flush();
      expect(panel).toHaveFocus();
    } finally {
      other.remove();
    }
  });

  it("no deletable note: Delete is disabled; ticking one deletable note enables it", async () => {
    stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga4");
    expect(barButton("Delete 1 selected item")).toBeDisabled();
    expect(barButton("Copy to")).toBeEnabled();
    tick("ga1");
    expect(barButton("Delete 2 selected items")).toBeEnabled();
  });

  it("recent tab with only shared (viewer) notes ticked: Delete is disabled, Copy to is enabled", async () => {
    stubServer();
    renderShells({ tab: "recent" });
    await enterSelecting();
    tick("s1");
    expect(barButton("Delete 1 selected item")).toBeDisabled();
    expect(barButton("Copy to")).toBeEnabled();
  });

  it("both notes editable and deletable: Undo is present", async () => {
    stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1", "ga2");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("one note that can be deleted but not edited mixed in: no Undo, with an explanatory sentence", async () => {
    stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1", "ga3");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Members of the group whose role can both edit and delete notes can restore it.", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("copy hits 429: stops at the second note, error toast + 1 completed, selection stays with only the two unprocessed notes", async () => {
    const server = stubServer();
    server.fail("POST /api/notes/p2/copy", 429, "too_many_requests");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Copy to"));
    fireEvent.click(within(await pickDestination("Make a copy")).getByRole("button", { name: "Make a copy" }));
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Too many requests. Please slow down.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 note was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p1/copy", "POST /api/notes/p2/copy"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selecting()).toBe(true);
    expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["p2", "p3"]);
  });

  it("move gets 404 group_not_found on the first note: 0 completed, both notes stay ticked", async () => {
    const server = stubServer();
    server.fail("POST /api/notes/p1/move", 404, "group_not_found");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Move to"));
    fireEvent.click(within(await pickDestination("A")).getByRole("button", { name: "Move into group" }));
    expect(await screen.findByText("We couldn't find that group.", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("0 notes were done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p1/move"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(checkedIds()).toEqual(["p1", "p2"]);
    // Stopped: focus returns to the button that opened the picker (Move to is usable again).
    expect(barButton("Move to")).toHaveFocus();
  });

  it("delete gets 500 on the second note: the error sentence is the title, 1 completed, Undo still present (restoring only the first), 2 selected", async () => {
    const server = stubServer();
    server.fail("DELETE /api/notes/p2", 500, "internal");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    const del = barButton("Delete 3 selected items");
    fireEvent.click(del);
    expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Something went wrong. Please try again.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 note was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument());
    expect(barButton("Delete 2 selected items")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/trash/restore")).toEqual([{ ids: ["p1"] }]);
  });

  it("when it stops with focus already moved to an outside input: focus is not moved back to the delete button", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    server.fail("DELETE /api/notes/p2", 500, "internal");
    renderShells({ outside: <input aria-label="probe" /> });
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    const probe = screen.getByRole("textbox", { name: "probe" });
    probe.focus();
    await releaseP1();
    expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument());
    await settleTimers();
    expect(probe).toHaveFocus();
  });

  describe("the currently open note", () => {
    function controlsFor(state: CollabState) {
      const leavingRef = { current: false };
      const controls: NotePageControls = { noteId: "p2", state, leavingRef, openEdits: () => {} };
      return { controls, leavingRef };
    }

    it("it is ordered last and leavingRef is set before sending it; one toast, navigates home; Undo restores three notes and navigates back to it", async () => {
      const server = stubServer();
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      const leavingAt: Record<string, boolean> = {};
      server.onRequest((key) => {
        leavingAt[key] = leavingRef.current;
      });
      renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p2", "p1", "p3");
      fireEvent.click(barButton("Delete 3 selected items"));
      expect(await screen.findByText("Moved 3 notes to the trash", { exact: true })).toBeInTheDocument();
      expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p3", "DELETE /api/notes/p2"]);
      expect(leavingAt).toEqual({ "DELETE /api/notes/p1": false, "DELETE /api/notes/p3": false, "DELETE /api/notes/p2": true });
      // Reference only (NotePage is not mounted, so its terminal toast does not occur).
      expect(document.querySelectorAll("li[data-swipe-direction]")).toHaveLength(1);
      await waitFor(() => expect(location()).toBe("/"));
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(await screen.findByText("Restored 3 notes", { exact: true })).toBeInTheDocument();
      expect(server.bodies("POST /api/trash/restore")).toEqual([{ ids: ["p1", "p3", "p2"] }]);
      await waitFor(() => expect(location()).toBe("/n/tester/note-p2"));
    });

    it("the open note fails with collaboration non-terminal: leavingRef is reset to false, no navigation", async () => {
      const server = stubServer();
      server.fail("DELETE /api/notes/p2", 500, "internal");
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
      expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
      expect(leavingRef.current).toBe(false);
      await settleTimers();
      expect(location()).toBe("/n/tester/note-p2");
    });

    it("the open note fails with collaboration terminal (deleted): navigates home, only the batch's one toast", async () => {
      const server = stubServer();
      server.fail("DELETE /api/notes/p2", 500, "internal");
      const { controls, leavingRef } = controlsFor({ phase: "deleted" });
      renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
      await waitFor(() => expect(location()).toBe("/"));
      expect(leavingRef.current).toBe(true);
      expect(document.querySelectorAll("li[data-swipe-direction]")).toHaveLength(1);
    });

    it("mid-batch the same NotePage switches to another note: sending the original note does not set leavingRef (it now belongs to the new note) and success does not navigate home", async () => {
      const server = stubServer();
      const releaseP1 = server.hold("DELETE /api/notes/p1");
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      const leavingAt: Record<string, boolean> = {};
      server.onRequest((key) => {
        leavingAt[key] = leavingRef.current;
      });
      const { host } = renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
      // Switching note via Ctrl+K / a wikilink: NotePage does not remount, the same leavingRef with noteId changed to p9.
      act(() => {
        void host.current?.navigate("/n/tester/note-p9");
        host.current?.setControls({ ...controls, noteId: "p9" });
      });
      expect(location()).toBe("/n/tester/note-p9");
      await releaseP1();
      expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
      expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
      expect(leavingAt["DELETE /api/notes/p2"]).toBe(false);
      expect(leavingRef.current).toBe(false);
      await settleTimers();
      expect(location()).toBe("/n/tester/note-p9");
    });

    it("the original note fails after switching note: the new note's leavingRef is untouched (its own single-note delete is going through the gate)", async () => {
      const server = stubServer();
      const releaseP1 = server.hold("DELETE /api/notes/p1");
      server.fail("DELETE /api/notes/p2", 500, "internal");
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      const { host } = renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
      act(() => host.current?.setControls({ ...controls, noteId: "p9" }));
      leavingRef.current = true;
      await releaseP1();
      expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
      expect(leavingRef.current).toBe(true);
    });
  });

  it("Esc with focus on Copy to: selection ends and focus is on the same shell's Select", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    const copy = barButton("Copy to");
    copy.focus();
    fireEvent.keyDown(copy, { key: "Escape" });
    await waitFor(() => expect(selecting()).toBe(false));
    expect(selectButton(1)).toHaveFocus();
  });

  it("Esc with the picker open: only the picker closes, the selection stays", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Copy to"));
    const picker = await screen.findByRole("dialog", { name: "Copy to" });
    fireEvent.keyDown(document.activeElement ?? picker, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selecting()).toBe(true);
    expect(checkedIds()).toEqual(["p1"]);
  });

  it("confirm dialog Cancel: selection stays, no request, focus returns to the button that opened it", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(server.keys()).toEqual([]);
    expect(selecting()).toBe(true);
    expect(barButton("Move to")).toHaveFocus();
  });

  it("picker Cancel: focus returns to Move to (still there after setTimeout)", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Move to"));
    const picker = await screen.findByRole("dialog", { name: "Move to" });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(barButton("Move to")).toHaveFocus();
  });

  it("pressing delete again while it runs: only one round runs", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    const del = barButton("Delete 2 selected items");
    fireEvent.click(del);
    fireEvent.click(del);
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
  });

  it("zh-TW: the move-to, copy-to and delete-2-selected-items labels and the moved-to-trash-2 toast", async () => {
    await i18n.changeLanguage("zh-TW");
    stubServer();
    renderShells();
    await waitFor(() => expect(within(shellHeader(1)).getByRole("button", { name: "選取" })).toBeEnabled());
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "選取" }));
    await within(shellHeader(1)).findByText("已選 0 項");
    await waitFor(() => expect(bar()).not.toBeNull());
    tick("p1", "p2");
    expect(barButton("移動到")).toBeInTheDocument();
    expect(barButton("複製到")).toBeInTheDocument();
    fireEvent.click(barButton("刪除選取的 2 項"));
    expect(await screen.findByText("已移到垃圾桶 2 篇", { exact: true })).toBeInTheDocument();
    await i18n.changeLanguage("en");
  });

  it("progress: Working... 0 of 3 -> 1 of 3 -> disappears when done; aria-busy, three buttons disabled", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    const releaseP2 = server.hold("DELETE /api/notes/p2");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent("Working… 0 of 3"));
    expect(bar()).toHaveAttribute("aria-busy", "true");
    for (const name of ["Move to", "Copy to", "Delete 3 selected items"]) expect(barButton(name)).toBeDisabled();
    // the other action bar shows it too (same provider)
    expect(within(bar(0)).getByRole("status")).toHaveTextContent("Working… 0 of 3");
    await releaseP1();
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent("Working… 1 of 3"));
    await releaseP2();
    expect(await screen.findByText("Moved 3 notes to the trash", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
    expect(shell(1).querySelector("[data-select-action-bar]")).toBeNull();
  });

  it("the progress row disappears at the end (when stopped and still selecting), aria-busy returns to false", async () => {
    const server = stubServer();
    server.fail("DELETE /api/notes/p2", 500, "internal");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(bar()).queryByRole("status")).toBeNull());
    expect(bar()).toHaveAttribute("aria-busy", "false");
  });

  it("everything skipped by the server (two 403s): Nothing was done... (destructive), no Undo, selection ends", async () => {
    const server = stubServer();
    server.fail("DELETE /api/notes/p1", 403, "forbidden");
    server.fail("DELETE /api/notes/p2", 403, "forbidden");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    const title = "Nothing was done; 2 skipped (no permission, or they no longer exist)";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => expect(selecting()).toBe(false));
  });

  it("while submitting the confirm dialog cannot be closed (Esc, the X, clicking outside) and shows progress; after release it closes, toast, selection ends, focus on Select", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("POST /api/notes/p1/copy");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("Make a copy");
    fireEvent.click(within(confirm).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(within(confirm).getByRole("status")).toHaveTextContent("Working… 0 of 3"));

    fireEvent.keyDown(document.activeElement ?? confirm, { key: "Escape" });
    await settleTimers();
    expect(screen.getByRole("dialog", { name: "Make a copy" })).toBe(confirm);

    fireEvent.click(within(confirm).getByRole("button", { name: "Close" }));
    await settleTimers();
    expect(screen.getByRole("dialog", { name: "Make a copy" })).toBe(confirm);

    // Clicking outside: while submitting it is blocked by both the progress wrapper (onOpenChange(false) is always ignored) and dismissOnOutside={false}; the latter alone is covered by the next case (clicking outside before submitting).
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Make a copy" })).toBe(confirm);
    expect(within(confirm).getByRole("button", { name: "Make a copy" })).toBeDisabled();
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(selecting()).toBe(true);

    await releaseP1();
    expect(await screen.findByText("Copied 3 notes to My notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selecting()).toBe(false);
    expect(selectButton(1)).toHaveFocus();
    await settleTimers();
    expect(selectButton(1)).toHaveFocus();
  });

  it("before submitting, clicking outside the confirm dialog does not close it (dismissOnOutside={false}); Cancel does", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("Make a copy");
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Make a copy" })).toBe(confirm);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.keys()).toEqual([]);
  });

  it("success with focus already moved to an outside input: selection ends and focus stays outside", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells({ outside: <main><input aria-label="probe" /></main> });
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    const probe = screen.getByRole("textbox", { name: "probe" });
    probe.focus();
    await releaseP1();
    expect(await screen.findByText("Moved 3 notes to the trash", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
    await settleTimers();
    expect(probe).toHaveFocus();
  });

  it("after pressing Done midway (the bar unmounts) and moving focus to a note link in the same sidebar: success does not steal focus (mountedRef)", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
    fireEvent.click(doneButton());
    await waitFor(() => expect(selecting()).toBe(false));
    const link = await within(shell(1)).findByRole("link", { name: "p3" });
    link.focus();
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    await settleTimers();
    expect(link).toHaveFocus();
  });

  it("an exception mid-batch: the lock is still released, the confirm dialog closes and the bar recovers (cleanup is in finally)", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("POST /api/notes/p1/copy");
    const { queryClient } = renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Copy to"));
    fireEvent.click(within(await pickDestination("Make a copy")).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(within(bar()).getByRole("status", { hidden: true })).toHaveTextContent("Working… 0 of 1"));
    // The batch's own finally (invalidating everything) throws -> runBatch rejects; take vitest's unhandledRejection listener away and collect only this one.
    const boom = new Error("boom");
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => {
      throw boom;
    });
    const caught: unknown[] = [];
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (reason) => {
      caught.push(reason);
    });
    try {
      await releaseP1();
      await waitFor(() => expect(caught).toEqual([boom]));
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const listener of saved) process.on("unhandledRejection", listener);
      vi.mocked(queryClient.invalidateQueries).mockRestore();
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(bar()).queryByRole("status")).toBeNull();
    expect(bar()).toHaveAttribute("aria-busy", "false");
    expect(barButton("Copy to")).toBeEnabled();
    expect(selecting()).toBe(true);
  });

  it("Done then Select midway and tick p3: the old round stopping does not overwrite the new selection", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    server.fail("DELETE /api/notes/p2", 429, "too_many_requests");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
    fireEvent.click(doneButton());
    await waitFor(() => expect(selecting()).toBe(false));
    await enterSelecting();
    tick("p3");
    await releaseP1();
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    await settleTimers();
    expect(within(shellHeader(1)).getByText("1 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["p3"]);
  });

  it("after Done -> Select the newly mounted bar shows progress and cannot be pressed until the old round finishes; it recovers after release", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
    fireEvent.click(doneButton());
    await waitFor(() => expect(selecting()).toBe(false));
    await enterSelecting();
    tick("p3");
    expect(within(bar()).getByRole("status")).toHaveTextContent("Working… 0 of 2");
    expect(bar()).toHaveAttribute("aria-busy", "true");
    for (const name of ["Move to", "Copy to", "Delete 1 selected item"]) expect(barButton(name)).toBeDisabled();
    fireEvent.click(barButton("Delete 1 selected item"));
    expect(server.keys()).toEqual(["DELETE /api/notes/p1"]);
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    // The old round's session has been replaced: the new selection is not ended; the buttons are pressable again.
    await waitFor(() => expect(within(bar()).queryByRole("status")).toBeNull());
    expect(selecting()).toBe(true);
    expect(checkedIds()).toEqual(["p3"]);
    expect(barButton("Delete 1 selected item")).toBeEnabled();
    expect(barButton("Move to")).toBeEnabled();
  });
});


/** My notes: three root folders A (p1, p2), A1 and B; p3, p4 at the root. Group G (admin) has folders GF and GF2. */
const FG: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
const FH: GroupDto = groupDto({ id: "H", name: "H" }, adminRole());
const FA = folderDto({ id: "A", name: "A" });
const FA1 = folderDto({ id: "A1", name: "A1" });
const FB = folderDto({ id: "B", name: "B" });
const GF = groupFolder({ id: "GF", name: "GF", groupId: "G" });
const GF2 = groupFolder({ id: "GF2", name: "GF2", groupId: "G" });
const SF = sharedFolder({ id: "SF", name: "SF" });
const FP1 = personalNote({ id: "p1", title: "p1", folderId: "A" });
const FP2 = personalNote({ id: "p2", title: "p2", folderId: "A" });
const FP3 = personalNote({ id: "p3", title: "p3" });
const FP4 = personalNote({ id: "p4", title: "p4" });
const MY = { notes: [FP1, FP2, FP3, FP4], groups: [FG], folders: [FA, FA1, FB, GF] };

const folderBox = (id: string, index = 1) =>
  shell(index).querySelector(`input[type="checkbox"][data-selection-key="folder:${id}"]`) as HTMLInputElement | null;
const tickFolder = (...ids: string[]) => {
  for (const id of ids) fireEvent.click(folderBox(id) as HTMLInputElement);
};
async function openPicker(name: "Move to" | "Copy to"): Promise<HTMLElement> {
  fireEvent.click(barButton(name));
  return screen.findByRole("dialog", { name });
}
/** Items on this level of the picker (accessible names; a separator is recorded as an em dash). */
const levelNames = (picker: HTMLElement) =>
  Array.from(picker.querySelectorAll("ul > li")).map((li) =>
    li.getAttribute("role") === "separator" ? "—" : li.querySelector("button")?.getAttribute("aria-label"),
  );
const barNames = () => within(bar()).getAllByRole("button", { hidden: true }).map((b) => b.getAttribute("aria-label") ?? b.textContent);
const openToasts = () => document.querySelectorAll('li[data-swipe-direction][data-state="open"]');
/** The text of the element aria-describedby points to (`toHaveAccessibleDescription` falls back to title when the description element is absent, which would not cover the sr-only copy). */
const describedText = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

async function waitFolders(...ids: string[]): Promise<void> {
  await waitFor(() => {
    for (const id of ids) expect(folderBox(id)).not.toBeNull();
  });
}

describe("SelectActionBar (folders)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
    __resetFolderSortForTests();
  });

  describe("buttons per tab", () => {
    // Every one of the four tabs needs a row to select (so Select is pressable): add one group note and one shared note.
    const everyTab = { ...MY, notes: [...MY.notes, groupNote({ id: "g9", title: "g9", group: FG }), sharedNote({ id: "s9", title: "s9" })] };

    it.each(["myNotes" as const, "workspace" as const, "shared" as const])("%s has Move to", async (tab) => {
      stubServer(everyTab);
      renderShells({ tab });
      await enterSelecting();
      expect(barNames()).toContain("Move to");
    });

    it("recent has no Move to", async () => {
      stubServer(everyTab);
      renderShells({ tab: "recent" });
      await enterSelecting();
      expect(barNames()).not.toContain("Move to");
    });

    it("shared with me: no delete button when only notes are ticked; \"Remove 1 selected folder\" when only folders are ticked", async () => {
      const s2 = sharedNote({ id: "s2", title: "s2" });
      stubServer({ notes: [s2], groups: [FG], folders: [SF] });
      renderShells({ tab: "shared" });
      await enterSelecting();
      await waitFolders("SF");
      tick("s2");
      expect(barNames()).toEqual(["Move to", "Copy to"]);
      tick("s2");
      tickFolder("SF");
      expect(barNames()).toEqual(["Move to", "Copy to", "Remove 1 selected folder"]);
      expect(barButton("Remove 1 selected folder")).toBeEnabled();
    });
  });

  it("same space: tick p3 and A1, move to B: no confirm dialog, PATCH A1 then PUT p3, toast with Undo, selection ends and focus is on Select; the previously collapsed folder:B is expanded", async () => {
    setCollapsed("folder:B", true);
    const server = stubServer(MY);
    renderShells();
    await enterSelecting();
    await waitFolders("A1", "B");
    tickFolder("A1");
    tick("p3");
    const picker = await openPicker("Move to");
    fireEvent.click(within(picker).getByRole("button", { name: "B" }));
    expect(await screen.findByText("Moved 2 items to “B”", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.keys()).toEqual(["PATCH /api/folders/A1", "PUT /api/notes/p3/folder"]);
    expect(server.bodies("PATCH /api/folders/A1")).toEqual([{ parentId: "B" }]);
    expect(server.bodies("PUT /api/notes/p3/folder")).toEqual([{ folderId: "B" }]);
    expect(within(toastRoot("Moved 2 items to “B”")).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
    expect(selectButton(1)).toHaveFocus();
    expect(isCollapsed("folder:B")).toBe(false);
  });

  it("pressing Undo sends them back in order ({parentId:null}, {folderId:null}); if all succeed no extra toast", async () => {
    const server = stubServer(MY);
    renderShells();
    await enterSelecting();
    await waitFolders("A1", "B");
    tickFolder("A1");
    tick("p3");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    const title = "Moved 2 items to “B”";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    fireEvent.click(within(toastRoot(title)).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.keys()).toHaveLength(4));
    expect(server.keys()).toEqual(["PATCH /api/folders/A1", "PUT /api/notes/p3/folder", "PATCH /api/folders/A1", "PUT /api/notes/p3/folder"]);
    expect(server.bodies("PATCH /api/folders/A1")).toEqual([{ parentId: "B" }, { parentId: null }]);
    expect(server.bodies("PUT /api/notes/p3/folder")).toEqual([{ folderId: "B" }, { folderId: null }]);
    await settleTimers();
    expect(openToasts()).toHaveLength(0);
  });

  it("Undo gets 429 on the second item: error toast + \"1 item was moved back; the rest weren't.\"", async () => {
    const server = stubServer(MY);
    renderShells();
    await enterSelecting();
    await waitFolders("A1", "B");
    tickFolder("A1");
    tick("p3");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    const title = "Moved 2 items to “B”";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    server.fail("PUT /api/notes/p3/folder", 429, "too_many_requests");
    fireEvent.click(within(toastRoot(title)).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Too many requests. Please slow down.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 item was moved back; the rest weren't.", { exact: true })).toBeInTheDocument();
    expect(server.bodies("PATCH /api/folders/A1")).toEqual([{ parentId: "B" }, { parentId: null }]);
  });

  it("moving back to the root: when all are at the root the first level has no Top level; p1 (in A) -> Top level -> {folderId:null}", async () => {
    const server = stubServer(MY);
    renderShells();
    await enterSelecting();
    await waitFolders("A");
    tick("p3");
    let picker = await openPicker("Move to");
    expect(levelNames(picker)).not.toContain("Top level");
    expect(levelNames(picker)).toEqual(["A", "A1", "B", "—", "G, open"]);
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    tick("p3", "p1");
    picker = await openPicker("Move to");
    expect(levelNames(picker)[0]).toBe("Top level");
    fireEvent.click(within(picker).getByRole("button", { name: "Top level" }));
    expect(await screen.findByText("Moved 1 item to “Top level”", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["PUT /api/notes/p1/folder"]);
    expect(server.bodies("PUT /api/notes/p1/folder")).toEqual([{ folderId: null }]);
  });

  it("a personal note moved into a group folder: p3 -> G, open -> GF -> the confirm description contains the group folder path -> body {groupId:G, folderId:GF}", async () => {
    const server = stubServer(MY);
    renderShells();
    await enterSelecting();
    tick("p3");
    const picker = await openPicker("Move to");
    fireEvent.click(within(picker).getByRole("button", { name: "G, open" }));
    await waitFor(() => expect(levelNames(picker)).toEqual(["Back", "Top level", "GF"]));
    fireEvent.click(within(picker).getByRole("button", { name: "GF" }));
    const confirm = await screen.findByRole("dialog", { name: "Move into group" });
    expect(confirm).toHaveAccessibleDescription('Move 1 note into "G › GF"?');
    fireEvent.click(within(confirm).getByRole("button", { name: "Move into group" }));
    expect(await screen.findByText('Moved 1 note into "G › GF"', { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p3/move"]);
    expect(server.bodies("POST /api/notes/p3/move")).toEqual([{ groupId: "G", folderId: "GF" }]);
  });

  it("a folder ticked as well: G in the lower half is disabled", async () => {
    stubServer(MY);
    renderShells();
    await enterSelecting();
    await waitFolders("A1");
    tick("p3");
    tickFolder("A1");
    const picker = await openPicker("Move to");
    expect(within(picker).getByRole("button", { name: "G" })).toBeDisabled();
  });

  // The greyed-out reason uses aria-disabled (not disabled, so the hover hint can appear).
  it("group tab across groups: Move to is aria-disabled with title / accessible description \"...different groups...\"; Copy to is pressable and the first level has no Make a copy", async () => {
    const g1 = groupNote({ id: "g1", title: "g1", group: FG });
    const h1 = groupNote({ id: "h1", title: "h1", group: FH });
    stubServer({ notes: [g1, h1], groups: [FG, FH], folders: [GF] });
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("g1", "h1");
    const move = barButton("Move to");
    expect(move).toHaveAttribute("aria-disabled", "true");
    expect(move).not.toHaveAttribute("disabled");
    expect(move).toHaveAttribute("title", "The selected notes are in different groups and can't be moved together");
    expect(describedText(move)).toBe("The selected notes are in different groups and can't be moved together");
    expect(barButton("Copy to")).toBeEnabled();
    const picker = await openPicker("Copy to");
    expect(levelNames(picker)).not.toContain("Make a copy");
    expect(levelNames(picker)[0]).toBe("My notes");
  });

  it("group tab with a single group: g2 (in GF2): the first level has only G's root and folders with no separator -> GF -> PUT {folderId:GF}", async () => {
    const g2 = groupNote({ id: "g2", title: "g2", group: FG, folderId: "GF2" });
    const server = stubServer({ notes: [g2], groups: [FG, FH], folders: [GF, GF2] });
    renderShells({ tab: "workspace" });
    await enterSelecting();
    await waitFor(() => expect(box("g2")).not.toBeNull());
    tick("g2");
    const picker = await openPicker("Move to");
    expect(levelNames(picker)).toEqual(["Top level", "GF", "GF2"]);
    expect(within(picker).getByRole("button", { name: "GF2" })).toBeDisabled();
    fireEvent.click(within(picker).getByRole("button", { name: "GF" }));
    expect(await screen.findByText("Moved 1 item to “GF”", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["PUT /api/notes/g2/folder"]);
    expect(server.bodies("PUT /api/notes/g2/folder")).toEqual([{ folderId: "GF" }]);
  });

  it("shared with me: s2: the first level has only SF -> PUT {folderId:SF}", async () => {
    const s2 = sharedNote({ id: "s2", title: "s2" });
    const server = stubServer({ notes: [s2], groups: [FG], folders: [SF] });
    renderShells({ tab: "shared" });
    await enterSelecting();
    await waitFolders("SF");
    tick("s2");
    const picker = await openPicker("Move to");
    expect(levelNames(picker)).toEqual(["SF"]);
    fireEvent.click(within(picker).getByRole("button", { name: "SF" }));
    expect(await screen.findByText("Moved 1 item to “SF”", { exact: true })).toBeInTheDocument();
    expect(server.bodies("PUT /api/notes/s2/folder")).toEqual([{ folderId: "SF" }]);
  });

  it("shared with me: no shared folder and everything selected is at the root: Move to is disabled (the first level is empty)", async () => {
    const s2 = sharedNote({ id: "s2", title: "s2" });
    stubServer({ notes: [s2], groups: [FG] });
    renderShells({ tab: "shared" });
    await enterSelecting();
    tick("s2");
    await settleTimers();
    expect(barButton("Move to")).toBeDisabled();
    expect(barButton("Copy to")).toBeEnabled();
  });

  it("delete with a folder: A + p3 -> summary confirm -> DELETE folder first then note -> toast + Undo (three ids); with the open p2 inside A: leavingRef is set when sending A, navigates home, one toast", async () => {
    const server = stubServer(MY);
    const leavingRef = { current: false };
    const controls: NotePageControls = { noteId: "p2", state: { phase: "connected", role: "owner" }, leavingRef, openEdits: () => {} };
    const leavingAt: Record<string, boolean> = {};
    server.onRequest((key) => {
      leavingAt[key] = leavingRef.current;
    });
    renderShells({ controls, path: "/n/tester/note-p2" });
    await enterSelecting();
    await waitFolders("A");
    tickFolder("A");
    tick("p3");
    fireEvent.click(barButton("Delete 2 selected items"));
    const confirm = await screen.findByRole("dialog", { name: "Delete 1 folder?" });
    // The appended sentence is also in the accessible description (read out when the dialog opens).
    expect(confirm).toHaveAccessibleDescription(
      "These folders and their subfolders will be deleted, and 2 notes will move to the trash. The 1 selected note will also move to the trash.",
    );
    expect(within(confirm).getByText("The 1 selected note will also move to the trash.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual([]);
    const submit = within(confirm).getByRole("button", { name: "Delete" });
    expect(submit).toHaveClass("bg-destructive");
    fireEvent.click(submit);
    const title = "1 folder deleted; 3 notes moved to the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/folders/A", "DELETE /api/notes/p3"]);
    expect(leavingAt).toEqual({ "DELETE /api/folders/A": true, "DELETE /api/notes/p3": true });
    await waitFor(() => expect(location()).toBe("/"));
    expect(openToasts()).toHaveLength(1);
    fireEvent.click(within(toastRoot(title)).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 3 notes", { exact: true })).toBeInTheDocument();
    const [restoreBody] = server.bodies("POST /api/trash/restore") as { ids: string[] }[];
    expect([...restoreBody.ids].sort()).toEqual(["p1", "p2", "p3"]);
    await waitFor(() => expect(location()).toBe("/n/tester/note-p2"));
  });

  it("shared-with-me removal: SF (containing the open s1) -> \"Remove 1 folder?\" -> ordinary toast, no Undo, leavingRef not set, no navigation", async () => {
    const s1 = sharedNote({ id: "s1", title: "s1", folderId: "SF" });
    const s2 = sharedNote({ id: "s2", title: "s2" });
    const server = stubServer({ notes: [s1, s2], groups: [FG], folders: [SF] });
    const leavingRef = { current: false };
    const controls: NotePageControls = { noteId: "s1", state: { phase: "connected", role: "editor" }, leavingRef, openEdits: () => {} };
    const leavingAt: Record<string, boolean> = {};
    server.onRequest((key) => {
      leavingAt[key] = leavingRef.current;
    });
    renderShells({ tab: "shared", controls, path: "/n/someone/note-s1" });
    await enterSelecting();
    await waitFolders("SF");
    tickFolder("SF");
    fireEvent.click(barButton("Remove 1 selected folder"));
    const confirm = await screen.findByRole("dialog", { name: "Remove 1 folder?" });
    expect(confirm).toHaveAccessibleDescription(
      "The folders will be removed and their shared notes moved back to the top level. No notes are deleted.",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    const title = "1 folder removed; its shared notes moved back to the top level";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/folders/SF"]);
    expect(leavingAt).toEqual({ "DELETE /api/folders/SF": false });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await settleTimers();
    expect(leavingRef.current).toBe(false);
    expect(location()).toBe("/n/someone/note-s1");
  });

  it("blocked (excluded beforehand) and already gone (server 404): only B and p3 are sent; the title is the trashed sentence + blocked + gone suffixes", async () => {
    const blocked = folderDto({ id: "A", name: "A", permissions: { manage: true, deleteNotes: false, createNote: true } });
    const server = stubServer({ notes: [FP1, FP3], groups: [FG], folders: [blocked, FB] });
    server.fail("DELETE /api/folders/B", 404, "folder_not_found");
    renderShells();
    await enterSelecting();
    await waitFolders("A", "B");
    tickFolder("A", "B");
    tick("p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    const confirm = await screen.findByRole("dialog", { name: "Delete 1 folder?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    const title = "Moved 1 note to the trash, 1 folder wasn't deleted (it holds notes you can't delete), 1 folder no longer exists";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/folders/B", "DELETE /api/notes/p3"]);
  });

  // Same as the group-tab case above: the greyed-out reason uses aria-disabled.
  it("copy: a ticked folder makes Copy to aria-disabled with \"Folders can't be copied\"; only p1 (in A) ticked: Make a copy -> copyLeadMakeCopy -> body {folderId:A}", async () => {
    const server = stubServer(MY);
    renderShells();
    await enterSelecting();
    await waitFolders("A");
    tickFolder("A");
    const copy = barButton("Copy to");
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(copy).not.toHaveAttribute("disabled");
    expect(copy).toHaveAttribute("title", "Folders can't be copied");
    expect(describedText(copy)).toBe("Folders can't be copied");
    tickFolder("A");
    tick("p1");
    const picker = await openPicker("Copy to");
    fireEvent.click(within(picker).getByRole("button", { name: "Make a copy" }));
    const confirm = await screen.findByRole("dialog", { name: "Make a copy" });
    expect(confirm).toHaveAccessibleDescription(
      "This creates a copy where the original is; the original stays as it is. AI edit history, version history and backlinks are not copied.",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Make a copy" }));
    expect(await screen.findByText("Copied 1 note to My notes", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/notes/p1/copy")).toEqual([{ folderId: "A" }]);
  });

  it("placement gets 404 folder_not_found midway: \"Folder not found.\" + \"1 item was done...\", [folders] is invalidated, selection stays with only the unprocessed ones", async () => {
    const server = stubServer(MY);
    server.fail("PUT /api/notes/p3/folder", 404, "folder_not_found");
    const { queryClient } = renderShells();
    await enterSelecting();
    await waitFolders("A1", "B");
    tickFolder("A1");
    tick("p3", "p4");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Folder not found.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 item was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    // Some items are already done: the stop error toast also carries Undo (sends the completed ones back).
    expect(within(toastRoot("Folder not found.")).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(server.keys()).toEqual(["PATCH /api/folders/A1", "PUT /api/notes/p3/folder"]);
    expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey) === '["folders"]')).toBe(true);
    await waitFor(() => expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument());
    expect(selecting()).toBe(true);
    expect(checkedIds()).toEqual(["p3", "p4"]);
    invalidate.mockRestore();
  });

  it("same space with only notes, stopped midway: the description still counts in items (consistent with the result sentence movedItems)", async () => {
    const server = stubServer(MY);
    server.fail("PUT /api/notes/p4/folder", 429, "too_many_requests");
    renderShells();
    await enterSelecting();
    await waitFolders("B");
    tick("p3", "p4");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("1 item was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["PUT /api/notes/p3/folder", "PUT /api/notes/p4/folder"]);
    await waitFor(() => expect(checkedIds()).toEqual(["p4"]));
  });

  it("at A > X1, X1 is deleted (folders refetch): the A level shows; pressing Back goes back one level to the first level", async () => {
    const A = folderDto({ id: "A", name: "A" });
    const X1 = folderDto({ id: "X1", name: "X1", parentId: "A" });
    const X2 = folderDto({ id: "X2", name: "X2", parentId: "X1" });
    const server = stubServer({ notes: [FP3], groups: [FG], folders: [A, X1, X2, FB] });
    const { queryClient } = renderShells();
    await enterSelecting();
    tick("p3");
    const picker = await openPicker("Move to");
    await waitFor(() => expect(levelNames(picker)).toEqual(["A, open", "B", "—", "G"]));
    fireEvent.click(within(picker).getByRole("button", { name: "A, open" }));
    fireEvent.click(await within(picker).findByRole("button", { name: "X1, open" }));
    await waitFor(() => expect(levelNames(picker)).toEqual(["Back", "Move here", "X2"]));
    server.box.folders = [A, FB];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["folders"] });
    });
    await waitFor(() => expect(levelNames(picker)).toEqual(["Back", "Move here"]));
    fireEvent.click(within(picker).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(levelNames(picker)).toEqual(["A", "B", "—", "G"]));
  });

  it("picker -> confirm dialog: the button that opened the picker gets no focus call and focus is inside the confirm dialog; cancel returns focus to that button", async () => {
    stubServer(MY);
    renderShells();
    await enterSelecting();
    tick("p3");
    const moveTo = barButton("Move to");
    const picker = await openPicker("Move to");
    const spy = vi.fn();
    moveTo.addEventListener("focus", spy);
    fireEvent.click(within(picker).getByRole("button", { name: "G, open" }));
    await waitFor(() => expect(within(picker).getByRole("button", { name: "GF" })).toBeInTheDocument());
    fireEvent.click(within(picker).getByRole("button", { name: "GF" }));
    const confirm = await screen.findByRole("dialog", { name: "Move into group" });
    await settleTimers();
    expect(spy).toHaveBeenCalledTimes(0);
    expect(confirm.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(moveTo).toHaveFocus();
  });

  describe("zh-TW", () => {
    afterEach(async () => {
      await i18n.changeLanguage("en");
    });

    async function enterSelectingZh(): Promise<void> {
      await waitFor(() => expect(within(shellHeader(1)).getByRole("button", { name: "選取" })).toBeEnabled());
      fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "選取" }));
      await within(shellHeader(1)).findByText("已選 0 項");
      await waitFor(() => expect(bar()).not.toBeNull());
    }

    it("same-space result: the moved-2-items-to-B text", async () => {
      await i18n.changeLanguage("zh-TW");
      stubServer(MY);
      renderShells();
      await enterSelectingZh();
      await waitFolders("A1", "B");
      tickFolder("A1");
      tick("p3");
      fireEvent.click(barButton("移動到"));
      const picker = await screen.findByRole("dialog", { name: "移動到" });
      fireEvent.click(within(picker).getByRole("button", { name: "B" }));
      expect(await screen.findByText("已移 2 項到「B」", { exact: true })).toBeInTheDocument();
    });

    it("folder delete confirm dialog: the delete-1-folder text", async () => {
      await i18n.changeLanguage("zh-TW");
      stubServer(MY);
      renderShells();
      await enterSelectingZh();
      await waitFolders("A");
      tickFolder("A");
      fireEvent.click(barButton("刪除選取的 1 項"));
      const confirm = await screen.findByRole("dialog", { name: "刪除 1 個資料夾？" });
      expect(within(confirm).getByRole("button", { name: "刪除" })).toBeInTheDocument();
    });
  });
});

// Wide one-row toolbar, narrow "Move to" outline, greyed-out reasons.
// Component tests default to narrow (jsdom's matchMedia is always false); wide cases always call `mockWidePointer(true)`. Actions are always started from shell 1.

const exitButton = (index = 1) => within(shellHeader(index)).queryByRole("button", { name: "Exit selection", hidden: true });
const selectAllBox = (index = 1) => within(shellHeader(index)).getByRole("checkbox", { name: "Select all", hidden: true }) as HTMLInputElement;
/** Keys ticked in the selection tree (excluding the header's select-all box; DOM order). */
const selectedKeys = (index = 1) =>
  Array.from(shell(index).querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-selection-key]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.selectionKey);
const barsOf = (index: number) => Array.from(shell(index).querySelectorAll("[data-select-action-bar]"));
const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const folderToggle = (name: string, index = 1) =>
  within(shell(index).querySelector("[data-sidebar-list]") as HTMLElement).getByRole("button", { name });
const allState = (index = 1) => {
  const all = selectAllBox(index);
  return all.indeterminate ? "some" : all.checked ? "all" : "none";
};

/** Wide: waits for Select to be pressable, presses it, and waits for the X, the selection tree and the action bar in the header (during a batch the count slot shows progress, so it cannot wait for "0 selected"). */
async function enterWide(index = 1): Promise<void> {
  await waitFor(() => expect(selectButton(index)).toBeEnabled());
  fireEvent.click(selectButton(index) as HTMLElement);
  await waitFor(() => expect(exitButton(index)).not.toBeNull());
  await waitFor(() => expect(shell(index).querySelector('input[type="checkbox"][data-selection-key]')).not.toBeNull());
  await waitFor(() => expect(bar(index)).not.toBeNull());
}

const enterForm = (form: "narrow" | "wide") => (form === "wide" ? enterWide() : enterSelecting());

describe("wide-screen one-row toolbar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
    __resetFolderSortForTests();
  });

  it("wide: the header has in order the X, the select-all box, 0 selected, three icon buttons; each instance has one action bar and it is inside the header; no Done, Select all text button or New note", async () => {
    mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    const header = shellHeader(1);
    const exit = exitButton() as HTMLElement;
    expect(exit).toHaveAttribute("title", "Exit selection");
    expect(exit).toHaveClass("h-6", "w-6");
    expect(exit.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    const all = selectAllBox();
    const count = within(header).getByText("0 selected");
    const actionBar = bar();
    expect(follows(exit, all)).toBe(true);
    expect(follows(all, count)).toBe(true);
    expect(follows(count, actionBar)).toBe(true);
    expect(within(actionBar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Move to", "Copy to", "Delete 0 selected items"]);
    for (const [name, icon] of [
      ["Move to", "folder-input"],
      ["Copy to", "copy"],
      ["Delete 0 selected items", "trash"],
    ] as const) {
      const button = barButton(name);
      expect(button).toHaveAttribute("title", name);
      expect(button).toHaveClass("h-6", "w-6");
      expect(button).toHaveTextContent(/^$/);
      expect(button.querySelector(`svg[data-icon="${icon}"]`)).toHaveAttribute("aria-hidden", "true");
      expect(button).toBeDisabled();
    }
    expect(within(header).queryByRole("button", { name: "Done", hidden: true })).toBeNull();
    expect(within(header).queryByRole("button", { name: "Select all", hidden: true })).toBeNull();
    for (const index of [0, 1]) {
      const bars = barsOf(index);
      expect(bars).toHaveLength(1);
      expect(bars[0]!.closest("[data-sidebar-header]")).toBe(shellHeader(index));
    }
    expect(within(shell(1)).queryByRole("button", { name: "New note", hidden: true })).toBeNull();
  });

  it("narrow (default): the header has 0 selected + Select all + Done text buttons, no X or select-all box; each instance has one action bar and it is outside the header", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    expect(exitButton()).toBeNull();
    expect(within(shellHeader(1)).queryByRole("checkbox", { hidden: true })).toBeNull();
    expect(within(shellHeader(1)).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    expect(doneButton()).toBeInTheDocument();
    for (const index of [0, 1]) {
      const bars = barsOf(index);
      expect(bars).toHaveLength(1);
      expect(bars[0]!.closest("[data-sidebar-header]")).toBeNull();
    }
  });

  it("wide: pressing Select puts focus on the X; pressing the X ends the selection with focus on the same shell's Select", async () => {
    mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    await waitFor(() => expect(exitButton()).toHaveFocus());
    fireEvent.click(exitButton() as HTMLElement);
    await waitFor(() => expect(exitButton()).toBeNull());
    expect(bar()).toBeNull();
    expect(selectButton(1)).toHaveFocus();
  });

  it("wide: Esc on body while selecting ends it with focus on Select", async () => {
    mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    tick("p1");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(exitButton()).toBeNull());
    // A document-level Esc is handled by the shell mounted first (it preventDefaults and the other yields); focus returns to that shell's Select.
    expect(document.activeElement).toHaveAttribute("data-sidebar-select");
  });

  it("wide: Esc with focus on the X ends it with focus on the same shell's Select; the same holds while a batch runs (the count slot is progress)", async () => {
    mockWidePointer(true);
    const server = stubServer(MY);
    const release = server.hold("PUT /api/notes/p3/folder");
    renderShells();
    await enterWide();
    let exit = exitButton() as HTMLElement;
    exit.focus();
    fireEvent.keyDown(exit, { key: "Escape" });
    await waitFor(() => expect(exitButton()).toBeNull());
    expect(selectButton(1)).toHaveFocus();

    await enterWide();
    await waitFolders("B");
    tick("p3");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    await waitFor(() => expect(within(shellHeader(1)).getByRole("status")).toHaveTextContent("Working… 0 of 1"));
    exit = exitButton() as HTMLElement;
    exit.focus();
    fireEvent.keyDown(exit, { key: "Escape" });
    await waitFor(() => expect(exitButton()).toBeNull());
    expect(selectButton(1)).toHaveFocus();
    await release();
    expect(await screen.findByText("Moved 1 item to “B”", { exact: true })).toBeInTheDocument();
  });

  it("wide: the three-state select-all box looks only at visible rows; empty/partial selects all visible rows, all-ticked clears everything; ticks inside a collapsed subtree are kept", async () => {
    mockWidePointer(true);
    stubServer({ notes: [FP1, FP3], groups: [FG], folders: [FA] });
    renderShells();
    await enterWide();
    await waitFolders("A");
    await waitFor(() => expect(box("p1")).not.toBeNull());
    expect(allState()).toBe("none");
    expect(selectAllBox()).toHaveAttribute("title", "Select all");
    // The outer 24px cell carries the same title (hovering beside the box shows the hint too).
    expect(selectAllBox().parentElement?.parentElement).toHaveAttribute("title", "Select all");
    tick("p3");
    expect(allState()).toBe("some");
    fireEvent.click(selectAllBox());
    expect(selectedKeys()).toEqual(["folder:A", "note:p1", "note:p3"]);
    expect(allState()).toBe("all");
    expect(selectAllBox()).toHaveAttribute("title", "Deselect all");
    expect(within(shellHeader(1)).getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(selectAllBox());
    expect(selectedKeys()).toEqual([]);
    expect(allState()).toBe("none");

    // Expand and tick p1, then collapse A: the visible rows (A, p3) are unticked -> empty box; clicking selects all visible rows and p1 stays ticked.
    tick("p1");
    fireEvent.click(folderToggle("A"));
    expect(box("p1")).toBeNull();
    expect(allState()).toBe("none");
    expect(within(shellHeader(1)).getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(selectAllBox());
    expect(within(shellHeader(1)).getByText("3 selected")).toBeInTheDocument();
    expect(allState()).toBe("all");
    fireEvent.click(folderToggle("A"));
    expect(selectedKeys()).toEqual(["folder:A", "note:p1", "note:p3"]);
  });

  it("wide: group tab with all groups collapsed (no visible rows): the select-all box is disabled; pressable after expanding", async () => {
    mockWidePointer(true);
    stubServer({ notes: [groupNote({ id: "g1", title: "g1", group: FG })], groups: [FG], folders: [] });
    renderShells({ tab: "workspace" });
    await enterWide();
    await waitFor(() => expect(box("g1")).not.toBeNull());
    expect(selectAllBox()).toBeEnabled();
    fireEvent.click(folderToggle("G"));
    expect(box("g1")).toBeNull();
    expect(selectAllBox()).toBeDisabled();
    fireEvent.click(folderToggle("G"));
    expect(selectAllBox()).toBeEnabled();
  });

  it("wide: pressing the X mid-batch and starting a new selection: before release the count slot is still progress and three buttons are disabled; after release 0 selected, still selecting, one result toast", async () => {
    mockWidePointer(true);
    const server = stubServer(MY);
    const release = server.hold("PATCH /api/folders/A1");
    renderShells();
    await enterWide();
    await waitFolders("A1", "B");
    tickFolder("A1");
    tick("p3");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    const status = await within(shellHeader(1)).findByRole("status");
    expect(status).toHaveTextContent("Working… 0 of 2");
    expect(status).toHaveAttribute("title", "Working… 0 of 2");
    expect(within(shellHeader(1)).queryByText("2 selected")).toBeNull();
    expect(within(shellHeader(1)).getAllByRole("status", { hidden: true })).toHaveLength(1);
    expect(bar()).toHaveAttribute("aria-busy", "true");

    fireEvent.click(exitButton() as HTMLElement);
    await waitFor(() => expect(exitButton()).toBeNull());
    fireEvent.click(selectButton(1) as HTMLElement);
    await waitFor(() => expect(exitButton()).not.toBeNull());
    await waitFor(() => expect(bar()).not.toBeNull());
    // select-run is keyed by actions: the old round is still running, so the new selection's count slot is still progress.
    expect(within(shellHeader(1)).getByRole("status")).toHaveTextContent("Working… 0 of 2");
    for (const name of ["Move to", "Copy to", "Delete 0 selected items"]) expect(barButton(name)).toBeDisabled();

    await release();
    expect(await screen.findByText("Moved 2 items to “B”", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(shellHeader(1)).queryByRole("status")).toBeNull());
    expect(within(shellHeader(1)).getByText("0 selected")).toBeInTheDocument();
    expect(exitButton()).not.toBeNull();
    await settleTimers();
    expect(openToasts()).toHaveLength(1);
  });

  it("wide -> narrow while selecting: the header switches back to 1 selected + Select all + Done, the action bar appears at the bottom, ticks are kept and an open picker closes", async () => {
    const mq = mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    tick("p1");
    fireEvent.click(barButton("Move to"));
    await screen.findByRole("dialog", { name: "Move to" });
    act(() => mq.setWide(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(exitButton()).toBeNull();
    expect(within(shellHeader(1)).getByText("1 selected")).toBeInTheDocument();
    expect(within(shellHeader(1)).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    expect(doneButton()).toBeInTheDocument();
    await waitFor(() => expect(bar()).not.toBeNull());
    for (const index of [0, 1]) {
      const bars = barsOf(index);
      expect(bars).toHaveLength(1);
      expect(bars[0]!.closest("[data-sidebar-header]")).toBeNull();
    }
    expect(selectedKeys()).toEqual(["note:p1"]);
  });

  it("crossing the criterion while selecting with focus on a header button: the X -> flip to narrow -> focus on Done; Done -> flip to wide -> focus on the X (does not fall to body)", async () => {
    const mq = mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    await waitFor(() => expect(exitButton()).toHaveFocus());
    act(() => mq.setWide(false));
    expect(doneButton()).toHaveFocus();
    act(() => mq.setWide(true));
    expect(exitButton()).toHaveFocus();
  });

  it("crossing the criterion while selecting with focus on body before the flip (not in the header): focus is not stolen and stays on body", async () => {
    const mq = mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    await waitFor(() => expect(exitButton()).toHaveFocus());
    (exitButton() as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    act(() => mq.setWide(false));
    expect(document.activeElement).toBe(document.body);
  });

  it("wide: clicking the Move to icon opens the picker; cancel returns focus to the icon button", async () => {
    mockWidePointer(true);
    stubServer();
    renderShells();
    await enterWide();
    tick("p1");
    fireEvent.click(barButton("Move to"));
    const picker = await screen.findByRole("dialog", { name: "Move to" });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(barButton("Move to")).toHaveFocus();
    expect(shellHeader(1).contains(document.activeElement)).toBe(true);
  });

  it("narrow: Move to is not the primary color (no bg-brand*) and has the same class as Copy to", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    const move = barButton("Move to");
    expect([...move.classList].filter((name) => name.startsWith("bg-brand"))).toEqual([]);
    expect(move.className).toBe(barButton("Copy to").className);
  });

  const ACROSS = "The selected notes are in different groups and can't be moved together";
  const NO_FOLDER_COPY = "Folders can't be copied";

  it.each(["narrow", "wide"] as const)(
    "%s: group tab across groups: Move to is aria-disabled (not disabled) with title / description; clicking opens no picker; narrow shows a toast and wide does not; both buttons have the same class",
    async (form) => {
      mockWidePointer(form === "wide");
      const g1 = groupNote({ id: "g1", title: "g1", group: FG });
      const h1 = groupNote({ id: "h1", title: "h1", group: FH });
      const server = stubServer({ notes: [g1, h1], groups: [FG, FH], folders: [GF] });
      renderShells({ tab: "workspace" });
      await enterForm(form);
      tick("g1", "h1");
      const move = barButton("Move to");
      expect(move).toHaveAttribute("aria-disabled", "true");
      expect(move).not.toHaveAttribute("disabled");
      expect(move).toHaveAttribute("title", ACROSS);
      expect(describedText(move)).toBe(ACROSS);
      expect(move).toHaveClass("aria-disabled:cursor-not-allowed", "aria-disabled:opacity-50");
      const copy = barButton("Copy to");
      expect(copy).toBeEnabled();
      expect(copy).not.toHaveAttribute("aria-disabled");
      expect(move.className).toBe(copy.className);
      fireEvent.click(move);
      await settleTimers();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(server.keys()).toEqual([]);
      expect(openToasts()).toHaveLength(form === "narrow" ? 1 : 0);
      if (form === "narrow") expect(openToasts()[0]).toHaveTextContent(ACROSS);
    },
  );

  it.each(["narrow", "wide"] as const)(
    "%s: a ticked folder: Copy to is aria-disabled (not disabled) with \"Folders can't be copied\"; clicking opens no picker; narrow shows a toast and wide does not",
    async (form) => {
      mockWidePointer(form === "wide");
      const server = stubServer(MY);
      renderShells();
      await enterForm(form);
      await waitFolders("A");
      tickFolder("A");
      const copy = barButton("Copy to");
      expect(copy).toHaveAttribute("aria-disabled", "true");
      expect(copy).not.toHaveAttribute("disabled");
      expect(copy).toHaveAttribute("title", NO_FOLDER_COPY);
      expect(describedText(copy)).toBe(NO_FOLDER_COPY);
      expect(copy.className).toBe(barButton("Move to").className);
      fireEvent.click(copy);
      await settleTimers();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(server.keys()).toEqual([]);
      expect(openToasts()).toHaveLength(form === "narrow" ? 1 : 0);
      if (form === "narrow") expect(openToasts()[0]).toHaveTextContent(NO_FOLDER_COPY);
    },
  );

  it.each(["narrow", "wide"] as const)("%s: with 0 items the three buttons, and Delete in the recent tab with only undeletable notes ticked, are truly disabled with no aria-disabled and clicking shows no toast", async (form) => {
    mockWidePointer(form === "wide");
    stubServer();
    renderShells({ tab: "recent" });
    await enterForm(form);
    for (const name of ["Copy to", "Delete 0 selected items"]) {
      expect(barButton(name)).toBeDisabled();
      expect(barButton(name)).not.toHaveAttribute("aria-disabled");
    }
    tick("s1");
    const del = barButton("Delete 1 selected item");
    expect(del).toBeDisabled();
    expect(del).not.toHaveAttribute("aria-disabled");
    expect(barButton("Copy to")).toBeEnabled();
    fireEvent.click(del);
    await settleTimers();
    expect(openToasts()).toHaveLength(0);
  });

  it.each(["narrow", "wide"] as const)("%s: while a batch runs the three buttons are truly disabled with no aria-disabled and clicking shows no toast", async (form) => {
    mockWidePointer(form === "wide");
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterForm(form);
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    await waitFor(() => expect(bar()).toHaveAttribute("aria-busy", "true"));
    for (const name of ["Move to", "Copy to", "Delete 2 selected items"]) {
      expect(barButton(name)).toBeDisabled();
      expect(barButton(name)).not.toHaveAttribute("aria-disabled");
      fireEvent.click(barButton(name));
    }
    await settleTimers();
    expect(openToasts()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
  });

  it.each(["narrow", "wide"] as const)("%s: precedence - a folder selected while a batch runs (busy and the greyed-out reason both hold): Copy to is truly disabled with no aria-disabled and clicking shows no toast", async (form) => {
    mockWidePointer(form === "wide");
    const server = stubServer(MY);
    const release = server.hold("PATCH /api/folders/A1");
    renderShells();
    await enterForm(form);
    await waitFolders("A1", "B");
    tickFolder("A1");
    tick("p3");
    expect(barButton("Copy to")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(await openPicker("Move to")).getByRole("button", { name: "B" }));
    await waitFor(() => expect(bar()).toHaveAttribute("aria-busy", "true"));
    const copy = barButton("Copy to");
    expect(copy).toBeDisabled();
    expect(copy).not.toHaveAttribute("aria-disabled");
    fireEvent.click(copy);
    await settleTimers();
    expect(openToasts()).toHaveLength(0);
    await release();
    expect(await screen.findByText("Moved 2 items to “B”", { exact: true })).toBeInTheDocument();
  });
});


describe("batch removal in the favorites tab", () => {
  /** Four favorites (tree order = newest added first: p2, ga1, p1, p3). */
  const FAV4: FavoriteDto[] = [...FAVORITES, { noteId: "p3", favoritedAt: "2026-02-01T00:00:00.000Z" }];
  const unfavoriteButton = () => barButton("Remove from favorites");
  const favoritesGets = () =>
    vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === "/api/favorites" && (init?.method ?? "GET").toUpperCase() === "GET").length;
  const cacheIds = (queryClient: QueryClient) => (queryClient.getQueryData<FavoriteDto[]>(["favorites"]) ?? []).map((favorite) => favorite.noteId);

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it.each(["narrow", "wide"] as const)("%s: remove-from-favorites is the star-off icon and delete the trash icon with the same name as in the ordinary tabs; in the wide form the icon buttons use the same class set", async (form) => {
    mockWidePointer(form === "wide");
    stubServer({ favorites: FAV4 });
    renderShells({ tab: "favorites" });
    await enterForm(form);
    tick("p2");
    expect(unfavoriteButton().querySelector("svg")).toHaveAttribute("data-icon", "star-off");
    const del = barButton(i18n.t("select.deleteSelected", { count: 1 }));
    expect(del).toHaveAccessibleName("Delete 1 selected item");
    expect(del.querySelector("svg")).toHaveAttribute("data-icon", "trash");
    if (form === "wide") expect(unfavoriteButton().className).toBe(barButton("Copy to").className);
  });

  it.each(["narrow", "wide"] as const)("%s: pressing remove-from-favorites opens a confirm dialog first (title carries the count, no request yet); Cancel: no request, selection unchanged, focus returns to the opener", async (form) => {
    mockWidePointer(form === "wide");
    const server = stubServer({ favorites: FAV4 });
    renderShells({ tab: "favorites" });
    await enterForm(form);
    tick("p2", "ga1", "p1");
    fireEvent.click(unfavoriteButton());
    expect(server.keys()).toEqual([]);
    const confirm = await screen.findByRole("dialog", { name: "Remove 3 notes from favorites?" });
    expect(confirm).toHaveAccessibleDescription("The notes themselves aren't changed, and you can add them back later.");
    expect(within(confirm).getByRole("button", { name: "Remove" })).toHaveClass("bg-destructive");
    await settleTimers();
    expect(server.keys()).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(server.keys()).toEqual([]);
    expect(bar()).not.toBeNull();
    expect(checkedIds()).toEqual(["p2", "ga1", "p1"]);
    expect(unfavoriteButton()).toHaveFocus();
  });

  it("confirm: DELETEs are sent in order and the favorites cache loses one note after each; the dialog cannot be closed while sending; at the end one refetch, the toast carries the count, no Undo, selection ends", async () => {
    const server = stubServer({ favorites: FAV4 });
    const releaseGa1 = server.hold("DELETE /api/favorites/ga1");
    const { queryClient } = renderShells({ tab: "favorites" });
    await enterSelecting();
    tick("p2", "ga1", "p1");
    await waitFor(() => expect(cacheIds(queryClient)).toEqual(["p2", "ga1", "p1", "p3"]));
    const getsBefore = favoritesGets();
    fireEvent.click(unfavoriteButton());
    const confirm = await screen.findByRole("dialog", { name: "Remove 3 notes from favorites?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    // The first note is done and the second is stuck at the server: the cache lost only the first.
    await waitFor(() => expect(within(confirm).getByRole("status")).toHaveTextContent("Working… 1 of 3"));
    expect(server.keys()).toEqual(["DELETE /api/favorites/p2", "DELETE /api/favorites/ga1"]);
    expect(cacheIds(queryClient)).toEqual(["ga1", "p1", "p3"]);
    expect(favoritesGets()).toBe(getsBefore);
    fireEvent.keyDown(document.activeElement ?? confirm, { key: "Escape" });
    await settleTimers();
    expect(screen.getByRole("dialog", { name: "Remove 3 notes from favorites?" })).toBe(confirm);
    expect(within(confirm).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeDisabled();

    await releaseGa1();
    expect(await screen.findByText("Removed 3 notes from favorites", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/favorites/p2", "DELETE /api/favorites/ga1", "DELETE /api/favorites/p1"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(favoritesGets()).toBe(getsBefore + 1));
    await waitFor(() => expect(cacheIds(queryClient)).toEqual(["p3"]));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(selecting()).toBe(false);
    expect(selectButton(1)).toHaveFocus();
  });

  it("all favorites removed and the list empty: the Select button is disabled and focus lands on that sidebar's panel, not on body", async () => {
    const server = stubServer({ favorites: FAV4 });
    const { queryClient } = renderShells({ tab: "favorites" });
    await enterSelecting();
    tick("p2", "ga1", "p1", "p3");
    fireEvent.click(unfavoriteButton());
    const confirm = await screen.findByRole("dialog", { name: "Remove 4 notes from favorites?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed 4 notes from favorites", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(cacheIds(queryClient)).toEqual([]));
    expect(server.keys()).toHaveLength(4);
    expect(selecting()).toBe(false);
    expect(selectButton(1)).toBeDisabled();
    expect(within(screen.getByTestId("shell-1")).getByRole("tabpanel")).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("429 on the second note stops it: the first is filtered out, the second and third stay ticked, error toast + 1 completed", async () => {
    const server = stubServer({ favorites: FAV4 });
    server.fail("DELETE /api/favorites/ga1", 429, "too_many_requests");
    const { queryClient } = renderShells({ tab: "favorites" });
    await enterSelecting();
    tick("p2", "ga1", "p1");
    fireEvent.click(unfavoriteButton());
    expect(server.keys()).toEqual([]);
    const confirm = await screen.findByRole("dialog", { name: "Remove 3 notes from favorites?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Too many requests. Please slow down.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 note was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/favorites/p2", "DELETE /api/favorites/ga1"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(cacheIds(queryClient)).toEqual(["ga1", "p1", "p3"]));
    expect(selecting()).toBe(true);
    expect(checkedIds()).toEqual(["ga1", "p1"]);
    expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument();
  });

  it.each(["narrow", "wide"] as const)("%s: while a batch runs remove-from-favorites, copy to and delete are truly disabled with no aria-disabled, and clicking shows no toast and no second dialog", async (form) => {
    mockWidePointer(form === "wide");
    const server = stubServer({ favorites: FAV4 });
    const releaseP2 = server.hold("DELETE /api/favorites/p2");
    renderShells({ tab: "favorites" });
    await enterForm(form);
    tick("p2", "ga1");
    fireEvent.click(unfavoriteButton());
    expect(server.keys()).toEqual([]);
    const confirm = await screen.findByRole("dialog", { name: "Remove 2 notes from favorites?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(bar()).toHaveAttribute("aria-busy", "true"));
    for (const name of ["Remove from favorites", "Copy to", "Delete 2 selected items"]) {
      expect(barButton(name)).toBeDisabled();
      expect(barButton(name)).not.toHaveAttribute("aria-disabled");
      fireEvent.click(barButton(name));
    }
    await settleTimers();
    expect(openToasts()).toHaveLength(0);
    expect(screen.getAllByRole("dialog")).toEqual([confirm]);
    expect(server.keys()).toEqual(["DELETE /api/favorites/p2"]);
    await releaseP2();
    expect(await screen.findByText("Removed 2 notes from favorites", { exact: true })).toBeInTheDocument();
  });

  it("zh-TW: the confirm dialog title and submit button, and the result toast", async () => {
    await i18n.changeLanguage("zh-TW");
    stubServer({ favorites: FAV4 });
    renderShells({ tab: "favorites" });
    await waitFor(() => expect(within(shellHeader(1)).getByRole("button", { name: "選取" })).toBeEnabled());
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "選取" }));
    await within(shellHeader(1)).findByText("已選 0 項");
    await waitFor(() => expect(bar()).not.toBeNull());
    tick("p2", "ga1");
    fireEvent.click(barButton("移出最愛"));
    const confirm = await screen.findByRole("dialog", { name: "要把 2 篇筆記移出最愛嗎？" });
    expect(confirm).toHaveAccessibleDescription("筆記本身不受影響，之後可以再加回來。");
    fireEvent.click(within(confirm).getByRole("button", { name: "移出最愛" }));
    expect(await screen.findByText("已移出最愛 2 篇", { exact: true })).toBeInTheDocument();
  });

  it.each(["recent", "myNotes", "workspace", "shared"] as const)("%s: selection mode has no remove-from-favorites button; GET /api/favorites happens only for the list's own subscription", async (tab) => {
    stubServer();
    renderShells({ tab });
    await enterSelecting();
    await settleTimers();
    expect(within(bar()).queryByRole("button", { name: "Remove from favorites", hidden: true })).toBeNull();
    expect(favoritesGets()).toBe(1);
  });
});
