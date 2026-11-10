import { describe, expect, it } from "vitest";
import { displaySnippet } from "./body-snippet";

describe("displaySnippet（命中前只留約 12 個字）", () => {
  it("命中在前 12 字內 → 原樣", () => {
    expect(displaySnippet("abcdefghijk needle tail", "needle")).toBe("abcdefghijk needle tail"); // 命中前恰 12 個
    expect(displaySnippet("needle first", "needle")).toBe("needle first");
  });

  it("命中在第 30 字 → …＋命中前 12 個 code point＋命中起的其餘", () => {
    const s = `${"x".repeat(18)}0123456789abNEEDLE tail`;
    expect(displaySnippet(s, "needle")).toBe("…0123456789abNEEDLE tail");
  });

  it("切點落在代理對上 → 不切半個（以 code point 計）", () => {
    const s = `${"x".repeat(10)}${"😀".repeat(12)}needle`;
    const out = displaySnippet(s, "needle");
    expect(out).toBe(`…${"😀".repeat(12)}needle`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("toLowerCase 後長度改變（İ）→ 原樣；找不到 → 原樣", () => {
    const s = `İ${"x".repeat(30)}needle`;
    expect(displaySnippet(s, "needle")).toBe(s);
    expect(displaySnippet("x".repeat(40), "needle")).toBe("x".repeat(40));
  });

  it("原本就以 … 開頭（server 截過前文）→ 裁切後仍只有一個 …", () => {
    const s = `…${"x".repeat(30)}needle`;
    expect(displaySnippet(s, "needle")).toBe(`…${"x".repeat(12)}needle`);
    expect(displaySnippet("…short needle", "needle")).toBe("…short needle");
  });
});
