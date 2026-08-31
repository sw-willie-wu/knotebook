import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type BacklinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_INSET } from "@/components/ui/article-column";
import { BACKLINKS_SCROLL_ROW, SIDEBAR_ROW_HEIGHT } from "@/components/ui/rows";
import { BacklinksSection } from "./BacklinksSection";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function mockFetch(backlinks: BacklinkDto[]) {
  return vi.fn(() =>
    Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks }) })),
  );
}

function renderSection(noteId: string | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BacklinksSection noteId={noteId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

const NOTE_ID = "11111111-1111-1111-1111-111111111111";

const BACKLINKS: BacklinkDto[] = [
  { id: "22222222-2222-2222-2222-222222222222", title: "Alpha", slug: "alpha" },
  { id: "33333333-3333-3333-3333-333333333333", title: "Beta", slug: null },
];

describe("BacklinksSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("0 篇 backlinks → 區塊仍在，顯示空狀態文案（不再整塊隱藏）", async () => {
    vi.stubGlobal("fetch", mockFetch([]));

    const { container, queryClient } = renderSection(NOTE_ID);

    // 等 query 真的 settle（success）才斷言——只等 fetch 被呼叫會在 pending 狀態
    // 就通過，測不出「拿到 0 篇之後」的行為。
    await waitFor(() =>
      expect(queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("success"),
    );
    expect(screen.getByText("No mentions yet")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("border-t");
  });

  it("noteId 尚未知道（筆記還沒載完）→ 不發請求；區塊留空列、不顯示任何文案", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { container } = renderSection(undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
    // 區塊本身保留（版面高度不跳動），但「有幾筆」未知時不得寫「尚無筆記提及」
    // ——那是謊報。
    expect(container.firstElementChild).not.toBeNull();
    expect(screen.queryByText("No mentions yet")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
  });

  it("查詢失敗 → 同樣只留空列，不噴錯誤也不謊報 0 筆", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fakeResponse({ ok: false, status: 500 }))),
    );

    const { container, queryClient } = renderSection(NOTE_ID);

    await waitFor(() =>
      expect(queryClient.getQueryState(["backlinks", NOTE_ID])?.status).toBe("error"),
    );
    expect(screen.queryByText("No mentions yet")).not.toBeInTheDocument();
    expect(container.textContent).toBe("");
  });

  it("N 篇 → 標題含篇數，逐條渲染標題文字與正確的 canonicalNotePath href", async () => {
    const fetchSpy = mockFetch(BACKLINKS);
    vi.stubGlobal("fetch", fetchSpy);

    renderSection(NOTE_ID);

    expect(await screen.findByText("Mentioned in 2 notes")).toBeInTheDocument();

    // 端點路徑釘死：不只驗證有打 fetch，還驗證打的是這篇筆記的 backlinks 端點
    // （不是隨便一個 URL 都會通過）。
    expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${NOTE_ID}/backlinks`, expect.anything());

    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", canonicalNotePath(BACKLINKS[0]));
    expect(screen.getByRole("link", { name: "Beta" })).toHaveAttribute("href", canonicalNotePath(BACKLINKS[1]));

    // 字面值錨點：canonicalNotePath 本身的行為已有 shared/NoteList 測試覆蓋，這裡多釘
    // 一個字面值，避免 `canonicalNotePath` 未來改行為時這支測試悄悄跟著失去意義
    // （比照 NoteList.test.tsx 的同款斷言形狀）。
    expect(canonicalNotePath(BACKLINKS[0])).toBe("/notes/alpha");
  });

  it("單數（1 篇）走 i18next 的 _one 分支", async () => {
    vi.stubGlobal("fetch", mockFetch([BACKLINKS[0]]));

    renderSection(NOTE_ID);

    expect(await screen.findByText("Mentioned in 1 note")).toBeInTheDocument();
  });

  it("chips 常駐可見，不需要點擊展開", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    renderSection(NOTE_ID);
    await screen.findByText("Mentioned in 2 notes");

    expect(screen.getByRole("link", { name: "Alpha" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Beta" })).toBeVisible();
  });

  it("chips 沒有折疊語意——沒有 <details>/<summary> 節點", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    const { container } = renderSection(NOTE_ID);
    await screen.findByText("Mentioned in 2 notes");

    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
  });

  // 撐高守衛：篇數多不得把內文卡撐高，也不得讓這一列變高。直接斷 class 字串
  // （比照 layout test 的手法，jsdom 不套 CSS）：
  //   footer 根   `shrink-0`（不被上方 flex-1 捲動容器吃高度）＋`border-t`
  //   內容列      SIDEBAR_ROW_HEIGHT（與側欄帳號列等高，見 ui/rows.ts）
  //   chips 容器  `overflow-x-scroll`（捲軸一律佔位）＋chip `shrink-0 whitespace-nowrap`
  //               （單排水平捲動；缺任一個都會變成換行→列被撐高）
  it("單排水平捲動守衛：footer shrink-0/border-t、內容列固定高、chips 不換行", async () => {
    vi.stubGlobal("fetch", mockFetch(BACKLINKS));

    const { container } = renderSection(NOTE_ID);
    const title = await screen.findByText("Mentioned in 2 notes");

    const footerRoot = container.firstElementChild;
    expect(footerRoot).not.toBeNull();
    // `py-2` 與帳號列容器的 `p-2` 是等高的另一半（列高本身由 SIDEBAR_ROW_HEIGHT
    // 管，見 ui/rows.ts）——這裡一起釘住，改成 py-3 之類會立刻紅。
    // 左右內距不在這一層：issue #88 之後由內容列套共用文章欄（見下一條斷言），
    // 外層維持滿卡寬，分隔線才橫跨整張卡。
    expect(footerRoot).toHaveClass("shrink-0", "border-t", "border-border", "py-2");
    expect(footerRoot?.className).not.toContain("px-");

    const row = title.parentElement;
    expect(row).not.toBeNull();
    expect(row).toHaveClass("flex", "items-center", SIDEBAR_ROW_HEIGHT);
    // issue #88：內容列＝文章欄（置中寬度鏈 ＋ 對齊內文首字的 70px 內縮），
    // 三處共用同一組常數的結構守衛在 `ui/article-column.guard.test.ts`。
    expect(row).toHaveClass(...ARTICLE_COLUMN.split(" "), ARTICLE_COLUMN_INSET);

    // 對齊補償必須做在 **chips 容器**（把 chips 往下推），不是標籤（把整組往上
    // 拉）——後者會讓整條列與側欄帳號列不共線，且 0 筆時捲軸不存在標籤仍偏上。
    expect(title.className).not.toContain("mb-2.5");

    const chip = screen.getByRole("link", { name: "Alpha" });
    const chipsContainer = chip.parentElement;
    expect(chipsContainer).not.toBeNull();
    // **同一排的結構守衛**：chips 容器必須是標籤那一列的兄弟（同一個 flex row）。
    // 少了這條，把 chips 容器搬到 row 外面變成第二行、class 一個都不用改，
    // 下面的 class 斷言仍會全綠，但版面（與等高）已經壞了。
    expect(chipsContainer?.parentElement).toBe(row);
    // `overflow-x-scroll`（不是 `-auto`）：捲軸一律佔位，chips 的垂直位置才不會
    // 隨「這篇有幾筆 backlinks」上下跳 5px，見元件註解。
    expect(chipsContainer).toHaveClass("flex", "min-w-0", "flex-1", "overflow-x-scroll");
    expect(chipsContainer?.className).not.toContain("overflow-x-auto");

    // 捲軸幾何整組走 ui/rows.ts 的常數（容器高＝列高＋捲軸、負邊距拉回、strip
    // 專用 6px 捲軸＋1px thumb border）。缺任一個，chips 就不再與標籤共線、
    // 或這一列被撐高。
    expect(chipsContainer).toHaveClass(...BACKLINKS_SCROLL_ROW.split(" "), "items-center");
    // 早期版本把補償寫成容器 `mt-2.5`（依賴全域 10px 捲軸），不得回退。
    expect(chipsContainer?.className).not.toContain("mt-2.5");

    // 幾何的另一半在 index.css：全域捲軸 10px，本 strip 的 `scrollbar-x-thin`
    // 覆寫成 6px（`h-[42px]` 的 42＝36＋6 就是照這個算的）。兩邊在這裡釘在一起
    // ——只改一邊會讓 chips 不再與標籤共線。讀檔前先剝註解（比照
    // theme.scrollbar-guard.test.ts）：整段被註解掉時不得還在註解文字裡命中。
    const indexCss = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // 全域那條的尺寸自 issue #111 起走 `--scrollbar-size` 變數（picker 的捲軸共用
    // 同一份值，見 theme.scrollbar-guard.test.ts）——所以要順著變數對值，不能只比
    // 字面。兩步都要：規則有引用變數 ＋ 變數就是 10px。
    expect(indexCss).toMatch(/(?<![\w.-])::-webkit-scrollbar\s*\{[^}]*height:\s*var\(--scrollbar-size\)/);
    expect(indexCss, "全域捲軸尺寸變了，本 strip 的 42＝36＋6 要重算").toMatch(/--scrollbar-size:\s*10px/);
    expect(indexCss).toMatch(/\.scrollbar-x-thin::-webkit-scrollbar\s*\{[^}]*height:\s*6px/);
    expect(indexCss).toMatch(/\.scrollbar-x-thin::-webkit-scrollbar-thumb\s*\{[^}]*border-width:\s*1px/);
    // 換行守衛：容器沒有 flex-wrap（預設 nowrap）且 chip 自己不被壓縮。
    expect(chipsContainer?.className).not.toContain("flex-wrap");
    expect(chip).toHaveClass("shrink-0", "whitespace-nowrap");
  });
});
