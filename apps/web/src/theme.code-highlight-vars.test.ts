import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 程式碼上色變數（issue #96）的結構守門（比照 `theme.block-selection-guard.test.ts`）。
 *
 * shiki 用的是 `createCssVariablesTheme`：token 顏色一律輸出成 `var(--code-…)`，
 * **實際色值只存在 `index.css`**。這裡守三件事，三件都是「壞了不會有任何測試紅、
 * 只有畫面靜默變醜／變不可讀」的形：
 *
 * 1. **兩套色值都要齊**：`--code-*` 在 `:root`（light）與 `.dark` 各定義一次。dark
 *    漏一個變數＝該 token 靜默沿用 light 色值（CSS 變數繼承），深色底配淺色文字的
 *    對比就沒了。
 * 2. **codeBlock 底色覆寫要贏內建**：BlockNote 寫死 `color:#fff` + `#161616` 深底
 *    （specificity (0,2,0)、載入順序晚於 index.css）——覆寫少了 `.bn-editor` 錨點
 *    （掉回 (0,2,0)）淺色模式的深色方塊就靜默回來。
 * 3. **與 accent 脫鉤**：issue 的設計限制——程式碼配色是語意配色，不得引用
 *    `--brand`／`--color-brand` 系（換主題色不得改變程式碼區塊任何顏色）。
 */

function readIndexCss(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** shiki `createCssVariablesTheme`（prefix `--code-`）會引用的完整變數集。 */
const CODE_VARS = [
  "--code-foreground",
  "--code-background",
  "--code-token-comment",
  "--code-token-constant",
  "--code-token-function",
  "--code-token-keyword",
  "--code-token-link",
  "--code-token-parameter",
  "--code-token-punctuation",
  "--code-token-string",
  "--code-token-string-expression",
  "--code-token-changed",
  "--code-token-deleted",
  "--code-token-inserted",
] as const;

/** 第一個頂層 `:root {…}`（light 基底）與 `.dark {…}` 的宣告內容。 */
function themeBlocks(): { light: string; dark: string } {
  const css = readIndexCss();
  const light = css.match(/(?:^|\n):root\s*\{([^}]*)\}/)?.[1];
  const dark = css.match(/(?:^|\n)\.dark\s*\{([^}]*)\}/)?.[1];
  expect(light, "index.css 應有頂層 :root 區塊").toBeDefined();
  expect(dark, "index.css 應有頂層 .dark 區塊").toBeDefined();
  return { light: light!, dark: dark! };
}

describe("程式碼上色變數（--code-*）", () => {
  it("light（:root）與 dark（.dark）各自定義完整一套——dark 漏一個＝該 token 靜默沿用 light 色", () => {
    const { light, dark } = themeBlocks();
    for (const name of CODE_VARS) {
      expect(light, `light 缺 ${name}`).toContain(`${name}:`);
      expect(dark, `dark 缺 ${name}`).toContain(`${name}:`);
    }
  });

  it("色值不引用 accent（--brand 系）——換主題色不得改變程式碼區塊的任何顏色", () => {
    const { light, dark } = themeBlocks();
    for (const block of [light, dark]) {
      for (const line of block.split("\n").filter((l) => l.trimStart().startsWith("--code-"))) {
        expect(line, `程式碼配色不得跟 accent 走：${line.trim()}`).not.toMatch(/--(?:color-)?brand/);
      }
    }
  });
});

describe("codeBlock 底色覆寫", () => {
  /** 抽出 codeBlock 的覆寫規則（data-content-type=codeBlock 那條）。 */
  function codeBlockRules(): { selector: string; body: string }[] {
    const css = readIndexCss();
    return [...css.matchAll(/([^{}]*\[data-content-type=codeBlock\][^{}]*)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
  }

  it("存在以 .bn-editor 為錨的覆寫（specificity 要贏內建的 (0,2,0)），底與字都用 --code-* 變數", () => {
    const rules = codeBlockRules();
    const main = rules.find((r) => /background/.test(r.body));
    expect(main, "index.css 缺 codeBlock 底色覆寫——淺色模式會是 BlockNote 寫死的 #161616 深色方塊").toBeDefined();
    expect(main!.selector, "少了 .bn-editor 錨點就墊不到 (0,3,0)，載入順序上必輸給 BlockNote 的 CSS").toMatch(/^\.bn-editor\s/);
    expect(main!.body).toContain("var(--code-background)");
    expect(main!.body).toContain("var(--code-foreground)");
    expect(main!.body, "不該把 BlockNote 寫死的深底抄過來").not.toContain("#161616");
  });

  it("語言下拉的文字色也要跟著換——內建寫死 color:#fff，淺色底上等於看不見", () => {
    const rules = codeBlockRules();
    const colorRule = rules.find((r) => /select/.test(r.selector) && /var\(--code-foreground\)/.test(r.body));
    expect(colorRule, "缺語言下拉的 color 覆寫（select + var(--code-foreground)）").toBeDefined();
    // 錨檢查跟底色那條同理由：內建 select 規則同樣在 lazy chunk、載入晚於 index.css，
    // 掉了 .bn-editor 錨就同 specificity 必輸、color:#fff 靜默回來（審查突變實測：
    // 沒有這條斷言時拿掉錨 4 測試全綠）。
    expect(colorRule!.selector, `少了 .bn-editor 錨：${colorRule!.selector}`).toMatch(/^\.bn-editor\s/);
  });

  it("語言下拉 hover/focus 的不透明度要墊高——內建 opacity:.5 讓淺色模式的有效對比只剩 3.1:1（<AA 4.5）", () => {
    const rules = codeBlockRules();
    const opacityRule = rules.find((r) => /select/.test(r.selector) && /opacity/.test(r.body));
    expect(opacityRule, "缺語言下拉的 opacity 覆寫（內建 hover/focus 只到 .5，鍵盤聚焦時就是 3.1:1）").toBeDefined();
    expect(opacityRule!.selector, `少了 .bn-editor 錨：${opacityRule!.selector}`).toMatch(/^\.bn-editor\s/);
    const value = Number(opacityRule!.body.match(/opacity:\s*([0-9.]+)/)?.[1]);
    // 0.75 是 light foreground #1f2328 混入底色後仍過 4.5:1 的下限附近；取 .8 留裕度。
    expect(value, "opacity 要 ≥ 0.75 才過得了 AA").toBeGreaterThanOrEqual(0.75);
  });
});
