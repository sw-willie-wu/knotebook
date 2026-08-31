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

  it("issue #111：語言下拉移到方塊**外面的上方靠右**，且保留列高度＝下拉的負 top", () => {
    const idle = selectRules().find((r) => /top:/.test(r.body) && /opacity:/.test(r.body));
    expect(idle, "缺語言下拉的定位覆寫（top ＋ opacity 那條）").toBeDefined();
    expect(idle!.selector, `少了 .bn-editor 錨：${idle!.selector}`).toMatch(/^\.bn-editor\s/);

    // 靠右：兩個宣告缺一不可。`left:auto` 不寫的話內建的 `left:18px` 還在、`right`
    // 反而被忽略（absolute 同時給 left/right 且寬度非 auto 時 ltr 下 left 勝出）
    // → 靜默留在左上角，也就是這條 issue 的原狀。
    expect(idle!.body, "缺 right（要與 mermaid 控制鈕同側）").toMatch(/right:\s*\d/);
    expect(idle!.body, "缺 left:auto——內建的 left:18px 會贏過 right，下拉仍在左上角").toMatch(/left:\s*auto/);

    // 「外面的上方」：top 必須是負值，否則它又疊回程式碼區域（會攔截點擊，mermaid
    // #94 踩過）。
    const top = Number(idle!.body.match(/top:\s*(-?[0-9.]+)rem/)?.[1]);
    expect(top, "top 要是負的 rem 值——正值＝疊在方塊內部").toBeLessThan(0);

    // 保留列與位移是**同一個數字的兩半**（比照 ui/rows.ts 的 `42 ＝ 36 ＋ 6`）：
    // block content 讓出 margin-top 的高度，下拉往上位移同樣的距離。改一個沒改另一個
    // → 下拉不是壓到上一個 block，就是在方塊上方留一條空白。
    const reserved = codeBlockRules().find((r) => /margin-top:/.test(r.body));
    expect(reserved, "缺保留列（block content 的 margin-top）").toBeDefined();
    expect(reserved!.selector, `少了 .bn-editor 錨：${reserved!.selector}`).toMatch(/^\.bn-editor\s/);
    const reservedRem = Number(reserved!.body.match(/margin-top:\s*([0-9.]+)rem/)?.[1]);
    expect(reservedRem, "保留列高度要等於下拉的位移量").toBe(Math.abs(top));
  });

  it("issue #111：平常隱形、hover 到 block 或聚焦才現身（與 mermaid 同邏輯）", () => {
    const idle = selectRules().find((r) => /top:/.test(r.body) && /opacity:/.test(r.body));
    expect(Number(idle!.body.match(/opacity:\s*([0-9.]+)/)?.[1]), "閒置態要 opacity:0").toBe(0);

    const raised = selectRules().find((r) => /:hover|:focus/.test(r.selector));
    expect(raised, "缺 hover/focus 的現身規則").toBeDefined();
    expect(raised!.selector, `少了 .bn-editor 錨：${raised!.selector}`).toMatch(/^\.bn-editor\s/);
    // hover 要掛在**整個 block** 上（不是 select 自己 hover）——否則要先摸到那個
    // 隱形的小方塊才會出現，等於摸不到。
    expect(raised!.selector, "hover 要吃整個 block").toMatch(/\[data-content-type=codeBlock\]:hover/);
    // `:focus` 那半是鍵盤唯一的入口（用 opacity 而不是 display 隱藏就是為了留住
    // Tab 順序）。
    expect(raised!.selector, "缺 :focus——鍵盤使用者會構不到").toMatch(/select:focus/);
    // 現身時要全對比：內建 hover 只墊到 .5（light 有效對比 3.1:1 < AA 4.5）。
    expect(Number(raised!.body.match(/opacity:\s*([0-9.]+)/)?.[1]), "現身時不得半透明").toBe(1);
  });

  it("issue #111：展開清單（OS widget）的 option 顏色與 color-scheme 跟著主題——內建寫死 color:#000，深色模式看不見", () => {
    const rules = codeBlockRules();
    const option = rules.find((r) => /select\s*>\s*option/.test(r.selector));
    expect(option, "缺 option 的顏色覆寫——內建 `option{color:#000}` 在深色清單上等於看不見").toBeDefined();
    expect(option!.selector, `少了 .bn-editor 錨：${option!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(option!.body).toMatch(/color:\s*var\(--color-foreground\)/);
    expect(option!.body).toMatch(/background-color:\s*var\(--color-background\)/);
    expect(option!.body, "不得把內建寫死的黑抄過來").not.toContain("#000");

    // color-scheme 兩套都要在，否則原生清單的底色/捲軸仍是另一個主題的那一套。
    const schemes = rules.filter((r) => /color-scheme:/.test(r.body));
    expect(schemes.map((r) => r.body.match(/color-scheme:\s*(\w+)/)?.[1]).sort()).toEqual(["dark", "light"]);
    const darkScheme = schemes.find((r) => /dark/.test(r.body.match(/color-scheme:\s*(\w+)/)?.[1] ?? ""));
    expect(darkScheme!.selector, "深色那條要以 .dark 起頭（主題切換靠 class，不是 media query）").toMatch(
      /^\.dark\s/,
    );
  });

  it("issue #111：唯讀時退成純文字標籤（BlockNote 仍渲染 select，只是 disabled）", () => {
    const disabled = selectRules().find((r) => /:disabled/.test(r.selector));
    expect(disabled, "缺 select:disabled 的覆寫——唯讀時會是個點不動的按鈕外框").toBeDefined();
    expect(disabled!.selector, `少了 .bn-editor 錨：${disabled!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(disabled!.body).toMatch(/border-color:\s*transparent/);
    expect(disabled!.body).toMatch(/background-color:\s*transparent/);
  });
});
