import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { TourContext } from "@/lib/tour-context";
import { findUserMenuReturnTarget } from "@/lib/tour-find";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { RELEASE_HIGHLIGHTS } from "./release-highlights";
import { ShortcutsContent } from "./ShortcutsLazy";
import { stubLayoutTier } from "@/test/layout-tier";

/**
 * Content of the help dialog: the left card lists the "Feature tour" and "What's new" pages and the shortcut categories, the right card shows only the selected page;
 * categories/entries are filtered by the site's AI capabilities, key faces for Mac vs other platforms, screen-reader-friendly key names and separators,
 * the hint sentence at the bottom of the left card (no button), focus on page selection and the two-layer switch on narrow screens (like settings' ManagementShell),
 * and the Start tour button and "What's new" filtered by who is signed in.
 *
 * matchMedia: the global stub in `test/setup.ts` always returns matches:false - for `(min-width: 768px)` that is a narrow viewport; wide-viewport cases stub it themselves.
 */

/** Stand-in for the registry: when `override` is not null it replaces the real registry (empty state, `adminOnly` filtering); other cases use the real one. */
const registryState = vi.hoisted(() => ({ override: null as null | { version: string; items: { id: string; adminOnly?: boolean }[] } }));
vi.mock("./release-highlights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./release-highlights")>();
  return {
    ...actual,
    get RELEASE_HIGHLIGHTS() {
      return registryState.override ?? actual.RELEASE_HIGHLIGHTS;
    },
  };
});

/** Stand-in for `/api/auth/me`: null = signed out (401). */
const sessionState = { user: null as null | { isAdmin: boolean } };

const INSTRUCT: AiActionDto = { id: "instruct", name: "Instruct", applyMode: "preview", kind: "instruct" };
const QUICK: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "direct", kind: "quick" };

