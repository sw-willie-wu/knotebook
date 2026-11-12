import { describe, expect, it } from "vitest";
import { hoverReveal, hoverRevealOnly } from "./reveal";

describe("hoverReveal 與 hoverRevealOnly", () => {
  it("hoverReveal：觸控（hover:none）常駐", () => {
    const classes = hoverReveal("noterow").split(/\s+/);
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("[@media(hover:none)]:opacity-100");
    expect(classes).toContain("group-hover/noterow:opacity-100");
    expect(classes).not.toContain("[@media(hover:none)]:hidden");
  });

  it("hoverRevealOnly：觸控（hover:none 或 pointer:coarse）整顆隱藏，不是常駐", () => {
    const classes = hoverRevealOnly("noterow").split(/\s+/);
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("transition-opacity");
    expect(classes).toContain("focus-visible:opacity-100");
    expect(classes).toContain("group-hover/noterow:opacity-100");
    expect(classes).toContain("group-has-[:focus-visible]/noterow:opacity-100");
    expect(classes).toContain("[@media(hover:none)]:hidden");
    expect(classes).toContain("[@media(pointer:coarse)]:hidden");
    expect(classes).not.toContain("[@media(hover:none)]:opacity-100");
  });

  it("hoverRevealOnly 的字面 class 逐字固定（Tailwind 靜態掃描要完整字面）", () => {
    expect(hoverRevealOnly("noterow")).toBe(
      "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden",
    );
  });
});
