import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { AiActionDto, NoteDto, UserDto } from "@knotebook/shared";
import type { CollabState } from "@/collab/connection";
import i18n from "@/i18n";
import tourEn from "@/i18n/tour.en.json";
import tourZhTW from "@/i18n/tour.zh-TW.json";
import shortcutsEn from "@/i18n/shortcuts.en.json";
import shortcutsZhTW from "@/i18n/shortcuts.zh-TW.json";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useIsPhone } from "@/lib/layout-tiers";
import { getShellControls } from "@/lib/tour-bridge";
import { findDrawerButton, findTourTarget, findUserMenuTrigger } from "@/lib/tour-find";
import { tourTarget, type TourTargetId } from "@/lib/tour-targets";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { ThemeProvider } from "@/theme";
import { AppShell, SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";
import { NoteBrowseBar } from "@/components/NoteBrowseBar";
import { CornerStack } from "@/components/CornerStack";
import { CORNER_STACK_COLLAPSED_STORAGE_KEY, isCornerStackCollapsed, setCornerStackCollapsed } from "@/components/corner-stack-state";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { NoteMenu } from "@/components/NoteMenu";
import { ShareDialog } from "@/components/ShareDialog";
import { OWNER_PERMS } from "@/test/fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";
import type { FolderListDto } from "@knotebook/shared";
import { stopTitle } from "./sequence";
import { FULL_TOUR, prepareStop, STOPS, stopBody, stopScreen, stopShownIn, stopTarget, type StopContext, type StopId } from "./stops";

// The test host follows the note page wiring: a real AppShell (sidebar, search box, tab list, new button, user menu), with the same components as the note header in the main area
// (back chevron, hamburger, share, kebab menu), the version bubble at the bottom right and the phone's bottom round button.
// Layout is always switched via `stubLayoutTier` (`docked` = wide window, `overlay` = floating sidebar, `phone` = phone).

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
  id: "77777777-7777-7777-7777-777777777777",
  title: "Tour Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "tour-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function stubFetch(folders: FolderListDto = FOLDER_LIST_EMPTY) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return json([]);
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/folders") return json(folders);
      if (url === "/api/notes" && method === "GET") return json([NOTE]);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function stubViewport(narrow: boolean) {
  stubLayoutTier(narrow ? "overlay" : "docked");
}

function NotePageStandIn({ withShare }: { withShare: boolean }) {
  const versions = useVersionsController({ noteId: NOTE.id, enabled: true });
  const phone = useIsPhone();
  return (
    <VersionsProvider value={versions}>
      <header>
        <BackToListButton />
        <SidebarDrawerButton />
        {withShare && <ShareDialog note={NOTE} />}
        <NoteMenu note={NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
      </header>
      <CornerStack />
      {/* Round button at the bottom of the phone note screen (the note page mounts it only on phones, as NotePage does). */}
      {phone && <NoteBrowseBar note={NOTE} />}
      {/* A ready-made `[[` link in the sample note. */}
      <a href="/somewhere" {...tourTarget("wikilink")}>
        linked note
      </a>
      {/* A diagram inserted with `/` in the sample note. */}
      <div {...tourTarget("flowchart")}>a flowchart</div>
      {/* Status icon after the sample note's knowledge heading. */}
      <button type="button" aria-label="Knowledge info: Verified" {...tourTarget("knowledgeIcon")}>
        ✓
      </button>
      {/* Format toolbar that appears after a selection (really a portal layer; placed directly in the page here). */}
      <div data-kb-formatting-toolbar-popover="">
        <button type="button" aria-label="Bold">
          B
        </button>
        <button type="button" aria-label="AI">
          AI
        </button>
      </div>
    </VersionsProvider>
  );
}

async function renderPage({
  withShare = true,
  home = false,
  inert = false,
  at = `/n/${NOTE.ownerHandle}/${NOTE.slug}`,
}: { withShare?: boolean; home?: boolean; inert?: boolean; at?: string } = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[at]}>
          <ActiveNoteProvider>
            <Routes>
              {/* Home page (on a phone it is the list screen). */}
              <Route path="/" element={<AppShell inert={inert}>{null}</AppShell>} />
              <Route
                path="/n/:handle/:slug"
                element={
                  <AppShell inert={inert}>
                    {home ? <NarrowTopBar /> : <NotePageStandIn withShare={withShare} />}
                  </AppShell>
                }
              />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  // The user menu has no name until /api/auth/me returns.
  await screen.findByRole("button", { name: USER.displayName });
}

const AI_ACTION: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "preview", kind: "quick" };

function ctx(searchQuery = "", aiActions: readonly AiActionDto[] = []): StopContext {
  return { searchQuery, aiActions, sampleNoteId: NOTE.id, liveStops: false };
}

const aside = () => document.querySelector<HTMLElement>("aside[data-sidebar-instance]")!;
const pageHeader = () => document.querySelector<HTMLElement>("main header")!;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem("sidebar.tab");
});

