import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AiPreview } from "@/ai/preview";
import type { DiffBlock } from "@/lib/version-diff";
import { ThemeProvider } from "@/theme";
import { SelectionAiPreview } from "./SelectionAiPreview";

const para = (id: string, text: string): DiffBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });

function makePreview(afterText: string): AiPreview {
  const before = [para("s1", "context before"), para("a1", "original middle sentence"), para("s2", "context after")];
  const after = [before[0]!, para("n1", afterText), before[2]!];
  return { before, after, surroundIds: ["s1", "s2"], noChange: false };
}

const outer = (id: string) => document.querySelector<HTMLElement>(`[data-testid="selection-ai-preview"] .bn-block-outer[data-id="${id}"]`);

describe("SelectionAiPreview（#263 §5.4）", () => {
  it("上下文塊貼 data-diff=\"surround\"（在 .bn-block-outer 上）；中間照 diff 標記", async () => {
    render(
      <ThemeProvider>
        <SelectionAiPreview preview={makePreview("totally new text")} onReady={() => {}} />
      </ThemeProvider>,
    );
    await screen.findByTestId("selection-ai-preview");
    expect(outer("s1")).toHaveAttribute("data-diff", "surround");
    expect(outer("s2")).toHaveAttribute("data-diff", "surround");
    const marks = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="selection-ai-preview"] .bn-block-outer[data-id]'))
      .map((el) => el.getAttribute("data-diff"))
      .filter((mark) => mark !== "surround");
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
  it("上下文塊淡色（不改版面）", () => {
    expect(css).toMatch(/\.kb-diff \[data-diff="surround"\] > \.bn-block \{[^}]*opacity:/);
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
