import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { ShortcutsDialogContext, type ShortcutsDialogApi } from "@/lib/shortcuts-dialog";
import { UserMenu } from "./UserMenu";

// 主題色選擇器：六個 RadioItem 渲染／role=menuitemradio／aria-checked、
// 點選→data-accent＋localStorage＋選單不關閉、鍵盤方向鍵移動焦點。
// 本檔現在也涵蓋 #78（選中改點內勾——ItemIndicator 只在 checked 渲染 Check，
// 與焦點態的 ring 是正交維度）與 #79（主題色群組補 aria-labelledby 可及名稱）。
//
// Harness（比照 SettingsModal.test.tsx／NoteMenu.test.tsx 既有寫法）：
// QueryClientProvider＋MemoryRouter＋ThemeProvider＋i18n＋`/api/auth/me` stub；
// DropdownMenuTrigger 只掛 onPointerDown（Radix），純 click 開不了選單。

const ACCENT_STORAGE_KEY = "knotebook:accent";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "plain@example.com",
  handle: "tester",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

function stubFetch(user: UserDto = USER) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderMenu(shortcuts: ShortcutsDialogApi | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter>
          <ShortcutsDialogContext.Provider value={shortcuts}>
            <UserMenu />
          </ShortcutsDialogContext.Provider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** DropdownMenuTrigger（`UserMenu`）只掛 `onPointerDown`（Radix），純
 * `fireEvent.click` 開不了——見 SettingsModal.test.tsx 的 `openUserMenu`。 */
async function openMenu(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument());
  fireEvent.pointerDown(screen.getByRole("button", { name: "Plain" }), { button: 0 });
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
}

describe("UserMenu 主題色選擇器", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-accent");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-accent");
  });

  it("渲染六個色點：role=menuitemradio，aria-checked 對應目前 accent（預設 indigo）", async () => {
    renderMenu();
    await openMenu();

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(6);

    const indigo = screen.getByRole("menuitemradio", { name: "Indigo" });
    expect(indigo).toHaveAttribute("aria-checked", "true");
    // title tooltip 也走 i18n 色名（跟 aria-label/textValue 同一個翻譯 key）。
    expect(indigo).toHaveAttribute("title", "Indigo");
    // 色點取色唯一守衛：真的讀 --brand-swatch-indigo，不是隨手寫死的 hex。
    expect(indigo.getAttribute("style")).toContain("var(--brand-swatch-indigo)");

    for (const name of ["Blue", "Teal", "Sage", "Rose", "Gold"]) {
      expect(screen.getByRole("menuitemradio", { name })).toHaveAttribute("aria-checked", "false");
    }
  });

  // wrapper 的 outline-none 清掉了瀏覽器原生
  // focus ring，鍵盤在六點間移動時畫面必須靠 data-[highlighted]:ring-foreground
  // 補上可見指示——jsdom 不套用 CSS，這裡只能釘 class 字面量存在，行為級（真的
  // 顯示出一圈）留給視覺驗證。
  it("色點 class 含 data-[highlighted]:ring-foreground（鍵盤移動時的可見指示，補償 outline-none）", async () => {
    renderMenu();
    await openMenu();

    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect(radio.className).toContain("data-[highlighted]:ring-2");
      expect(radio.className).toContain("data-[highlighted]:ring-foreground");
    }
  });

  it("點選色點 → 更新 <html> 的 data-accent 與 localStorage，且選單不關閉", async () => {
    renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Teal" }));

    await waitFor(() => expect(document.documentElement.getAttribute("data-accent")).toBe("teal"));
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");
    // 選色不關選單（onSelect preventDefault）——選單這時應該還在畫面上。
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Indigo" })).toHaveAttribute("aria-checked", "false");
  });

  // 這裡只驗證 document.activeElement 有沒有真的移動；移動當下畫面上是否看得見
  // （data-[highlighted]:ring-foreground，補償 wrapper 的 outline-none）是另一條
  // class 字面量案的職責，見上方那條測試。
  it("鍵盤 ArrowDown 依 DOM 序移動焦點（視覺上橫排，鍵盤仍走選單原生的上下）", async () => {
    renderMenu();
    await openMenu();

    const radios = screen.getAllByRole("menuitemradio");

    // pointerDown 開的選單不會自動把焦點帶進第一個項目（Radix 的 entry-focus
    // 只在鍵盤觸發時才生效）——這裡直接把焦點放上第一個色點，模擬「使用者已經
    // 用方向鍵導覽到這裡」的狀態，純粹測「再按一次 ArrowDown 會不會移動」。
    act(() => radios[0].focus());
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));

    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios[1]));

    fireEvent.keyDown(radios[1], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios[2]));
  });

  // #78：選中態改成「點內打勾」（Radix ItemIndicator，checked 時才渲染），
  // 焦點態的 ring 維持不動——見上方 data-[highlighted]:ring-foreground 那條。
  // 案 A：選中點渲染 Check（svg），且 class 含 text-popover。
  it("選中的色點在點內渲染 Check（svg），class 含 text-popover", async () => {
    renderMenu();
    await openMenu();

    const indigo = screen.getByRole("menuitemradio", { name: "Indigo" });
    const indigoSvg = indigo.querySelector("svg");
    expect(indigoSvg).not.toBeNull();
    expect(indigoSvg).toHaveClass("text-popover");
  });

  // 案 B：未選中的色點不渲染 svg——ItemIndicator unchecked 時 DOM 裡完全沒有
  // 子元素，防「勾畫在所有點上」的假綠：這條如果誤把 svg 畫在每個點上會抓到。
  it("未選中的色點不渲染 Check（svg 為 null）", async () => {
    renderMenu();
    await openMenu();

    const teal = screen.getByRole("menuitemradio", { name: "Teal" });
    expect(teal.querySelector("svg")).toBeNull();
  });

  // 案 C：切換選色後，勾跟著移動到新選中的色點（indigo → teal）。
  it("切換選色後，勾跟著移動到新選中的色點", async () => {
    renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Teal" }));
    await waitFor(() => expect(document.documentElement.getAttribute("data-accent")).toBe("teal"));

    expect(screen.getByRole("menuitemradio", { name: "Teal" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Indigo" }).querySelector("svg")).toBeNull();
  });

  // 案 D（負向）：色點 class 不含 ring-ring（低對比選中 ring 已廢除），且含
  // 置中用的 flex/items-center/justify-center 字面（置中是勾可見性的前提）。
  it("色點 class 不含 ring-ring（低對比選中 ring 已廢除，改點內勾），且含置中用的 flex/items-center/justify-center", async () => {
    renderMenu();
    await openMenu();

    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect(radio.className).not.toContain("ring-ring");
      expect(radio.className).toContain("flex");
      expect(radio.className).toContain("items-center");
      expect(radio.className).toContain("justify-center");
    }
  });

  // #79：主題色群組的可及名稱——RadioGroup 的 role=group 要能算出
  // t("userMenu.accent") 這個名字，斷言不寫死英文字面。
  it("主題色 RadioGroup 有可及名稱（aria-labelledby 指到「主題色」Label）", async () => {
    renderMenu();
    await openMenu();

    expect(screen.getByRole("group", { name: i18n.t("userMenu.accent") })).toBeInTheDocument();
  });
});

