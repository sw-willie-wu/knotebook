import { describe, expect, it } from "vitest";
import { canonicalColor, isCustomColor, isShownColor, normalizeNoteColors } from "./note-colors.js";

const BOTH = "style (CSSOM) / data-*";
const DATA = "data-*";
// [input, expected, source]：source 是這個值會從哪條路徑進來（style 經 CSSOM 改寫，或 data-* 原字串）
const ACCEPT: [string, string, string][] = [
  ["red", "red", BOTH], ["default", "default", BOTH],
  ["#F60", "#ff6600", DATA], ["#FF6600", "#ff6600", DATA], ["#ff6600", "#ff6600", DATA],
  ["#ff6600ff", "#ff6600", DATA], ["#F60F", "#ff6600", DATA], ["#ff6600FF", "#ff6600", DATA],
  ["rgb(255, 102, 0)", "#ff6600", BOTH], ["rgb(1,2,3)", "#010203", DATA], ["rgb( 1 , 2 , 3 )", "#010203", DATA],
  ["rgb(1.5, 2, 3)", "#020203", "style (CSSOM, some browsers, unverified) / data-*"],
  ["rgb(0, 0, 0)", "#000000", BOTH], ["rgb(254.5, 0, 0)", "#ff0000", DATA],
];
const REJECT: [unknown, string][] = [
  ["RED", DATA], ["Red", DATA], ["#ff660080", DATA], ["#f608", DATA],
  ["rgb(256, 0, 0)", DATA], ["rgb(-1, 0, 0)", DATA], ["rgb(255.5, 0, 0)", DATA],
  ["rgb(1 2 3)", DATA], ["RGB(1,2,3)", DATA], ["rgb(100%, 0%, 0%)", DATA], ["rgb(1, 2)", DATA],
  ["rgb( 1,2,3)", DATA], // 非 CSS 空白（NBSP）不收
  ["rgba(255, 102, 0, 0.5)", BOTH], ["rgba(1, 2, 3, 1)", BOTH],
  ...["tomato", "transparent", "currentcolor", "var(--x)", "url(x)", "expression(x)", "oklch(0.7 0.1 30)",
    "lab(50 20 30)", "color(srgb 1 0 0)", "color-mix(in srgb, red, blue)", "", "ff6600", "#ff660", "#gggggg"]
    .map((v): [unknown, string] => [v, BOTH]),
  ...([3, null, undefined, {}] as unknown[]).map((v): [unknown, string] => [v, "non-string"]),
];

describe("canonicalColor", () => {
  it.each(ACCEPT.map(([input, expected, src]) => [src, input, expected] as const))("%s: %j -> %j", (_src, input, expected) => {
    expect(canonicalColor(input)).toBe(expected);
  });
  it.each(REJECT.map(([input, src]) => [src, input, null] as const))("%s: %j -> %j", (_src, input) => {
    expect(canonicalColor(input)).toBeNull();
  });
  it("tolerates CSS whitespace (tab/newline) inside rgb()", () => {
    expect(canonicalColor("rgb(\t1,\n2,\f3\r)")).toBe("#010203");
  });
});

describe("normalizeNoteColors", () => {
  const para = (props: Record<string, unknown>, styles: Record<string, unknown> = {}) => ({
    type: "paragraph", props, content: [{ type: "text", text: "x", styles }], children: [],
  });

  it("rewrites every color to its canonical form in place and returns null", () => {
    const blocks = [{ type: "paragraph", props: { textColor: "#F60", backgroundColor: "default" }, content: [{ type: "text", text: "x", styles: { backgroundColor: "rgb(1, 2, 3)" } }] }];
    expect(normalizeNoteColors(blocks)).toBeNull();
    expect(blocks[0]!.props.textColor).toBe("#ff6600");
    expect(blocks[0]!.props.backgroundColor).toBe("default");
    expect(blocks[0]!.content[0]!.styles.backgroundColor).toBe("#010203");
  });

  it("reaches link text, new-shape table cells and legacy inline-array cells", () => {
    const link = { type: "paragraph", props: {}, content: [{ type: "link", href: "https://e.com", content: [{ type: "text", text: "l", styles: { textColor: "#ABCDEF" } }] }] };
    const cell = { type: "tableCell", props: { backgroundColor: "#F00" }, content: [{ type: "text", text: "c", styles: { textColor: "rgb(0, 0, 255)" } }] };
    const legacyCell = [{ type: "text", text: "c", styles: { backgroundColor: "#0F0" } }];
    const table = { type: "table", props: {}, content: { type: "tableContent", rows: [{ cells: [cell, legacyCell] }] }, children: [] };
    expect(normalizeNoteColors([link, table])).toBeNull();
    expect(link.content[0]!.content[0]!.styles.textColor).toBe("#abcdef");
    expect(cell.props.backgroundColor).toBe("#ff0000");
    expect(cell.content[0]!.styles.textColor).toBe("#0000ff");
    expect(legacyCell[0]!.styles.backgroundColor).toBe("#00ff00");
  });

  it("returns the first value that cannot be shown", () => {
    expect(normalizeNoteColors([para({ textColor: "red" }, { backgroundColor: "tomato" })])).toBe("tomato");
    expect(normalizeNoteColors([para({}, { textColor: "#ff660080" })])).toBe("#ff660080");
  });

  it("does not overflow the stack on 5000-deep nesting or a 100k-element array", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- synthetic tree, mutated while building
    const root: any = para({});
    let cur = root;
    for (let i = 0; i < 5000; i++) {
      const next = para({});
      cur.children.push(next);
      cur = next;
    }
    cur.content = [{ type: "text", text: "deep", styles: { textColor: "#F60" } }];
    expect(normalizeNoteColors([root])).toBeNull();
    expect(cur.content[0].styles.textColor).toBe("#ff6600");
    const wide = Array.from({ length: 100_000 }, () => para({ textColor: "red" }));
    expect(normalizeNoteColors(wide)).toBeNull();
  });

  it("rejects a non-string color and reports it as a string", () => {
    expect(normalizeNoteColors([para({ backgroundColor: 3 })])).toBe("3");
  });
});

describe("isCustomColor / isShownColor", () => {
  it("isCustomColor only accepts canonical lowercase #rrggbb", () => {
    expect(isCustomColor("#ff6600")).toBe(true);
    expect(isCustomColor("#FF6600")).toBe(false);
    expect(isCustomColor("red")).toBe(false);
  });
  it("isShownColor", () => {
    expect(isShownColor("red")).toBe(true);
    expect(isShownColor("#ff6600")).toBe(true);
    for (const v of ["default", "#FF6600", "rgb(1, 2, 3)", 3]) expect(isShownColor(v)).toBe(false);
  });
});
