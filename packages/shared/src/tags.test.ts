import { describe, expect, it } from "vitest";
import { PALETTE_COLORS } from "./note-colors.js";
import { TAG_COLORS, canEditNoteTags, normalizeTagName, pickTagColor } from "./tags.js";

describe("normalizeTagName", () => {
  it("trims ASCII and ideographic spaces and NFC-normalizes", () => {
    expect(normalizeTagName("  aws ")).toBe("aws");
    expect(normalizeTagName("　影像　")).toBe("影像");
    expect(normalizeTagName("é")).toBe("é");
    expect(normalizeTagName("\taws\n")).toBe("aws");
  });
  it("accepts 40 code points and rejects 41, empty and blank", () => {
    expect(normalizeTagName("😀".repeat(40))).toBe("😀".repeat(40));
    expect(normalizeTagName("a".repeat(41))).toBeNull();
    expect(normalizeTagName("")).toBeNull();
    expect(normalizeTagName("   ")).toBeNull();
  });
  it("rejects control characters and lone surrogates", () => {
    for (const bad of ["a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\ud800b", "a\udc00"]) expect(normalizeTagName(bad)).toBeNull();
  });
});

describe("pickTagColor", () => {
  it("takes the first unused color in TAG_COLORS order", () => {
    expect(pickTagColor([])).toBe("blue");
    expect(pickTagColor(["blue", "orange"])).toBe("green");
  });
  it("when all nine are used, takes the least used, ties in TAG_COLORS order", () => {
    expect(pickTagColor([...TAG_COLORS, "blue", "green"])).toBe("orange");
  });
  it("ignores values that aren't tag colors", () => {
    expect(pickTagColor(["default", "#ff0000"])).toBe("blue");
  });
});

describe("TAG_COLORS", () => {
  it("are the editor's named colors without default", () => {
    expect([...TAG_COLORS].sort()).toEqual(PALETTE_COLORS.filter((c) => c !== "default").sort());
  });
});

describe("canEditNoteTags", () => {
  const p = (edit: boolean) => ({ edit });
  it("personal note: only the owner", () => {
    expect(canEditNoteTags({ role: "owner", groupId: null, permissions: p(true) })).toBe(true);
    expect(canEditNoteTags({ role: "editor", groupId: null, permissions: p(true) })).toBe(false);
    expect(canEditNoteTags({ role: "viewer", groupId: null, permissions: p(false) })).toBe(false);
  });
  it("group note: members whose role can edit", () => {
    expect(canEditNoteTags({ role: "editor", groupId: "g", permissions: p(true) })).toBe(true);
    expect(canEditNoteTags({ role: "viewer", groupId: "g", permissions: p(false) })).toBe(false);
  });
});
