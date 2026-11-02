import { createRef, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { ShortcutsDialog } from "./ShortcutsDialog";

/**
 * 快捷鍵介紹頁的對話框外殼（plan 2026-11-02-shortcuts-modal T5）：lazy 邊界、名稱與描述、焦點（開啟聚焦內容捲動容器、
 * Tab 在容器與 ✕ 之間循環、關閉還焦點）。內容元件換成替身——它自己的行為在 ShortcutsLazy.test.tsx。
 *
 * ⚠⚠ D1 必須是本檔第一個 `it`：`vi.mock` 的 factory 一個檔只執行一次，`React.lazy` 的結果又永久快取
 * （同 App.lazyPages.test.tsx 的做法）。`mockState.loaded` 由 factory 設——factory 執行＝lazy 的第一次動態 import；
 * 所以 D1 斷言 open=false 時它還是 false，換成靜態 import 就會紅。
 */

const mockState = vi.hoisted(() => ({ loaded: false }));

vi.mock("@/components/shortcuts/ShortcutsLazy", () => {
  mockState.loaded = true;
  // 替身不得含任何可聚焦元素（D7：否則 region 不再是最後一個 tabbable）。
  return { ShortcutsContent: () => <p>stub shortcuts content</p> };
});

/** 每案自己建一份 ref：計時器洩到下一案時（Radix 卸載後 setTimeout(0) 才發 onCloseAutoFocus）不會碰到別案的 ref。 */
function newRef(): RefObject<HTMLElement | null> {
  return createRef<HTMLElement>();
}

function ui(open: boolean, onOpenChange: (open: boolean) => void, returnFocusRef: RefObject<HTMLElement | null> = newRef()) {
  return (
    <>
      <button type="button">opener</button>
      <button type="button">target</button>
      <ShortcutsDialog open={open} onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />
    </>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ShortcutsDialog", () => {
  it("D1 open=false：沒有 dialog，內容 chunk 還沒載入", () => {
    render(ui(false, () => {}));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockState.loaded).toBe(false);
  });

  it("D2 open=true：dialog 有名稱與描述、內容出現、✕ 名稱 Close、region 可 Tab 到", async () => {
    render(ui(true, () => {}));
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toHaveAccessibleDescription("Common keyboard shortcuts and typing triggers");
    expect(await screen.findByText("stub shortcuts content")).toBeInTheDocument();
    expect(mockState.loaded).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Keyboard shortcuts" });
    expect(region.tabIndex).toBe(0);
  });

  it("D3 Esc 與點 ✕ 都呼叫 onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(ui(true, onOpenChange));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("D4 關閉後焦點回到 returnFocusRef 指的元素（不是開啟前碰巧停的那顆）", async () => {
    const onOpenChange = vi.fn();
    const ref = newRef();
    const view = render(ui(false, onOpenChange, ref));
    const opener = screen.getByRole("button", { name: "opener" });
    const target = screen.getByRole("button", { name: "target" });
    opener.focus();
    ref.current = target;
    view.rerender(ui(true, onOpenChange, ref));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    view.rerender(ui(false, onOpenChange, ref));
    await waitFor(() => expect(target).toHaveFocus());
  });

  it("D5 returnFocusRef 指向已移除的元素：關閉不丟錯", async () => {
    const onOpenChange = vi.fn();
    const ref = newRef();
    const view = render(ui(false, onOpenChange, ref));
    const gone = document.createElement("button");
    ref.current = gone; // 從沒掛進 document：isConnected 為 false
    view.rerender(ui(true, onOpenChange, ref));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(() => view.rerender(ui(false, onOpenChange, ref))).not.toThrow();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ref.current).toBeNull();
  });

  it("D6 開啟後焦點在內容捲動容器（region）", async () => {
    render(ui(true, () => {}));
    const region = await screen.findByRole("region", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("D7 Tab 在 region 與 ✕ 之間循環（FocusScope loop）", async () => {
    render(ui(true, () => {}));
    const region = await screen.findByRole("region", { name: "Keyboard shortcuts" });
    await waitFor(() => expect(region).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(region, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(region).toHaveFocus();
  });
});