describe("stop table", () => {
  it("full tour order; each stop appears once", () => {
    expect(FULL_TOUR).toEqual(["tabs", "newNote", "folders", "search", "header", "versions", "knowledge", "tags", "wikilink", "ai", "slash", "userMenu"]);
    expect(Object.keys(STOPS).sort()).toEqual([...FULL_TOUR].sort());
    for (const id of FULL_TOUR) expect(STOPS[id].id).toBe(id);
  });

  it.each([
    ["en", tourEn],
    ["zh-TW", tourZhTW],
  ] as const)("%s: every stop's title and body (including the floating-sidebar and phone bodies) have text", (_lang, bundle) => {
    for (const stop of Object.values(STOPS)) {
      for (const key of [stop.titleKey, stop.bodyKey, stop.narrowBodyKey, stop.phoneTitleKey, stop.phoneBodyKey].filter((k) => k !== undefined)) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundle);
        expect(typeof value === "string" && value.length > 0, key).toBe(true);
      }
    }
  });
});

describe("wide window: targets", () => {
  beforeEach(() => stubViewport(false));

  it("every stop is found, and is the one inside the sidebar card / header", async () => {
    await renderPage();
    const side = within(aside());
    const header = within(pageHeader());
    // the folders target is in the My notes header; the default tab is My notes
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));

    const expected: Record<StopId, HTMLElement[]> = {
      tabs: [side.getByRole("tablist")],
      newNote: [side.getByRole("button", { name: "New note" })],
      folders: [side.getByRole("button", { name: "New folder" })],
      search: [side.getByRole("textbox", { name: "Search notes" })],
      header: [header.getByRole("button", { name: "Share" }), header.getByRole("button", { name: "More" })],
      versions: [screen.getByTestId("versions-bubble")],
      knowledge: [screen.getByRole("button", { name: "Knowledge info: Verified" })],
      tags: [header.getByRole("button", { name: "More" })],
      wikilink: [screen.getByRole("link", { name: "linked note" })],
      ai: [screen.getByRole("button", { name: "AI" })],
      slash: [screen.getByText("a flowchart")],
      userMenu: [side.getByRole("button", { name: "Ann" })],
    };
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual(expected[id]);
  });

  it("returns an empty array when the page has no target", () => {
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });

  it("the header's width button is highlighted together when visible (share, width, kebab menu), and only share and kebab menu when a container query hides it (no measurable size)", () => {
    const make = (id: string, size: number) => {
      const el = document.createElement("button");
      el.setAttribute("data-kb-tour-target", id);
      el.getBoundingClientRect = () => new DOMRect(0, 0, size, size);
      document.body.append(el);
      return el;
    };
    const share = make("share", 30);
    const width = make("noteWidth", 30);
    const more = make("noteMenu", 30);
    expect(stopTarget(STOPS.header, ctx())).toEqual([share, width, more]);
    width.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    expect(stopTarget(STOPS.header, ctx())).toEqual([share, more]);
    for (const el of [share, width, more]) el.remove();
  });

  it("the header target needs both the share button and the kebab menu (finding only one highlights nothing)", async () => {
    await renderPage({ withShare: false });
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(stopTarget(STOPS.header, ctx())).toEqual([]);
  });

  it("the body uses the wide-window text", () => {
    const t = i18n.getFixedT("en");
    for (const stop of Object.values(STOPS)) expect(stopBody(t, stop), stop.id).toBe(stopBody(t, stop, "wide"));
  });
});

describe("floating sidebar (640-1279): targets", () => {
  beforeEach(() => stubViewport(true));

  it("stops in the sidebar point at the header's hamburger button; versions still point at the bottom-right bubble (present from 640 up); the header is unchanged", async () => {
    await renderPage();
    const header = within(pageHeader());
    const hamburger = header.getByRole("button", { name: "Open sidebar" });
    const more = header.getByRole("button", { name: "More" });
    const expected: Record<StopId, HTMLElement[]> = {
      tabs: [hamburger],
      newNote: [hamburger],
      folders: [hamburger],
      search: [hamburger],
      header: [header.getByRole("button", { name: "Share" }), more],
      versions: [screen.getByTestId("versions-bubble")],
      knowledge: [screen.getByRole("button", { name: "Knowledge info: Verified" })],
      tags: [more],
      wikilink: [screen.getByRole("link", { name: "linked note" })],
      ai: [screen.getByRole("button", { name: "AI" })],
      slash: [screen.getByText("a flowchart")],
      userMenu: [hamburger],
    };
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual(expected[id]);
  });

  it("versions: a collapsed corner stack is expanded for the stop without saving it, and collapses again when the stop is left", async () => {
    setCornerStackCollapsed(true);
    try {
      await renderPage();
      expect(screen.queryByTestId("versions-bubble")).toBeNull();
      act(() => prepareStop(STOPS.versions, ctx()));
      expect(stopTarget(STOPS.versions, ctx())).toEqual([screen.getByTestId("versions-bubble")]);
      expect(window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY)).toBe("1");
      act(() => STOPS.versions.leave?.(ctx()));
      expect(isCornerStackCollapsed()).toBe(true);
      expect(screen.queryByTestId("versions-bubble")).toBeNull();
    } finally {
      setCornerStackCollapsed(false);
    }
  });

  it("body: stops that have a narrow-window text use it", () => {
    const narrowOnes = Object.values(STOPS).filter((s) => s.narrowBodyKey !== undefined).map((s) => s.id);
    expect(narrowOnes.sort()).toEqual(["folders", "newNote", "search", "tabs", "userMenu"]);
    const t = i18n.getFixedT("en");
    for (const stop of Object.values(STOPS)) expect(stopBody(t, stop), stop.id).toBe(stopBody(t, stop, "floating"));
  });
});

