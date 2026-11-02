import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ShortcutsContent } from "./ShortcutsLazy";

/**
 * 快捷鍵介紹頁的內容（plan 2026-11-02-shortcuts-modal T4）：分類／條目依站台 AI 能力篩選、Mac 與其他平台的鍵面、
 * 報讀器友善的鍵名與分隔符、footer 提示句（沒有「重看導覽」鈕，D8）。
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

function renderContent() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShortcutsContent />
    </QueryClientProvider>,
  );
}

const ALL_EN = ["General", "Typing triggers", "Markdown shortcuts", "Text formatting", "Columns", "Sidebar", "Presentation", "AI", "Mouse"];
const NO_AI_EN = ALL_EN.filter((title) => title !== "AI");

const h3Names = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-shortcut-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
};
const hasRow = (id: string) => document.querySelector(`[data-shortcut-id="${id}"]`) !== null;
const kbdTexts = (el: HTMLElement) => Array.from(el.querySelectorAll("kbd")).map((k) => k.textContent);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubPlatform("Win32");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("站台能力（K8）", () => {
  it("C1 AI 回 []：分類標題依序是去掉 AI 的那些", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(h3Names()).toEqual(NO_AI_EN));
    expect(hasRow("aiSelect")).toBe(false);
  });

  it("C2 AI 有 Instruct 與 quick：AI 段在 Mouse 之前，有 aiSelect、aiSend、aiClose 三列", async () => {
    stubActions([INSTRUCT, QUICK]);
    renderContent();
    await waitFor(() => expect(h3Names()).toEqual(ALL_EN));
    const section = screen.getByRole("heading", { level: 3, name: "AI" }).closest("section")!;
    const ids = Array.from(section.querySelectorAll("[data-shortcut-id]")).map((el) => el.getAttribute("data-shortcut-id"));
    expect(ids).toEqual(["aiSelect", "aiSend", "aiClose"]);
  });

  it("C2b AI 只回 quick 的動作：有 aiSelect、aiClose，沒有 aiSend", async () => {
    stubActions([QUICK]);
    renderContent();
    await waitFor(() => expect(h3Names()).toEqual(ALL_EN));
    expect(hasRow("aiSelect")).toBe(true);
    expect(hasRow("aiClose")).toBe(true);
    expect(hasRow("aiSend")).toBe(false);
  });

  it("C3 AI 請求永不回來：其他分類都在、沒有 AI", async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    renderContent();
    await waitFor(() => expect(h3Names()).toEqual(NO_AI_EN));
  });

  it("C3 AI 回 500：同上且不崩", async () => {
    stubFetch(() => jsonResponse({ error: { code: "internal", message: "boom" } }, 500));
    renderContent();
    await waitFor(() => expect(h3Names()).toEqual(NO_AI_EN));
    // 等查詢走完錯誤路徑後仍然一樣
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h3Names()).toEqual(NO_AI_EN);
  });
});

describe("鍵面（K9）", () => {
  it("C4 Win32：search 列的 <kbd> 依序是 Ctrl、K", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    expect(kbdTexts(row("search"))).toEqual(["Ctrl", "K"]);
    // 組合鍵之間的「+」是裝飾：aria-hidden（K13），報讀器不讀成 plus
    const plus = Array.from(row("search").querySelectorAll("span")).filter((el) => el.textContent === "+");
    expect(plus.length).toBeGreaterThan(0);
    for (const el of plus) expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("C4 MacIntel：第一個 <kbd> 的可見符號是 ⌘（aria-hidden），該列含 sr-only 的 Command；Mac 的 redo 列沒有 Y", async () => {
    stubPlatform("MacIntel");
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("search")).toBe(true));
    const first = row("search").querySelector("kbd")!;
    const symbol = first.querySelector('[aria-hidden="true"]');
    expect(symbol?.textContent).toBe("⌘");
    const sr = Array.from(row("search").querySelectorAll(".sr-only")).map((el) => el.textContent);
    expect(sr).toContain("Command");
    expect(kbdTexts(row("redo")).join(" ")).not.toContain("Y");
    expect(kbdTexts(row("redo")).join("")).toContain("Z");
  });

  it("C4 Win32 的 redo 列有 Y 與 Z 兩種按法", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("redo")).toBe(true));
    const texts = kbdTexts(row("redo"));
    expect(texts).toContain("Y");
    expect(texts.filter((t) => t === "Z")).toHaveLength(1);
  });

  it("C5 typed 條目：`[[` 那列有一個 <kbd> 文字恰為 [[；heading 列有 # 與 Space", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("wikilink")).toBe(true));
    expect(kbdTexts(row("wikilink"))).toEqual(["[["]);
    const heading = kbdTexts(row("heading"));
    expect(heading).toContain("#");
    expect(heading).toContain("Space");
    // 三種觸發字都要接空白：只在最後放一個 Space，不是每個各帶一個
    expect(heading.filter((t) => t === "Space")).toHaveLength(1);
  });

  it("C5b redo 列（sep: or）：可見的「／」是 aria-hidden，且該列含 sr-only 的 “or”", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("redo")).toBe(true));
    const el = row("redo");
    const slashes = Array.from(el.querySelectorAll("span")).filter((s) => s.textContent === "／");
    expect(slashes.length).toBeGreaterThan(0);
    for (const s of slashes) expect(s.getAttribute("aria-hidden")).toBe("true");
    const sr = Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent);
    expect(sr).toContain("or");
  });

  it("C5c indent 列（sep: pair）：sr-only 分隔是 pair 的符號、不含 “or”；說明同時交代 Tab 與 Shift Tab", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("indent")).toBe(true));
    const el = row("indent");
    const sr = Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent);
    expect(sr).not.toContain("or");
    expect(sr).toContain(", ");
    expect(el.textContent).toMatch(/Tab indents/);
    expect(el.textContent).toMatch(/Shift Tab takes the indent back/);
  });

  it("C5 方向鍵：presentNav 的符號 aria-hidden、旁邊有 sr-only 名稱", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(hasRow("presentNav")).toBe(true));
    const el = row("presentNav");
    const sr = Array.from(el.querySelectorAll(".sr-only")).map((s) => s.textContent);
    for (const name of ["Right arrow", "Left arrow", "Down arrow", "Up arrow"]) expect(sr).toContain(name);
    for (const kbd of Array.from(el.querySelectorAll("kbd"))) expect(kbd.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe("footer（D8）", () => {
  it("C6 提示句含 “to open this page” 與 <kbd>/</kbd>；整個內容裡沒有任何按鈕（沒有「重看導覽」）", async () => {
    stubActions([]);
    renderContent();
    await waitFor(() => expect(document.querySelector("[data-shortcuts-footer]")).not.toBeNull());
    const footer = document.querySelector<HTMLElement>("[data-shortcuts-footer]")!;
    expect(footer.textContent).toContain("to open this page");
    expect(within(footer).getByText("/", { selector: "kbd" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("語系", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("C7 zh-TW：第一個 h3 是「通用」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubActions([]);
    renderContent();
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 })[0]?.textContent).toBe("通用"));
  });
});
