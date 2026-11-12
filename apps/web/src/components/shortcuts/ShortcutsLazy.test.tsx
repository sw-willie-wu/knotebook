import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { TourContext } from "@/lib/tour-context";
import { findUserMenuReturnTarget } from "@/lib/tour-targets";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { RELEASE_HIGHLIGHTS } from "./release-highlights";
import { ShortcutsContent } from "./ShortcutsLazy";

/**
 * 說明視窗的內容：左卡列「功能導覽」「這一版新增」兩頁與快捷鍵分類、右卡只顯示所選那一頁；
 * 分類／條目依站台 AI 能力篩選、Mac 與其他平台的鍵面、報讀器友善的鍵名與分隔符、左卡底部的提示句（沒有按鈕）、
 * 選頁的焦點與窄螢幕兩層切換（比照設定的 ManagementShell）、〔開始導覽〕與「這一版新增」依登入者過濾。
 *
 * matchMedia：`test/setup.ts` 的全域 stub 恆回 matches:false——對 `(min-width: 768px)` 來說＝窄視窗；寬視窗案自己 stub。
 */

/** 登記檔的替身：`override` 不為 null 時取代真的登記檔（空狀態、`adminOnly` 過濾用）；其餘案例用真的。 */
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

/** `/api/auth/me` 的替身：null＝未登入（401）。 */
const sessionState = { user: null as null | { isAdmin: boolean } };

const INSTRUCT: AiActionDto = { id: "instruct", name: "Instruct", applyMode: "preview", kind: "instruct" };
const QUICK: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "direct", kind: "quick" };

/** `/api/ai/actions` 的替身；其他請求一律丟錯（內容元件不該打別的 API）。 */
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
  /** 有導覽 context（說明視窗從 App 層拿到 `useTour()`）。 */
  tour?: { start: (options: { returnTo: string; returnFocus: () => Element | null }) => void };
  startPage?: ShortcutsStartPage;
  onClose?: () => void;
  client?: QueryClient;
  route?: string;
}

