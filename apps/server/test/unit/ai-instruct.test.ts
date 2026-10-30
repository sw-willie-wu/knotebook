import { describe, expect, it } from "vitest";
import { checkInstructFields, INSTRUCT_GUARD_PROMPT, MARKUP_GUARD_PROMPT, withInstructGuard, withMarkupGuard, wrapInstructVars } from "../../src/ai/instruct.js";

// 並排 PR-2（Q4）：每個站內 AI 動作的 system prompt 前面都放這段，管理員改不掉。
describe("MARKUP_GUARD_PROMPT／withMarkupGuard", () => {
  it("MG1：講到並排的外層與欄標籤、圖片的 width、表格的 colwidth", () => {
    expect(MARKUP_GUARD_PROMPT).toContain("data-kb-columns");
    expect(MARKUP_GUARD_PROMPT).toContain("<div data-kb-column ");
    expect(MARKUP_GUARD_PROMPT).toContain("width");
    expect(MARKUP_GUARD_PROMPT).toContain("colwidth");
    // 整段逐字（T9＋T10 審查 r1 M-3：只釘片段時刪掉「</div> 收尾行」那半句照綠）；docs/ai.md 的轉述以此為準
    expect(MARKUP_GUARD_PROMPT).toBe(
      [
        "The note content you are given is Markdown and may include HTML that the editor uses for side-by-side columns and for sizes. Wherever your reply keeps that content, keep its HTML as it is:",
        "- Every <div data-kb-columns …> and <div data-kb-column …> line, and each </div> line that closes one, stays exactly as written, on a line of its own, with the blank lines around it unchanged. Inside a column, write Markdown as usual.",
        "- An image's width attribute and a table cell's colwidth attribute keep their values.",
      ].join("\n"),
    );
  });

  it("MG2：固定說明在前、空行、再接動作的 system prompt；動作 prompt 為空字串時只有固定說明", () => {
    expect(withMarkupGuard("sp")).toBe(`${MARKUP_GUARD_PROMPT}\n\nsp`);
    expect(withMarkupGuard("")).toBe(MARKUP_GUARD_PROMPT);
  });
});

describe("Instruct 守門（#263 §4.2）", () => {
  it("守門文字引用三個固定標記名", () => {
    for (const tag of ["<text>", "<selected>", "<instruction>"]) expect(INSTRUCT_GUARD_PROMPT).toContain(tag);
  });

  it("withInstructGuard：守門在前、空行、再接動作自己的 system prompt", () => {
    expect(withInstructGuard("tone: friendly")).toBe(`${INSTRUCT_GUARD_PROMPT}\n\ntone: friendly`);
  });

  it("wrapInstructVars：三個變數各包固定標記；focus 沒帶或空字串 → <selected></selected>", () => {
    expect(wrapInstructVars({ text: "body", instruction: "shorten", focus: "bo" })).toEqual({
      instruction: "<instruction>\nshorten\n</instruction>",
      focus: "<selected>\nbo\n</selected>",
      text: "<text>\nbody\n</text>",
    });
    expect(wrapInstructVars({ text: "body", instruction: "x" }).focus).toBe("<selected></selected>");
    expect(wrapInstructVars({ text: "body", instruction: "x", focus: "" }).focus).toBe("<selected></selected>");
  });
});

describe("checkInstructFields（#263 §4.3 矩陣的純函式半邊）", () => {
  it("Instruct：缺、空字串、只有空白（含全形空白 U+3000、tab）→ 失敗（RF2）", () => {
    for (const instruction of [undefined, "", "   ", "　\t "]) {
      expect(checkInstructFields(true, instruction, undefined).ok).toBe(false);
    }
  });

  it("Instruct：trim 後 500 code point 通過、501 失敗；500 個 emoji（1000 個 UTF-16 單位）通過（RF2）", () => {
    expect(checkInstructFields(true, `  ${"字".repeat(500)}  `, undefined)).toEqual({ ok: true, instruct: { instruction: "字".repeat(500) } });
    expect(checkInstructFields(true, "字".repeat(501), undefined).ok).toBe(false);
    expect(checkInstructFields(true, "😀".repeat(500), undefined).ok).toBe(true);
  });

  it("Instruct：focus ≤ 2000 code point 通過（2000 個 emoji）、2001 失敗；focus 原樣帶回（不 trim）", () => {
    expect(checkInstructFields(true, "x", "😀".repeat(2000)).ok).toBe(true);
    expect(checkInstructFields(true, "x", "😀".repeat(2001)).ok).toBe(false);
    expect(checkInstructFields(true, " x ", " sel ")).toEqual({ ok: true, instruct: { instruction: "x", focus: " sel " } });
  });

  it("非 Instruct：帶 instruction（含空字串）或 focus（含空字串）都失敗；兩者都沒帶 → 成功且 instruct 為 null", () => {
    expect(checkInstructFields(false, "", undefined).ok).toBe(false);
    expect(checkInstructFields(false, "do it", undefined).ok).toBe(false);
    expect(checkInstructFields(false, undefined, "").ok).toBe(false);
    expect(checkInstructFields(false, undefined, undefined)).toEqual({ ok: true, instruct: null });
  });
});
