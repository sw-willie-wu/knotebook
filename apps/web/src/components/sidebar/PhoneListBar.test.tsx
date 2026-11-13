import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PhoneListBar } from "./PhoneListBar";

interface BarOverrides {
  query?: string;
  active?: boolean;
  showNewNote?: boolean;
  newNotePending?: boolean;
}

function renderBar(overrides: BarOverrides = {}) {
  const onQueryChange = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onCreateNote = vi.fn();
  const searchRef = createRef<HTMLInputElement>();
  render(
    <PhoneListBar
      query={overrides.query ?? ""}
      onQueryChange={onQueryChange}
      searchRef={searchRef}
      active={overrides.active ?? false}
      onOpen={onOpen}
      onClose={onClose}
      showNewNote={overrides.showNewNote ?? true}
      onCreateNote={onCreateNote}
      newNotePending={overrides.newNotePending ?? false}
    />,
  );
  return { onQueryChange, onOpen, onClose, onCreateNote, searchRef };
}

describe("PhoneListBar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("搜尋框 44 高、16px 字級（防 iOS 放大），沒有 Ctrl K 徽章", () => {
    renderBar();
    const input = screen.getByRole("textbox", { name: "Search notes" });
    expect(input).toHaveClass("h-11");
    expect(input).toHaveClass("text-base");
    expect(input.className).not.toContain("text-[13px]");
    expect(screen.queryByText("Ctrl K")).toBeNull();
  });

  it("沒在搜尋：右側是 44 高的「New note」，按了呼叫 onCreateNote；建立中停用", () => {
    const { onCreateNote } = renderBar();
    const button = screen.getByRole("button", { name: "New note" });
    expect(button).toHaveClass("h-11");
    fireEvent.click(button);
    expect(onCreateNote).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("建立中：New note 停用", () => {
    renderBar({ newNotePending: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
  });

  it("showNewNote 為 false（垃圾桶）：沒有 New note，只剩搜尋框", () => {
    renderBar({ showNewNote: false });
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
  });

  it("搜尋層開著：Cancel 取代 New note；點了清空字、讓搜尋框失焦並關搜尋層", () => {
    const { onQueryChange, onClose, searchRef } = renderBar({ active: true, query: "alp" });
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveClass("h-11");
    const input = screen.getByRole("textbox", { name: "Search notes" });
    input.focus();
    expect(searchRef.current).toBe(input);
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(input).not.toHaveFocus();
  });

  it("聚焦開搜尋層；失焦不關（點結果、收鍵盤都會失焦）", () => {
    const { onOpen, onClose } = renderBar();
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("打字呼叫 onQueryChange；Esc 清空、失焦並關搜尋層", () => {
    const { onQueryChange, onClose } = renderBar({ query: "x" });
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "xy" } });
    expect(onQueryChange).toHaveBeenLastCalledWith("xy");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onQueryChange).toHaveBeenLastCalledWith("");
    expect(input).not.toHaveFocus();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("列高 56（內距 6＋44＋6）加底部 safe area", () => {
    const { searchRef } = renderBar();
    const bar = searchRef.current?.closest("[data-phone-list-bar]");
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain("env(safe-area-inset-bottom)");
    expect(bar).toHaveClass("pt-1.5");
  });

  describe("鍵盤開著", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;

    function setKeyboard(inset: number) {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    }

    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal("innerHeight", 800);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    });

    function bar() {
      return document.querySelector<HTMLElement>("[data-phone-list-bar]")!;
    }

    it("鍵盤收著：列在文件流裡（沒有 margin-bottom），有 New note 與 safe area", () => {
      renderBar();
      expect(bar()).not.toHaveClass("fixed");
      expect(bar().style.bottom).toBe("");
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
      expect(bar().className).toContain("env(safe-area-inset-bottom)");
    });

    it("鍵盤升起：列仍在文件流裡、margin-bottom＝鍵盤高（結果區跟著縮短），只留搜尋框，沒有 New note、沒有 safe area 內距", () => {
      renderBar();
      setKeyboard(300);
      expect(bar()).not.toHaveClass("fixed");
      expect(bar()).toHaveClass("shrink-0");
      expect(bar().style.marginBottom).toBe("300px");
      expect(screen.getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
      expect(bar().className).not.toContain("env(safe-area-inset-bottom)");
    });

    it("鍵盤升起且搜尋層開著：Cancel 也收起", () => {
      renderBar({ active: true });
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      setKeyboard(300);
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    });

    it("高度差在門檻以內：不算鍵盤，列照舊", () => {
      renderBar();
      setKeyboard(60);
      expect(bar()).not.toHaveClass("fixed");
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    });

    it("鍵盤收起：回到文件流、按鈕回來", () => {
      renderBar();
      setKeyboard(300);
      setKeyboard(0);
      expect(bar().style.marginBottom).toBe("");
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    });
  });
});
