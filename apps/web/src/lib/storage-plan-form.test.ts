import { describe, expect, it } from "vitest";
import { quotaBytesFromInput, quotaInputFromBytes, validPlanName } from "./storage-plan-form";

describe("validPlanName（trim 後 1–40 個 code point；server 仍是最終裁決）", () => {
  it("trim（含全形空白 U+3000）", () => expect(validPlanName("　 Team 　")).toBe("Team"));
  it("空白 → null", () => expect(validPlanName("   ")).toBeNull());
  it("40 個 astral 字元（.length 80）→ 合法；41 個 → null", () => {
    expect(validPlanName("😀".repeat(40))).toBe("😀".repeat(40));
    expect(validPlanName("😀".repeat(41))).toBeNull();
  });
});

describe("quotaBytesFromInput（RF3）", () => {
  it("1 MB → 1048576；1.5 GB → 1610612736；前後空白可", () => {
    expect(quotaBytesFromInput("1", "MB")).toBe(1048576);
    expect(quotaBytesFromInput(" 1.5 ", "GB")).toBe(1610612736);
  });
  it("0 合法（配額 0 的方案）", () => expect(quotaBytesFromInput("0", "MB")).toBe(0));
  it("四捨五入到整數 byte：0.0005 MB → 524", () => expect(quotaBytesFromInput("0.0005", "MB")).toBe(524));
  it("空字串、負數、指數、非數字 → null", () => {
    for (const raw of ["", "-1", "1e3", "abc", "1.", ".5", "1,5"]) expect(quotaBytesFromInput(raw, "MB"), raw).toBeNull();
  });
  it("上界：1048576 GB（＝2^50）合法；1048577 GB → null", () => {
    expect(quotaBytesFromInput("1048576", "GB")).toBe(2 ** 50);
    expect(quotaBytesFromInput("1048577", "GB")).toBeNull();
  });
});

describe("quotaInputFromBytes（編輯對話框的初值）", () => {
  it("整 GiB → GB", () => expect(quotaInputFromBytes(2147483648)).toEqual({ value: "2", unit: "GB" }));
  it("整 MiB 但不是整 GiB → MB", () => expect(quotaInputFromBytes(1536 * 1048576)).toEqual({ value: "1536", unit: "MB" }));
  it("0 → 0 MB", () => expect(quotaInputFromBytes(0)).toEqual({ value: "0", unit: "MB" }));
  it("不整除 → MB 最多 6 位小數（1000 bytes → 0.000954）", () => expect(quotaInputFromBytes(1000)).toEqual({ value: "0.000954", unit: "MB" }));
});
