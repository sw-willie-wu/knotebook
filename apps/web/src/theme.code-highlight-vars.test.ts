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

  /** 語言下拉的三條規則（閒置／hover-focus／disabled），依 body 特徵分辨。 */
  function selectRules(): { selector: string; body: string }[] {
    return codeBlockRules().filter((r) => /select/.test(r.selector));
  }

  it("語言下拉的文字色也要跟著換——內建寫死 color:#fff，淺色底上等於看不見", () => {
    const idle = selectRules().find((r) => !/:hover|:focus|:disabled/.test(r.selector));
    expect(idle, "缺語言下拉的閒置態覆寫").toBeDefined();
    // 錨檢查跟底色那條同理由：內建 select 規則同樣在 lazy chunk、載入晚於 index.css，
    // 掉了 .bn-editor 錨就同 specificity 必輸、內建那套（#fff、左上角、隱形）靜默
    // 回來（審查突變實測：沒有這條斷言時拿掉錨 4 測試全綠）。
    expect(idle!.selector, `少了 .bn-editor 錨：${idle!.selector}`).toMatch(/^\.bn-editor\s/);
    // issue #111 之後改用**主題**色（與 mermaid 控制鈕同語彙）而不是 --code-* 那組
    // 程式碼配色；共同的底線是「不得留下寫死色」。
    expect(idle!.body, "語言下拉的顏色要走 CSS 變數，不得寫死").toMatch(/color:\s*var\(--(?:code|color)-/);
    expect(idle!.body).not.toContain("#fff");
  });

  it("issue #111：語言下拉常駐在**右上角**——內建是 opacity:0 藏在左上角（疊在第一行開頭）", () => {
    const idle = selectRules().find((r) => !/:hover|:focus|:disabled/.test(r.selector));
    expect(idle, "缺語言下拉的閒置態覆寫").toBeDefined();
    // 三個宣告缺一不可：`left:auto` 不寫的話內建的 `left:18px` 還在，right 反而被忽略
    // （absolute 同時給 left/right 且寬度非 auto 時，ltr 下 left 勝出）→ 靜默留在左上角。
    expect(idle!.body, "缺 right（要移到右上角，與 mermaid 控制鈕同側）").toMatch(/right:\s*\d/);
    expect(idle!.body, "缺 left:auto——內建的 left:18px 會贏過 right，下拉仍在左上角").toMatch(/left:\s*auto/);
    const opacity = Number(idle!.body.match(/opacity:\s*([0-9.]+)/)?.[1]);
    expect(opacity, "閒置態要 opacity:1（常駐）——內建是 0，不覆寫就等於沒有這個控制項").toBe(1);
  });

  it("issue #111：hover/focus 提到全對比（不靠半透明——有效對比會隨底色浮動）", () => {
    const raised = selectRules().find((r) => /:hover|:focus/.test(r.selector));
    expect(raised, "缺語言下拉的 hover/focus 覆寫").toBeDefined();
    expect(raised!.selector, `少了 .bn-editor 錨：${raised!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(raised!.body, "hover/focus 要換成全對比的前景色").toMatch(/color:\s*var\(--(?:code|color)-foreground\)/);
    // 內建 hover 只把 opacity 墊到 .5（light 有效對比 3.1:1 < AA 4.5）。改用顏色分層
    // 之後，opacity 若還被調成小於 1 就是把那個問題搬回來。
    const opacity = raised!.body.match(/opacity:\s*([0-9.]+)/)?.[1];
    if (opacity !== undefined) expect(Number(opacity), "hover/focus 不得用半透明").toBe(1);
  });

  it("issue #111：唯讀時退成純文字標籤（BlockNote 仍渲染 select，只是 disabled）", () => {
    const disabled = selectRules().find((r) => /:disabled/.test(r.selector));
    expect(disabled, "缺 select:disabled 的覆寫——唯讀時會是個點不動的按鈕外框").toBeDefined();
    expect(disabled!.selector, `少了 .bn-editor 錨：${disabled!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(disabled!.body).toMatch(/border-color:\s*transparent/);
    expect(disabled!.body).toMatch(/background-color:\s*transparent/);
  });
});
