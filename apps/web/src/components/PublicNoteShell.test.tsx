import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PublicNoteErrorBoundary, PublicNoteFallback } from "./PublicNoteShell";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PublicNoteFallback（#72 Task 3：/p/ chunk 載入中的專屬 fallback）", () => {
  it("極簡 loading 卡：loading 文案在場、**沒有** AppShell（側欄的 New note／搜尋都不得露給匿名者）", () => {
    render(<PublicNoteFallback />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("New note")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});

describe("PublicNoteErrorBoundary（#72 Task 3：/p/ 的 chunk／render 錯誤邊界）", () => {
  function Boom(): never {
    throw new Error("failed to fetch dynamically imported module: /assets/PublicNotePage-x.js");
  }

  it("正常時原樣渲染 children", () => {
    render(
      <PublicNoteErrorBoundary reload={vi.fn()}>
        <p>public-content</p>
      </PublicNoteErrorBoundary>,
    );
    expect(screen.getByText("public-content")).toBeInTheDocument();
  });

  it("child throw → 錯誤卡（role=alert＋載入失敗文案＋重試鈕）；**不**自動 reload（公開頁沒有旗標額度機制，手動重試是唯一出口）", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <PublicNoteErrorBoundary reload={reload}>
        <Boom />
      </PublicNoteErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load this page — check your connection and try again.")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    // 錯誤卡也不得包 AppShell（同 fallback：匿名者拿不到側欄）
    expect(screen.queryByText("New note")).not.toBeInTheDocument();
  });

  it("按重試 → 整頁 reload 恰一次", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <PublicNoteErrorBoundary reload={reload}>
        <Boom />
      </PublicNoteErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("離線時重試鈕 disabled＋顯示離線說明（離線 reload 只會落到瀏覽器錯誤頁——比照 ErrorBoundary 兩個錯誤畫面的既有行為）", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // 與 ErrorBoundary.test.tsx 同款手法：defineProperty 蓋 instance own property，
    // afterEach 的 restoreAllMocks 管不到它，這裡自己刪回（回落到 prototype getter）。
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      render(
        <PublicNoteErrorBoundary reload={vi.fn()}>
          <Boom />
        </PublicNoteErrorBoundary>,
      );
      expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
      expect(
        screen.getByText("You appear to be offline — this button will re-enable when the connection returns."),
      ).toBeInTheDocument();
    } finally {
      delete (window.navigator as unknown as Record<string, unknown>).onLine;
    }
  });
});

// ──────────────── 滿版外框（user 定案，對齊 #115 之後主 app 的滿版語彙） ────────────────

describe("PublicPageFrame（滿版外框）", () => {
  it("frame 層鋪滿視窗（h-screen＋flex flex-col＋overflow-hidden＋bg-card）、無卡片語彙", async () => {
    // 動態 import：本檔頭部的具名 import 沒帶 PublicPageFrame，避免動舊測試的 import 行。
    const { PublicPageFrame } = await import("./PublicNoteShell");
    render(
      <PublicPageFrame>
        <p data-testid="probe">content</p>
      </PublicPageFrame>,
    );
    const probe = screen.getByTestId("probe");
    // 只斷 **frame 自己那一層**（probe 的直接父層）：頁面內容合法帶 border-b 分隔線
    // 與 rounded 徽章，鏈式掃描會誤殺——卡片語彙的禁令只針對外框。
    const frame = probe.parentElement!;
    // 高度/捲動鏈四件套缺一不可（審查 M2 突變實證）：flex+flex-col 是內文
    // `min-h-0 flex-1 overflow-y-auto` 的前提，overflow-hidden 是「頁面本身不得
    // 整體捲動」的支點（AppShell 同款鏈），h-screen 定根高。
    // token 比對、非子字串（geometry memory 記載的 #88 前科：includes 放行過本尊
    // ——`min-h-screen` 內含 "h-screen"、`flex-col` 內含 "flex"，字串形兩個退化都放行）
    // 底色是 bg-card（第五件、同樣承重）：BlockNote 編輯器全域畫 --color-card 底
    // （index.css）——frame 用更深的 bg-background 時，文章欄寬的卡色長條浮在頁底
    // 上、看起來仍像一張內文卡（user 二次回報實證）。整頁同卡色才是「滿版一色」。
    const tokens = frame.className.split(/\s+/);
    for (const cls of ["h-screen", "flex", "flex-col", "overflow-hidden", "bg-card"]) {
      expect(tokens).toContain(cls);
    }
    // 卡面退場：無 max-w 上限、無圓角、無邊框（滿版定案——不是置中卡）
    expect(frame.className).not.toMatch(/max-w-|rounded|border/);
    // frame 直接包 children（中間不再有卡層）
    expect(frame.parentElement?.className ?? "").toBe(""); // RTL 容器
  });
});
