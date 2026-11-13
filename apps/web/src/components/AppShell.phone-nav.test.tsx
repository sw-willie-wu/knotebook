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

// 手機的「回清單」：清單那一格的 history 序號、退回或換掉、進筆記的轉場、回清單後的焦點落點。

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
      <button type="button" onClick={() => navigate("/")}>
        go-home
      </button>
      <button type="button" onClick={() => navigate(1)}>
        go-forward
      </button>
    </div>
  );
}

/** 與 `App.tsx` 的 `AppRoutes` 同形：真實 location／navigationType 放 `RealLocationContext`，內層 `<Routes location>` 讓子樹的 `useNavigationType()` 恆為 POP。 */
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
  // 真瀏覽器在導覽時已先把 history 序號加一。
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

describe("AppShell — 手機回清單", () => {
  it("清單可見時記下這一格的 history 序號；筆記路由不記", async () => {
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

  it("寬度不是手機時不記序號", async () => {
    historyIdx = 2;
    renderAt("/", "overlay");
    await screen.findByTestId("location");
    expect(sessionStorage.getItem("nav.listIdx")).toBeNull();
  });

  it("清單那格在較前面：「‹」退回去（POP），不新增 history", async () => {
    historyIdx = 2;
    const { container } = renderAt("/");
    await openNoteFromRow(container);
    historyIdx = 3;
    expect(screen.getByTestId("location")).toHaveTextContent(NOTE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId("type")).toHaveTextContent("POP");
  });

  it("沒有清單序號（直接開筆記）：「‹」把這一格換成清單（REPLACE），不是 push", () => {
    historyIdx = 0;
    renderAt(NOTE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.getByTestId("type")).toHaveTextContent("REPLACE");
  });

  it("過期的清單序號（目前這格不在它之後）在非清單畫面被清掉", () => {
    sessionStorage.setItem("nav.listIdx", "5");
    historyIdx = 0;
    renderAt(NOTE_PATH);
    expect(sessionStorage.getItem("nav.listIdx")).toBeNull();
  });

  it("連點「‹」：第一下生效前第二下不再多退一格", () => {
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

  it("清單序號不小於目前序號（記錄過期）：換掉而不是退", () => {
    sessionStorage.setItem("nav.listIdx", "5");
    historyIdx = 5;
    renderAt(NOTE_PATH);
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    expect(screen.getByTestId("type")).toHaveTextContent("REPLACE");
  });
});

describe("AppShell — 進筆記的轉場", () => {
  const ENTER = "kb-phone-enter";

  it("手機：從清單 PUSH 進筆記 → 內容區加一次轉場 class", async () => {
    const { container } = renderAt("/");
    await openNoteFromRow(container);
    expect(container.querySelector("main")).toHaveClass(ENTER);
  });

  it("深連結直接開筆記 → 不加", () => {
    const { container } = renderAt(NOTE_PATH);
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("POP（回清單再下一頁回筆記）→ 不加", async () => {
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

  it("正式的路由形（真實 navigationType 在 RealLocationContext、子樹的 useNavigationType 恆為 POP）：PUSH 加、POP 不加", async () => {
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

  it("筆記 → 另一篇筆記的 PUSH 不播轉場", async () => {
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    expect(container.querySelector("main")).toHaveClass(ENTER);
    fireEvent.click(screen.getByRole("button", { name: "go-other-note" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/other-note");
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("非手機寬度：PUSH 進筆記也不加", async () => {
    const { container } = renderAt("/", "overlay");
    await screen.findByTestId("location");
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    expect(container.querySelector("main")).not.toHaveClass(ENTER);
  });

  it("index.css：轉場 class 存在，且 prefers-reduced-motion 區塊把它關掉", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(`.${ENTER}`);
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
    const off = blocks.find((block) => block.includes(`.${ENTER}`));
    expect(off, "reduced-motion 區塊沒有處理轉場 class").toBeDefined();
    expect(off).toMatch(/animation:\s*none/);
  });
});

describe("AppShell — 回清單後的焦點", () => {
  it("點清單列進筆記、按「‹」回來：焦點回到那一列", async () => {
    historyIdx = 1;
    const { container } = renderAt("/");
    const row = await openNoteFromRow(container);
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await act(async () => {});
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(document.activeElement).toBe(row);
  });

  it("不是從列進筆記（找不到列）：焦點落在 tabpanel", async () => {
    historyIdx = 1;
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("button", { name: "go-note" }));
    historyIdx = 2;
    fireEvent.click(screen.getByRole("button", { name: "Back to notes" }));
    await act(async () => {});
    expect(document.activeElement).toBe(within(aside(container)).getByRole("tabpanel"));
  });

  it("手機段內清單仍在、只是跨 640 的寬度變化：不搶焦點", async () => {
    const tier = stubLayoutTier("overlay");
    const { container } = renderAt("/", "overlay");
    await screen.findByTestId("location");
    act(() => tier.setLayoutTier("phone"));
    await screen.findByRole("tablist");
    await act(async () => {});
    expect(aside(container).contains(document.activeElement)).toBe(false);
  });

  it("非手機寬度：筆記 → 清單不搶焦點", async () => {
    const { container } = renderAt(NOTE_PATH, "overlay");
    fireEvent.click(screen.getByRole("button", { name: "go-home" }));
    await act(async () => {});
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(aside(container).contains(document.activeElement)).toBe(false);
  });

  it("有對話框開著時回清單不搶焦點", async () => {
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

  it("首次載入清單不搶焦點", async () => {
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    await act(async () => {});
    expect(aside(container).contains(document.activeElement)).toBe(false);
  });
});