/** Stand-in for `/api/ai/actions`; any other request throws (the content component must not call other APIs). */
function stubFetch(handler: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ai/actions") return handler();
      if (url === "/api/auth/me") {
        return sessionState.user === null
          ? jsonResponse({ error: { code: "unauthorized", message: "no session" } }, 401)
          : jsonResponse({ id: "u1", email: "alice@example.com", handle: "alice", displayName: "Alice", ...sessionState.user });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const jsonResponse = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function stubActions(actions: AiActionDto[]) {
  stubFetch(() => jsonResponse({ actions }));
}

function stubPlatform(platform: string) {
  vi.stubGlobal("navigator", { ...navigator, platform });
}

function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

interface ContentOptions {
  /** With a tour context (the help dialog gets `useTour()` from the App level). */
  tour?: { start: (options: { returnTo: string; returnFocus: () => Element | null }) => void };
  startPage?: ShortcutsStartPage;
  onClose?: () => void;
  listBack?: { label: string; onBack: () => void };
  client?: QueryClient;
  route?: string;
}

function contentElement({ tour, startPage, onClose = () => {}, listBack, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), route = "/" }: ContentOptions = {}) {
  const content = <ShortcutsContent startPage={startPage} onClose={onClose} listBack={listBack} />;
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{tour ? <TourContext.Provider value={tour}>{content}</TourContext.Provider> : content}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderContent(options: ContentOptions = {}) {
  return render(contentElement(options));
}

const ALL_EN = ["General", "Typing triggers", "Markdown shortcuts", "Text formatting", "Columns", "Sidebar", "Presentation", "AI", "Mouse"];
const NO_AI_EN = ALL_EN.filter((title) => title !== "AI");

/** The category buttons in the left column (names in order). */
const navNames = () => Array.from(document.querySelectorAll("[data-shortcuts-category]")).map((el) => el.textContent);
const navButton = (name: string) => within(screen.getByRole("navigation", { name: "Help" })).getByRole("button", { name });
/** Names of all buttons in the left column, in order (two pages + each category). */
const allNavNames = () => within(screen.getByRole("navigation", { name: "Help" })).getAllByRole("button").map((b) => b.textContent);
/** The h3 currently shown in the right card. */
const heading = () => screen.getByRole("heading", { level: 3 }).textContent;
const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-shortcut-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}（目前顯示的分類：${heading()}）`);
  return el;
};
const hasRow = (id: string) => document.querySelector(`[data-shortcut-id="${id}"]`) !== null;
const rowIds = () => Array.from(document.querySelectorAll("[data-shortcut-id]")).map((el) => el.getAttribute("data-shortcut-id"));
const kbdTexts = (el: HTMLElement) => Array.from(el.querySelectorAll("kbd")).map((k) => k.textContent);
const region = () => screen.getByRole("region");

/** Switches to a category (clicks the left column button). */
function openCategory(name: string): void {
  fireEvent.click(navButton(name));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubPlatform("Win32");
  sessionState.user = null;
  registryState.override = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("site capabilities: categories", () => {
  it("AI returns []: the left column is the categories without AI, in order", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navNames()).not.toContain("AI");
  });

  it("AI has Instruct and quick: the AI category comes before Mouse and opens with three rows aiSelect, aiSend, aiClose", async () => {
    stubActions([INSTRUCT, QUICK]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(ALL_EN));
    openCategory("AI");
    expect(heading()).toBe("AI");
    expect(rowIds()).toEqual(["aiSelect", "aiSend", "aiClose"]);
  });

  it("AI returns only quick actions: the AI category has aiSelect and aiClose but no aiSend", async () => {
    stubActions([QUICK]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(ALL_EN));
    openCategory("AI");
    expect(rowIds()).toEqual(["aiSelect", "aiClose"]);
  });

  it("the AI request never returns: all other categories are there, no AI", async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
  });

  it("AI returns 500: same as above and does not crash", async () => {
    stubFetch(() => jsonResponse({ error: { code: "internal", message: "boom" } }, 500));
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    await new Promise((resolve) => setTimeout(resolve, 20)); // wait for the query to finish its error path; still the same
    expect(navNames()).toEqual(NO_AI_EN);
  });

  it("the selected category is AI and site capabilities then disappear: falls back to the first page rather than blank", async () => {
    registryState.override = { version: "9.9.9", items: [] };
    stubActions([INSTRUCT]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderContent({ client });
    await waitFor(() => expect(navNames()).toContain("AI"));
    openCategory("AI");
    expect(heading()).toBe("AI");
    // The admin turns all AI actions off (["ai-actions"] cache updates): the selected AI category disappears, the right card falls back to the first page ("What's new" when there is no tour context), the component does not crash
    act(() => {
      client.setQueryData(["ai-actions"], []);
    });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("What's new")).toHaveAttribute("aria-current", "true");
    expect(region()).toHaveTextContent("Nothing new to highlight in this version.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("category switching (left card items + right card content)", () => {
  beforeEach(() => stubActions([]));

  it("defaults to General: aria-current is on it, the right card region is named after it, and it shows only General's entries", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("General")).toHaveAttribute("aria-current", "true");
    for (const other of NO_AI_EN.slice(1)) expect(navButton(other)).not.toHaveAttribute("aria-current");
    expect(region()).toHaveAccessibleName("General");
    expect(rowIds()).toEqual(["search", "searchClear", "saveVersion", "openSettings", "openShortcuts"]);
  });

  it("clicking \"Markdown shortcuts\": aria-current moves, the region name changes, the right card keeps only that category's entries", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    openCategory("Markdown shortcuts");
    expect(navButton("Markdown shortcuts")).toHaveAttribute("aria-current", "true");
    expect(navButton("General")).not.toHaveAttribute("aria-current");
    expect(heading()).toBe("Markdown shortcuts");
    expect(region()).toHaveAccessibleName("Markdown shortcuts");
    expect(hasRow("heading")).toBe(true);
    expect(hasRow("search")).toBe(false);
    expect(navButton("Markdown shortcuts").getAttribute("aria-controls")).toBe(region().id);
  });

  it("the whole list: visiting every category shows every entry under some category (no entry is eaten by category switching)", async () => {
    stubActions([INSTRUCT]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(ALL_EN));
    const seen = new Set<string>();
    for (const name of ALL_EN) {
      openCategory(name);
      for (const id of rowIds()) seen.add(id!);
    }
    expect(seen.size).toBeGreaterThanOrEqual(43);
  });

  it("after opening, focus is in the right card's content area (PageDown scrolls immediately)", async () => {
    renderContent();
    await waitFor(() => expect(region()).toHaveFocus());
  });

  it("wide screen: after choosing a category focus stays on the clicked item (same as settings' NavLink)", async () => {
    stubWide();
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    navButton("Columns").focus();
    openCategory("Columns");
    expect(navButton("Columns")).toHaveFocus();
    expect(heading()).toBe("Columns");
  });

  it("narrow two layers: default is the content layer; after choosing a category it is the content layer with focus in the content area; the back button returns to the category layer with focus on the current item", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    const items = document.querySelector<HTMLElement>('[data-shortcuts-card="items"]')!;
    const content = document.querySelector<HTMLElement>('[data-shortcuts-card="content"]')!;
    // jsdom does not apply Tailwind: only class assertions (same as ManagementShell.test)
    expect(items.className).toMatch(/(^| )hidden( |$)/);
    expect(content.className).toMatch(/(^| )flex( |$)/);

    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(items.className).toMatch(/(^| )flex( |$)/));
    expect(content.className).toMatch(/(^| )hidden( |$)/);
    await waitFor(() => expect(navButton("General")).toHaveFocus());

    openCategory("Sidebar");
    await waitFor(() => expect(region()).toHaveFocus());
    expect(content.className).toMatch(/(^| )flex( |$)/);
    expect(items.className).toMatch(/(^| )hidden( |$)/);
    expect(region()).toHaveAccessibleName("Sidebar");
  });
});

describe("help dialog pages", () => {
  beforeEach(() => stubActions([]));

  it("left column order: Feature tour, What's new, separator, the \"Keyboard shortcuts\" subheading; category buttons are in a group named by that subheading", async () => {
    renderContent({ tour: { start: vi.fn() } });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(allNavNames()).toEqual(["Feature tour", "What's new", ...NO_AI_EN]);
    const nav = screen.getByRole("navigation", { name: "Help" });
    const kids = Array.from(nav.children);
    expect(kids.map((el) => el.getAttribute("role") ?? el.tagName.toLowerCase())).toEqual(["button", "button", "separator", "group"]);
    const group = within(nav).getByRole("group", { name: "Keyboard shortcuts" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(NO_AI_EN);
    const label = group.firstElementChild as HTMLElement;
    expect(label.textContent).toBe("Keyboard shortcuts");
    expect(label.tabIndex).toBe(-1);
  });

  it("without a tour context: no Feature tour in the left column, What's new is still at the top", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(allNavNames()).toEqual(["What's new", ...NO_AI_EN]);
  });

  it("start page: global stays on General; tour stays on Feature tour (aria-current and region name follow)", async () => {
    const first = renderContent({ tour: { start: vi.fn() }, startPage: "global" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("General")).toHaveAttribute("aria-current", "true");
    expect(region()).toHaveAccessibleName("General");
    first.unmount();

    renderContent({ tour: { start: vi.fn() }, startPage: "tour" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("Feature tour")).toHaveAttribute("aria-current", "true");
    expect(navButton("General")).not.toHaveAttribute("aria-current");
    expect(region()).toHaveAccessibleName("Feature tour");
    expect(screen.getByRole("button", { name: "Start tour" })).toBeInTheDocument();
  });

  it("without a tour context but asked to stay on tour: falls back to What's new, no unresponsive button appears", async () => {
    renderContent({ startPage: "tour" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("What's new")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: "Start tour" })).toBeNull();
  });

  it("Start tour: closes the dialog first, then calls start once; returnTo is the current location (including search and hash), returnFocus is the user menu lookup function", async () => {
    const calls: string[] = [];
    const start = vi.fn(() => void calls.push("start"));
    const onClose = vi.fn(() => void calls.push("close"));
    renderContent({ tour: { start }, startPage: "tour", onClose, route: "/n/alice/notes/draft?tab=2#top" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    fireEvent.click(screen.getByRole("button", { name: "Start tour" }));
    expect(calls).toEqual(["close", "start"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ returnTo: "/n/alice/notes/draft?tab=2#top", returnFocus: findUserMenuReturnTarget });
  });

  it("Feature tour page: title, description and button", async () => {
    renderContent({ tour: { start: vi.fn() }, startPage: "tour" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(heading()).toBe("Feature tour");
    expect(region()).toHaveTextContent("It creates a sample note in My notes");
  });

  it("narrow screen: opens on the content layer (Feature tour page); the back button returns to the left column; choosing What's new enters the content layer", async () => {
    registryState.override = { version: "9.9.9", items: [] };
    renderContent({ tour: { start: vi.fn() }, startPage: "tour" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    const items = document.querySelector<HTMLElement>('[data-shortcuts-card="items"]')!;
    const content = document.querySelector<HTMLElement>('[data-shortcuts-card="content"]')!;
    expect(content.className).toMatch(/(^| )flex( |$)/);
    expect(items.className).toMatch(/(^| )hidden( |$)/);
    expect(heading()).toBe("Feature tour");

    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(items.className).toMatch(/(^| )flex( |$)/));
    expect(content.className).toMatch(/(^| )hidden( |$)/);
    await waitFor(() => expect(navButton("Feature tour")).toHaveFocus());

    fireEvent.click(navButton("What's new"));
    await waitFor(() => expect(region()).toHaveFocus());
    expect(content.className).toMatch(/(^| )flex( |$)/);
    expect(items.className).toMatch(/(^| )hidden( |$)/);
    expect(region()).toHaveAccessibleName("What's new");
  });

  it("zh-TW: the left column and pages use the localized names for Feature tour, What's new and Shortcuts", async () => {
    registryState.override = { version: "9.9.9", items: [] };
    await i18n.changeLanguage("zh-TW");
    renderContent({ tour: { start: vi.fn() }, startPage: "tour" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "說明" })).toBeInTheDocument());
    const nav = within(screen.getByRole("navigation", { name: "說明" }));
    expect(nav.getAllByRole("button").slice(0, 2).map((b) => b.textContent)).toEqual(["功能導覽", "這一版新增"]);
    expect(nav.getByRole("group", { name: "快捷鍵" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開始導覽" })).toBeInTheDocument();
    fireEvent.click(nav.getByRole("button", { name: "這一版新增" }));
    expect(region()).toHaveTextContent("這一版沒有要特別介紹的新功能。");
  });
});

describe("What's new", () => {
  beforeEach(() => {
    stubActions([]);
    i18n.addResourceBundle(
      "en",
      "translation",
      {
        helpGuide: {
          whatsNew: {
            items: {
              sample: { title: "Sample feature", desc: "Sample description." },
              adminSample: { title: "Admin-only feature", desc: "Only site admins see this." },
              modSample: { title: "Shortcut feature", desc: "Press {{mod}}/ to open." },
            },
          },
        },
      },
      true,
      false,
    );
  });

  const SAMPLE_REGISTRY = { version: "9.9.9", items: [{ id: "sample" }, { id: "adminSample", adminOnly: true }] };
  const highlightIds = () => Array.from(document.querySelectorAll("[data-highlight-id]")).map((el) => el.getAttribute("data-highlight-id"));
  const highlightEl = (id: string) => {
    const el = document.querySelector(`[data-highlight-id="${id}"]`);
    if (!el) throw new Error(`no highlight ${id}`);
    return el as HTMLElement;
  };

  async function openWhatsNew(options: ContentOptions = {}) {
    renderContent(options);
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    fireEvent.click(navButton("What's new"));
  }

  it("ordinary user: the title carries the registry version and lists only entries not marked adminOnly (name and description both present)", async () => {
    registryState.override = SAMPLE_REGISTRY;
    sessionState.user = { isAdmin: false };
    await openWhatsNew();
    await waitFor(() => expect(heading()).toBe("New in v9.9.9"));
    expect(highlightIds()).toEqual(["sample"]);
    expect(region()).toHaveTextContent("Sample feature");
    expect(region()).toHaveTextContent("Sample description.");
    expect(region()).not.toHaveTextContent("Admin-only feature");
  });

  it("site admin: both entries are listed, in registry order", async () => {
    registryState.override = SAMPLE_REGISTRY;
    sessionState.user = { isAdmin: true };
    await openWhatsNew();
    await waitFor(() => expect(highlightIds()).toEqual(["sample", "adminSample"]));
    expect(heading()).toBe("New in v9.9.9");
  });

  it("signed-in user not yet resolved (loading): treated as an ordinary user first, adminOnly entries are not shown", async () => {
    registryState.override = SAMPLE_REGISTRY;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/ai/actions") return jsonResponse({ actions: [] });
        return new Promise<Response>(() => {});
      }),
    );
    await openWhatsNew();
    expect(highlightIds()).toEqual(["sample"]);
  });

  it("registry has no entries: the left column still has What's new, the page has only that one sentence and no version title", async () => {
    registryState.override = { version: "9.9.9", items: [] };
    await openWhatsNew();
    expect(navButton("What's new")).toHaveAttribute("aria-current", "true");
    expect(region()).toHaveTextContent("Nothing new to highlight in this version.");
    expect(screen.queryByRole("heading", { name: /New in v/ })).toBeNull();
    expect(document.querySelectorAll("[data-highlight-id]")).toHaveLength(0);
    expect(region()).toHaveAccessibleName("What's new");
  });

  it("all entries are adminOnly and the signed-in user is not an admin: likewise only that one sentence and no version title", async () => {
    registryState.override = { version: "9.9.9", items: [{ id: "adminSample", adminOnly: true }] };
    sessionState.user = { isAdmin: false };
    await openWhatsNew();
    expect(region()).toHaveTextContent("Nothing new to highlight in this version.");
    expect(screen.queryByRole("heading", { name: /New in v/ })).toBeNull();
  });

  it("real registry: the title uses the registry version and each entry an ordinary user may see is listed (or the empty-state sentence when there are none)", async () => {
    registryState.override = null;
    sessionState.user = { isAdmin: false };
    await openWhatsNew();
    const visible = RELEASE_HIGHLIGHTS.items.filter((item) => item.adminOnly !== true).map((item) => item.id);
    expect(highlightIds()).toEqual(visible);
    if (visible.length > 0) expect(screen.getByRole("heading", { name: `New in v${RELEASE_HIGHLIGHTS.version}` })).toBeInTheDocument();
    else expect(region()).toHaveTextContent("Nothing new to highlight in this version.");
  });

  it("{{mod}} in an entry description: Mac writes the Command sign, others write Ctrl+", async () => {
    stubPlatform("MacIntel");
    registryState.override = { version: "9.9.9", items: [{ id: "modSample" }] };
    await openWhatsNew();
    await waitFor(() => expect(highlightIds()).toEqual(["modSample"]));
    expect(highlightEl("modSample")).toHaveTextContent("Press ⌘/ to open.");
    expect(highlightEl("modSample")).not.toHaveTextContent("Ctrl");
    expect(highlightEl("modSample")).not.toHaveTextContent("{{");
  });

  it("{{mod}} in an entry description: non-Mac writes Ctrl+", async () => {
    registryState.override = { version: "9.9.9", items: [{ id: "modSample" }] };
    await openWhatsNew();
    await waitFor(() => expect(highlightIds()).toEqual(["modSample"]));
    expect(highlightEl("modSample")).toHaveTextContent("Press Ctrl+/ to open.");
    expect(highlightEl("modSample")).not.toHaveTextContent("{{");
  });

  it("real registry: Traditional Chinese lists the same entries, or the empty-state sentence when there are none", async () => {
    registryState.override = null;
    sessionState.user = { isAdmin: false };
    await i18n.changeLanguage("zh-TW");
    renderContent();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "說明" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("navigation", { name: "說明" })).getByRole("button", { name: "這一版新增" }));
    const visible = RELEASE_HIGHLIGHTS.items.filter((item) => item.adminOnly !== true).map((item) => item.id);
    await waitFor(() => expect(highlightIds()).toEqual(visible));
    const content = document.querySelector('[data-shortcuts-card="content"]');
    if (visible.length > 0) expect(content).not.toHaveTextContent("這一版沒有要特別介紹的新功能。");
    else expect(content).toHaveTextContent("這一版沒有要特別介紹的新功能。");
  });

  it("real registry: each adminOnly entry is invisible to an ordinary user and visible to an admin, the rest are visible to both", async () => {
    const all = RELEASE_HIGHLIGHTS.items;
    const adminOnly = all.filter((item) => item.adminOnly === true).map((item) => item.id);
    const everyone = all.filter((item) => item.adminOnly !== true).map((item) => item.id);

    sessionState.user = { isAdmin: false };
    const normal = renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    fireEvent.click(navButton("What's new"));
    expect(highlightIds()).toEqual(everyone);
    normal.unmount();

    sessionState.user = { isAdmin: true };
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    fireEvent.click(navButton("What's new"));
    await waitFor(() => expect(highlightIds()).toEqual(all.map((item) => item.id)));
    for (const id of adminOnly) expect(highlightIds()).toContain(id);
  });
});

describe("key faces", () => {
  beforeEach(() => stubActions([]));

  it("Win32: the <kbd>s of the search row are Ctrl, K in order; the \"+\" between combo keys is aria-hidden", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    expect(kbdTexts(row("search"))).toEqual(["Ctrl", "K"]);
    const plus = Array.from(row("search").querySelectorAll("span")).filter((el) => el.textContent === "+");
    expect(plus.length).toBeGreaterThan(0);
    for (const el of plus) expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("MacIntel: the first <kbd>'s visible symbol is the Command sign (aria-hidden) and the row has an sr-only Command; Mac's redo row has no Y", async () => {
    stubPlatform("MacIntel");
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    const first = row("search").querySelector("kbd")!;
    expect(first.querySelector('[aria-hidden="true"]')?.textContent).toBe("⌘");
    expect(Array.from(row("search").querySelectorAll(".sr-only")).map((el) => el.textContent)).toContain("Command");
    openCategory("Text formatting");
    expect(kbdTexts(row("redo")).join(" ")).not.toContain("Y");
    expect(kbdTexts(row("redo")).join("")).toContain("Z");
  });

  it("Win32's redo row has both Y and Z ways", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Text formatting");
    const texts = kbdTexts(row("redo"));
    expect(texts).toContain("Y");
    expect(texts.filter((t) => t === "Z")).toHaveLength(1);
  });

  it("typed entry: the `[[` row has one <kbd> whose text is [[; the heading row has # and one Space", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Typing triggers");
    expect(kbdTexts(row("wikilink"))).toEqual(["[["]);
    openCategory("Markdown shortcuts");
    const heading3 = kbdTexts(row("heading"));
    expect(heading3).toContain("#");
    expect(heading3).toContain("Space");
    // All three trigger characters must be followed by a space: only one Space at the end, not one per trigger
    expect(heading3.filter((t) => t === "Space")).toHaveLength(1);
  });

  it("redo row (sep: or): the visible slash is aria-hidden and the row has an sr-only \"or\"", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Text formatting");
    const el = row("redo");
    const slashes = Array.from(el.querySelectorAll("span")).filter((s) => s.textContent === "／");
    expect(slashes.length).toBeGreaterThan(0);
    for (const s of slashes) expect(s.getAttribute("aria-hidden")).toBe("true");
    expect(Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent)).toContain("or");
  });

  it("indent row (sep: pair): the sr-only separator is the pair's symbol and does not contain \"or\"; the description mentions both Tab and Shift Tab", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Text formatting");
    const el = row("indent");
    const sr = Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent);
    expect(sr).not.toContain("or");
    expect(sr).toContain(", ");
    expect(el.textContent).toMatch(/Tab indents/);
    expect(el.textContent).toMatch(/Shift Tab takes the indent back/);
  });

  it("arrow keys: presentNav's symbol is aria-hidden with an sr-only name beside it", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Presentation");
    const el = row("presentNav");
    const sr = Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent);
    for (const name of ["Right arrow", "Left arrow", "Down arrow", "Up arrow"]) expect(sr).toContain(name);
    for (const kbd of Array.from(el.querySelectorAll("kbd"))) expect(kbd.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe("hint sentence", () => {
  it("the hint sentence at the bottom of the left card contains \"to open this page\" and <kbd>/</kbd>; it has no button (the tour entry is on the Feature tour page, not at the bottom)", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(document.querySelector("[data-shortcuts-footer]")).not.toBeNull());
    const footer = document.querySelector<HTMLElement>("[data-shortcuts-footer]")!;
    expect(footer.textContent).toContain("to open this page");
    expect(within(footer).getByText("/", { selector: "kbd" })).toBeTruthy();
    expect(within(footer).queryAllByRole("button")).toHaveLength(0);
    expect(footer.closest("[data-shortcuts-card]")?.getAttribute("data-shortcuts-card")).toBe("items");
  });
});

describe("locale", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("zh-TW: the first item in the left column and the right card title are the localized General", async () => {
    await i18n.changeLanguage("zh-TW");
    stubActions([]);
    renderContent();
    await waitFor(() => expect(navNames()[0]).toBe("通用"));
    expect(heading()).toBe("通用");
  });
});

describe("phone (< 640)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("first stays on the category list; the list's top-left is the shell's back arrow (name and action passed through); choosing a category goes to the content layer where the same position is \"Back to sections\"", async () => {
    stubActions([]);
    stubLayoutTier("phone");
    const onBack = vi.fn();
    renderContent({ listBack: { label: "Back to menu", onBack } });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    const items = document.querySelector<HTMLElement>('[data-shortcuts-card="items"]')!;
    const content = document.querySelector<HTMLElement>('[data-shortcuts-card="content"]')!;
    expect(items.className).toMatch(/(^| )flex( |$)/);
    expect(content.className).toMatch(/(^| )hidden( |$)/);
    const listBack = within(items).getByRole("button", { name: "Back to menu" });
    expect(listBack).toHaveClass("absolute", "left-2", "top-2", "max-sm:after:-inset-2", "max-sm:left-[max(0.5rem,env(safe-area-inset-left))]");
    // On mount focus goes to the visible layer (the list's back arrow), not the hidden content area
    await waitFor(() => expect(listBack).toHaveFocus());
    fireEvent.click(listBack);
    expect(onBack).toHaveBeenCalledTimes(1);

    openCategory("Sidebar");
    await waitFor(() => expect(content.className).toMatch(/(^| )flex( |$)/));
    expect(within(content).getByRole("button", { name: "Back to sections" })).toHaveClass("absolute", "left-2", "top-2", "max-sm:after:-inset-2", "max-sm:left-[max(0.5rem,env(safe-area-inset-left))]");
    expect(within(items).queryByRole("button", { name: "Back to menu" })).toBeNull();
  });

  it("on phones same family as the menu sheet: card popover background with 12px top corners, category rows 48px/16px/adjacent/grey, a chevron at the row end, title 18px with a hairline, entry names 16px", async () => {
    stubActions([]);
    stubLayoutTier("phone");
    renderContent({ listBack: { label: "Back to menu", onBack: vi.fn() } });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    const items = document.querySelector<HTMLElement>('[data-shortcuts-card="items"]')!;
    const content = document.querySelector<HTMLElement>('[data-shortcuts-card="content"]')!;
    for (const card of [items, content]) expect(card).toHaveClass("max-sm:bg-popover", "max-sm:rounded-t-xl");
    const rows = Array.from(items.querySelectorAll<HTMLElement>("[data-shortcuts-category]"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveClass("max-sm:min-h-12", "max-sm:text-base", "max-sm:font-normal", "max-sm:rounded-sm", "max-sm:hover:bg-accent", "max-sm:-mx-2", "max-sm:px-2");
      // `w-full` would make the negative margin only push the row left: on phones it goes back to auto width so the row extends 8px on each side
      expect(row).toHaveClass("w-full", "max-sm:w-auto");
      expect(row.querySelector("svg")).toHaveClass("sm:hidden", "ml-auto");
      expect(row.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    // the current category has no persistent brand color
    const current = rows.find((row) => row.getAttribute("aria-current") === "true")!;
    expect(current).toHaveClass("max-sm:bg-transparent");
    expect(items.querySelector("nav")).toHaveClass("max-sm:gap-0", "max-sm:min-h-0", "max-sm:flex-1", "max-sm:overflow-y-auto", "max-sm:-mx-2", "max-sm:px-2");
    const title = within(items).getByText("Help");
    expect(title).toHaveClass("max-sm:text-lg", "font-semibold");
    expect(title.parentElement).toHaveClass("max-sm:border-b", "max-sm:border-border", "max-sm:h-12");
    // Content layer: title 18px, same height as the back arrow; entry names 16px, description stays 14px grey
    const heading = content.querySelector("h3")!;
    expect(heading).toHaveClass("max-sm:text-lg", "max-sm:min-h-12", "max-sm:items-center", "max-sm:pl-10", "max-sm:-mt-12");
    expect(content.querySelector("[data-shortcuts-content]")).toHaveClass("pt-12", "max-sm:pt-16");
    const entry = content.querySelector("li")!;
    expect(entry.querySelector("p.font-medium")).toHaveClass("max-sm:text-base");
    expect(entry.querySelector("p.text-muted-foreground")).toHaveClass("text-sm");
    expect(entry.querySelector("p.text-muted-foreground")!.className).not.toMatch(/max-sm:text-/);
    expect(content.querySelector("ul")).toHaveClass("divide-y");
    for (const back of [within(items).getByRole("button", { name: "Back to menu" }), within(content).getByRole("button", { name: "Back to sections", hidden: true })]) {
      expect(back).toHaveClass("max-sm:top-[26px]", "max-sm:bg-popover");
    }
  });
});