// 站台管理入口：admin 才看得到「Site admin」，點了導 /admin/users 且**帶**
// backgroundLocation（#247 起站台管理是 modal，關閉時回到原頁）。
describe("UserMenu 站台管理入口", () => {
  const ADMIN: UserDto = { ...USER, displayName: "Plain", isAdmin: true };

  function stubFetchAs(user: UserDto) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  let lastLocation: Location | null = null;
  function LocationSpy() {
    lastLocation = useLocation();
    return <div data-testid="location">{lastLocation.pathname}</div>;
  }

  function renderMenuWithProbe() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/n/tester/some-note"]}>
            <UserMenu />
            <LocationSpy />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    lastLocation = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin：看得到「Site admin」；點了導 /admin/users，state 帶 backgroundLocation（#247：站台管理是 modal）", async () => {
    stubFetchAs(ADMIN);
    renderMenuWithProbe();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Site admin" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/admin/users"));
    const state = lastLocation?.state as { backgroundLocation?: { pathname: string } } | null;
    expect(state?.backgroundLocation?.pathname).toBe("/n/tester/some-note");
  });

  it("非 admin：看不到「Site admin」（「Settings」仍在）", async () => {
    stubFetchAs(USER);
    renderMenuWithProbe();
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Site admin" })).not.toBeInTheDocument();
  });

  it("zh-TW：入口文案是「站台管理」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFetchAs(ADMIN);
    renderMenuWithProbe();
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "站台管理" })).toBeInTheDocument();
  });
});

