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

  it("word-break: break-all 只命中 link mark 的 <a> 與行內 code，不命中 wikilink 的 <a>（#269：wikilink 不在字中間切）", () => {
    const css = readIndexCssWithoutComments();
    // #269 起 wikilink 也渲染成 `<a>`（外層 span 帶 data-inline-content-type="wikilink"），舊的裸 `a` 選擇器會連它一起
    // 套上 break-all。現在 link 那支寫成**沒引號**的 `[data-inline-content-type=link]`（與本檔 `[data-content-type=…]` 同慣例）：
    // 加上引號會被 `theme.link-guard.test.ts` 的 linkRules() 收進去，「恰好兩條規則」案就紅。
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter((m) => /word-break:\s*break-all/.test(m[2]!));
    expect(rules, "word-break: break-all 應恰好一條規則").toHaveLength(1);
    // ⚠ 逗號清單逐一拆開判（repo 慣例）。
    const selectors = rules[0]![1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    document.body.innerHTML =
      '<div class="bn-editor"><div class="bn-inline-content">' +
      '<a data-inline-content-type="link" href="https://x.example/a">l</a>' +
      '<span data-inline-content-type="wikilink"><a href="/notes/x">w</a></span>' +
      "<code>c</code></div></div>";
    const hit = (el: Element) => selectors.some((s) => el.matches(s));
    expect(hit(document.querySelector('a[data-inline-content-type="link"]')!), "link mark 的 <a> 要命中").toBe(true);
    expect(hit(document.querySelector("code")!), "行內 code 要命中").toBe(true);
    expect(hit(document.querySelector('[data-inline-content-type="wikilink"] a')!), "wikilink 的 <a> 不得命中（#269）").toBe(false);
    document.body.innerHTML = "";
  });
});
