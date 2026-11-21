import { describe, expect, it } from "vitest";
import { PALETTE_COLORS } from "./note-colors.js";
import { TAG_PRESET_COLORS, canEditNoteTags, canonicalTagColor, isTagColor, normalizeTagName, pickTagColor } from "./tags.js";

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
  it("takes the first unused color in TAG_PRESET_COLORS order", () => {
    expect(pickTagColor([])).toBe("blue");
    expect(pickTagColor(["blue", "orange"])).toBe("green");
  });
  it("when all nine are used, takes the least used, ties in TAG_PRESET_COLORS order", () => {
    expect(pickTagColor([...TAG_PRESET_COLORS, "blue", "green"])).toBe("orange");
  });
  it("ignores values that aren't presets, custom colors included, and never picks a custom color", () => {
    expect(pickTagColor(["default", "#ff0000"])).toBe("blue");
    expect(pickTagColor([...TAG_PRESET_COLORS, "#0000ff", "#0000ff", "blue"])).toBe("green");
  });
});

describe("TAG_PRESET_COLORS", () => {
  it("are the editor's named colors without default", () => {
    expect([...TAG_PRESET_COLORS].sort()).toEqual(PALETTE_COLORS.filter((c) => c !== "default").sort());
  });
});

describe("isTagColor", () => {
  it("accepts the presets and lowercase #rrggbb only", () => {
    for (const c of [...TAG_PRESET_COLORS, "#e03e3e", "#000000"]) expect(isTagColor(c), c).toBe(true);
    for (const c of ["default", "#E03E3E", "#abc", "#e03e3eff", "rgb(1, 2, 3)", "", "Blue", null, 3]) expect(isTagColor(c), String(c)).toBe(false);
  });
});

describe("canonicalTagColor", () => {
  it("keeps preset names and lowercase #rrggbb as they are", () => {
    for (const c of [...TAG_PRESET_COLORS, "#e03e3e"]) expect(canonicalTagColor(c)).toBe(c);
  });
  it("normalizes the forms a custom text color accepts", () => {
    expect(canonicalTagColor("#E03E3E")).toBe("#e03e3e");
    expect(canonicalTagColor("#ABC")).toBe("#aabbcc");
    expect(canonicalTagColor("#abcf")).toBe("#aabbcc");
    expect(canonicalTagColor("#e03e3eFF")).toBe("#e03e3e");
    expect(canonicalTagColor("rgb(224, 62, 62)")).toBe("#e03e3e");
  });
  it("rejects default, colors that aren't opaque, and anything else", () => {
    for (const c of ["default", "#abc8", "#e03e3e80", "rgba(1, 2, 3, 0.5)", "e03e3e", "#e03e3", " #e03e3e", "Blue", "transparent", "", null, undefined, 7, {}]) {
      expect(canonicalTagColor(c), String(c)).toBeNull();
    }
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
