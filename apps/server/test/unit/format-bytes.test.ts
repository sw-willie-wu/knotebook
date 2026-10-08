import { describe, expect, it } from "vitest";
import { formatBytes } from "../../src/storage/format-bytes.js";

describe("formatBytes（1024 進位、一位小數；儲存配額 spec §8.3-3）", () => {
  it("0 → 0 B", () => expect(formatBytes(0)).toBe("0 B"));
  it("1023 → 1023 B（未滿 1 KB 印整數）", () => expect(formatBytes(1023)).toBe("1023 B"));
  it("1024 → 1.0 KB", () => expect(formatBytes(1024)).toBe("1.0 KB"));
  it("1536 → 1.5 KB", () => expect(formatBytes(1536)).toBe("1.5 KB"));
  it("2^31 → 2.0 GB（Basic 方案的上限）", () => expect(formatBytes(2 ** 31)).toBe("2.0 GB"));
  it("2^50 → 1024.0 TB（TB 是最大單位，配額上限 1125899906842624＝2^50）", () => expect(formatBytes(2 ** 50)).toBe("1024.0 TB"));
  it("1048575 → 1.0 MB（四捨五入進位到 1024.0 KB 時改用下一個單位）", () => expect(formatBytes(1048575)).toBe("1.0 MB"));
});
