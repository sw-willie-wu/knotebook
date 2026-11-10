import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { CUSTOM_COLORS_STYLE_ID, resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor, renderAiHost, selectInBlock } from "@/test/ai-host";
import { applyColor } from "./apply-color";

beforeEach(() => {
  localStorage.clear();
  resetRecentColorsForTest();
});
afterEach(() => {
  resetCustomColorsForTest();
});

function selectors(): string[] {
  const sheet = (document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null)?.sheet;
  return sheet ? Array.from(sheet.cssRules).map((r) => (r as CSSStyleRule).selectorText) : [];
}

function setup() {
  const editor = createTestEditor([
    { id: "p1", type: "paragraph", content: "hello world" },
    { id: "p2", type: "paragraph", content: "second" },
    { id: "c1", type: "codeBlock", content: "let a" },
  ]);
  renderAiHost({ editor });
  return editor;
}

describe("applyColor", () => {
  it("AP1 行內套色碼：styles 寫成正規形、只登記行內規則；default 移除", () => {
    const ed = setup();
    selectInBlock(ed, "p1", 0, 5);
    let ok = false;
    act(() => {
      ok = applyColor(ed, "text", { kind: "inline" }, "#F60");
    });
    expect(ok).toBe(true);
    const first = (ed.document[0]!.content as { text: string; styles: Record<string, string> }[])[0]!;
    expect(first.styles.textColor).toBe("#ff6600");
    const sels = selectors();
    expect(sels).toContain('[data-style-type="textColor"][data-value="#ff6600"]');
    expect(sels.some((s) => s.startsWith('[data-text-color="#ff6600"]') || s.includes(":has("))).toBe(false);

    selectInBlock(ed, "p1", 0, 5);
    act(() => {
      applyColor(ed, "text", { kind: "inline" }, "default");
    });
    const after = (ed.document[0]!.content as { styles: Record<string, string> }[])[0]!;
    expect(after.styles.textColor).toBeUndefined();
  });

  it("AP2 block 套底色碼：props 寫成正規形、登記 block 規則", () => {
    const ed = setup();
    let ok = false;
    act(() => {
      ok = applyColor(ed, "background", { kind: "block", blockId: "p1" }, "#00FF00");
    });
    expect(ok).toBe(true);
    expect(ed.getBlock("p1")!.props.backgroundColor).toBe("#00ff00");
    expect(selectors()).toContain('[data-background-color="#00ff00"]');
  });

  it("AP3 不是顏色的值回 false、文件不變", () => {
    const ed = setup();
    selectInBlock(ed, "p1", 0, 5);
    const before = JSON.stringify(ed.document);
    expect(applyColor(ed, "text", { kind: "inline" }, "tomato")).toBe(false);
    expect(applyColor(ed, "background", { kind: "block", blockId: "p1" }, "tomato")).toBe(false);
    expect(JSON.stringify(ed.document)).toBe(before);
  });

  it("AP4 block 已不存在回 false、不丟例外、不登記規則", () => {
    const ed = setup();
    act(() => {
      ed.removeBlocks(["p1"]);
    });
    let ok = true;
    expect(() => {
      ok = applyColor(ed, "background", { kind: "block", blockId: "p1" }, "#00ff00");
    }).not.toThrow();
    expect(ok).toBe(false);
    expect(selectors()).toEqual([]);
  });

  it("AP5 block 種類沒有該 prop（codeBlock 沒有 backgroundColor）回 false、不登記規則", () => {
    const ed = setup();
    expect(ed.getBlock("c1")!.props).not.toHaveProperty("backgroundColor");
    const before = JSON.stringify(ed.document);
    expect(applyColor(ed, "background", { kind: "block", blockId: "c1" }, "#00ff00")).toBe(false);
    expect(JSON.stringify(ed.document)).toBe(before);
    expect(selectors()).toEqual([]);
  });

  it("AP6 色盤名原樣寫入、不登記任何規則（行內與 block）", () => {
    const ed = setup();
    selectInBlock(ed, "p1", 0, 5);
    let ok = false;
    act(() => {
      ok = applyColor(ed, "text", { kind: "inline" }, "red");
    });
    expect(ok).toBe(true);
    expect((ed.document[0]!.content as { styles: Record<string, string> }[])[0]!.styles.textColor).toBe("red");
    act(() => {
      ok = applyColor(ed, "background", { kind: "block", blockId: "p2" }, "blue");
    });
    expect(ok).toBe(true);
    expect(ed.getBlock("p2")!.props.backgroundColor).toBe("blue");
    expect(selectors()).toEqual([]);
  });
});
