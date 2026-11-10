import { describe, expect, it } from "vitest";
import { bodySearchGate } from "./body-search-gate";

describe("bodySearchGate（至少 2 個字、超過 200 code unit 不搜）", () => {
  it.each([
    ["", "off"],
    ["  ", "off"],
    ["a", "tooShort"],
    ["中", "tooShort"],
    [" a ", "tooShort"],
    ["😀", "tooShort"], // 1 code point、2 code unit
    ["ab", "search"],
    ["中文", "search"],
    [" ab ", "search"],
    ["a".repeat(200), "search"],
    ["a".repeat(201), "tooLong"],
    ["😀".repeat(100), "search"], // 200 code unit
    ["😀".repeat(101), "tooLong"], // 101 code point、202 code unit
  ] as const)("%j → %s", (raw, gate) => {
    expect(bodySearchGate(raw)).toBe(gate);
  });
});
