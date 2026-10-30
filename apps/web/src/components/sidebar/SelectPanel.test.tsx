import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FolderDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { dismissAllToasts, toast, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { adminRole, groupDto } from "@/test/fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder } from "@/test/folder-fixtures";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";

// 一般 tab 的選取模式：標題列「選取」、選取模式標題列（含 Esc）與勾選樹（#181 PR-2c T4，NS1–NS13）。

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
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
};

const G1: GroupDto = groupDto({ id: "g1", name: "G1" }, adminRole());
const G2: GroupDto = groupDto({ id: "g2", name: "G2" }, adminRole());
const P1 = personalNote({ id: "p1", title: "p1" });
const P2 = personalNote({ id: "p2", title: "p2" });
const P3 = personalNote({ id: "p3", title: "p3" });
const G1A = groupNote({ id: "g1a", title: "g1a", group: G1 });
const G1B = groupNote({ id: "g1b", title: "g1b", group: G1 });
const G2A = groupNote({ id: "g2a", title: "g2a", group: G2 });
const S1 = sharedNote({ id: "s1", title: "s1", role: "viewer" });
const ALL_NOTES = [P1, P2, P3, G1A, G1B, G2A, S1];

/** `notes` 是可變的盒子：改 `box.notes` 後 invalidate 就重抓到新清單（NS10）。`pending: true` 讓 `GET /api/notes` 永不回。 */
function stubFetch(box: { notes: NoteDto[]; groups?: GroupDto[]; folders?: FolderDto[]; pending?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") {
        const body = box.folders === undefined ? FOLDER_LIST_EMPTY : { folders: box.folders };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url === "/api/notes" && method === "GET") {
        if (box.pending) return new Promise<Response>(() => {});
        return Promise.resolve(fakeResponse(box.notes));
      }
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse(box.groups ?? [G1, G2]));
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 可控 matchMedia（`AppShell.tabs.test.tsx` 的 `stubControllableMatchMedia` 沒有 export，照抄）；`afterEach` 的 `vi.unstubAllGlobals()` 還原。 */
function stubMatchMedia(narrow: boolean) {
  const mql = {
    matches: narrow,
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
  return mql;
}

interface RenderOpts {
  tab?: SidebarTab;
  queryClient?: QueryClient;
  /** 外殼帶 `data-sidebar-drawer`（抽屜那份）。 */
  drawer?: boolean;
  toaster?: boolean;
  /** 外殼之外的內容（主內容區的探針）。 */
  outside?: ReactNode;
}

/** H7 骨架＋一份側欄實例外殼（`data-sidebar-instance`）。 */
function renderPanel(opts: RenderOpts = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shellProps = opts.drawer ? { "data-sidebar-drawer": "" } : {};
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div data-sidebar-instance="" {...shellProps}>
              <div role="tabpanel">
                <NoteList />
              </div>
            </div>
            {opts.outside}
            {opts.toaster && <Toaster />}
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const panel = () => screen.getByRole("tabpanel");
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const checkbox = (id: string) => panel().querySelector(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;
const checkedIds = () =>
  Array.from(panel().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.selectionKey?.replace(/^note:/, ""));
const selectButton = () => within(header()).getByRole("button", { name: "Select" });
const headerButtonNames = () => within(header()).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

/** 等「選取」可按（筆記到了）→ 按 → 等 lazy chunk 到（標題列「0 selected」＋勾選框）。 */
async function enterSelect(): Promise<void> {
  const select = await within(header()).findByRole("button", { name: "Select" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.click(select);
  await within(header()).findByText("0 selected");
  await within(panel()).findAllByRole("checkbox");
}

async function renderSelecting(opts: RenderOpts & { notes?: NoteDto[]; groups?: GroupDto[]; folders?: FolderDto[] } = {}) {
  const box = { notes: opts.notes ?? ALL_NOTES, groups: opts.groups, folders: opts.folders };
  stubFetch(box);
  const view = renderPanel(opts);
  await enterSelect();
  return { ...view, box };
}

const pressEsc = (target: Element | Document = document.body, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key: "Escape", ...init });
const selecting = () => within(header()).queryByRole("button", { name: "Done" }) !== null;

describe("一般 tab 的選取模式（PR-2c T4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("NS1 標題列「選取」鈕", () => {
    it("我的筆記依序 Select、New personal note；Select 是 24px 圖示鈕、帶 title／data-sidebar-select", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel();
      await within(panel()).findByRole("link", { name: "p1" });
      expect(headerButtonNames()).toEqual(["Select", "New folder", "New personal note"]);
      const select = selectButton();
      expect(select).toHaveAttribute("title", "Select");
      expect(select).toHaveAttribute("data-sidebar-select", "");
      expect(select.querySelector('svg[data-icon="select"]')).not.toBeNull();
      expect(select).toHaveClass("h-6", "w-6");
      expect(select).toBeEnabled();
    });

    it("最近只有 Select", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel({ tab: "recent" });
      await within(panel()).findAllByRole("link");
      expect(headerButtonNames()).toEqual(["Select"]);
      expect(selectButton()).toBeEnabled();
    });

    it("與我共享只有 Select", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel({ tab: "shared" });
      await within(panel()).findByRole("link", { name: /^s1/ });
      expect(headerButtonNames()).toEqual(["Select"]);
      expect(selectButton()).toBeEnabled();
    });

    it("工作坊 Select、New group", async () => {
      stubFetch({ notes: ALL_NOTES });
      renderPanel({ tab: "workspace" });
      await within(panel()).findByRole("button", { name: "G1" });
      expect(headerButtonNames()).toEqual(["Select", "New group"]);
      expect(selectButton()).toBeEnabled();
    });

    it("0 篇 → disabled", async () => {
      stubFetch({ notes: [], groups: [] });
      renderPanel();
      await within(panel()).findByText("No notes yet.");
      expect(selectButton()).toBeDisabled();
    });

    it("只有空群組 → disabled", async () => {
      stubFetch({ notes: [P1] });
      renderPanel({ tab: "workspace" });
      await within(panel()).findByRole("button", { name: "G1" });
      expect(selectButton()).toBeDisabled();
    });

    it("筆記載入中 → disabled", async () => {
      stubFetch({ notes: ALL_NOTES, pending: true });
      renderPanel();
      expect(await within(panel()).findByText("Loading…")).toBeInTheDocument();
      expect(selectButton()).toBeDisabled();
    });
  });

  it("NS2 進入：0 selected、Select all／Done；勾選框全未勾；沒有連結、⋮、New personal note；焦點在 Done", async () => {
    stubFetch({ notes: ALL_NOTES });
    renderPanel();
    await within(panel()).findByRole("link", { name: "p1" });
    fireEvent.click(selectButton());
    expect(await within(header()).findByText("0 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    const done = within(header()).getByRole("button", { name: "Done" });
    const boxes = await within(panel()).findAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(within(panel()).queryAllByRole("link")).toHaveLength(0);
    expect(within(panel()).queryByRole("button", { name: "Note actions for p1" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: "New personal note" })).toBeNull();
    expect(done).toHaveFocus();
  });

  it("NS2b 兩份實例（靜態卡＋抽屜）共用選取：焦點只由發起的那一份移動（進入→它的 Done、完成→它的 Select）", async () => {
    stubFetch({ notes: ALL_NOTES });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              {["static", "drawer"].map((id) => (
                <div key={id} data-testid={id} data-sidebar-instance="">
                  <div role="tabpanel">
                    <NoteList />
                  </div>
                </div>
              ))}
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // 從 DOM 裡第一份發起：React 依樹序跑 layout effect，若兩份都聚焦，焦點會落在後掛的第二份。
    const first = screen.getByTestId("static");
    await within(first).findByRole("link", { name: "p1" });
    fireEvent.click(within(first).getByRole("button", { name: "Select" }));
    const done = await within(first).findByRole("button", { name: "Done" });
    await within(screen.getByTestId("drawer")).findByRole("button", { name: "Done" });
    expect(done).toHaveFocus();

    fireEvent.click(done);
    expect(await within(first).findByRole("button", { name: "Select" })).toHaveFocus();
  });

  it("NS3 點列文字：勾、1 selected、bg-brand-soft；再點取消", async () => {
    await renderSelecting();
    fireEvent.click(within(panel()).getByText("p1"));
    expect(checkbox("p1")).toBeChecked();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(checkbox("p1").closest("label")).toHaveClass("bg-brand-soft");
    fireEvent.click(within(panel()).getByText("p1"));
    expect(checkbox("p1")).not.toBeChecked();
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();
    expect(checkbox("p1").closest("label")).not.toHaveClass("bg-brand-soft");
  });

  it("NS4 Shift：點 p1 → Shift 點 p3 → 三篇勾", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p3"), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "p3"]);
  });

  it("NS4b Ctrl：點 p1 → Ctrl 點 p3 → 只有 p1、p3", async () => {
    await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p3"), { ctrlKey: true });
    expect(checkedIds()).toEqual(["p1", "p3"]);
  });

  it("NS4c 點列文字帶修飾鍵（Firefox 不轉送給勾選框，由 label 自己切換）：Shift 走範圍、Ctrl 只切一次", async () => {
    await renderSelecting();
    const title = (id: string) => within(checkbox(id).closest("label") as HTMLElement).getByText(id, { exact: true });
    fireEvent.click(checkbox("p1"));
    fireEvent.click(title("p3"), { shiftKey: true });
    expect(checkedIds()).toEqual(["p1", "p2", "p3"]);
    fireEvent.click(title("p2"), { ctrlKey: true });
    expect(checkedIds()).toEqual(["p1", "p3"]);
  });

  it("NS5 工作坊：群組列是 button[aria-expanded]、沒有勾選框；只有三篇有勾選框；沒有群組的「＋」與 ⋮", async () => {
    await renderSelecting({ tab: "workspace" });
    for (const name of ["G1", "G2"]) {
      const row = within(panel()).getByRole("button", { name });
      expect(row).toHaveAttribute("aria-expanded", "true");
      // 群組列（主鈕所在的那一列）沒有勾選框；子筆記在列下方的導引線容器裡。
      expect(row.parentElement?.querySelector("input")).toBeNull();
    }
    expect(within(panel()).getAllByRole("checkbox")).toHaveLength(3);
    expect(checkedIds()).toEqual([]);
    expect(within(panel()).queryByRole("button", { name: "New note in G1" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Group actions for G1" })).toBeNull();
  });

  it("NS6 收合與全選：全選只勾看得到的；展開後字樣變回 Select all；再全選三篇；取消全選", async () => {
    await renderSelecting({ tab: "workspace" });
    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(within(panel()).getByRole("button", { name: "G1" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["g2a"]);
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Deselect all" })).toBeInTheDocument();

    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["g1a", "g1b", "g2a"]);
    expect(within(header()).getByText("3 selected")).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole("button", { name: "Deselect all" }));
    expect(checkedIds()).toEqual([]);
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();
  });

  it("NS7 收合後仍算：勾 g1a → 收合 → 1 selected；Shift 的錨點不在可見序 → 退化成單列切換", async () => {
    await renderSelecting({ tab: "workspace" });
    fireEvent.click(checkbox("g1a"));
    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(checkbox("g1a")).toBeNull();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();

    fireEvent.click(checkbox("g2a"), { shiftKey: true });
    fireEvent.click(within(panel()).getByRole("button", { name: "G1" }));
    expect(checkedIds()).toEqual(["g1a", "g2a"]);
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
  });

  describe("NS8 Esc 與完成", () => {
    it("焦點在勾選框上按 Esc → 平常標題列、焦點在 Select；Done 同；再進入是 0 selected", async () => {
      await renderSelecting();
      checkbox("p1").focus();
      pressEsc(checkbox("p1"));
      expect(await within(header()).findByRole("button", { name: "Select" })).toHaveFocus();
      expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);

      await enterSelect();
      fireEvent.click(checkbox("p2"));
      expect(within(header()).getByText("1 selected")).toBeInTheDocument();
      fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
      expect(await within(header()).findByRole("button", { name: "Select" })).toHaveFocus();
      expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);

      await enterSelect();
      expect(within(header()).getByText("0 selected")).toBeInTheDocument();
      expect(checkedIds()).toEqual([]);
    });

    it("NS8b 已被處理的 Esc（document capture 先 preventDefault，模擬抽屜 Radix）→ 仍在選取；拿掉後一般 Esc 會離開", async () => {
      await renderSelecting();
      const swallow = (event: KeyboardEvent) => event.preventDefault();
      document.addEventListener("keydown", swallow, { capture: true });
      try {
        pressEsc();
        expect(selecting()).toBe(true);
      } finally {
        document.removeEventListener("keydown", swallow, { capture: true });
      }
      pressEsc();
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8c 有抽屜以外的 dialog → 仍在選取；移除後一般 Esc 會離開", async () => {
      await renderSelecting();
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);
      try {
        pressEsc();
        expect(selecting()).toBe(true);
      } finally {
        dialog.remove();
      }
      pressEsc();
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8d 焦點不在側欄（寬螢幕、body）→ 離開選取、焦點在 Select", async () => {
      await renderSelecting();
      document.body.focus();
      pressEsc(document.body);
      expect(await within(header()).findByRole("button", { name: "Select" })).toHaveFocus();
    });

    it("NS8e 主內容區的輸入框按 Esc → 仍在選取、焦點仍在 input；對 body 按 Esc 會離開", async () => {
      await renderSelecting({
        outside: (
          <main>
            <input aria-label="probe" />
          </main>
        ),
      });
      const probe = screen.getByRole("textbox", { name: "probe" });
      probe.focus();
      pressEsc(probe);
      expect(selecting()).toBe(true);
      expect(probe).toHaveFocus();

      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8f 消耗事件：勾選框上的 Esc 離開選取、同一個事件物件 defaultPrevented", async () => {
      await renderSelecting();
      const target = checkbox("p1");
      const event = createEvent.keyDown(target, { key: "Escape" });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8g 窄螢幕、只有靜態卡（抽屜關著）→ 仍在選取；回到寬螢幕後一般 Esc 會離開", async () => {
      const mql = stubMatchMedia(true);
      await renderSelecting();
      pressEsc(document.body);
      expect(selecting()).toBe(true);

      mql.matches = false;
      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8g' 窄螢幕的抽屜那份看得見：對 body 按 Esc 會離開", async () => {
      stubMatchMedia(true);
      await renderSelecting({ drawer: true });
      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8h 組字中的 Esc → 仍在選取；一般 Esc 會離開", async () => {
      await renderSelecting();
      pressEsc(document.body, { isComposing: true });
      expect(selecting()).toBe(true);

      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });

    it("NS8i 開著 toast：第一下 Esc 只關 toast、仍在選取；第二下離開", async () => {
      await renderSelecting({ toaster: true });
      act(() => {
        toast({ title: "x" });
      });
      const item = await screen.findByText("x", { exact: true });
      const toastLi = item.closest("li") as HTMLElement;
      expect(toastLi).toHaveAttribute("data-state", "open");

      // 真瀏覽器在 listener 之間跑 microtask：Radix 關 toast 的更新在 SelectHeader 的 bubble 之前就 commit（所以 ④b 要在 window
      // capture 記錄）。jsdom 的 fireEvent 同步派發不會 flush，在 body 上補一個 flushSync 模擬那個時間點（T4 review r1 Minor-1）。
      const flush = () => {
        flushSync(() => {});
      };
      document.body.addEventListener("keydown", flush);
      try {
        pressEsc(document.body);
      } finally {
        document.body.removeEventListener("keydown", flush);
      }
      await waitFor(() => expect(screen.queryByText("x", { exact: true })?.closest("li")?.getAttribute("data-state") ?? "gone").not.toBe("open"));
      expect(selecting()).toBe(true);

      pressEsc(document.body);
      await waitFor(() => expect(selecting()).toBe(false));
    });
  });

  it("NS15 Esc 監聽的清理：選取中多出恰兩個 keydown 監聽（window capture＋document bubble），完成與卸載後歸零", async () => {
    // 記錄 window／document 上目前掛著的 keydown 監聽（目標＋capture＋函式本身）。
    const live = new Set<string>();
    const ids = new Map<unknown, number>();
    const spies = [window, document].map((target) => {
      const name = target === window ? "W" : "D";
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      const tag = (listener: unknown, options: unknown) => {
        if (!ids.has(listener)) ids.set(listener, ids.size + 1);
        const capture = typeof options === "object" && options !== null ? Boolean((options as EventListenerOptions).capture) : Boolean(options);
        return `${name}:${capture ? "capture" : "bubble"}#${ids.get(listener)}`;
      };
      return [
        vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "keydown") live.add(tag(listener, options));
          add(type, listener, options);
        }),
        vi.spyOn(target, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
          if (type === "keydown") live.delete(tag(listener, options));
          remove(type, listener, options);
        }),
      ];
    });
    try {
      stubFetch({ notes: ALL_NOTES });
      const view = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <ActiveNoteProvider>
              <SidebarTabProvider>
                <div data-sidebar-instance="">
                  <div role="tabpanel">
                    <NoteList />
                  </div>
                </div>
              </SidebarTabProvider>
            </ActiveNoteProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await within(panel()).findByRole("link", { name: "p1" });
      const base = new Set(live);
      // 只數 window capture 與 document bubble：平常的列每列 ⋮（Radix Menu）在 document capture 各掛一個，隨列重掛會換新函式。
      const extra = () =>
        [...live]
          .filter((key) => !base.has(key) && /^(W:capture|D:bubble)#/.test(key))
          .map((key) => key.replace(/#\d+$/, ""))
          .sort();

      await enterSelect();
      expect(extra()).toEqual(["D:bubble", "W:capture"]);
      fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
      await within(header()).findByRole("button", { name: "Select" });
      expect(extra()).toEqual([]);

      await enterSelect();
      expect(extra()).toEqual(["D:bubble", "W:capture"]);
      view.unmount();
      expect(extra()).toEqual([]);
    } finally {
      for (const spy of spies.flat()) spy.mockRestore();
    }
  });

  it("NS9 最近 tab：兩行（標題＋位置）都在 label 內", async () => {
    await renderSelecting({ tab: "recent" });
    const label = checkbox("g1a").closest("label") as HTMLElement;
    expect(label).toHaveTextContent("g1a");
    expect(label).toHaveTextContent("Workspace › G1");
    expect(checkbox("p1").closest("label")).toHaveTextContent("My notes");
  });

  it("NS9b 與我共享：s1 列帶 Viewer", async () => {
    await renderSelecting({ tab: "shared" });
    expect(checkbox("s1").closest("label")).toHaveTextContent("Viewer");
  });

  it("NS10 重抓後消失的篇不算", async () => {
    const { queryClient, box } = await renderSelecting();
    fireEvent.click(checkbox("p1"));
    fireEvent.click(checkbox("p2"));
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
    box.notes = ALL_NOTES.filter((note) => note.id !== "p2");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
    expect(await within(header()).findByText("1 selected")).toBeInTheDocument();
    expect(checkbox("p2")).toBeNull();
  });

  it("NS15 選取中清單重抓後沒有可勾的篇（工作坊只剩空群組）：仍是選取標題列與勾選樹，群組列沒有「＋」與 ⋮（T4 review Nit-3）", async () => {
    const { queryClient, box } = await renderSelecting({ tab: "workspace" });
    fireEvent.click(checkbox("g1a"));
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    box.notes = ALL_NOTES.filter((note) => note.groupId === null);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
    expect(await within(header()).findByText("0 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "G1" })).toHaveAttribute("aria-expanded", "true");
    expect(within(panel()).queryByRole("button", { name: "New note in G1" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Group actions for G1" })).toBeNull();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
    // 對照：離開選取後是平常的群組列（有群組 ⋮）。
    fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
    expect(await within(panel()).findByRole("button", { name: "Group actions for G1" })).toBeInTheDocument();
  });

  it("NS15b 選取中清單重抓後完全沒有節點（我的筆記清空）：選取標題列＋平常的空狀態句，沒有勾選框（T5 review r1 M2）", async () => {
    const { queryClient, box } = await renderSelecting();
    fireEvent.click(checkbox("p1"));
    box.notes = ALL_NOTES.filter((note) => note.groupId !== null || note.role !== "owner");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["notes"] });
    });
    expect(await within(panel()).findByText("No personal notes yet.")).toBeInTheDocument();
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("NS11 捲動容器不換、捲動位置保留（進入與完成）", async () => {
    stubFetch({ notes: ALL_NOTES });
    renderPanel();
    await within(panel()).findByRole("link", { name: "p1" });
    const container = list();
    container.scrollTop = 120;
    expect(container.scrollTop).toBe(120);
    await enterSelect();
    expect(list()).toBe(container);
    expect(container.scrollTop).toBe(120);
    fireEvent.click(within(header()).getByRole("button", { name: "Done" }));
    await within(panel()).findByRole("link", { name: "p1" });
    expect(list()).toBe(container);
    expect(container.scrollTop).toBe(120);
  });

  it("NS13 zh-TW：已選 0 項、全選、完成；選取鈕 aria-label 選取", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      stubFetch({ notes: ALL_NOTES });
      renderPanel();
      await within(panel()).findByRole("link", { name: "p1" });
      fireEvent.click(within(header()).getByRole("button", { name: "選取" }));
      expect(await within(header()).findByText("已選 0 項")).toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "全選" })).toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "完成" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

// ── 選取模式遇上資料夾（資料夾 PR-3b-1 T2）
describe("選取模式 × 資料夾", () => {
  const FA = personalNote({ id: "fa1", title: "fa1", folderId: "A" });
  const FA2 = personalNote({ id: "fa2", title: "fa2", folderId: "A1" });
  const ROOT = personalNote({ id: "root3", title: "root3" });
  const FOLDERS = [folderDto({ id: "A", name: "A" }), folderDto({ id: "A1", name: "A1", parentId: "A" })];

  function stubFolders() {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify({ folders: FOLDERS }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([FA, FA2, ROOT]));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  const folderRow = (id: string) => panel().querySelector(`[data-node-kind="folder"][data-node-id="${id}"]`) as HTMLElement | null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFolderSortForTests();
  });

  // PR-3b-2 T6a 改寫：資料夾列換成可勾（原斷言「列內沒有勾選框」「全選只勾 root3」反轉成下列）。
  it("NS-F1 我的筆記：資料夾 A 列有 button[aria-expanded] 與勾選框 folder:A；A 底下 fa1 有；收合 A → 全選勾可見的 A 與 root3", async () => {
    stubFolders();
    renderPanel();
    await enterSelect();
    await waitFor(() => expect(checkbox("fa1")).not.toBeNull());
    const row = folderRow("A")!;
    const toggle = row.querySelector(":scope > div > button[aria-expanded]") as HTMLElement;
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(row.firstElementChild!.querySelector('input[type="checkbox"][data-selection-key="folder:A"]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(localStorage.getItem("sidebar.collapsed.folder:A")).toBe("1");
    expect(checkbox("fa1")).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["folder:A", "root3"]);
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
  });

  it("NS-F2 選取模式最近 tab：fa2 第二行 title「My notes › A › A1」", async () => {
    stubFolders();
    renderPanel({ tab: "recent" });
    await enterSelect();
    await waitFor(() => expect(checkbox("fa2")).not.toBeNull());
    const line = checkbox("fa2").closest("label")!.querySelector('[title="My notes › A › A1"]');
    expect(line).toHaveTextContent("My notes › A › A1");
  });
});

// ── 資料夾可勾（資料夾 spec §6.10；PR-3b-2 T6a，NSf1–NSf6）
describe("選取模式 × 資料夾可勾（PR-3b-2 T6a）", () => {
  // 我的筆記：A ⊃ { q1, q2 }、B（空）、根層 q3。可見序＝folder:A、q1、q2、folder:B、q3。
  const FA = folderDto({ id: "A", name: "A" });
  const FB = folderDto({ id: "B", name: "B" });
  const Q1 = personalNote({ id: "q1", title: "q1", folderId: "A" });
  const Q2 = personalNote({ id: "q2", title: "q2", folderId: "A" });
  const Q3 = personalNote({ id: "q3", title: "q3" });
  const MINE = { notes: [Q1, Q2, Q3], groups: [] as GroupDto[], folders: [FA, FB] };

  const folderRow = (id: string) => panel().querySelector(`[data-node-kind="folder"][data-node-id="${id}"]`) as HTMLElement;
  const folderBox = (id: string) => panel().querySelector(`input[type="checkbox"][data-selection-key="folder:${id}"]`) as HTMLInputElement | null;
  /** 資料夾列（列的第一個子元素）裡的折疊鈕；不綁它是不是列的直接子元素（NSf1 另斷言它不在 label 內）。 */
  const chevron = (id: string) => folderRow(id).firstElementChild!.querySelector("button[aria-expanded]") as HTMLButtonElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetFolderSortForTests();
  });

  it("NSf1 資料夾列：勾選框 folder:A（可及名稱 A）與獨立的 button[aria-expanded]（可及名稱 A、不在 label 內）；點 chevron 只收合、點名稱才勾", async () => {
    await renderSelecting(MINE);
    const toggle = chevron("A");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("A");
    expect(toggle.closest("label")).toBeNull();
    const box = folderBox("A")!;
    expect(within(folderRow("A")).getByRole("checkbox", { name: "A" })).toBe(box);
    const label = box.closest("label") as HTMLElement;
    expect(folderRow("A").firstElementChild).toContainElement(label);
    expect(label.querySelector('svg[data-icon="folder"]')).not.toBeNull();

    fireEvent.click(toggle);
    expect(chevron("A")).toHaveAttribute("aria-expanded", "false");
    expect(folderBox("A")).not.toBeChecked();
    expect(within(header()).getByText("0 selected")).toBeInTheDocument();

    fireEvent.click(within(label).getByText("A"));
    expect(folderBox("A")).toBeChecked();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(label).toHaveClass("bg-brand-soft");
  });

  it("NSf2 勾 A → 1 selected；再勾 A 裡的 q1 → 2 selected（標題列不去重）", async () => {
    await renderSelecting(MINE);
    fireEvent.click(folderBox("A")!);
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(checkbox("q1"));
    expect(within(header()).getByText("2 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["folder:A", "q1"]);
  });

  it("NSf3 收合 A 後全選 → A、B、q3 勾到、A 的子項沒有（展開後 q1、q2 未勾）", async () => {
    await renderSelecting(MINE);
    fireEvent.click(chevron("A"));
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    expect(checkedIds()).toEqual(["folder:A", "folder:B", "q3"]);
    expect(within(header()).getByText("3 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Deselect all" })).toBeInTheDocument();
    fireEvent.click(chevron("A"));
    expect(checkbox("q1")).not.toBeChecked();
    expect(checkbox("q2")).not.toBeChecked();
    expect(within(header()).getByText("3 selected")).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Select all" })).toBeInTheDocument();
  });

  it("NSf4 Shift 範圍含資料夾列：q2 → Shift q3 ＝ q2、B、q3；Shift＋點資料夾名稱（label 自己切換）也走範圍", async () => {
    await renderSelecting(MINE);
    fireEvent.click(checkbox("q2"));
    fireEvent.click(checkbox("q3"), { shiftKey: true });
    expect(checkedIds()).toEqual(["q2", "folder:B", "q3"]);

    // 清空（錨點一併清掉）：全選 → 取消全選。
    fireEvent.click(within(header()).getByRole("button", { name: "Select all" }));
    fireEvent.click(within(header()).getByRole("button", { name: "Deselect all" }));
    expect(checkedIds()).toEqual([]);
    fireEvent.click(checkbox("q1"));
    fireEvent.click(within(folderBox("B")!.closest("label") as HTMLElement).getByText("B"), { shiftKey: true });
    expect(checkedIds()).toEqual(["q1", "q2", "folder:B"]);
  });

  it("NSf5 工作坊：群組列不可勾；群組下的資料夾 GF 可勾", async () => {
    const GF = groupFolder({ id: "GF", name: "GF", groupId: G1.id });
    const inGF = groupNote({ id: "g1f", title: "g1f", group: G1, folderId: "GF" });
    await renderSelecting({ tab: "workspace", notes: [inGF, G1B, G2A], folders: [GF] });
    for (const name of ["G1", "G2"]) {
      const row = within(panel()).getByRole("button", { name, expanded: true });
      expect(row.parentElement?.querySelector("input")).toBeNull();
    }
    expect(panel().querySelector('[data-selection-key^="group:"]')).toBeNull();
    expect(within(panel()).getAllByRole("checkbox")).toHaveLength(4);
    fireEvent.click(folderBox("GF")!);
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["folder:GF"]);
  });

  it("NSf6 我的筆記只有空資料夾（沒有個人筆記）→ Select 可按、進入後有資料夾勾選框", async () => {
    await renderSelecting({ notes: [S1], groups: [], folders: [FB] });
    expect(within(panel()).getAllByRole("checkbox")).toEqual([folderBox("B")]);
  });
});
