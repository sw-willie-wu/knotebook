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

// 手機（< 640）的清單畫面：`/` 與非筆記路由時側欄滿版、筆記路由時藏起來並 inert；頂列、只有圖示的 tab 列、底部列與全螢幕搜尋。

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

/** 側欄的 `<aside>`：筆記路由時它 inert＋隱藏，role 查詢要帶 `hidden: true`。 */
function aside(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>("aside[data-sidebar-instance]");
  if (node === null) throw new Error("aside missing");
  return node;
}

const BAR = "[data-phone-list-bar]";

describe("AppShell — 手機清單畫面", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubLayoutTier("phone");
  });

  it("PH1 `/`：側欄滿版（fixed inset-0、沒有圓角與框）、沒有 inert、沒有拖曳把手", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const node = aside(container);
    await screen.findByRole("tablist");
    expect(node).not.toHaveAttribute("inert");
    for (const name of ["max-sm:fixed", "max-sm:inset-0", "max-sm:flex", "max-sm:rounded-none", "max-sm:border-0"]) {
      expect(node).toHaveClass(name);
    }
    expect(within(node).queryByRole("separator")).toBeNull();
    expect(node.style.width).toBe("");
  });

  it("PH2 筆記路由：側欄仍在 DOM（不卸載）但 inert", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    const node = aside(container);
    expect(node).toHaveAttribute("inert");
    expect(node).toHaveClass("hidden");
  });

  it("PH3 非筆記路由（/groups/…）仍是清單：側欄不 inert、套滿版 class", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/groups/g1");
    const node = aside(container);
    expect(node).not.toHaveAttribute("inert");
    expect(node).toHaveClass("max-sm:fixed", "max-sm:inset-0");
  });

  it("PH4 頂列：頭像鈕開使用者選單、選單有 Settings；中間是 Knotebook 字標；沒有選單列的名字文字", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const trigger = await within(aside(container)).findByRole("button", { name: "Ann" });
    expect(trigger).toHaveClass("h-11", "w-11");
    expect(trigger.textContent).toBe("A");
    expect(within(aside(container)).getByText("Knotebook")).toBeInTheDocument();
    fireEvent.pointerDown(trigger, { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
  });

  it("PH5 頂列高 48＋上緣 safe area；底部沒有使用者列（那顆鈕只有頂列一顆）", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await within(aside(container)).findByRole("button", { name: "Ann" });
    expect(within(aside(container)).getAllByRole("button", { name: "Ann" })).toHaveLength(1);
    const top = container.querySelector("[data-phone-top-bar]");
    expect(top?.className).toContain("env(safe-area-inset-top)");
    expect(top?.firstElementChild).toHaveClass("h-12");
  });

  it("PH6 tab 列：每個 tab 一顆、只有圖示（沒有文字）、h-11、不橫捲", async () => {
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

  it("PH7 底部列：搜尋框 h-11＋text-base、右側 New note；頂端沒有第二個搜尋框、沒有 Ctrl K 徽章", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    const inputs = screen.getAllByRole("textbox", { name: "Search notes" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveClass("h-11", "text-base");
    expect(inputs[0].className).not.toContain("text-[13px]");
    expect(screen.queryByText("Ctrl K")).toBeNull();
    const bar = container.querySelector(BAR) as HTMLElement;
    expect(bar).toContainElement(inputs[0]);
    expect(within(bar).getByRole("button", { name: "New note" })).toBeInTheDocument();
    // 底部列在 tablist 之後（清單畫面最底）。
    expect(screen.getByRole("tablist").compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("PH8 按 New note：建個人筆記並導向", async () => {
    const created = stubFetch([NOTE]);
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "New note" }));
    await waitFor(() => expect(created).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/untitled-99999999"));
  });

  it("PH9 聚焦搜尋框：tab 列與清單換成搜尋層（空字顯示提示）、Cancel 取代 New note", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    fireEvent.focus(input);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByTestId("phone-search-hint")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("PH10 打字出結果；按 Cancel 清空、離開搜尋層回到 tab 列與 New note", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    input.focus();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    expect(await within(results).findByRole("link", { name: /^Alpha Note/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(input).toHaveValue("");
    await screen.findByRole("tablist");
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("PH11 失焦不關搜尋層（有字、沒字都一樣）；Esc 才關並清空", async () => {
    stubFetch([NOTE]);
    renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
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
    expect(input).toHaveValue("");
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
  });

  it("PH12 跨到 640 以上：搜尋層收起，回到手機後不會自己又開著", async () => {
    stubFetch([NOTE]);
    const tier = stubLayoutTier("phone");
    renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    expect(screen.queryByRole("tablist")).toBeNull();

    act(() => tier.setLayoutTier("overlay"));
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
    act(() => tier.setLayoutTier("phone"));
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("phone-search-hint")).toBeNull();
  });

  it("PH13 選取模式：底部列換成選取動作列", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const panel = await screen.findByRole("tabpanel");
    fireEvent.click(await within(panel).findByRole("button", { name: "Select" }));
    await within(aside(container)).findByText("0 selected");
    await waitFor(() => expect(container.querySelector("[data-select-action-bar]")).not.toBeNull());
    expect(container.querySelector(BAR)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search notes" })).toBeNull();
  });

  it("PH14 垃圾桶 tab：沒有 New note、搜尋框還在、保留天數說明在底部列上方", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    fireEvent.click(await screen.findByRole("tab", { name: "Trash" }));
    const footer = await screen.findByTestId("trash-footer");
    const bar = container.querySelector(BAR) as HTMLElement;
    expect(within(bar).queryByRole("button", { name: "New note" })).toBeNull();
    expect(within(bar).getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
    expect(footer.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("PH15 清單捲動容器帶 overscroll-y-contain（Android 獨立視窗下拉不誤重整）", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    await screen.findByRole("tablist");
    expect(container.querySelector("[data-sidebar-list]")).toHaveClass("overscroll-y-contain");
  });

  it("PH16 Ctrl+K 在筆記路由：回清單並聚焦底部搜尋框；在清單上：直接聚焦、preventDefault", async () => {
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

  it("PH18 選取模式下 Ctrl+K：先結束選取、底部搜尋框回來並取得焦點", async () => {
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

  it("PH19 筆記路由上搜尋層開著：側欄滿版蓋住筆記、不 inert；有字時失焦（收鍵盤、點結果前的 blur）仍留著、結果看得到", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    const node = aside(container);
    const input = within(node).getByRole("textbox", { name: "Search notes", hidden: true });
    expect(node).toHaveAttribute("inert");
    fireEvent.focus(input);
    expect(node).not.toHaveAttribute("inert");
    expect(node).toHaveClass("max-sm:fixed", "max-sm:inset-0");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.blur(input);
    expect(node).not.toHaveAttribute("inert");
    const results = await screen.findByTestId("sidebar-search");
    expect(await within(results).findByRole("link", { name: /^Alpha Note/ })).toBeInTheDocument();
  });

  it("PH21 清單上聚焦、打字、點結果（沒有 blur）：進入筆記路由後搜尋層關、側欄藏起來並 inert", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    fireEvent.click(await within(results).findByRole("link", { name: /^Alpha Note/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note"));
    const node = aside(container);
    await waitFor(() => expect(node).toHaveAttribute("inert"));
    expect(node).not.toHaveClass("max-sm:fixed");
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel", hidden: true })).toBeNull();
  });

  it("PH20 浮動段開著的抽屜：窄到手機時關掉（不留舊抽屜與遮罩蓋住滿版清單）", async () => {
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

  it("PH17 手機點 tab：不開抽屜；在筆記路由點 tab 會回清單", async () => {
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    const tab = within(aside(container)).getByRole("tab", { name: "Groups", hidden: true });
    fireEvent.click(tab);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(document.querySelector("[data-sidebar-drawer]")).toBeNull();
  });
});

describe("AppShell — 手機以外維持原樣", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  it.each(["docked", "overlay"] as const)("PN1 %s：頂端搜尋框（13px、Ctrl K 徽章）、底部使用者列、沒有底部列與頭像形", async (tier) => {
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

  it("PN2 固定段下聚焦搜尋框不進搜尋層（tab 列還在）", async () => {
    stubLayoutTier("docked");
    stubFetch([NOTE]);
    renderAt("/");
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  it("PN3 浮動段在筆記路由：側欄 aside 沒有 inert（抽屜流程不受手機規則影響）", async () => {
    stubLayoutTier("overlay");
    stubFetch([NOTE]);
    const { container } = renderAt("/n/tester/alpha-note");
    expect(aside(container)).not.toHaveAttribute("inert");
  });
});

describe("AppShell — 手機筆記頁的瀏覽列", () => {
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

  it("搜尋框按鈕：搜尋層蓋在筆記上（網址不變、側欄不 inert、搜尋框取得焦點）；Cancel 回到同一篇", async () => {
    stubFetch([NOTE]);
    // jsdom 不看 CSS：模擬瀏覽器「藏起來（inert）的元素聚焦不了」，才分得出是不是真的先把搜尋層開起來再聚焦。
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
    expect(node).toHaveClass("max-sm:fixed", "max-sm:inset-0");
    const input = within(node).getByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");

    // 筆記在搜尋層後面：不可達。
    expect(container.querySelector("main")).toHaveAttribute("inert");

    fireEvent.click(within(node).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(node).toHaveAttribute("inert"));
    expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/alpha-note");
    expect(container.querySelector("main")).not.toHaveAttribute("inert");
    // 焦點回到瀏覽列的搜尋鈕。
    await waitFor(() => expect(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "Search notes" })).toHaveFocus());
  });

  it("搜尋層開在筆記上時按系統返回：回到清單，搜尋層已關、搜尋框沒有焦點", async () => {
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

  it("搜尋層開在筆記上時按 Ctrl+K：直接聚焦搜尋框，不回清單", async () => {
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

  it("開著搜尋層的筆記路由上，點結果換到另一篇：搜尋層關掉、側欄藏起來", async () => {
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
    expect(node).not.toHaveClass("max-sm:fixed");
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
  });

  it("開著搜尋層時點的結果就是目前這篇：搜尋層也關掉", async () => {
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

  it("同一篇換網址（改名後的 canonical 收斂）不算換頁：搜尋層留著", async () => {
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

  it("「New note」建立並導向新筆記（同一個 createNote 流程）", async () => {
    const created = stubFetch([NOTE]);
    renderNote();
    fireEvent.click(within(screen.getByTestId("note-browse-bar")).getByRole("button", { name: "New note" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/untitled-99999999"));
    expect(created).toHaveLength(1);
  });
});
