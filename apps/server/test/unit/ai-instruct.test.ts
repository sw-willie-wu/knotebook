import { describe, expect, it } from "vitest";
import { checkInstructFields, INSTRUCT_GUARD_PROMPT, MARKUP_GUARD_PROMPT, withInstructGuard, withMarkupGuard, wrapInstructVars } from "../../src/ai/instruct.js";

// Side-by-side columns: this text precedes every in-site AI action's system prompt, and admins can't change it.
describe("MARKUP_GUARD_PROMPT/withMarkupGuard", () => {
  it("covers the columns wrapper and column tags, image width, and table colwidth", () => {
    expect(MARKUP_GUARD_PROMPT).toContain("data-kb-columns");
    expect(MARKUP_GUARD_PROMPT).toContain("<div data-kb-column ");
    expect(MARKUP_GUARD_PROMPT).toContain("width");
    expect(MARKUP_GUARD_PROMPT).toContain("colwidth");
    // Whole text verbatim (pinning fragments would stay green if the closing-</div> clause were dropped); docs/ai.md paraphrases this
    expect(MARKUP_GUARD_PROMPT).toBe(
      [
        "The note content you are given is Markdown and may include HTML that the editor uses for side-by-side columns and for sizes. Wherever your reply keeps that content, keep its HTML as it is:",
        "- Every <div data-kb-columns …> and <div data-kb-column …> line, and each </div> line that closes one, stays exactly as written, on a line of its own, with the blank lines around it unchanged. Inside a column, write Markdown as usual.",
        "- An image's width attribute and a table cell's colwidth attribute keep their values.",
        "- Every <!-- knotebook:knowledge … --> comment stays exactly as written, on the lines right after its heading, with a blank line after it.",
      ].join("\n"),
    );
  });

  it("asks to keep knotebook:knowledge comments right after their heading", () => {
    expect(MARKUP_GUARD_PROMPT).toContain("<!-- knotebook:knowledge … --> comment stays exactly as written");
    expect(MARKUP_GUARD_PROMPT).toContain("on the lines right after its heading, with a blank line after it.");
  });

  it("fixed text first, blank line, then the action's system prompt; an empty action prompt yields only the fixed text", () => {
    expect(withMarkupGuard("sp")).toBe(`${MARKUP_GUARD_PROMPT}\n\nsp`);
    expect(withMarkupGuard("")).toBe(MARKUP_GUARD_PROMPT);
  });
});

describe("Instruct guard (#263)", () => {
  it("guard text references the three fixed marker names", () => {
    for (const tag of ["<text>", "<selected>", "<instruction>"]) expect(INSTRUCT_GUARD_PROMPT).toContain(tag);
  });

  it("withInstructGuard: guard first, blank line, then the action's own system prompt", () => {
    expect(withInstructGuard("tone: friendly")).toBe(`${INSTRUCT_GUARD_PROMPT}\n\ntone: friendly`);
  });

  it("wrapInstructVars: each of the three variables is wrapped in its fixed marker; missing or empty focus -> <selected></selected>", () => {
    expect(wrapInstructVars({ text: "body", instruction: "shorten", focus: "bo" })).toEqual({
      instruction: "<instruction>\nshorten\n</instruction>",
      focus: "<selected>\nbo\n</selected>",
      text: "<text>\nbody\n</text>",
    });
    expect(wrapInstructVars({ text: "body", instruction: "x" }).focus).toBe("<selected></selected>");
    expect(wrapInstructVars({ text: "body", instruction: "x", focus: "" }).focus).toBe("<selected></selected>");
  });
});

describe("checkInstructFields (pure-function half of the #263 matrix)", () => {
  it("Instruct: missing, empty, or whitespace-only (incl. full-width space U+3000, tab) -> fails", () => {
    for (const instruction of [undefined, "", "   ", "　\t "]) {
      expect(checkInstructFields(true, instruction, undefined).ok).toBe(false);
    }
  });

  it("Instruct: 500 code points after trim pass, 501 fails; 500 emoji (1000 UTF-16 units) pass", () => {
    expect(checkInstructFields(true, `  ${"字".repeat(500)}  `, undefined)).toEqual({ ok: true, instruct: { instruction: "字".repeat(500) } });
    expect(checkInstructFields(true, "字".repeat(501), undefined).ok).toBe(false);
    expect(checkInstructFields(true, "😀".repeat(500), undefined).ok).toBe(true);
  });

  it("Instruct: focus up to 2000 code points passes (2000 emoji), 2001 fails; focus is returned as-is (not trimmed)", () => {
    expect(checkInstructFields(true, "x", "😀".repeat(2000)).ok).toBe(true);
    expect(checkInstructFields(true, "x", "😀".repeat(2001)).ok).toBe(false);
    expect(checkInstructFields(true, " x ", " sel ")).toEqual({ ok: true, instruct: { instruction: "x", focus: " sel " } });
  });

  it("non-Instruct: instruction or focus present (even empty) fails; neither present -> ok with instruct null", () => {
    expect(checkInstructFields(false, "", undefined).ok).toBe(false);
    expect(checkInstructFields(false, "do it", undefined).ok).toBe(false);
    expect(checkInstructFields(false, undefined, "").ok).toBe(false);
    expect(checkInstructFields(false, undefined, undefined)).toEqual({ ok: true, instruct: null });
  });
});
