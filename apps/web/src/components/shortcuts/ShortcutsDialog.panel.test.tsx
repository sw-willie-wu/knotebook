import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { ShortcutsDialog } from "./ShortcutsDialog";

/**
 * 外殼（ShortcutsDialog）＋真的內容元件（ShortcutsLazy）合在一起的行為：開啟落點、Tab 循環、選分類不關對話框。
 * 外殼單獨的行為（lazy 邊界、名稱、還焦點）在 ShortcutsDialog.test.tsx（內容換成替身）；內容單獨的在 ShortcutsLazy.test.tsx。
 */

function renderOpen(onOpenChange: (open: boolean) => void = () => {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/ai/actions") return Promise.resolve(new Response(JSON.stringify({ actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ShortcutsDialog open onOpenChange={onOpenChange} returnFocusRef={createRef<HTMLElement>()} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShortcutsDialog＋ShortcutsContent", () => {
  it("W1 第一次開啟（chunk 還在下載）：對話框先有名稱；內容到了之後焦點落在右卡內容區，名稱是「General」", async () => {
    renderOpen();
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    const region = await screen.findByRole("region", { name: "General" });
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("W2 Tab 在內容區與 ✕ 之間循環（左欄分類鈕與窄螢幕的返回鈕夾在中間）", async () => {
    renderOpen();
    const region = await screen.findByRole("region", { name: "General" });
    await waitFor(() => expect(region).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(region, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(region).toHaveFocus();
  });

  it("W3 DOM 順序：✕ → 左欄分類鈕 → 右卡內容區（開啟落點與 Tab 循環依賴它）", async () => {
    renderOpen();
    const region = await screen.findByRole("region", { name: "General" });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const firstCategory = within(dialog).getByRole("button", { name: "General" });
    const order = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order(close, firstCategory)).toBe(true);
    expect(order(firstCategory, region)).toBe(true);
  });

  it("W4 選分類：對話框不關、右卡換成那一類（Esc 才關）", async () => {
    const onOpenChange = vi.fn();
    renderOpen(onOpenChange);
    await screen.findByRole("region", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("region", { name: "Columns" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
