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
