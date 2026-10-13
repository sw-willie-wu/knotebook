import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AiPreview } from "@/ai/preview";
import type { DiffBlock } from "@/lib/version-diff";
import { ThemeProvider } from "@/theme";
import { SelectionAiPreview } from "./SelectionAiPreview";

const para = (id: string, text: string): DiffBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

function makePreview(afterText: string): AiPreview {
  return { before: [para("a1", "original middle sentence")], after: [para("n1", afterText)], noChange: false };
}

describe("SelectionAiPreview（#263 §5.4）", () => {
  it("只渲染被改的區塊，每塊照 diff 標記（added／deleted／changed）", async () => {
    render(
      <ThemeProvider>
        <SelectionAiPreview preview={makePreview("totally new text")} onReady={() => {}} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="selection-ai-preview"] .bn-block-outer[data-id]')).map((el) =>
      el.getAttribute("data-diff"),
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark === "added" || mark === "deleted" || mark === "changed")).toBe(true);
  });

  it("就緒訊號：掛載後 onReady(那份 preview)；preview 換新 → 先 onReady(null) 再 onReady(新的)；卸載 → onReady(null)", async () => {
    const onReady = vi.fn();
    const first = makePreview("first result");
    const second = makePreview("second result");
    const { rerender, unmount } = render(
      <ThemeProvider>
        <SelectionAiPreview preview={first} onReady={onReady} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    expect(onReady.mock.calls).toEqual([[first]]);
    rerender(
      <ThemeProvider>
        <SelectionAiPreview preview={second} onReady={onReady} />
      </ThemeProvider>,
    );
    expect(onReady.mock.calls).toEqual([[first], [null], [second]]);
    unmount();
    expect(onReady.mock.calls.at(-1)).toEqual([null]);
  });
});

describe("index.css：框選 AI 預覽的樣式規則（#263 §5.3、§5.4）", () => {
  const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
  it("沒有上下文塊的淡色規則（#263 後續：預覽不再帶前後上下文，surround 已移除）", () => {
    expect(css).not.toContain('data-diff="surround"');
  });
  it("框內唯讀編輯器左右內距歸零，選擇器墊到 (0,3,0)", () => {
    expect(css).toMatch(/\.kb-ai-preview \.bn-editor\.bn-editor \{[^}]*padding-inline: 0;/);
  });
  it("四種色條改 inset box-shadow 並拿掉 border-left，選擇器 (0,4,0)", () => {
    for (const mark of ["added", "deleted", "changed", "moved"]) {
      expect(css).toMatch(new RegExp(`\\.kb-ai-preview \\.kb-diff \\[data-diff="${mark}"\\] > \\.bn-block \\{[^}]*border-left: 0;[^}]*box-shadow: inset 3px 0 0 `));
    }
  });
});
