import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 內文左右對齊（issue I7 審查修正，2026-09-17）：`text-align: justify` 與
 * `word-break: break-all` 這兩條規則是**一組**，見 `index.css` 該區塊上方的
 * 註解——單獨留 justify 會在「一小段文字 ＋ 空白 ＋ 一長串不能斷的東西」那種行
 * 把唯一的空白拉爆（680px 欄寬實測 136.4px→7.9px，見 index.css 的量測明細）。
 * 這條測試釘住「兩段同進同出」：不得只刪其中一半、也不得只改其中一半而讓另一半
 * 的存在理由消失。
 */

function readIndexCssWithoutComments(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("內文左右對齊 ＋ 長識別字 word-break（同進同出）", () => {
  it("text-align: justify（配 hyphens: auto）與 word-break: break-all 兩條規則必須同時存在", () => {
    const css = readIndexCssWithoutComments();

    const hasJustify = /text-align:\s*justify;/.test(css);
    const hasHyphens = /hyphens:\s*auto;/.test(css);
    const hasWordBreakAll = /word-break:\s*break-all;/.test(css);

    expect(hasJustify, "找不到 text-align: justify——這條若被刪，下面的 word-break: break-all 也該一起刪").toBe(
      true,
    );
    expect(hasHyphens, "找不到 hyphens: auto——與 text-align: justify 同一條規則、同進同出").toBe(true);
    expect(
      hasWordBreakAll,
      "找不到 word-break: break-all——justify 若沒有這條搭著，長識別字那一行會把唯一的空白拉爆",
    ).toBe(true);
  });

  it("word-break: break-all 的選擇器只用 link mark 的 data 屬性，不得再补一個沒有引號的裸重複選擇器（N5）", () => {
    const css = readIndexCssWithoutComments();
    // N5：`[data-inline-content-type=link]`（沒引號）曾經是多餘的第二個選擇器——
    // link mark 的 DOM 本來就是帶該屬性的 `<a>`，`a` 選擇器已經涵蓋；而且一旦有人
    // 幫它補上引號，就會讓 `theme.link-guard.test.ts` 的「不得含裸 a」變紅
    // （那條測試專門掃 link inline content 的規則，這裡不該再長出第二份）。
    const wordBreakBlock = /\.bn-editor \.bn-inline-content a,[\s\S]*?\{[\s\S]*?word-break:\s*break-all;[\s\S]*?\}/.exec(
      css,
    );
    expect(wordBreakBlock, "找不到 word-break: break-all 規則本體").not.toBeNull();
    expect(
      wordBreakBlock![0],
      "word-break 規則不該再帶 [data-inline-content-type=link] 選擇器——a 已經涵蓋",
    ).not.toMatch(/data-inline-content-type/);
  });
});
