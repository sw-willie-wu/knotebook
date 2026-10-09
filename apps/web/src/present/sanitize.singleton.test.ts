import { describe, expect, it } from "vitest";
import DOMPurify from "dompurify";

// spec §13.1「單例不受污染」。⚠ 本檔不得在頂層 import ./sanitize——要先量 import 之前的基準。
describe("DOMPurify 預設單例不受 present/sanitize 污染（§2.13-7：mermaid 共用它）", () => {
  it("import 並跑過一次我們的淨化之後，預設單例對兩個輸入的結果逐字相同", async () => {
    const svgInput = '<svg><a href="https://x">t</a></svg>';
    const dataImg = '<img src="data:image/png;base64,AAA">';
    const before = [
      DOMPurify.sanitize(svgInput, { USE_PROFILES: { svg: true } }),
      DOMPurify.sanitize(dataImg),
    ];
    expect(before[1]).toContain('src="data:image/png;base64,AAA"'); // 基準本身要保留 data: src，否則下面比對沒有鑑別力

    const { sanitizeSlideFragment } = await import("./sanitize");
    sanitizeSlideFragment(`<p>x</p>${dataImg}<span href="https://e">y</span>`);

    const after = [
      DOMPurify.sanitize(svgInput, { USE_PROFILES: { svg: true } }),
      DOMPurify.sanitize(dataImg),
    ];
    expect(after).toEqual(before);
  });
});