describe("UserMenu「快捷鍵介紹」項", () => {
  const ADMIN_USER: UserDto = { ...USER, isAdmin: true };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch(ADMIN_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("U1 在「Settings」之後、「Site admin」之前", async () => {
    renderMenu({ open: vi.fn() });
    await openMenu();
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    const settings = names.findIndex((n) => n.startsWith("Settings"));
    const shortcuts = names.findIndex((n) => n.startsWith("Keyboard shortcuts"));
    const admin = names.findIndex((n) => n.startsWith("Site admin"));
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(shortcuts).toBe(settings + 1);
    expect(admin).toBe(shortcuts + 1);
  });

  it("U2 可及名稱恰為 Keyboard shortcuts（getByRole 的字串 name 是全字比對；提示字 aria-hidden）；項內有 Ctrl+/，Mac 是 ⌘/", async () => {
    renderMenu({ open: vi.fn() });
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Keyboard shortcuts" });
    expect(item).toHaveTextContent("Ctrl+/");
  });

  it("U2 MacIntel：提示字是 ⌘/", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    renderMenu({ open: vi.fn() });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toHaveTextContent("⌘/");
  });

  it("U3 aria-keyshortcuts：Control+/；Mac 是 Meta+/", async () => {
    const view = renderMenu({ open: vi.fn() });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toHaveAttribute("aria-keyshortcuts", "Control+/");
    view.unmount();
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    renderMenu({ open: vi.fn() });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toHaveAttribute("aria-keyshortcuts", "Meta+/");
  });

  it("U4 選該項：open 被呼叫一次、參數是觸發鈕；選單已關", async () => {
    const open = vi.fn();
    renderMenu({ open });
    const trigger = await screen.findByRole("button", { name: "Plain" }); // 選單開著時觸發鈕被標 aria-hidden，先抓
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("U5 沒有 Provider（不在 AppShell 底下）：沒有這一項", async () => {
    renderMenu(null);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("UserMenu「設定」項的 Ctrl+, 提示（與 AppShell 的 Ctrl+, 同一條路）", () => {
  let lastLocation: Location | null = null;
  function Probe() {
    lastLocation = useLocation();
    return <div data-testid="location">{lastLocation.pathname}</div>;
  }

  function renderWithProbe(shortcuts: ShortcutsDialogApi | null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/n/tester/some-note"]}>
            <ShortcutsDialogContext.Provider value={shortcuts}>
              <UserMenu />
            </ShortcutsDialogContext.Provider>
            <Probe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    lastLocation = null;
    stubFetch(USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("U6 在 AppShell 底下：Settings 項可及名稱仍是 Settings，旁邊標 Ctrl+,（aria-hidden），aria-keyshortcuts 是 Control+,", async () => {
    renderWithProbe({ open: vi.fn() });
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Settings" });
    expect(item).toHaveTextContent("Ctrl+,");
    expect(item).toHaveAttribute("aria-keyshortcuts", "Control+,");
    const hint = Array.from(item.querySelectorAll("span")).find((el) => el.textContent === "Ctrl+,");
    expect(hint?.getAttribute("aria-hidden")).toBe("true");
  });

  it("U6 MacIntel：⌘, 與 Meta+,", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    renderWithProbe({ open: vi.fn() });
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Settings" });
    expect(item).toHaveTextContent("⌘,");
    expect(item).toHaveAttribute("aria-keyshortcuts", "Meta+,");
  });

  it("U7 不在 AppShell 底下（沒有 context）：Settings 項沒有提示字、也沒有 aria-keyshortcuts（那個快捷鍵在這裡不作用）", async () => {
    renderWithProbe(null);
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Settings" });
    expect(item).not.toHaveTextContent("Ctrl+,");
    expect(item).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("U8 點 Settings：導 /settings/account，state 帶 backgroundLocation（與 Ctrl+, 同一條路）", async () => {
    renderWithProbe({ open: vi.fn() });
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    const state = lastLocation?.state as { backgroundLocation?: { pathname: string } } | null;
    expect(state?.backgroundLocation?.pathname).toBe("/n/tester/some-note");
  });
});

describe("UserMenu 頭像形（avatar）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderAvatar() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu variant="avatar" />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  it("UA1 觸發鈕只有頭像：名稱仍是 displayName、點擊範圍 44、視覺 32、沒有名字文字與齒輪", async () => {
    renderAvatar();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    expect(trigger).toHaveClass("h-11", "w-11");
    expect(trigger.textContent).toBe("P");
    expect(trigger.querySelector("svg")).toBeNull();
    expect(trigger.querySelector("span")).toHaveClass("h-8", "w-8");
  });

  it("UA2 選單內容不變：開得起來、有 Settings 與 Log out", async () => {
    renderAvatar();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Plain" }), { button: 0 });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("UA3 預設（row）形不變：有名字文字", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    expect(trigger.textContent).toContain("Plain");
    expect(trigger).not.toHaveClass("w-11");
  });
});
