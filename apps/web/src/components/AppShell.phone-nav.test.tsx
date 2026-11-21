import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { RealLocationContext } from "@/lib/real-location";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { trashList } from "@/test/trash-fixtures";
import type { ReactNode } from "react";
import { AppShell } from "./AppShell";
import { BackToListButton } from "./BackToListButton";


const NOTE_PATH = "/n/tester/alpha-note";

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

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/folders") return Promise.resolve(fakeResponse(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([NOTE]));
      if (url === "/api/trash") return Promise.resolve(fakeResponse(trashList([], { retentionDays: 7 })));
      if (url === "/api/favorites") return Promise.resolve(fakeResponse([]));
      if (url.startsWith("/api/search?")) return Promise.resolve(fakeResponse({ hits: [], nextCursor: null }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

let historyIdx: number | null = null;

function Probe() {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="type">{type}</div>
      <BackToListButton />
      <button type="button" onClick={() => navigate(NOTE_PATH)}>
        go-note
      </button>
      <button type="button" onClick={() => navigate("/n/tester/other-note")}>
        go-other-note
      </button>
      <button type="button" onClick={() => navigate("/knowledge/f/folder-1")}>
        go-index
      </button>
      <button type="button" onClick={() => navigate("/")}>
        go-home
      </button>
      <button type="button" onClick={() => navigate(1)}>
        go-forward
      </button>
    </div>
  );
}

/** Same shape as `AppRoutes` in `App.tsx`: the real location/navigationType live in `RealLocationContext`; the inner `<Routes location>` makes the subtree's `useNavigationType()` always POP. */
function RealRouterBridge({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const value = useMemo(() => ({ location, navigationType }), [location, navigationType]);
  return (
    <RealLocationContext.Provider value={value}>
      <Routes location={location}>
        <Route path="*" element={children} />
      </Routes>
    </RealLocationContext.Provider>
  );
}

function renderAt(path: string, tier: LayoutTier = "phone", bridge = false) {
  stubLayoutTier(tier);
  const shell = (
    <AppShell>
      <Probe />
    </AppShell>
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <ActiveNoteProvider>
            {bridge ? (
              <RealRouterBridge>{shell}</RealRouterBridge>
            ) : (
              <Routes>
                <Route path="*" element={shell} />
              </Routes>
            )}
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function aside(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>("aside[data-sidebar-instance]");
  if (node === null) throw new Error("aside missing");
  return node;
}

async function openNoteFromRow(container: HTMLElement): Promise<HTMLElement> {
  const row = await within(aside(container)).findByRole("link", { name: /Alpha Note/ });
  // A real browser has already bumped the history index by navigation time.
  if (historyIdx !== null) historyIdx += 1;
  fireEvent.click(row);
  return row;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  dismissAllToasts();
  stubFetch();
  historyIdx = null;
  Object.defineProperty(window.history, "state", {
    configurable: true,
    get: () => (historyIdx === null ? null : { idx: historyIdx }),
  });
});

afterEach(() => {
  delete (window.history as unknown as Record<string, unknown>).state;
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("AppShell - phone back to list", () => {
  it("records this entry's history index while the list is visible; note routes don't", async () => {
    historyIdx = 2;
    const { unmount } = renderAt("/");
    await screen.findByRole("tablist");
    expect(sessionStorage.getItem("nav.listIdx")).toBe("2");
    unmount();
    sessionStorage.clear();
    renderAt(NOTE_PATH);
    await screen.findByTestId("location");
    expect(sessionStorage.getItem("nav.listIdx")).toBeNull();
  });

  it("no index recorded when the width is not phone", async () => {
    historyIdx = 2;
    renderAt("/", "overlay");
    await screen.findByTestId("location");
    expect(sessionStorage.getItem("nav.listIdx")).toBeNull();
  });

  it("list entry is earlier: the back button steps back (POP) without adding history", async () => {
    historyIdx = 2;
    const { container } = renderAt("/");
    await openNoteFromRow(container);
    historyIdx = 3;
    expect(screen.getByTestId("location")).toHaveTextContent(NOTE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId("type")).toHaveTextContent("POP");
  });

  it("no list index (note opened directly): the back button replaces this entry with the list (REPLACE), not a push", () => {
    historyIdx = 0;
    renderAt(NOTE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId("type")).toHaveTextContent("REPLACE");
  });

  it("a stale list index (current entry is not after it) is cleared on a non-list screen", () => {
    sessionStorage.setItem("nav.listIdx", "5");
    historyIdx = 0;
    renderAt(NOTE_PATH);
    expect(sessionStorage.getItem("nav.listIdx")).toBeNull();
  });

  it("double-tapping the back button: the second tap doesn't step back again before the first takes effect", () => {
    stubLayoutTier("phone");
    sessionStorage.setItem("nav.listIdx", "1");
    historyIdx = 2;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/groups/g1", "/", NOTE_PATH]} initialIndex={2}>
            <ActiveNoteProvider>
              <Routes>
                <Route
                  path="*"
                  element={
                    <AppShell>
                      <Probe />
                    </AppShell>
                  }
                />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const back = screen.getByRole("button", { name: "Back to notes" });
    act(() => {
      back.click();
      back.click();
    });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });

  it("list index not smaller than the current index (stale record): replace instead of stepping back", () => {
    sessionStorage.setItem("nav.listIdx", "5");
    historyIdx = 5;
    renderAt(NOTE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("type")).toHaveTextContent("REPLACE");
  });
});

describe("AppShell - phone knowledge index route", () => {
  const INDEX_PATH = "/knowledge/f/folder-1";

  it("an index route is a page, not the list: no list index is recorded and the back button replaces it with the list", () => {
    historyIdx = 0;
    renderAt(INDEX_PATH);
    expect(sessionStorage.getItem("nav.listIdx")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId("type")).toHaveTextContent("REPLACE");
  });

  it("with the list entry earlier, the back button steps back to it", async () => {
    historyIdx = 2;
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    historyIdx = 3;
    fireEvent.click(within(container).getByRole("button", { name: "go-index" }));
    expect(screen.getByTestId("location")).toHaveTextContent(INDEX_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId("type")).toHaveTextContent("POP");
  });
});

describe("AppShell - transition into a note", () => {
  const ENTER = "kb-phone-enter";

  it("phone: PUSH from the list into a note -> content area gets the transition class once", async () => {
    const { container } = renderAt("/");
    await openNoteFromRow(container);
    expect(container.querySelector("main")).toHaveClass(ENTER);
  });

  it("deep link opening a note -> no transition class", () => {
    const { container } = renderAt(NOTE_PATH);
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("POP (back to list, then forward to the note) -> no transition class", async () => {
    historyIdx = 1;
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    expect(container.querySelector("main")).toHaveClass(ENTER);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    historyIdx = 1;
    expect(screen.getByTestId("type")).toHaveTextContent("POP");
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "go-forward" }));
    expect(screen.getByTestId("location")).toHaveTextContent(NOTE_PATH);
    expect(screen.getByTestId("type")).toHaveTextContent("POP");
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("production routing shape (real navigationType in RealLocationContext, subtree's useNavigationType always POP): PUSH adds the class, POP doesn't", async () => {
    historyIdx = 1;
    const { container } = renderAt("/", "phone", true);
    await screen.findByRole("tablist");
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    expect(container.querySelector("main")).toHaveClass(ENTER);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    historyIdx = 1;
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "go-forward" }));
    expect(screen.getByTestId("location")).toHaveTextContent(NOTE_PATH);
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("PUSH from one note to another plays no transition", async () => {
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    expect(container.querySelector("main")).toHaveClass(ENTER);
    fireEvent.click(screen.getByRole("button", { name: "go-other-note" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/other-note");
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("non-phone width: PUSH into a note doesn't add it either", async () => {
    const { container } = renderAt("/", "overlay");
    await screen.findByTestId("location");
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("index.css: the transition class exists and the prefers-reduced-motion block turns it off", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(`.${ENTER}`);
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
    const off = blocks.find((block) => block.includes(`.${ENTER}`));
    expect(off, "reduced-motion 區塊沒有處理轉場 class").toBeDefined();
    expect(off).toMatch(/animation:\s*none/);
  });
});

describe("AppShell - focus after returning to the list", () => {
  it("opening a note from a list row, then pressing the back button: focus returns to that row", async () => {
    historyIdx = 1;
    const { container } = renderAt("/");
    const row = await openNoteFromRow(container);
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await act(async () => {});
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(document.activeElement).toBe(row);
  });

  it("note not opened from a row (row not found): focus lands on the tabpanel", async () => {
    historyIdx = 1;
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await act(async () => {});
    expect(document.activeElement).toBe(within(aside(container)).getByRole("tabpanel"));
  });

  it("list still present within the phone tier, only the width changes across 640: focus isn't stolen", async () => {
    const tier = stubLayoutTier("overlay");
    const { container } = renderAt("/", "overlay");
    await screen.findByTestId("location");
    act(() => tier.setLayoutTier("phone"));
    await screen.findByRole("tablist");
    await act(async () => {});
    expect(aside(container).contains(document.activeElement)).toBe(false);
  });

  it("non-phone width: note -> list doesn't steal focus", async () => {
    const { container } = renderAt(NOTE_PATH, "overlay");
    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    await act(async () => {});
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(aside(container).contains(document.activeElement)).toBe(false);
  });

  it("returning to the list with a dialog open doesn't steal focus", async () => {
    historyIdx = 1;
    const { container } = renderAt("/");
    await openNoteFromRow(container);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await act(async () => {});
    expect(aside(container).contains(document.activeElement)).toBe(false);
    dialog.remove();
  });

  it("first load of the list doesn't steal focus", async () => {
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    await act(async () => {});
    expect(aside(container).contains(document.activeElement)).toBe(false);
  });
});
