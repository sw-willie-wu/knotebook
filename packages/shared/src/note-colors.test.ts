import { describe, expect, it } from "vitest";
import { canonicalColor, isCustomColor, isShownColor } from "./note-colors.js";

const BOTH = "style (CSSOM) / data-*";
const DATA = "data-*";
// [input, expected, source]（來源見 spec §11.1）
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
