import { describe, expect, it } from "vitest";
import { firstGrapheme, hasVisibleText } from "./first-grapheme";

describe("firstGrapheme", () => {
  it.each([
    ["ann", "A"],
    ["王小明", "王"],
    ["👩‍💻 dev", "👩‍💻"],
    ["éclair", "É"],
    ["  ", "?"],
    ["", "?"],
    [" bob", "B"],
  ])("%j → %j", (name, expected) => {
    expect(firstGrapheme(name)).toBe(expected);
  });

  // #293：開頭的 bidi／格式字元看不見，首字取第一個看得見的字素。
  it.each([
    [String.fromCharCode(0x202e) + "Ann", "A"],
    [String.fromCharCode(0x200f, 0x2066) + "bob", "B"],
    [String.fromCharCode(0xfeff, 0x200b) + "王", "王"],
    [String.fromCharCode(0x200b), "?"],
    [String.fromCharCode(0x202e, 0x3000, 0x200e), "?"],
  ])("開頭不可見字元 %j → %j", (name, expected) => {
    expect(firstGrapheme(name)).toBe(expected);
  });
});

describe("hasVisibleText", () => {
  it.each([
    ["ann", true],
    ["  ", false],
    ["", false],
    [String.fromCharCode(0x200b, 0x202e), false],
  ])("%j → %j", (name, expected) => {
    expect(hasVisibleText(name)).toBe(expected);
  });
});
