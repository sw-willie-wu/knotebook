import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { NoteDto, TrashItemDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useSidebarTabActions, useSidebarTabState, type SidebarTabActions } from "@/lib/sidebar-tab";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";
import { trashItem, trashList } from "@/test/trash-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { clickOutside } from "@/test/outside-click";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

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
  folderId: null,
  permissions: OWNER_PERMS,
};

const CREATED: NoteDto = {
  ...NOTE,
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  slug: "untitled-33333333",
};

function stubFetchWithNotes(notes: NoteDto[], trash: TrashItemDto[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/notes" && method === "POST") return Promise.resolve(fakeResponse(CREATED, 201));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(notes));
      if (url === "/api/trash" && method === "GET") return Promise.resolve(fakeResponse(trashList(trash)));
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
    expect(ids).toHaveLength(12);
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

  it("AS8 零筆記零群組：tablist 照常在、我的筆記選中、面板內是 EmptyState 兩句", async () => {
    stubFetchWithNotes([]);
    renderShell();
    const tablist = await within(aside()).findByRole("tablist");
    expect(tablist).toBeInTheDocument();
    expect(within(aside()).getByRole("tab", { name: "My notes" })).toHaveAttribute("aria-selected", "true");
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("No notes yet.")).toBeInTheDocument();
    expect(within(panel).getByText("Create your first note to get started.")).toBeInTheDocument();
  });

  it("AS9 tabpanel 可聚焦（tabindex=0＋focus-visible ring）：沒有可聚焦內容的面板（最近空）Tab 也能停在面板上", async () => {
    stubFetchWithNotes([]);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Recent" }));
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("No notes yet.")).toBeInTheDocument();
    // 面板內沒有任何可聚焦元素（PR-2c 起標題列有「Select」，0 篇時 disabled、不可聚焦）。
    expect(panel.querySelector("a, button:not(:disabled), input, [tabindex]")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Select" })).toBeDisabled();
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(panel).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring");
    panel.focus();
    expect(panel).toHaveFocus();

    // 切 tab 後換成新的 tabpanel 屬性仍在（同一個元素跟著 tab 更新）。
    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
  });

  it("AS10 開始搜尋結束選取（spec §6.10.2）：靜態搜尋框打字 → 選取結束；清空搜尋後仍不在選取", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell(<SelectionProbe />);
    fireEvent.click(await screen.findByTestId("start-select"));
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
    // PR-2c：我的筆記 tab 真的換成 lazy 的選取標題列與勾選樹，等它到（不然 Suspense 在斷言之後才 resolve）。
    await within(aside()).findByText("0 selected");

    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "tab" } });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
  });

  it("AS11 抽屜 Esc 先結束選取：第一次 Esc 抽屜仍在、選取結束；第二次 Esc 才關抽屜", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell(
      <>
        <SidebarDrawerButton />
        <SelectionProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(screen.getByTestId("start-select"));
    expect(screen.getByTestId("selecting")).toHaveTextContent("true");
    // 靜態 <aside> 那份也在 DOM，等待圈定在抽屜內。
    await within(drawer).findByText("0 selected");

    // 本案同時經過抽屜 Radix 的 Esc（document capture，flushSync 結束選取並 preventDefault）與 `SelectHeader` 的 document
    // bubble 監聽：後者看到 defaultPrevented（而且已隨選取結束卸載）不動作；靜態卡那份在窄螢幕也因看不見不動作（plan 讀碼發現 20）。
    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");

    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("AS12 抽屜 Esc 平常照關（沒有選取時）", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell(
      <>
        <SidebarDrawerButton />
        <SelectionProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(screen.getByTestId("selecting")).toHaveTextContent("false");
    fireEvent.keyDown(document.activeElement ?? drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("AS13 垃圾桶 tab：tabpanel 換成 TrashPanel、底部換成保留天數說明；切回我的筆記 New note 回來", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    const panel = within(aside()).getByRole("tabpanel");
    expect(await within(panel).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(panel.querySelector("[data-sidebar-header]")).toHaveTextContent("Trash · 0 notes");
    expect(within(panel).queryByRole("button", { name: "New personal note" })).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(await within(aside()).findByTestId("trash-footer")).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(aside()).queryByTestId("trash-footer")).toBeNull();
    expect(within(within(aside()).getByRole("tabpanel")).getByRole("button", { name: "New personal note" })).toBeInTheDocument();
  });

  it("SM11 選取兩份共用：抽屜內進選取、勾 p1 → 靜態卡那份也勾、標題 1 selected", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(drawer.querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(drawer, "p1")!);

    expect(trashBox(drawer, "p1")).toBeChecked();
    expect(trashBox(aside(), "p1")).toBeChecked();
    expect(trashBox(aside(), "p2")).not.toBeChecked();
    expect(within(trashHeader(aside())).getByText("1 selected", { exact: true })).toBeInTheDocument();
  });

  it("SM13 勾選不重繪 children（spec §5.10）：進垃圾桶、Select、勾三篇、Done，只消費 actions 的子樹不重跑", async () => {
    stubFetchWithNotes([NOTE], TRASH);
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

    fireEvent.click(within(aside()).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="w1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    for (const id of ["p1", "p2", "w1"]) fireEvent.click(trashBox(aside(), id)!);
    expect(within(trashHeader(aside())).getByText("3 selected", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Done" }));
    expect(within(trashHeader(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("SM14 選取中切 tab 離開：點 My notes 再點 Trash → 平常標題列", async () => {
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(aside(), "p1")!);
    expect(within(trashHeader(aside())).getByRole("button", { name: "Done" })).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    fireEvent.click(within(aside()).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    expect(within(trashHeader(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(trashHeader(aside())).queryByRole("button", { name: "Done" })).toBeNull();
    expect(trashBox(aside(), "p1")).toBeNull();
  });

  it("SM16 焦點只在發起的那一份：抽屜內 Select → 抽屜的 Done；抽屜內 Done → 抽屜的 Select", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(drawer.querySelector('li[data-node-id="p1"]')).not.toBeNull());

    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    const drawerDone = within(trashHeader(drawer)).getByRole("button", { name: "Done" });
    expect(drawerDone).toHaveFocus();
    expect(within(trashHeader(aside())).getByRole("button", { name: "Done", hidden: true })).not.toHaveFocus();

    fireEvent.click(drawerDone);
    expect(within(trashHeader(drawer)).getByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("SM18 外殼握把（data-sidebar-instance）：底部動作列 Esc 後焦點回同一份的 Select——靜態卡與抽屜各一次", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    // 窄螢幕的 showTab 會開抽屜；先關掉，在靜態卡上做第一輪。
    const opened = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.keyDown(opened, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(aside(), "p1")!);
    const asideRestore = within(aside()).getByRole("button", { name: "Restore" });
    asideRestore.focus();
    fireEvent.keyDown(asideRestore, { key: "Escape" });
    expect(within(trashHeader(aside())).getByRole("button", { name: "Select" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(drawer, "p1")!);
    const drawerRestore = within(drawer).getByRole("button", { name: "Restore" });
    drawerRestore.focus();
    fireEvent.keyDown(drawerRestore, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(within(trashHeader(drawer)).getByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("SM19 抽屜 Esc 只經 Radix（派在 document，重現真瀏覽器 React onKeyDown 收不到）：選取結束、抽屜不關、焦點在抽屜的 Select", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(drawer.querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(drawer)).getByRole("button", { name: "Select" }));
    fireEvent.click(trashBox(drawer, "p1")!);
    trashBox(drawer, "p1")!.focus();

    // 派在 document：只有 Radix 的 capture listener 收到，TrashPanel／動作列的 React onKeyDown 不參與。
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(drawer.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(within(trashHeader(drawer)).getByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("SM16 寬螢幕（沒有抽屜）：靜態卡 Select → 靜態卡的 Done", async () => {
    stubControllableMatchMedia(false);
    stubFetchWithNotes([NOTE], TRASH);
    renderShell();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));
    await waitFor(() => expect(aside().querySelector('li[data-node-id="p1"]')).not.toBeNull());
    fireEvent.click(within(trashHeader(aside())).getByRole("button", { name: "Select" }));
    expect(within(trashHeader(aside())).getByRole("button", { name: "Done" })).toHaveFocus();
  });
});

const TRASH = [
  trashItem({ id: "p1", title: "p1" }, { deletedDaysAgo: 0 }),
  trashItem({ id: "p2", title: "p2" }, { deletedDaysAgo: 1 }),
  trashItem({ id: "w1", title: "w1", group: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" } }, { deletedDaysAgo: 2 }),
];
const trashHeader = (container: HTMLElement) => container.querySelector("[data-sidebar-header]") as HTMLElement;
const trashBox = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLInputElement>(`li[data-node-id="${id}"] input[type="checkbox"]`);

/** 選取 probe：讀 state context 的 `selection.active`，按鈕進入選取模式。抽屜開著時背景被標 aria-hidden，一律以 testid 查。 */
function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="selecting">{String(selection.active)}</span>
      <button type="button" data-testid="start-select" onClick={() => updateSelection({ type: "start" })}>
        start selecting
      </button>
    </>
  );
}

/**
 * 一般 tab 批次動作進行中關掉抽屜（#181 PR-2c T5，SA23／SA23b，plan gate r2 m-D、Rev 4 裁定 2）：抽屜內的動作列卸載，
 * 批次照跑；選取結果看 session（不看掛載）照套；重開抽屜新掛的動作列看得到進行中那輪。
 */
describe("AppShell — 批次進行中關掉抽屜（PR-2c T5）", () => {
  const notes = ["n1", "n2", "n3"].map((id) => ({ ...NOTE, id, title: id, slug: id }));

  function stubBatchServer(opts: { failSecond?: boolean } = {}) {
    let list = [...notes];
    const deletes: string[] = [];
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
        if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(list));
        if (method === "DELETE") {
          const id = url.split("/").pop() as string;
          deletes.push(id);
          const respond = () => {
            if (opts.failSecond && id === "n2") return fakeResponse({ error: { code: "too_many_requests", message: "x" } }, 429);
            list = list.filter((note) => note.id !== id);
            return fakeResponse(undefined, 204);
          };
          return id === "n1" ? gate.then(respond) : Promise.resolve(respond());
        }
        return Promise.resolve(fakeResponse({ error: { code: "not_found", message: "x" } }, 404));
      }),
    );
    return {
      deletes,
      release: async () => {
        await act(async () => {
          open();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
    };
  }

  const header = (container: HTMLElement) => container.querySelector("[data-sidebar-header]") as HTMLElement;
  const noteBox = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;
  const drawerNow = () => screen.queryByRole("dialog", { name: "Navigation" });

  /** 開抽屜 → 抽屜內我的筆記進選取 → 勾三篇 → 刪除（第一支掛起）。 */
  async function startBatchInDrawer(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await waitFor(() => expect(within(header(drawer)).getByRole("button", { name: "Select" })).toBeEnabled());
    fireEvent.click(within(header(drawer)).getByRole("button", { name: "Select" }));
    await within(header(drawer)).findByText("0 selected");
    await waitFor(() => expect(noteBox(drawer, "n3")).not.toBeNull());
    for (const id of ["n1", "n2", "n3"]) fireEvent.click(noteBox(drawer, id));
    fireEvent.click(await within(drawer).findByRole("button", { name: "Delete 3 selected items" }));
  }

  async function closeDrawerByOutsideClick(): Promise<void> {
    await clickOutside();
    await waitFor(() => expect(drawerNow()).toBeNull());
    // 正向檢查：選取還在（靜態卡那份標題列）。
    expect(within(header(aside())).getByText("3 selected")).toBeInTheDocument();
  }

  async function reopenDrawer(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "Open navigation", hidden: true }));
    return screen.findByRole("dialog", { name: "Navigation" });
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("SA23 成功：抽屜在批次中關掉 → 跑完後選取照樣結束（重開抽屜是平常標題列）", async () => {
    stubControllableMatchMedia(true);
    const server = stubBatchServer();
    renderShell();
    await startBatchInDrawer();
    await waitFor(() => expect(server.deletes).toEqual(["n1"]));
    await closeDrawerByOutsideClick();
    await server.release();
    await waitFor(() => expect(server.deletes).toEqual(["n1", "n2", "n3"]));
    await waitFor(() => expect(within(header(aside())).queryByText("3 selected")).toBeNull());
    const drawer = await reopenDrawer();
    expect(within(header(drawer)).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(header(drawer)).queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("SA23 停下（第二支 429）：重開抽屜仍在選取、只留未處理的 2 篇", async () => {
    stubControllableMatchMedia(true);
    const server = stubBatchServer({ failSecond: true });
    renderShell();
    await startBatchInDrawer();
    await waitFor(() => expect(server.deletes).toEqual(["n1"]));
    await closeDrawerByOutsideClick();
    await server.release();
    await waitFor(() => expect(within(header(aside())).getByText("2 selected")).toBeInTheDocument());
    expect(server.deletes).toEqual(["n1", "n2"]);
    const drawer = await reopenDrawer();
    expect(await within(header(drawer)).findByText("2 selected")).toBeInTheDocument();
    expect(noteBox(drawer, "n2")).toBeChecked();
    expect(noteBox(drawer, "n3")).toBeChecked();
  });

  it("SA23b 第一支仍掛起時重開抽屜 → 新掛的動作列顯示進度、三顆鈕 disabled；放行後恢復平常標題列", async () => {
    stubControllableMatchMedia(true);
    const server = stubBatchServer();
    renderShell();
    await startBatchInDrawer();
    await waitFor(() => expect(server.deletes).toEqual(["n1"]));
    await closeDrawerByOutsideClick();
    const drawer = await reopenDrawer();
    await waitFor(() => expect(drawer.querySelector("[data-select-action-bar]")).not.toBeNull());
    const bar = drawer.querySelector("[data-select-action-bar]") as HTMLElement;
    expect(within(bar).getByRole("status")).toHaveTextContent("Working… 0 of 3");
    for (const button of within(bar).getAllByRole("button")) expect(button).toBeDisabled();
    expect(within(bar).getAllByRole("button")).toHaveLength(3);
    await server.release();
    await waitFor(() => expect(within(header(drawer)).getByRole("button", { name: "Select" })).toBeInTheDocument());
    expect(server.deletes).toEqual(["n1", "n2", "n3"]);
  });
});

/** 一般 tab 選取模式與 AppShell 的接線（#181 PR-2c T6，spec §6.10.2 M6、§5.10、抽屜 Esc）。 */
describe("AppShell — 一般 tab 選取模式（PR-2c T6）", () => {
  const notes = ["p1", "p2", "p3"].map((id) => personalNote({ id, title: id }));
  const header = (container: HTMLElement) => container.querySelector("[data-sidebar-header]") as HTMLElement;
  const noteBox = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][data-selection-key="note:${id}"]`);

  /** 等清單到了（「Select」可按）再按，等勾選樹換上。 */
  async function startSelecting(container: HTMLElement): Promise<void> {
    await waitFor(() => expect(within(header(container)).getByRole("button", { name: "Select" })).toBeEnabled());
    fireEvent.click(within(header(container)).getByRole("button", { name: "Select" }));
    await waitFor(() => expect(noteBox(container, "p1")).not.toBeNull());
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetCollapseForTests();
  });

  it("AS-S1 兩份共用：窄螢幕抽屜內 Select、勾 p1 → 靜態卡那份也勾、1 selected", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes(notes);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await startSelecting(drawer);
    fireEvent.click(noteBox(drawer, "p1")!);

    expect(noteBox(drawer, "p1")).toBeChecked();
    expect(noteBox(aside(), "p1")).toBeChecked();
    expect(noteBox(aside(), "p2")).not.toBeChecked();
    expect(within(header(aside())).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(within(header(drawer)).getByText("1 selected", { exact: true })).toBeInTheDocument();
  });

  it("AS-S2 不重繪 children（spec §5.10）：Select、勾三篇、Done，只消費 actions 的子樹不重跑", async () => {
    stubFetchWithNotes(notes);
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return <div>counter</div>;
    });
    renderShell(<Counter />);
    await within(aside()).findByRole("link", { name: "p1" });
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);

    await startSelecting(aside());
    for (const id of ["p1", "p2", "p3"]) fireEvent.click(noteBox(aside(), id)!);
    expect(within(header(aside())).getByText("3 selected", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(header(aside())).getByRole("button", { name: "Done" }));
    expect(within(header(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();

    expect(renders).toBe(baseline);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });

  it("AS-S3 抽屜 Esc（派在 document，同 SM19）：選取結束、抽屜不關、焦點在抽屜我的筆記標題列的 Select", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes(notes);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await startSelecting(drawer);
    fireEvent.click(noteBox(drawer, "p1")!);
    noteBox(drawer, "p1")!.focus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBe(drawer);
    expect(drawer.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const select = header(drawer).querySelector("button[data-sidebar-select]");
    expect(select).toHaveAccessibleName("Select");
    expect(select).toHaveFocus();
  });

  it("AS-S4 選取中切 tab 離開：點 Workspace → 平常標題列、底部動作列消失（工作區 tab 沒有 New note）", async () => {
    stubFetchWithNotes(notes);
    renderShell();
    await startSelecting(aside());
    fireEvent.click(noteBox(aside(), "p1")!);
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();

    fireEvent.click(within(aside()).getByRole("tab", { name: "Workspace" }));
    expect(within(header(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(header(aside())).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(header(aside())).queryByText(/selected/)).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("AS-S5 搜尋離開：選取中在搜尋框打字 → 選取結束；清空後我的筆記是平常的列與標題列", async () => {
    stubFetchWithNotes(notes);
    renderShell();
    await startSelecting(aside());
    fireEvent.click(noteBox(aside(), "p1")!);

    const input = within(aside()).getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "p" } });
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "" } });
    expect(await within(aside()).findByRole("link", { name: "p1" })).toBeInTheDocument();
    expect(within(header(aside())).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(header(aside())).queryByRole("button", { name: "Done" })).toBeNull();
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("AS-S6 寬螢幕焦點：靜態卡 Select → 焦點在靜態卡的 Done", async () => {
    stubControllableMatchMedia(false);
    stubFetchWithNotes(notes);
    renderShell();
    await startSelecting(aside());
    const done = await within(header(aside())).findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toHaveFocus());
  });
});
