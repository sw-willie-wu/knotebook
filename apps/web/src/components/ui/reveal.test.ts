import { describe, expect, it } from "vitest";
import { hoverReveal, hoverRevealOnly } from "./reveal";

describe("hoverReveal and hoverRevealOnly", () => {
  it("hoverReveal: always shown on touch (hover:none)", () => {
    const classes = hoverReveal("noterow").split(/\s+/);
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("[@media(hover:none)]:opacity-100");
    expect(classes).toContain("group-hover/noterow:opacity-100");
    expect(classes).not.toContain("[@media(hover:none)]:hidden");
  });

  it("hoverReveal: the tab title row scope reveals on row hover and keyboard focus inside the row", () => {
    const classes = hoverReveal("tabheader").split(/\s+/);
    expect(classes).toContain("group-hover/tabheader:opacity-100");
    expect(classes).toContain("group-has-[:focus-visible]/tabheader:opacity-100");
    expect(classes).toContain("[@media(hover:none)]:opacity-100");
  });

  it("hoverRevealOnly: hidden entirely on touch (hover:none or pointer:coarse), not always shown", () => {
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

  it("the literal classes of hoverRevealOnly are fixed verbatim (Tailwind's static scan needs complete literals)", () => {
    expect(hoverRevealOnly("noterow")).toBe(
      "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden",
    );
  });
});