function contentElement({ tour, startPage, onClose = () => {}, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), route = "/" }: ContentOptions = {}) {
  const content = <ShortcutsContent startPage={startPage} onClose={onClose} />;
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

/** 左欄的分類鈕（名稱依序）。 */
const navNames = () => Array.from(document.querySelectorAll("[data-shortcuts-category]")).map((el) => el.textContent);
const navButton = (name: string) => within(screen.getByRole("navigation", { name: "Help" })).getByRole("button", { name });
/** 左欄所有按鈕的名稱，依序（兩頁＋各分類）。 */
const allNavNames = () => within(screen.getByRole("navigation", { name: "Help" })).getAllByRole("button").map((b) => b.textContent);
/** 右卡目前顯示的 h3。 */
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

/** 切到某個分類（點左欄鈕）。 */
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

describe("站台能力：分類", () => {
  it("C1 AI 回 []：左欄是去掉 AI 的那些分類，依序", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navNames()).not.toContain("AI");
  });

  it("C2 AI 有 Instruct 與 quick：AI 分類在 Mouse 之前，點開有 aiSelect、aiSend、aiClose 三列", async () => {
    stubActions([INSTRUCT, QUICK]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(ALL_EN));
    openCategory("AI");
    expect(heading()).toBe("AI");
    expect(rowIds()).toEqual(["aiSelect", "aiSend", "aiClose"]);
  });

  it("C2b AI 只回 quick 的動作：AI 分類有 aiSelect、aiClose，沒有 aiSend", async () => {
    stubActions([QUICK]);
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(ALL_EN));
    openCategory("AI");
    expect(rowIds()).toEqual(["aiSelect", "aiClose"]);
  });

  it("C3 AI 請求永不回來：其他分類都在、沒有 AI", async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
  });

  it("C3 AI 回 500：同上且不崩", async () => {
    stubFetch(() => jsonResponse({ error: { code: "internal", message: "boom" } }, 500));
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    await new Promise((resolve) => setTimeout(resolve, 20)); // 等查詢走完錯誤路徑後仍然一樣
    expect(navNames()).toEqual(NO_AI_EN);
  });

  it("C3b 所選的是 AI、之後站台能力消失 → 退回第一頁而不是空白", async () => {
    stubActions([INSTRUCT]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderContent({ client });
    await waitFor(() => expect(navNames()).toContain("AI"));
    openCategory("AI");
    expect(heading()).toBe("AI");
    // 管理員把 AI 動作全關掉（["ai-actions"] 快取更新）：所選的 AI 分類消失，右卡退回第一頁（沒有導覽 context 時是「這一版新增」），元件不崩
    act(() => {
      client.setQueryData(["ai-actions"], []);
    });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("What's new")).toHaveAttribute("aria-current", "true");
    expect(heading()).toMatch(/^New in v/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("分類切換（左卡項次＋右卡內容）", () => {
  beforeEach(() => stubActions([]));

  it("P1 預設停在「通用」：aria-current 在它身上、右卡 region 的名稱是它、只有通用的條目", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("General")).toHaveAttribute("aria-current", "true");
    for (const other of NO_AI_EN.slice(1)) expect(navButton(other)).not.toHaveAttribute("aria-current");
    expect(region()).toHaveAccessibleName("General");
    expect(rowIds()).toEqual(["search", "searchClear", "saveVersion", "openSettings", "openShortcuts"]);
  });

  it("P2 點「Markdown shortcuts」：aria-current 移過去、region 名稱換掉、右卡只剩這一類的條目", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    openCategory("Markdown shortcuts");
    expect(navButton("Markdown shortcuts")).toHaveAttribute("aria-current", "true");
    expect(navButton("General")).not.toHaveAttribute("aria-current");
    expect(heading()).toBe("Markdown shortcuts");
    expect(region()).toHaveAccessibleName("Markdown shortcuts");
    expect(hasRow("heading")).toBe(true);
    expect(hasRow("search")).toBe(false);
    // 左欄鈕 aria-controls 指向右卡 region
    expect(navButton("Markdown shortcuts").getAttribute("aria-controls")).toBe(region().id);
  });

  it("P3 整份清單：每個分類點過一遍，每個條目都出現在某個分類下（沒有條目被分類切換吃掉）", async () => {
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

  it("P4 開啟後焦點落在右卡內容區（PageDown 立刻能捲）", async () => {
    renderContent();
    await waitFor(() => expect(region()).toHaveFocus());
  });

  it("P5 寬螢幕：選分類後焦點留在被點的項次（同設定的 NavLink）", async () => {
    stubWide();
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    navButton("Columns").focus();
    openCategory("Columns");
    expect(navButton("Columns")).toHaveFocus();
    expect(heading()).toBe("Columns");
  });

  it("P6 窄螢幕兩層：預設是內容層；選分類後內容層、焦點進內容區；返回鈕回分類層、焦點回目前項次", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    const items = document.querySelector<HTMLElement>('[data-shortcuts-card="items"]')!;
    const content = document.querySelector<HTMLElement>('[data-shortcuts-card="content"]')!;
    // jsdom 不套 Tailwind：只能以 class 斷言（同 ManagementShell.test）
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

describe("說明視窗的頁", () => {
  beforeEach(() => stubActions([]));

  it("左欄順序：Feature tour、What's new、分隔線、「Keyboard shortcuts」小標題；分類按鈕在以小標題命名的群組裡", async () => {
    renderContent({ tour: { start: vi.fn() } });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(allNavNames()).toEqual(["Feature tour", "What's new", ...NO_AI_EN]);
    const nav = screen.getByRole("navigation", { name: "Help" });
    const kids = Array.from(nav.children);
    expect(kids.map((el) => el.getAttribute("role") ?? el.tagName.toLowerCase())).toEqual(["button", "button", "separator", "group"]);
    const group = within(nav).getByRole("group", { name: "Keyboard shortcuts" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(NO_AI_EN);
    // 小標題是文字、不可聚焦
    const label = group.firstElementChild as HTMLElement;
    expect(label.textContent).toBe("Keyboard shortcuts");
    expect(label.tabIndex).toBe(-1);
  });

  it("沒有導覽 context：左欄沒有 Feature tour，What's new 仍在最上面", async () => {
    renderContent();
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(allNavNames()).toEqual(["What's new", ...NO_AI_EN]);
  });

  it("起始頁：global 停在 General；tour 停在 Feature tour（aria-current 與 region 名稱都跟著）", async () => {
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

  it("沒有導覽 context 卻要求停在 tour：退回 What's new，不會出現沒反應的鈕", async () => {
    renderContent({ startPage: "tour" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(navButton("What's new")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: "Start tour" })).toBeNull();
  });

  it("〔Start tour〕：先關視窗、再恰好呼叫一次 start；returnTo 是當下位置（含 search 與 hash），returnFocus 是使用者選單的查找函式", async () => {
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

  it("Feature tour 頁：標題、說明句與按鈕", async () => {
    renderContent({ tour: { start: vi.fn() }, startPage: "tour" });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(heading()).toBe("Feature tour");
    expect(region()).toHaveTextContent("It creates a sample note in My notes");
  });

  it("窄螢幕：打開就是內容層（Feature tour 頁）；返回鈕回左欄；再選 What's new 進內容層", async () => {
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
    expect(region()).toHaveAccessibleName(/^New in v/);
  });

  it("zh-TW：左欄與頁面用「功能導覽」「這一版新增」「快捷鍵」", async () => {
    await i18n.changeLanguage("zh-TW");
    renderContent({ tour: { start: vi.fn() }, startPage: "tour" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "說明" })).toBeInTheDocument());
    const nav = within(screen.getByRole("navigation", { name: "說明" }));
    expect(nav.getAllByRole("button").slice(0, 2).map((b) => b.textContent)).toEqual(["功能導覽", "這一版新增"]);
    expect(nav.getByRole("group", { name: "快捷鍵" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開始導覽" })).toBeInTheDocument();
    fireEvent.click(nav.getByRole("button", { name: "這一版新增" }));
    expect(heading()).toBe(`v${RELEASE_HIGHLIGHTS.version} 新增`);
  });
});

describe("這一版新增", () => {
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
  const highlightTitle = (id: string) => highlightEl(id).querySelector("p")?.textContent ?? null;

  async function openWhatsNew(options: ContentOptions = {}) {
    renderContent(options);
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    fireEvent.click(navButton("What's new"));
  }

  it("一般使用者：標題帶登記檔的版本，只列沒有標 adminOnly 的條目（名稱與說明都在）", async () => {
    registryState.override = SAMPLE_REGISTRY;
    sessionState.user = { isAdmin: false };
    await openWhatsNew();
    await waitFor(() => expect(heading()).toBe("New in v9.9.9"));
    expect(highlightIds()).toEqual(["sample"]);
    expect(region()).toHaveTextContent("Sample feature");
    expect(region()).toHaveTextContent("Sample description.");
    expect(region()).not.toHaveTextContent("Admin-only feature");
  });

  it("站台管理員：兩條都列，順序照登記檔", async () => {
    registryState.override = SAMPLE_REGISTRY;
    sessionState.user = { isAdmin: true };
    await openWhatsNew();
    await waitFor(() => expect(highlightIds()).toEqual(["sample", "adminSample"]));
    expect(heading()).toBe("New in v9.9.9");
  });

  it("登入者還沒查到（載入中）：先當一般使用者，不露出 adminOnly 條目", async () => {
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

  it("登記檔沒有條目：左欄仍有 What's new，頁面只有那一句，沒有版本標題", async () => {
    registryState.override = { version: "9.9.9", items: [] };
    await openWhatsNew();
    expect(navButton("What's new")).toHaveAttribute("aria-current", "true");
    expect(region()).toHaveTextContent("Nothing new to highlight in this version.");
    expect(screen.queryByRole("heading", { name: /New in v/ })).toBeNull();
    expect(document.querySelectorAll("[data-highlight-id]")).toHaveLength(0);
    expect(region()).toHaveAccessibleName("What's new");
  });

  it("條目全是 adminOnly 而登入者不是管理員：同樣只有那一句，沒有版本標題", async () => {
    registryState.override = { version: "9.9.9", items: [{ id: "adminSample", adminOnly: true }] };
    sessionState.user = { isAdmin: false };
    await openWhatsNew();
    expect(region()).toHaveTextContent("Nothing new to highlight in this version.");
    expect(screen.queryByRole("heading", { name: /New in v/ })).toBeNull();
  });

  it("真的登記檔：標題帶登記檔版本，列出最愛、安裝成 app、說明與導覽（英文名稱與說明都在）", async () => {
    registryState.override = null;
    sessionState.user = { isAdmin: false };
    await openWhatsNew();
    await waitFor(() => expect(heading()).toBe(`New in v${RELEASE_HIGHLIGHTS.version}`));
    expect(highlightIds()).toContain("favorites");
    expect(highlightIds()).toContain("installApp");
    expect(highlightIds()).toContain("helpAndTour");
    expect(highlightIds()).not.toContain("signOutThisBrowser");
    expect(highlightTitle("favorites")).toBe("Favorites");
    expect(highlightTitle("installApp")).toBe("Install Knotebook as an app");
    expect(highlightTitle("helpAndTour")).toBe("Help and feature tour");
    expect(highlightEl("helpAndTour")).toHaveTextContent("Ctrl+/");
    expect(highlightEl("helpAndTour")).toHaveTextContent("Start tour");
    expect(highlightEl("installApp")).toHaveTextContent("HTTPS");
  });

  it("真的登記檔：繁體中文也列出最愛、安裝成 app、說明與導覽（標題在各自條目內）", async () => {
    registryState.override = null;
    sessionState.user = { isAdmin: false };
    await i18n.changeLanguage("zh-TW");
    renderContent();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "說明" })).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("navigation", { name: "說明" })).getByRole("button", { name: "這一版新增" }));
    await waitFor(() => expect(highlightTitle("favorites")).toBe("最愛"));
    expect(highlightTitle("installApp")).toBe("把 Knotebook 安裝成 App");
    expect(highlightTitle("helpAndTour")).toBe("說明與功能導覽");
    expect(highlightEl("helpAndTour")).toHaveTextContent("Ctrl+/");
    expect(highlightEl("helpAndTour")).toHaveTextContent("開始導覽");
    expect(highlightEl("installApp")).toHaveTextContent("HTTPS");
    expect(highlightIds()).not.toContain("signOutThisBrowser");
  });

  it("真的登記檔：每個 adminOnly 條目一般使用者看不到、管理員看得到，其餘兩邊都看得到", async () => {
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

describe("鍵面", () => {
  beforeEach(() => stubActions([]));

  it("C4 Win32：search 列的 <kbd> 依序是 Ctrl、K；組合鍵之間的「+」是 aria-hidden", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    expect(kbdTexts(row("search"))).toEqual(["Ctrl", "K"]);
    const plus = Array.from(row("search").querySelectorAll("span")).filter((el) => el.textContent === "+");
    expect(plus.length).toBeGreaterThan(0);
    for (const el of plus) expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("C4 MacIntel：第一個 <kbd> 的可見符號是 ⌘（aria-hidden），該列含 sr-only 的 Command；Mac 的 redo 列沒有 Y", async () => {
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

  it("C4 Win32 的 redo 列有 Y 與 Z 兩種按法", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Text formatting");
    const texts = kbdTexts(row("redo"));
    expect(texts).toContain("Y");
    expect(texts.filter((t) => t === "Z")).toHaveLength(1);
  });

  it("C5 typed 條目：`[[` 那列有一個 <kbd> 文字恰為 [[；heading 列有 # 與恰一個 Space", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Typing triggers");
    expect(kbdTexts(row("wikilink"))).toEqual(["[["]);
    openCategory("Markdown shortcuts");
    const heading3 = kbdTexts(row("heading"));
    expect(heading3).toContain("#");
    expect(heading3).toContain("Space");
    // 三種觸發字都要接空白：只在最後放一個 Space，不是每個各帶一個
    expect(heading3.filter((t) => t === "Space")).toHaveLength(1);
  });

  it("C5b redo 列（sep: or）：可見的「／」是 aria-hidden，且該列含 sr-only 的 “or”", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Text formatting");
    const el = row("redo");
    const slashes = Array.from(el.querySelectorAll("span")).filter((s) => s.textContent === "／");
    expect(slashes.length).toBeGreaterThan(0);
    for (const s of slashes) expect(s.getAttribute("aria-hidden")).toBe("true");
    expect(Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent)).toContain("or");
  });

  it("C5c indent 列（sep: pair）：sr-only 分隔是 pair 的符號、不含 “or”；說明同時交代 Tab 與 Shift Tab", async () => {
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

  it("C5 方向鍵：presentNav 的符號 aria-hidden、旁邊有 sr-only 名稱", async () => {
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    openCategory("Presentation");
    const el = row("presentNav");
    const sr = Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent);
    for (const name of ["Right arrow", "Left arrow", "Down arrow", "Up arrow"]) expect(sr).toContain(name);
    for (const kbd of Array.from(el.querySelectorAll("kbd"))) expect(kbd.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe("提示句", () => {
  it("C6 左卡底部的提示句含 “to open this page” 與 <kbd>/</kbd>；提示句裡沒有按鈕（導覽的入口在「功能導覽」頁，不在底部）", async () => {
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

describe("語系", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("C7 zh-TW：左欄第一個是「通用」，右卡標題也是「通用」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubActions([]);
    renderContent();
    await waitFor(() => expect(navNames()[0]).toBe("通用"));
    expect(heading()).toBe("通用");
  });
});
