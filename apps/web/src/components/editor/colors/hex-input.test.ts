import { describe, expect, it } from "vitest";
import { parseHexInput } from "./hex-input";

describe("parseHexInput", () => {
  it("HX1 accepts 3 or 6 digits with or without #, trims, lowercases", () => {
    expect(parseHexInput("#F60")).toBe("#ff6600");
    expect(parseHexInput("ff6600")).toBe("#ff6600");
    expect(parseHexInput("  #FF6600 ")).toBe("#ff6600");
    expect(parseHexInput("#ABC")).toBe("#aabbcc");
  });

  it("HX1 rejects everything else", () => {
    for (const raw of ["", "#", "#ff66", "#ff66001", "ggg", "#ff6600ff", "rgb(1,2,3)"]) {
      expect(parseHexInput(raw), raw).toBeNull();
    }
  });
});