describe("phone: targets", () => {
  beforeEach(() => stubLayoutTier("phone"));

  const topBar = () => within(document.querySelector<HTMLElement>("[data-phone-top-bar]")!);

  it("list stops point at real things on the list screen: the tab list, the new-note button at the bottom right, the new-folder button in the My notes header, the search button at the bottom left, the avatar in the top row", async () => {
    await renderPage({ at: "/" });
    const side = within(aside());
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
    const expected: Partial<Record<StopId, HTMLElement[]>> = {
      tabs: [side.getByRole("tablist")],
      newNote: [side.getByRole("button", { name: "New note" })],
      folders: [side.getByRole("button", { name: "New folder" })],
      search: [side.getByRole("button", { name: "Search notes" })],
      userMenu: [topBar().getByRole("button", { name: USER.displayName })],
    };
    for (const [id, els] of Object.entries(expected)) expect(stopTarget(STOPS[id as StopId], ctx()), id).toEqual(els);
    expect(stopTarget(STOPS.newNote, ctx())[0]).toHaveAttribute("data-phone-fab", "new-note");
    expect(stopTarget(STOPS.search, ctx())[0]).toHaveAttribute("data-phone-fab", "search");
  });

  it("stops on the note screen: the header's share and kebab menu, versions and tags pointing at the kebab menu (phones have no bubble), the knowledge icon, the [[ and / results; the AI stop has no target", async () => {
    await renderPage();
    const header = within(pageHeader());
    const more = header.getByRole("button", { name: "More" });
    const expected: Partial<Record<StopId, HTMLElement[]>> = {
      header: [header.getByRole("button", { name: "Share" }), more],
      versions: [more],
      knowledge: [screen.getByRole("button", { name: "Knowledge info: Verified" })],
      tags: [more],
      wikilink: [screen.getByRole("link", { name: "linked note" })],
      ai: [],
      slash: [screen.getByText("a flowchart")],
    };
    for (const [id, els] of Object.entries(expected)) expect(stopTarget(STOPS[id as StopId], ctx("", [AI_ACTION])), id).toEqual(els);
    expect(findDrawerButton()).toBeNull();
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("the list is not interactive on the note screen: the tab list, folder button and avatar cannot be found there (go back to the list first)", async () => {
    await renderPage();
    for (const id of ["tabs", "folders", "userMenu"] as const) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });

  it("which stop is on which screen: phones split between the list and the sample note, other layouts are always on the sample note", () => {
    expect(FULL_TOUR.filter((id) => stopScreen(STOPS[id], "phone") === "list")).toEqual(["tabs", "newNote", "folders", "search", "userMenu"]);
    for (const layout of ["wide", "floating"] as const) expect(FULL_TOUR.filter((id) => stopScreen(STOPS[id], layout) === "list")).toEqual([]);
  });

  it("the only stop the phone lacks is AI; other layouts have every stop", () => {
    expect(FULL_TOUR.filter((id) => !stopShownIn(STOPS[id], "phone"))).toEqual(["ai"]);
    for (const layout of ["wide", "floating"] as const) expect(FULL_TOUR.filter((id) => !stopShownIn(STOPS[id], layout))).toEqual([]);
  });

  it("prepare still runs (there is no drawer): new note and folders switch to My notes first and the screen stays on the list", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage({ at: "/" });
    const controls = getShellControls()!;
    act(() => prepareStop(STOPS.folders, ctx()));
    expect(controls.getTab()).toBe("myNotes");
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
    expect(aside()).toHaveAttribute("data-phone-list-shown");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("prepare only switches the tab, not the screen: running it on the note screen does not bring you back to the list (the tour changes screens itself)", async () => {
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    act(() => prepareStop(STOPS.newNote, ctx()));
    expect(getShellControls()!.getTab()).toBe("myNotes");
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("main header")).not.toBeNull();
    expect(aside()).not.toHaveAttribute("data-phone-list-shown");
  });

  it("body and title: read the current layout by default; stops with their own phone text use it", () => {
    const phoneOnes = Object.values(STOPS).filter((s) => s.phoneBodyKey !== undefined).map((s) => s.id);
    expect(phoneOnes.sort()).toEqual(["folders", "header", "knowledge", "newNote", "search", "slash", "tabs", "tags", "userMenu", "versions"]);
    const t = i18n.getFixedT("en");
    for (const stop of Object.values(STOPS)) {
      expect(stopBody(t, stop), stop.id).toBe(stopBody(t, stop, "phone"));
      expect(stopTitle(t, stop), stop.id).toBe(stopTitle(t, stop, "phone"));
    }
  });
});

// Folder names are user-chosen: even a name equal to any target's must not steal the target.
const COLLIDING_NAMES = [USER.displayName, "New note", "New folder", "Search notes", "Share", "More", "Open sidebar", "Sidebar sections", "Version history"];

describe("user content name clashes", () => {
  beforeEach(() => {
    stubViewport(false);
    stubFetch({ folders: COLLIDING_NAMES.map((name, i) => folderDto({ id: `f-${i}`, name })) });
  });

  /** Folder element inside the tabpanel whose name clashes with a target (in normal mode the folder row; in select mode the folder button with an `aria-label`). Header action buttons do not count. */
  function collidingInPanel(): Element[] {
    const panel = aside().querySelector("[role=tabpanel]")!;
    return Array.from(panel.querySelectorAll("button, input")).filter(
      (el) =>
        el.closest("[data-sidebar-header]") === null &&
        COLLIDING_NAMES.includes(el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""),
    );
  }

  /** The button named `name` inside the sidebar card but outside the tabpanel (the account row, the bottom new-note button). */
  function outsidePanel(name: string): HTMLElement {
    const found = within(aside())
      .getAllByRole("button", { name })
      .filter((el) => el.closest("[role=tabpanel]") === null);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  function targetsOf(): Map<StopId, Element[]> {
    return new Map(FULL_TOUR.map((id) => [id, stopTarget(STOPS[id], ctx())]));
  }

  it("normal mode: every stop still points at its own target and none points at a folder", async () => {
    await renderPage();
    const side = within(aside());
    await waitFor(() => expect(collidingInPanel().length).toBeGreaterThanOrEqual(COLLIDING_NAMES.length));
    const colliding = collidingInPanel();
    const targets = targetsOf();
    for (const [id, els] of targets) for (const el of els) expect(colliding, id).not.toContain(el);
    expect(targets.get("userMenu")).toEqual([outsidePanel(USER.displayName)]);
    expect(targets.get("newNote")).toEqual([outsidePanel("New note")]);
    expect(targets.get("search")).toEqual([side.getByRole("textbox", { name: "Search notes" })]);
  });

  it("select mode: the folder button uses the folder name as its aria-label and still is not taken as a target", async () => {
    await renderPage();
    const side = within(aside());
    await waitFor(() => expect(side.getByRole("button", { name: "Select" })).toBeEnabled());
    act(() => side.getByRole("button", { name: "Select" }).click());
    await side.findByRole("button", { name: "Done" });
    // The name clash is real: the select tree has a folder button whose aria-label is the user's name, and it comes before the account row in the DOM.
    const folderButton = await waitFor(() => {
      const el = collidingInPanel().find((e) => e.getAttribute("aria-label") === USER.displayName);
      expect(el).toBeDefined();
      return el!;
    });
    const account = findUserMenuTrigger()!;
    expect(folderButton.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const colliding = collidingInPanel();
    for (const [id, els] of targetsOf()) for (const el of els) expect(colliding, id).not.toContain(el);
    expect(account).toBe(outsidePanel(USER.displayName));
    expect(stopTarget(STOPS.userMenu, ctx())).toEqual([account]);
  });
});

describe("non-interactive background (AppShell inert in presentation mode)", () => {
  const ALL_IDS: TourTargetId[] = ["tabs", "newNote", "newFolder", "search", "share", "noteMenu", "versions", "userMenu", "drawerButton", "wikilink", "flowchart", "knowledgeIcon"];

  it.each([false, true])("floating sidebar = %s: none of the twelve targets can be found", async (narrow) => {
    stubViewport(narrow);
    await renderPage({ inert: true });
    // The elements are still in the DOM (with their attributes), only inside the inert range. The version bubble is present on a floating sidebar (640-1279) too.
    for (const id of ALL_IDS) {
      expect(document.querySelector(`[data-kb-tour-target="${id}"]`), id).not.toBeNull();
    }
    for (const id of ALL_IDS) expect(findTourTarget(id), id).toBeNull();
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });
});

describe("phone: non-interactive background", () => {
  it("the back chevron and the bottom round button cannot be found either", async () => {
    stubLayoutTier("phone");
    await renderPage({ inert: true });
    await waitFor(() => expect(document.querySelector('[data-kb-tour-target="phoneNewNote"]')).not.toBeNull());
    for (const id of ["backToList", "phoneNewNote", "phoneSearch", "share", "noteMenu"] as const) {
      expect(document.querySelector(`[data-kb-tour-target="${id}"]`), id).not.toBeNull();
      expect(findTourTarget(id), id).toBeNull();
    }
    for (const id of FULL_TOUR) expect(stopTarget(STOPS[id], ctx()), id).toEqual([]);
  });
});

describe("hamburger button", () => {
  it("also found on pages without a note header (the narrow top row)", async () => {
    stubViewport(true);
    await renderPage({ home: true });
    expect(document.querySelector("main header")).toBeNull();
    expect(findDrawerButton()).toBe(within(document.querySelector("main")!).getByRole("button", { name: "Open sidebar" }));
    expect(stopTarget(STOPS.userMenu, ctx())).toEqual([findDrawerButton()]);
  });
});

describe("two sidebars: with the drawer open the drawer one is used, otherwise the fixed card one", () => {
  beforeEach(() => stubViewport(true));

  it("user menu, search box, tab list; with the drawer open the header's hamburger button is covered and cannot be found", async () => {
    await renderPage();
    const card = aside();
    expect(findUserMenuTrigger()?.closest("aside")).toBe(card);
    expect(findTourTarget("search")?.closest("aside")).toBe(card);
    expect(findDrawerButton()).toBe(within(pageHeader()).getByRole("button", { name: "Open sidebar" }));

    act(() => within(pageHeader()).getByRole("button", { name: "Open sidebar" }).click());
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await within(drawer).findByRole("button", { name: USER.displayName });
    for (const id of ["userMenu", "search", "tabs"] as const) {
      expect(findTourTarget(id), id).not.toBeNull();
      expect(drawer.contains(findTourTarget(id)), id).toBe(true);
    }
    expect(findDrawerButton()).toBeNull();

    act(() => getShellControls()!.closeDrawer());
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
    expect(findUserMenuTrigger()?.closest("aside")).toBe(card);
    expect(findDrawerButton()).not.toBeNull();
  });
});

describe("prepare", () => {
  it("wide window: newNote and folders first switch to My notes and leave select mode", async () => {
    stubViewport(false);
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    for (const id of ["newNote", "folders"] as const) {
      act(() => getShellControls()!.showTab("recent"));
      const controls = getShellControls()!;
      const endSelection = vi.spyOn(controls, "endSelectionIfActive");
      act(() => prepareStop(STOPS[id], ctx()));
      expect(controls.getTab(), id).toBe("myNotes");
      expect(endSelection, id).toHaveBeenCalledTimes(1);
      endSelection.mockRestore();
    }
    // the New folder button appears in the header only after switching tabs
    await waitFor(() => expect(stopTarget(STOPS.folders, ctx())).toHaveLength(1));
  });

  it("floating sidebar: prepare does not run - the tab stays and the drawer remains closed", async () => {
    stubLayoutTier("overlay");
    localStorage.setItem("sidebar.tab", "recent");
    await renderPage();
    const controls = getShellControls()!;
    const showTab = vi.spyOn(controls, "showTab");
    const endSelection = vi.spyOn(controls, "endSelectionIfActive");
    for (const id of FULL_TOUR) act(() => prepareStop(STOPS[id], ctx()));
    expect(showTab).not.toHaveBeenCalled();
    expect(endSelection).not.toHaveBeenCalled();
    expect(controls.getTab()).toBe("recent");
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("with no registered sidebar it does nothing and does not throw", () => {
    stubViewport(false);
    expect(getShellControls()).toBeNull();
    for (const id of FULL_TOUR) expect(() => prepareStop(STOPS[id], ctx())).not.toThrow();
  });
});

describe("knowledge stop scrolling", () => {
  it("scrolls the icon into view once per visit: re-finding it in the same visit leaves the user's scrolling alone, and coming back after leave scrolls again", () => {
    const icon = document.createElement("button");
    icon.setAttribute("data-kb-tour-target", "knowledgeIcon");
    const scroll = vi.fn();
    icon.scrollIntoView = scroll;
    document.body.append(icon);
    try {
      expect(stopTarget(STOPS.knowledge, ctx())).toEqual([icon]);
      expect(stopTarget(STOPS.knowledge, ctx())).toEqual([icon]);
      expect(scroll).toHaveBeenCalledTimes(1);
      STOPS.knowledge.leave!(ctx());
      expect(stopTarget(STOPS.knowledge, ctx())).toEqual([icon]);
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      STOPS.knowledge.leave!(ctx());
      icon.remove();
    }
  });
});

describe("precondition", () => {
  it("while the search box has text tabs, folders and search do not hold (the tab list and header are not rendered while searching, and the user's text is not cleared); other stops work as usual", () => {
    const applies = (q: string) => FULL_TOUR.filter((id) => STOPS[id].precondition?.(ctx(q, [AI_ACTION])) ?? true);
    expect(applies("")).toEqual(FULL_TOUR);
    expect(applies("ab")).toEqual(["newNote", "header", "versions", "knowledge", "tags", "wikilink", "ai", "slash", "userMenu"]);
    // whitespace also counts as searching (same check as AppShell)
    expect(applies(" ")).toEqual(["newNote", "header", "versions", "knowledge", "tags", "wikilink", "ai", "slash", "userMenu"]);
  });
});

describe("precondition of the AI stop", () => {
  const applies = (aiActions: readonly AiActionDto[]) => STOPS.ai.precondition?.(ctx("", aiActions)) ?? true;

  it("holds only when the site has AI actions; without them (load failure, not configured) the whole stop is skipped", () => {
    expect(applies([AI_ACTION])).toBe(true);
    expect(applies([])).toBe(false);
  });

  it("no AI actions: the full tour omits the AI stop", () => {
    const planned = FULL_TOUR.filter((id) => STOPS[id].precondition?.(ctx("", [])) ?? true);
    expect(planned).toEqual(["tabs", "newNote", "folders", "search", "header", "versions", "knowledge", "tags", "wikilink", "slash", "userMenu"]);
  });
});

describe("body text", () => {
  const TITLES: Record<"en" | "zh-TW", Record<StopId, string>> = {
    en: {
      tabs: "Sidebar sections",
      newNote: "New note",
      folders: "Folders",
      search: "Search",
      header: "Share and more",
      versions: "Version history",
      knowledge: "Knowledge info",
      tags: "Tags",
      wikilink: "Link to another note",
      ai: "Ask AI about a selection",
      slash: "Insert blocks with /",
      userMenu: "Forgot how something works?",
    },
    "zh-TW": {
      tabs: "側欄分類",
      newNote: "新增筆記",
      folders: "資料夾",
      search: "搜尋",
      header: "分享與更多動作",
      versions: "版本歷史",
      knowledge: "知識資訊",
      tags: "標籤",
      wikilink: "連到別篇筆記",
      ai: "框選文字叫 AI",
      slash: "用 / 插入各種區塊",
      userMenu: "忘了怎麼用？",
    },
  };

  /** Stops with their own phone title (phones have no sidebar). */
  const PHONE_TITLES: Record<"en" | "zh-TW", Partial<Record<StopId, string>>> = {
    en: { tabs: "Lists of notes" },
    "zh-TW": { tabs: "筆記清單" },
  };

  /** Fragments the wide-window body must contain (`{mod}` stands for the shortcut modifier key). */
  const WIDE_PARTS: Record<"en" | "zh-TW", Record<StopId, string[]>> = {
    en: {
      tabs: ["hover over one to see its name"],
      newNote: ["Click here to create a note", "My notes"],
      folders: ["My notes header", "Move to…"],
      search: ["{mod}K", "titles and note text"],
      header: ["invites others to view or edit", "icon next to Share", "⋮ → \"Width\"", "Standard, Wide and Full width"],
      versions: ["{mod}S", "bottom-right corner"],
      knowledge: ["/info", "This icon", "point at it", "index"],
      tags: ["\"Add tag\" in this ⋮ menu", "/tag", "#name and a space on its first line when that line is a plain paragraph", "row above the text", "colored dots in the sidebar", "funnel button", "type # in the search box"],
      wikilink: ["Type [[", "Mentioned in"],
      ai: ["AI button", "toolbar"],
      slash: ["Type /", "flowchart", "side-by-side columns", "\"2 columns\"", "divider between columns"],
      userMenu: ["{mod}/", "open Help from here", "shortcuts, the feature tour and what's new"],
    },
    "zh-TW": {
      tabs: ["滑鼠停在上面就會顯示名稱"],
      newNote: ["按這裡新增一篇筆記", "我的筆記"],
      folders: ["我的筆記", "移動到…"],
      search: ["{mod}K", "標題和內文"],
      header: ["邀請別人一起看或一起編輯", "「分享」旁邊的圖示", "⋮ →「寬度」", "標準、寬或全寬"],
      versions: ["{mod}S", "右下角"],
      knowledge: ["/info", "這個小圖示", "滑鼠移上去", "知識索引"],
      tags: ["⋮ 選「加標籤」", "/tag", "第一行（須為一般段落）打 #名稱 再按空白", "內文上方", "側欄顯示成彩色圓點", "漏斗鈕", "在搜尋框打 #"],
      wikilink: ["打 [[", "提及"],
      ai: ["「AI」鈕", "工具列"],
      slash: ["打 /", "流程圖", "並排 2 欄", "拖欄與欄之間的分隔線"],
      userMenu: ["{mod}/", "從這裡打開「說明」", "快捷鍵、功能導覽和這一版新增"],
    },
  };

  /** Fragments the floating-sidebar (640-1279) body must contain; stops not listed keep the wide-window text. */
  const FLOATING_PARTS: Record<"en" | "zh-TW", Partial<Record<StopId, string[]>>> = {
    en: {
      tabs: ["Open the sidebar from here"],
      newNote: ["bottom of the sidebar", "Open the sidebar from here"],
      folders: ["Move to…", "Open the sidebar from here"],
      search: ["{mod}K", "open the sidebar from here"],
      userMenu: ["{mod}/", "open Help from the menu at the bottom-left of the sidebar", "Open the sidebar from here"],
    },
    "zh-TW": {
      tabs: ["點這裡打開側欄"],
      newNote: ["側欄底部", "點這裡打開側欄"],
      folders: ["移動到…", "點這裡打開側欄"],
      search: ["{mod}K", "點這裡打開側欄"],
      userMenu: ["{mod}/", "從側欄左下角的選單打開「說明」", "點這裡打開側欄"],
    },
  };

  /** Fragments the phone body must contain; stops not listed keep the wide-window text (the AI stop is not shown on phones, so it is not checked). */
  const PHONE_PARTS: Record<"en" | "zh-TW", Partial<Record<StopId, string[]>>> = {
    en: {
      tabs: ["This row of icons", "lists of notes"],
      newNote: ["Tap here to create a note", "same folder or group", "My notes"],
      folders: ["Tap this button in the My notes header", "Move to…"],
      search: ["Tap here to search", "titles and note text"],
      header: ["invites others to view or edit"],
      versions: ["\"Version history\" in the ⋮ menu", "save a version yourself"],
      knowledge: ["/info", "tap it"],
      tags: ["\"Add tag\" in this ⋮ menu", "colored dots in the list", "funnel button"],
      slash: ["Type /", "flowchart"],
      userMenu: ["Tap your avatar here", "Help", "shortcuts, the feature tour and what's new"],
    },
    "zh-TW": {
      tabs: ["這排圖示", "筆記清單"],
      newNote: ["點這裡新增一篇筆記", "同一個資料夾或群組", "我的筆記"],
      folders: ["點「我的筆記」標題列的這顆鈕", "移動到…"],
      search: ["點這裡就能搜尋", "標題和內文"],
      header: ["邀請別人一起看或一起編輯"],
      versions: ["⋮ 選單裡的「版本歷史」", "自己儲存一個版本"],
      knowledge: ["/info", "點一下"],
      tags: ["⋮ 選「加標籤」", "清單上顯示成彩色圓點", "漏斗鈕"],
      slash: ["打 /", "流程圖"],
      userMenu: ["點這裡的頭像", "「說明」", "快捷鍵、功能導覽和這一版新增"],
    },
  };

  /** The "open the sidebar" sentence appears only on a floating sidebar; the wide-window and phone texts must not contain it. */
  const FLOATING_SENTENCE = { en: /open the sidebar/i, "zh-TW": /打開側欄/ } as const;
  /** Phones have no sidebar, no corner bubble, and mostly no keyboard or mouse; list stops point at real things on the list, so nobody needs to press the back chevron first: phone texts mention none of these. */
  const NOT_ON_PHONE = {
    en: /sidebar|bottom-right|bottom-left|\bPress\b|\bClick\b|hover|\bdrag\b|‹/i,
    "zh-TW": /側欄|右下角|左下角|按 Ctrl|按 ⌘|滑鼠|拖|‹/,
  } as const;

  const withMod = (parts: string[], mod: string) => parts.map((p) => p.replace("{mod}", mod));

  afterEach(() => vi.unstubAllGlobals());

  it.each(["en", "zh-TW"] as const)("%s: every stop's title and body (wide, floating sidebar, phone)", (lng) => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const t = i18n.getFixedT(lng);
    for (const id of FULL_TOUR) {
      const stop = STOPS[id];
      expect(stopTitle(t, stop, "wide"), id).toBe(TITLES[lng][id]);
      expect(stopTitle(t, stop, "floating"), id).toBe(TITLES[lng][id]);
      expect(stopTitle(t, stop, "phone"), id).toBe(PHONE_TITLES[lng][id] ?? TITLES[lng][id]);

      const wide = stopBody(t, stop, "wide");
      for (const part of withMod(WIDE_PARTS[lng][id], "Ctrl+")) expect(wide, `${id} wide`).toContain(part);
      expect(wide, `${id} wide`).not.toMatch(FLOATING_SENTENCE[lng]);

      const floating = stopBody(t, stop, "floating");
      const floatingParts = FLOATING_PARTS[lng][id];
      if (floatingParts === undefined) {
        expect(floating, `${id} floating`).toBe(wide);
      } else {
        expect(floating, `${id} floating`).not.toBe(wide);
        for (const part of withMod(floatingParts, "Ctrl+")) expect(floating, `${id} floating`).toContain(part);
      }

      if (!stopShownIn(stop, "phone")) continue;
      const phone = stopBody(t, stop, "phone");
      const phoneParts = PHONE_PARTS[lng][id];
      if (phoneParts === undefined) {
        expect(phone, `${id} phone`).toBe(wide);
      } else {
        expect(phone, `${id} phone`).not.toBe(wide);
        expect(phone, `${id} phone`).not.toBe(floating);
        for (const part of phoneParts) expect(phone, `${id} phone`).toContain(part);
      }
      expect(phone, `${id} phone`).not.toMatch(FLOATING_SENTENCE[lng]);
      expect(phone, `${id} phone`).not.toMatch(NOT_ON_PHONE[lng]);
      expect(phone, `${id} phone`).not.toContain("Ctrl+");
    }
  });

  it.each(["en", "zh-TW"] as const)("%s: stop 6 on a floating sidebar also points at the bottom-right bubble (present from 640 up) and its body does not mention the kebab menu; on a phone it talks about Version history inside the kebab menu", (lng) => {
    const t = i18n.getFixedT(lng);
    const wide = stopBody(t, STOPS.versions, "wide");
    expect(stopBody(t, STOPS.versions, "floating")).toBe(wide);
    expect(wide).toMatch(/右下角|bottom-right/);
    expect(wide).not.toContain("⋮");
    const phone = stopBody(t, STOPS.versions, "phone");
    expect(phone).toContain("⋮");
    expect(phone).toContain(t("note.menu.versions"));
  });

  it.each(["en", "zh-TW"] as const)("%s: Mac shows the Command symbol, other platforms show Ctrl+, no unsubstituted {{mod}} remains; the phone body does not mention shortcuts", (lng) => {
    const t = i18n.getFixedT(lng);
    const all = (layout: "wide" | "floating") => FULL_TOUR.map((id) => stopBody(t, STOPS[id], layout)).join("\n");
    for (const layout of ["wide", "floating"] as const) {
      vi.stubGlobal("navigator", { platform: "MacIntel" });
      const mac = all(layout);
      expect(mac).toContain("⌘K");
      expect(mac).toContain("⌘/");
      expect(mac).not.toContain("Ctrl");
      vi.stubGlobal("navigator", { platform: "Win32" });
      const other = all(layout);
      expect(other).toContain("Ctrl+K");
      expect(other).toContain("Ctrl+/");
      expect(other).not.toContain("⌘");
      for (const text of [mac, other]) expect(text).not.toContain("{{");
    }
    for (const platform of ["MacIntel", "Win32"]) {
      vi.stubGlobal("navigator", { platform });
      const phone = FULL_TOUR.filter((id) => stopShownIn(STOPS[id], "phone"))
        .map((id) => stopBody(t, STOPS[id], "phone"))
        .join("\n");
      expect(phone).not.toMatch(/⌘|Ctrl|\{\{/);
    }
  });

  it("names mentioned in the body match the names in the UI (both languages)", () => {
    for (const lng of ["en", "zh-TW"] as const) {
      const t = i18n.getFixedT(lng);
      const body = (id: StopId) => stopBody(t, STOPS[id], "wide");
      const floatingBody = (id: StopId) => stopBody(t, STOPS[id], "floating");
      const phoneBody = (id: StopId) => stopBody(t, STOPS[id], "phone");
      // Stop 1: the example tab names must match the sidebar (the tab count is not locked).
      for (const key of ["sidebar.myNotes", "sidebar.workspace", "sidebar.shared", "sidebar.trash"]) {
        for (const text of [body("tabs"), floatingBody("tabs"), phoneBody("tabs")]) expect(text, `${lng} ${key}`).toContain(t(key));
      }
      // Stop 2: the new-note button's name (the one at the bottom of the sidebar); the place it goes into is My notes.
      expect(stopTitle(t, STOPS.newNote)).toBe(t("home.newNote"));
      expect(floatingBody("newNote")).toContain(t("home.newNote"));
      expect(body("newNote")).toContain(t("sidebar.myNotes"));
      expect(phoneBody("newNote")).toContain(t("sidebar.myNotes"));
      // Stop 3: "Move to..." in the note kebab menu, and the header is under My notes.
      for (const text of [body("folders"), phoneBody("folders")]) {
        expect(text).toContain(t("note.menu.moveTo"));
        expect(text).toContain(t("sidebar.myNotes"));
      }
      // Stop 5: the four items in the share button and kebab menu (the phone's kebab menu has them too); the width submenu and its three options exist only in the kebab menu from 640 up, and phones do not mention them.
      expect(body("header")).toContain(t("share.button"));
      for (const key of ["note.menu.present", "note.menu.aiEdits", "note.menu.moveTo", "note.menu.copyTo"]) {
        expect(body("header"), `${lng} ${key}`).toContain(t(key));
        expect(phoneBody("header"), `${lng} ${key}`).toContain(t(key));
      }
      for (const key of ["note.width.label", "note.width.standard", "note.width.wide", "note.width.full"]) {
        expect(body("header"), `${lng} ${key}`).toContain(t(key));
        expect(floatingBody("header"), `${lng} ${key}`).toContain(t(key));
      }
      expect(phoneBody("header")).not.toContain(t("note.width.label"));
      // Knowledge and tags: titles match the /info item and the tag row's label; the menu item is named as in the note's ⋮ menu.
      expect(stopTitle(t, STOPS.knowledge)).toBe(t("note.knowledge.slashTitle"));
      expect(stopTitle(t, STOPS.tags)).toBe(t("tags.label"));
      for (const text of [body("tags"), phoneBody("tags")]) expect(text).toContain(t("tags.entry.menuItem"));
      // Stop 10: the entry is called Help, matching the user menu item.
      for (const text of [body("userMenu"), floatingBody("userMenu"), phoneBody("userMenu")]) expect(text).toContain(t("userMenu.help"));
      // The three pages mentioned in stop 10 must be named the same as the page names in the help dialog's left column.
      const nav = (lng === "en" ? shortcutsEn : shortcutsZhTW).helpGuide.nav;
      for (const text of [body("userMenu"), floatingBody("userMenu"), phoneBody("userMenu")]) {
        if (lng === "en") {
          const lower = text.toLowerCase();
          expect(lower).toContain(nav.tour.toLowerCase());
          expect(lower).toContain(nav.whatsNew.toLowerCase());
          expect(lower).toContain(nav.shortcuts.toLowerCase().replace("keyboard ", ""));
        } else {
          for (const name of [nav.tour, nav.whatsNew, nav.shortcuts]) expect(text).toContain(name);
        }
      }
    }
  });

  it.each(["en", "zh-TW"] as const)("%s: stop texts do not use the keyboard shortcuts page as the entry name", (lng) => {
    const t = i18n.getFixedT(lng);
    const text = FULL_TOUR.flatMap((id) => (["wide", "floating", "phone"] as const).map((layout) => stopBody(t, STOPS[id], layout))).join("\n");
    expect(text).not.toMatch(/Keyboard shortcuts|快捷鍵介紹/);
  });
});
