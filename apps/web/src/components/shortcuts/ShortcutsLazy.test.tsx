import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ShortcutsContent } from "./ShortcutsLazy";

/**
 * 快捷鍵介紹頁的內容（plan 2026-11-02-shortcuts-modal T4，Willie 2026-11-02 改版後）：左卡列分類、右卡只顯示所選分類；
 * 分類／條目依站台 AI 能力篩選、Mac 與其他平台的鍵面、報讀器友善的鍵名與分隔符、左卡底部的提示句（沒有「重看導覽」，D8）、
 * 選分類的焦點與窄螢幕兩層切換（比照設定的 ManagementShell）。
 *
 * matchMedia：`test/setup.ts` 的全域 stub 恆回 matches:false——對 `(min-width: 768px)` 來說＝窄視窗；寬視窗案自己 stub。
 */

const INSTRUCT: AiActionDto = { id: "instruct", name: "Instruct", applyMode: "preview", kind: "instruct" };
const QUICK: AiActionDto = { id: "rewrite", name: "Rewrite", applyMode: "direct", kind: "quick" };

/** `/api/ai/actions` 的替身；其他請求一律丟錯（內容元件不該打別的 API）。 */
function stubFetch(handler: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ai/actions") return handler();
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

function renderContent() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShortcutsContent />
    </QueryClientProvider>,
  );
}

const ALL_EN = ["General", "Typing triggers", "Markdown shortcuts", "Text formatting", "Columns", "Sidebar", "Presentation", "AI", "Mouse"];
const NO_AI_EN = ALL_EN.filter((title) => title !== "AI");

/** 左欄的分類鈕（名稱依序）。 */
const navNames = () => Array.from(document.querySelectorAll("[data-shortcuts-category]")).map((el) => el.textContent);
const navButton = (name: string) => within(screen.getByRole("navigation", { name: "Keyboard shortcuts" })).getByRole("button", { name });
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("站台能力（K8）：分類", () => {
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

  it("C3b 所選的是 AI、之後站台能力消失 → 退回第一個分類而不是空白", async () => {
    stubActions([INSTRUCT]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShortcutsContent />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(navNames()).toContain("AI"));
    openCategory("AI");
    expect(heading()).toBe("AI");
    // 管理員把 AI 動作全關掉（["ai-actions"] 快取更新）：所選的 AI 分類消失，右卡退回第一個分類，元件不崩
    act(() => {
      client.setQueryData(["ai-actions"], []);
    });
    await waitFor(() => expect(navNames()).toEqual(NO_AI_EN));
    expect(heading()).toBe("General");
    expect(navButton("General")).toHaveAttribute("aria-current", "true");
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

describe("鍵面（K9）", () => {
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

describe("提示句（D8）", () => {
  it("C6 左卡底部的提示句含 “to open this page” 與 <kbd>/</kbd>；提示句裡沒有按鈕（沒有「重看導覽」）", async () => {
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
