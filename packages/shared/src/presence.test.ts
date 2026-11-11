import { describe, expect, it } from "vitest";
import { AGENT_PRESENCE_COLOR, PRESENCE_FIELD, collabUserColor } from "./presence.js";

describe("collabUserColor（搬家後輸出不變）", () => {
  it.each([
    ["", "hsl(0 65% 45%)"],
    ["a", "hsl(97 65% 45%)"],
    ["user-1", "hsl(31 65% 45%)"],
    ["00000000-0000-4000-8000-000000000001", "hsl(29 65% 45%)"],
    ["王小明", "hsl(162 65% 45%)"],
    ["x".repeat(200), "hsl(40 65% 45%)"],
  ])("%j → %s", (seed, expected) => {
    expect(collabUserColor(seed)).toBe(expected);
    expect(collabUserColor(seed)).toMatch(/^hsl\(\d{1,3} 65% 45%\)$/);
  });
});

describe("常數", () => {
  it("AGENT_PRESENCE_COLOR 與 PRESENCE_FIELD", () => {
    expect(AGENT_PRESENCE_COLOR).toBe("#7c3aed");
    expect(PRESENCE_FIELD).toBe("knotebook");
  });
});
