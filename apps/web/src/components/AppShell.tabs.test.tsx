import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useSidebarTabActions, type SidebarTabActions } from "@/lib/sidebar-tab";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";

// 側欄 tab 與 AppShell 的接線（plan T2）。骨架抄 AppShell.test.tsx 的「#115 側欄抽屜」describe。

// `sidebar.tab` 會往外流到同檔後面的案，檔案頂層清（plan I3）。
afterEach(() => {
  localStorage.clear();
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
  id: "66666666-6666-6666-6666-666666666666",
  title: "Tab Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "tab-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
};

const CREATED: NoteDto = {
  ...NOTE,
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  slug: "untitled-33333333",
};

function stubFetchWithNotes(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/notes" && method === "POST") return Promise.resolve(fakeResponse(CREATED, 201));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 可控 matchMedia stub（同 AppShell.test.tsx）。 */
function stubControllableMatchMedia(initialMatches: boolean) {
  const mql = {
    matches: initialMatches,
    media: "(width < 48rem)",
    addEventListener: () => {},
    removeEventListener: () => {},
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
}

function NoteRouteProbe() {
  const { handle, slug } = useParams<{ handle: string; slug: string }>();
  return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
}

function renderShell(children: ReactNode = <SidebarDrawerButton />) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="/" element={<AppShell>{children}</AppShell>} />
              <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;

describe("AppShell — 側欄 tab 接線", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AS1：tabpanel 的 aria-labelledby 指向選中那顆 tab，切 tab 後跟著變", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    await screen.findByRole("tab", { name: "My notes" });

    const panel = within(aside()).getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", within(aside()).getByRole("tab", { name: "My notes" }).id);

    fireEvent.click(within(aside()).getByRole("tab", { name: "Workspace" }));
    expect(within(aside()).getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      within(aside()).getByRole("tab", { name: "Workspace" }).id,
    );
  });

  it("AS2 兩份共用：抽屜裡切 tab，靜態卡跟著；關抽屜後仍在", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Workspace" }));

    expect(within(drawer).getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
    // 抽屜開著時 Radix 把背景標 aria-hidden，靜態卡要 hidden:true 才查得到。
    expect(within(aside()).getByRole("tab", { name: "Workspace", hidden: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
    expect(within(aside()).getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
  });

  it("AS3 useId 不撞：兩份實例的 aria-controls 不同、各落在自己的容器、整份 DOM 的 id 唯一", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    const staticControls = within(aside())
      .getByRole("tab", { name: "My notes", hidden: true })
      .getAttribute("aria-controls")!;
    const drawerControls = within(drawer).getByRole("tab", { name: "My notes" }).getAttribute("aria-controls")!;
    expect(staticControls).not.toBe(drawerControls);
    expect(aside().contains(document.getElementById(staticControls))).toBe(true);
    expect(drawer.contains(document.getElementById(drawerControls))).toBe(true);

    const ids = [...document.querySelectorAll("[role=tab], [role=tabpanel]")].map((el) => el.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("AS4 不重繪 children：切 tab、搜尋框打字都不讓只消費 actions 的子樹重跑", async () => {
    stubFetchWithNotes([NOTE]);
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return <div>counter</div>;
    });
    renderShell(<Counter />);
    await screen.findAllByRole("link", { name: "Tab Note" });
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);

    for (const name of ["Workspace", "Shared with me", "Recent"]) {
      fireEvent.click(within(aside()).getByRole("tab", { name }));
    }
    // 搜尋輸入這兩行守的是 plan 讀碼發現 3：抽屜 context 每次 render 換新物件時，`showTab` 不可依賴 drawer（依賴它就會讓 actions 捛物件、Counter 重跑）。
    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "tab" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("AS5 showTab 在窄螢幕開抽屜、寬螢幕不開", async () => {
    function ShowShared() {
      const { showTab } = useSidebarTabActions();
      return (
        <button type="button" onClick={() => showTab("shared")}>
          go shared
        </button>
      );
    }

    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    const narrow = renderShell(<ShowShared />);
    fireEvent.click(await screen.findByRole("button", { name: "go shared" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
    narrow.unmount();
    localStorage.clear();

    stubControllableMatchMedia(false);
    renderShell(<ShowShared />);
    fireEvent.click(await screen.findByRole("button", { name: "go shared" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    expect(within(aside()).getByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
  });

  it("AS6 重掛帶回：AppShell 卸載重掛後仍是同一個 tab", async () => {
    stubFetchWithNotes([NOTE]);
    const first = renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Shared with me" }));
    first.unmount();

    renderShell();
    expect(await screen.findByRole("tab", { name: "Shared with me" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "false");
  });

  it("AS7 建筆記不切 tab（spec §5.3）", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Recent" }));
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    await waitFor(() => expect(screen.getByTestId("note-route")).toBeInTheDocument());
    await act(async () => {});
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");
  });
});
