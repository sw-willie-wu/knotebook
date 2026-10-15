import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARET_INSIDE_ATTR } from "@/collab/code-block-caret";

/**
 * 程式碼上色變數（issue #96）的結構守門（比照 `theme.block-selection-guard.test.ts`）。
 *
 * shiki 用的是 `createCssVariablesTheme`：token 顏色一律輸出成 `var(--code-…)`，
 * **實際色值只存在 `index.css`**。這裡守三件事，三件都是「壞了不會有任何測試紅、
 * 只有畫面靜默變醜／變不可讀」的形：
 *
 * 1. **兩套色值都要齊**：`--code-*` 在 `:root`（light）與 `:root.dark` 各定義一次。dark
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

/** 第一個頂層 `:root {…}`（light 基底）與 `:root.dark {…}` 的宣告內容。 */
function themeBlocks(): { light: string; dark: string } {
  const css = readIndexCss();
  // ⚠ 取的是**含 --code-* 的那個** `:root`，不是第一個：index.css 自 issue #111 起有
  // 第二個頂層 `:root`（滾動條的共用變數），靠出現順序抓會變成一條沒人寫下來的相依。
  const light = [...css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes("--code-"));
  // 與上面同理由：抓「含 --code-* 的那個 `:root.dark`」，不靠出現順序。深色基底塊自 #154
  // 起錨在 `:root`（裸 `.dark` 會在 BlockNote 的 `.bn-root.dark` 上再命中一次）。
  const dark = [...css.matchAll(/(?:^|\n):root\.dark\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes("--code-"));
  expect(light, "index.css 應有頂層 :root 區塊").toBeDefined();
  expect(dark, "index.css 應有頂層 :root.dark 區塊").toBeDefined();
  return { light: light!, dark: dark! };
}

/** 主題區塊裡某個變數的值（去掉行尾註解已在 readIndexCss 做掉）。 */
function varValue(block: string, name: string): string {
  const value = block.match(new RegExp(`(?:^|[;{\\s])--${name}:\\s*([^;]+);`))?.[1]?.trim();
  expect(value, `主題區塊缺 --${name}`).toBeDefined();
  return value!;
}

/** `#rrggbb` 或 `oklch(L C H)` → 線性 sRGB（0–1）。半透明值不收：對比要看實際疊出來的色，算不準就該紅。 */
function parseColor(value: string, label: string): [number, number, number] {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [0, 2, 4].map((i) => {
      const c = parseInt(hex[1]!.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  }
  const ok = value.match(/^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/);
  expect(ok, `${label} 不是可計算的不透明色（${value}）`).not.toBeNull();
  const [L, C, H] = [Number(ok![1]), Number(ok![2]), (Number(ok![3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  // OKLab → LMS → 線性 sRGB（Björn Ottosson 的係數）。
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** WCAG 2.x 對比值。 */
function contrast(x: [number, number, number], y: [number, number, number]): number {
  const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("程式碼上色變數（--code-*）", () => {
  it("light（:root）與 dark（:root.dark）各自定義完整一套——dark 漏一個＝該 token 靜默沿用 light 色", () => {
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

  /** 語言下拉的規則（定位／hover-focus／disabled／共用長相），依 body 特徵分辨。 */
  function selectRules(): { selector: string; body: string }[] {
    return codeBlockRules().filter((r) => /select/.test(r.selector));
  }

  /**
   * 剝掉選擇器裡的 `:not(…)` 再做狀態判斷。
   *
   * `select:not(:disabled)` 是**基底態**的寫法，但字面上含 `:disabled`——三處依選擇器
   * 挑規則的地方（基底態、hover/focus、disabled）都得先剝掉，否則會挑到錯的規則而**假紅**
   * （第四輪 gate 突變實測：只有 baseRules 剝、另外兩處沒剝，套件仍會紅在別條）。
   */
  function stateOf(selector: string): string {
    return selector.replace(/:not\([^)]*\)/g, "");
  }

  /** index.css 全部的頂層規則（`.block-control` 那條的選擇器不含 codeBlock 以外的錨）。 */
  function allRules(): { selector: string; body: string }[] {
    return [...readIndexCss().matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
  }

  /** 語言下拉的**基底態**規則：選擇器就是 select 本身（無狀態、非 option／picker），且帶 `opacity`。 */
  function baseSelectRule(): { selector: string; body: string } | undefined {
    return selectRules().find(
      (r) =>
        /\[data-content-type=codeBlock\]\s*>\s*div\s*>\s*select$/.test(r.selector) && /(?:^|[;{])\s*opacity:/.test(r.body),
    );
  }

  /** 規則 body 裡 `@apply` 的 utility 清單。 */
  function applyTokens(body: string): string[] {
    return (body.match(/@apply\s+([^;]*);/)?.[1] ?? "").trim().split(/\s+/);
  }


  it("語言下拉的文字色也要跟著換——內建寫死 color:#fff，淺色底上等於看不見", () => {
    // #96 時這是 select 自己的一條 `color:` 覆寫；#111 之後顏色與 mermaid 那顆鈕
    // 共用同一條規則（`.block-control` 的 `@apply … text-muted-foreground`）。
    const rules = selectRules();
    expect(rules.length, "index.css 完全沒有接住語言下拉的規則").toBeGreaterThan(0);
    for (const rule of rules) {
      // 錨檢查跟底色那條同理由：內建 select 規則同樣在 lazy chunk、載入晚於 index.css，
      // 掉了 .bn-editor 錨就同 specificity 必輸、內建那套（#fff、左上角、隱形）靜默
      // 回來（審查突變實測：沒有這條斷言時拿掉錨 4 測試全綠）。
      expect(rule.selector, `少了 .bn-editor 錨：${rule.selector}`).toMatch(/\.bn-editor\s/);
      expect(rule.body, `不得留下寫死色：${rule.selector}`).not.toContain("#fff");
    }

    // ⚠ 這一段必須釘在**基底態**（沒有任何狀態偽類）且**作用於 select 本身**的規則上。
    // 兩輪 gate 各抓到一種放寬後的假綠：
    //   第一輪：對所有含 `select` 的規則做 `some(/color:\s*var\(--/)`——`background-color`、
    //           `border-color`、甚至 picker 的 `scrollbar-color` 都命中。
    //   第二輪：只排除 option／picker 還不夠——把顏色只寫在 `select:disabled` 上照樣
    //           通過，但**可編輯**筆記上的下拉已經退回內建 `color:#fff`（淺色底＝白字
    //           白底，正是 #96 的病灶）。
    const baseRules = rules.filter((r) => {
      const bare = stateOf(r.selector);
      return !/>\s*option|::picker/.test(bare) && !/:(?:hover|focus|disabled|open|active)\b/.test(bare);
    });
    const carriesColor = baseRules.some(
      (r) => /@apply[^;]*\btext-muted-foreground\b/.test(r.body) || /(?:^|[;{])\s*color:\s*var\(--/.test(r.body),
    );
    expect(
      carriesColor,
      "select 的**基底態**沒有前景色——內建的 color:white 會復活（淺色底＝白字白底）；" +
        "寫在 :hover/:disabled 之類的狀態上不算數",
    ).toBe(true);
  });

  it("語言下拉疊在方塊**內**的右上角：位置由共用的 .block-control 給（top/right），不是外上緣的 bottom:100%", () => {
    const idle = baseSelectRule();
    expect(idle, "缺語言下拉的基底覆寫（opacity:0 那條）").toBeDefined();
    expect(idle!.selector, `少了 .bn-editor 錨：${idle!.selector}`).toMatch(/^\.bn-editor\s/);

    // 位置只寫在共用規則：兩種 block 的控制項疊在同一個角（「統一」的位置那半）。
    const shared = allRules().find((r) => /\.block-control\b/.test(r.selector));
    expect(shared, "index.css 缺 `.block-control` 共用規則").toBeDefined();
    const apply = applyTokens(shared!.body);
    expect(apply, "共用規則要絕對定位（疊在方塊內容上）").toContain("absolute");
    // 內縮的 top/right（正值、走 utility 不手抄）＝方塊**內**的右上角。
    expect(apply.some((t) => /^top-\d+(?:\.\d+)?$/.test(t)), `缺 top-N：${apply.join(" ")}`).toBe(true);
    expect(apply.some((t) => /^right-\d+(?:\.\d+)?$/.test(t)), `缺 right-N：${apply.join(" ")}`).toBe(true);
    // 退回外上緣（#111 的 bottom:100%／bottom-full）或負 top 都是回到方塊外面。
    expect(apply.some((t) => /^(?:bottom-|-top-|-right-)/.test(t)), `不得把控制項推出方塊：${apply.join(" ")}`).toBe(false);
    for (const rule of selectRules()) {
      // ⚠ 邊界 `(?:^|[;{])\s*`：裸 regex 會被 `margin-bottom`／`margin-top` 之類餵飽（#111 第四輪 gate 突變實測）。
      expect(rule.body, `select 規則不得再用 bottom 定位：${rule.selector}`).not.toMatch(/(?:^|[;{])\s*bottom:/);
      expect(rule.body, `select 規則不得用負 top 把它推到方塊外：${rule.selector}`).not.toMatch(/(?:^|[;{])\s*top:\s*-/);
    }

    // `left:auto` 不可省：內建的 `left:18px` 還在，少了它下拉會從左緣 ＋18px 撐到右上角，
    // 整條蓋在第一行程式碼上（2026-10-15 headless Chromium 151 實測，見 index.css 註解）。
    expect(idle!.body, "缺 left:auto——內建的 left:18px 會把下拉撐成一整條").toMatch(/(?:^|[;{])\s*left:\s*auto/);

    // 寬度下限：原生 select 的寬度跟著目前選到的標籤走（`C` 36px ↔ `Markdown` 86px），
    // 沒有下限就會每換一個語言跳一次。
    expect(idle!.body, "缺寬度下限——控制項寬度會隨選到的語言縮放").toMatch(/min-width:\s*[0-9.]+rem/);
    // ⚠ 刻意**不是** `width`：那個值是量出來的（字寬看字型），寫死 width 配上
    // `overflow:hidden` 的失敗形是「標籤被靜默截斷」；min-width 的失敗形只是變寬一點，
    // 而它右錨定，右緣不動。
    // ⚠ 邊界要寫成 `[;{])\s*`（不是 `[;{]\s*)`）：body 的第一條宣告前面是換行＋縮排，
    // 前者才吃得到。同形的錯在 `carriesColor` 那條也犯過（寫死 width 當第一條宣告時
    // 這條原本全綠通過，第三輪 gate 突變實測抓到）。
    expect(idle!.body, "不得寫死 width：換字型／更長的語言名會變成靜默截斷").not.toMatch(
      /(?:^|[;{])\s*width:/,
    );
    expect(idle!.body, "有了 min-width 就不該再用 overflow:hidden 去藏溢出").not.toMatch(/overflow:\s*hidden/);
  });

  it("沒有保留列（2026-10-15 拿掉 #111 的 1.75rem）：codeBlock 不再 margin-top、mermaid 不再有 h-7 那列", () => {
    // 控制項疊在方塊內、平常隱形，不必替它多佔一段高度。兩側都要拿掉——只拿一邊就是兩種 block 間距不一。
    for (const rule of codeBlockRules()) {
      expect(rule.body, `codeBlock 不得再讓出保留列：${rule.selector}`).not.toMatch(/(?:^|[;{])\s*margin-top:/);
    }
    const mermaidSource = readFileSync(`${process.cwd()}/src/components/mermaid/MermaidView.tsx`, "utf8");
    expect(mermaidSource, "MermaidView 不得再有固定高度的工具列（h-7 那列）").not.toMatch(/className="[^"]*\bh-\d+\b[^"]*justify-end/);
  });

  it("控制項的長相只有一份真相：一條規則兩個選擇器（mermaid 鈕＋語言下拉）", () => {
    // 這條直接讀 `MermaidView.tsx` 對消費端：兩邊各改各的就是 #111 的原狀（一左一右、
    // 一藏一露、兩套長相），只釘 CSS 這一側等於沒釘住「統一」。
    const mermaidSource = readFileSync(`${process.cwd()}/src/components/mermaid/MermaidView.tsx`, "utf8");

    // **一條規則兩個選擇器**，不是兩邊各抄一份。前一版是「各寫一份、測試逐項對值」，結果把
    // `rounded-sm` 抄成 `0.125rem`——那是 Tailwind **v3** 的值，v4 的 `rounded-sm` 是
    // `0.25rem`，圓角就差一半（Willie 實測看出來的）。人工換算沒了，這一族的漂移才真的沒了。
    const shared = allRules().find((r) => /\.block-control\b/.test(r.selector));
    expect(shared, "index.css 缺 `.block-control` 共用規則").toBeDefined();
    expect(
      shared!.selector,
      "共用規則要同時接上 codeBlock 的語言下拉（原生 select 拿不到 className，只能用選擇器接進來）",
    ).toMatch(/\.bn-editor\s[^,]*\[data-content-type=codeBlock\][^,]*>\s*div\s*>\s*select/);
    expect(shared!.body, "長相要走 @apply 吃同一組 utility，不得手抄數值").toMatch(/@apply\s+[^;]*rounded-sm/);
    expect(shared!.body, "手抄 border-radius 就是圓角差一半的那個錯法").not.toMatch(/border-radius:/);
    // 原生 select 專屬的一條：CSS 沒有「繼承字型」的預設，不寫就用 OS 的 UI 字型，
    // 跟旁邊那顆 <button> 明顯不同一套字。
    expect(shared!.body, "缺 font-family: inherit").toMatch(/font-family:\s*inherit/);

    // 消費端：mermaid 那顆鈕要掛這個 class，且不得自己再列一份長相或位置 utility。
    expect(mermaidSource, "MermaidView 的控制鈕要掛 block-control").toContain('"block-control"');
    expect(
      mermaidSource,
      "MermaidView 不得再自己寫一份長相 class（rounded-*＋border-*）——那就是回到兩份真相",
    ).not.toMatch(/rounded-(?:xs|sm|md|lg)[^"]*border-border/);
    // 「不得自己寫位置」改在 `MermaidView.test.tsx` 對渲染後的 className token 斷言（不看順序、不受註解干擾）。
  });

  it("現身時有實底＋邊框，淺色與深色的 WCAG 對比都過（文字 ≥ 4.5、邊框對方塊底 ≥ 3）", () => {
    // 控制項疊在程式碼／圖上：沒有自己的底就讀不到，沒有夠深的邊就跟方塊底糊在一起。
    // 這裡從 `.block-control` 的 @apply 取出它**實際用的** token，再拿 index.css 兩套主題的
    // 變數色值算對比——換 token 或改色值讓對比掉下去都會紅，不必回頭重量。
    const shared = allRules().find((r) => /\.block-control\b/.test(r.selector));
    const apply = applyTokens(shared!.body);
    expect(apply, "缺邊框寬度（`border`）——沒有邊框就沒有分界").toContain("border");
    const token = (prefix: string): string => {
      const names = apply
        .filter((t) => t.startsWith(prefix))
        .map((t) => t.slice(prefix.length))
        .filter((n) => !/^(?:\d+|x|y|t|r|b|l|s|e|solid|dashed|none|xs|sm|base|lg|xl|\dxl)$/.test(n));
      expect(names, `@apply 裡 ${prefix}<顏色> 要恰好一個：${apply.join(" ")}`).toHaveLength(1);
      return names[0]!;
    };
    const fg = token("text-");
    const bg = token("bg-");
    const border = token("border-");
    // 透明的底／邊等於沒有（`bg-transparent`、`border-transparent`、半透明 `/NN` 都不算實底）。
    for (const name of [bg, border]) expect(name, `不得用透明或半透明：${name}`).not.toMatch(/transparent|\//);

    // utility 名 → 主題變數：`@theme inline` 的 `--color-X: var(--X)`（確認這個對應真的存在，
    // 否則下面算的是錯的變數）。
    const css = readIndexCss();
    // codeBlock 的底直接用 var(--code-background)（上面的底色覆寫測試釘住），不經 utility。
    for (const name of [fg, bg, border, "card"]) {
      expect(css, `@theme inline 缺 --color-${name}: var(--${name})`).toMatch(new RegExp(`--color-${name}:\\s*var\\(--${name}\\)`));
    }

    const { light, dark } = themeBlocks();
    for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
      const color = (name: string) => parseColor(varValue(block, name), `${theme} --${name}`);
      const text = contrast(color(fg), color(bg));
      // 方塊底：codeBlock 是 `--code-background`；mermaid 坐在編輯器表面 `--card` 上
      // （`--bn-colors-editor-background: var(--color-card)`）。
      const onCode = contrast(color(border), color("code-background"));
      const onCard = contrast(color(border), color("card"));
      expect(text, `${theme}：--${fg} 對 --${bg} 只有 ${text.toFixed(2)}:1（文字要 ≥ 4.5）`).toBeGreaterThanOrEqual(4.5);
      expect(onCode, `${theme}：邊框 --${border} 對 --code-background 只有 ${onCode.toFixed(2)}:1（要 ≥ 3）`).toBeGreaterThanOrEqual(3);
      expect(onCard, `${theme}：邊框 --${border} 對 --card 只有 ${onCard.toFixed(2)}:1（要 ≥ 3）`).toBeGreaterThanOrEqual(3);
    }
  });

  it("平常隱形且不吃點擊；hover 整個 block、游標在程式碼裡（data-caret-inside）或聚焦才現身", () => {
    const idle = baseSelectRule();
    expect(Number(idle!.body.match(/(?:^|[;{])\s*opacity:\s*([0-9.]+)/)?.[1]), "閒置態要 opacity:0").toBe(0);
    // 隱形時它疊在程式碼上：觸控點到那一角不得被一顆看不見的下拉吃掉（想放游標卻打開語言選單）。
    expect(idle!.body, "閒置態要 pointer-events:none").toMatch(/(?:^|[;{])\s*pointer-events:\s*none/);

    const raised = selectRules().find((r) => /:hover|:focus|data-caret-inside/.test(stateOf(r.selector)));
    expect(raised, "缺現身規則").toBeDefined();
    // ⚠ 選擇器清單**拆逗號逐一**比對（scrollbar-guard 立過的規矩）：整串 test 的話，三個條件
    // 少了哪一個只要別處字串碰巧含有它就騙得過。
    const parts = raised!.selector.split(",").map((s) => s.trim());
    for (const part of parts) expect(part, `少了 .bn-editor 錨：${part}`).toMatch(/^\.bn-editor\s/);
    // hover 要掛在**整個 block** 上（不是 select 自己 hover）——否則要先摸到那個
    // 隱形的小方塊才會出現，等於摸不到。
    expect(
      parts.some((p) => /\[data-content-type=codeBlock\]:hover\s*>\s*div\s*>\s*select$/.test(p)),
      `hover 要吃整個 block：${parts.join(" | ")}`,
    ).toBe(true);
    // 觸控沒有 hover：游標點進程式碼就要現身。屬性由 `collab/code-block-caret.ts` 的 decoration 掛上——
    // 名字對不上就是兩邊都綠、功能卻是死的，所以直接拿那支檔案匯出的常數比對。
    expect(
      parts.some((p) => new RegExp(`\\[data-content-type=codeBlock\\]\\[${CARET_INSIDE_ATTR}\\]\\s*>\\s*div\\s*>\\s*select$`).test(p)),
      `缺 [${CARET_INSIDE_ATTR}]——觸控裝置叫不出語言下拉：${parts.join(" | ")}`,
    ).toBe(true);
    // `:focus` 那半是鍵盤唯一的入口（用 opacity 而不是 display 隱藏就是為了留住 Tab 順序）。
    expect(parts.some((p) => /select:focus$/.test(p)), `缺 :focus——鍵盤使用者會構不到：${parts.join(" | ")}`).toBe(true);
    // 現身時要全對比：內建 hover 只墊到 .5（light 有效對比 3.1:1 < AA 4.5）。
    expect(Number(raised!.body.match(/(?:^|[;{])\s*opacity:\s*([0-9.]+)/)?.[1]), "現身時不得半透明").toBe(1);
    expect(raised!.body, "現身時要把 pointer-events 還回來，否則點不到").toMatch(/(?:^|[;{])\s*pointer-events:\s*auto/);
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

  /** `@supports (appearance: base-select)` 區塊的內容（大括號配對掃出來）。 */
  function baseSelectBlock(): string {
    const css = readIndexCss();
    const start = css.search(/@supports\s*\(\s*appearance:\s*base-select\s*\)\s*\{/);
    expect(start, "index.css 缺 `@supports (appearance: base-select)` 區塊").toBeGreaterThanOrEqual(0);
    let i = css.indexOf("{", start);
    const from = i + 1;
    for (let depth = 1; depth > 0; ) {
      i += 1;
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      else if (i >= css.length) throw new Error("@supports 區塊沒有收尾");
    }
    return css.slice(from, i);
  }

  it("issue #111：可自訂 select 只是**漸進增強**——原生清單那組必須留在 @supports 外面", () => {
    const block = baseSelectBlock();
    // 規範要求 select 與 ::picker(select) **都**切到 base 外觀；只給 select 的話清單
    // 仍是 OS widget（看起來像沒生效，卻不會有任何錯誤）。
    const switched = [...block.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter((m) => /appearance:\s*base-select/.test(m[2]!))
      .flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    expect(switched.length, "沒有任何規則把 appearance 切到 base-select").toBeGreaterThan(0);
    expect(
      switched.some((s) => />\s*select$/.test(s)),
      `select 本身沒切到 base 外觀：${switched.join(" | ")}`,
    ).toBe(true);
    expect(
      switched.some((s) => /::picker\(select\)$/.test(s)),
      `::picker(select) 沒切到 base 外觀——清單仍會是 OS widget：${switched.join(" | ")}`,
    ).toBe(true);

    // base 外觀下 select 變成 flex 容器，`::picker-icon`（箭頭）靠這條貼在右緣；沒有
    // 它，箭頭會緊跟在語言名後面浮在中間，`min-width` 撐出來的空白全落在右邊。
    expect(block, "缺 justify-content: space-between——箭頭不會貼在控制項右緣").toMatch(
      /justify-content:\s*space-between/,
    );

    // 退路（Firefox 等尚未支援者）必須在 @supports **外面**：搬進去就等於退回
    // BlockNote 寫死的 `option{color:#000}`，深色模式的清單又看不見了。
    const css = readIndexCss();
    const outside = css.replace(block, "");
    expect(outside, "option 的顏色退路被搬進 @supports 了").toMatch(/option\s*\{[^}]*color:\s*var\(--color-foreground\)/);
    expect(outside, "color-scheme 退路被搬進 @supports 了").toMatch(/color-scheme:\s*dark/);
  });

  it("清單展開中（select:open）下拉本體保持現身——焦點已移進 option，:focus 撐不住", () => {
    // base-select 展開時焦點移進 `<option>`，select 的 :focus／:focus-within 都不成立（Chromium 151 觸控模擬實測）；
    // 編輯器同時 blur、caret 屬性拿掉。少了這條，手指／滑鼠一離開 block 下拉就淡出、清單卻還開著。真瀏覽器那半由 e2e 30 守。
    const rules = [...baseSelectBlock().matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
    const open = rules.find((r) => r.selector.split(",").some((s) => /\[data-content-type=codeBlock\]\s*>\s*div\s*>\s*select:open$/.test(s.trim())));
    expect(open, "@supports (appearance: base-select) 裡缺 select:open 的現身規則").toBeDefined();
    expect(open!.body).toMatch(/(?:^|[;{])\s*opacity:\s*1\b/);
    expect(open!.body).toMatch(/(?:^|[;{])\s*pointer-events:\s*auto/);
    // `:open` 不認得的瀏覽器會讓整條選擇器清單作廢——不得併進 @supports 外的現身規則。
    const outside = readIndexCss().replace(baseSelectBlock(), "");
    expect(outside, ":open 不得出現在 @supports 外（會讓不支援的瀏覽器整條現身規則作廢）").not.toMatch(/select:open\b/);
  });

  it("唯讀（disabled）時 base-select 的箭頭退場、可編輯態保留（公開頁回報：hover 出現不能按的下拉）", () => {
    // 掏掉這條規則不會讓任何渲染測試紅（jsdom 畫不了 ::picker-icon）——失敗形＝
    // user 回報的 bug 靜默復活，所以在源碼層釘（本 describe 的既有慣例）。
    const block = baseSelectBlock();
    const rules = [...block.matchAll(/([^{}]*)\{([^}]*)\}/g)];
    // ⚠ 選擇器串必須**拆逗號逐一**檢查（scrollbar-guard 立過的規矩）：整串 test 的話
    // 「enabled, disabled 併成一條」的突變——可編輯態箭頭也消失、打破 #111 的 caret
    // 宣稱——會同時騙過正向與反向釘（實跑證實過）。拆開後：恰一個選擇器隱藏箭頭、
    // 且它必須是 disabled 態。
    const iconSelectors = rules
      .filter((m) => /::picker-icon/.test(m[1]!) && /display:\s*none/.test(m[2]!))
      .flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    expect(iconSelectors, "缺隱藏箭頭的規則——唯讀 hover 又會長出箭頭").toHaveLength(1);
    expect(
      iconSelectors.every((s) => /select:disabled::picker-icon$/.test(s)),
      `隱藏箭頭的規則只能命中 disabled 態，可編輯態被一併藏掉：${iconSelectors.join(" | ")}`,
    ).toBe(true);
    // 單項貼右：箭頭退場後 space-between 退化成 flex-start，語言標籤會浮在 min-width
    // 撐出的空盒左端——disabled 態補 flex-end（mermaid 唯讀鈕同位置）。
    const disabledSelect = rules.filter(
      (m) => /select:disabled\s*$/.test(m[1]!.trim()) && /justify-content:\s*flex-end/.test(m[2]!),
    );
    expect(disabledSelect, "缺 select:disabled 的 justify-content: flex-end——唯讀標籤浮在空盒左端").toHaveLength(1);
  });

  it("issue #111：清單長相對齊 app 既有的 ⋮ 選單（同一個 app 的清單就該長一樣）", () => {
    const block = baseSelectBlock();
    const menuSource = readFileSync(`${process.cwd()}/src/components/ui/dropdown-menu.tsx`, "utf8");

    // 容器 ↔ DropdownMenuContent；選項 ↔ DropdownMenuItem。兩邊用的是**同一組 Tailwind
    // class 名**（不是換算過的數值），所以這裡逐個 token 對照即可。
    const container = ["rounded-md", "border-border", "bg-popover", "p-1", "text-popover-foreground", "shadow-md"];
    const item = ["rounded-sm", "px-2", "py-1.5", "text-sm", "transition-colors"];
    const pickerRule = /::picker\(select\)\s*\{([^}]*)\}/g;
    const pickerBodies = [...block.matchAll(pickerRule)].map((m) => m[1]!).join(" ");
    const optionBodies = [...block.matchAll(/>\s*option[^{]*\{([^}]*)\}/g)].map((m) => m[1]!).join(" ");

    for (const token of container) {
      expect(menuSource, `DropdownMenuContent 不再用 ${token}——兩邊的對照要重新確認`).toContain(token);
      expect(pickerBodies, `::picker(select) 缺 ${token}`).toContain(token);
    }
    for (const token of item) {
      expect(menuSource, `DropdownMenuItem 不再用 ${token}——兩邊的對照要重新確認`).toContain(token);
      expect(optionBodies, `option 缺 ${token}`).toContain(token);
    }
    // 選中/hover 的高亮也走同一組 accent token。
    expect(optionBodies, "option 的 hover/focus 要用 bg-accent／text-accent-foreground").toMatch(
      /bg-accent[^;]*text-accent-foreground/,
    );
  });

  it("issue #111：唯讀時退成純文字標籤（BlockNote 仍渲染 select，只是 disabled）", () => {
    const disabled = selectRules().find((r) => /:disabled/.test(stateOf(r.selector)));
    expect(disabled, "缺 select:disabled 的覆寫——唯讀時會是個點不動的按鈕外框").toBeDefined();
    expect(disabled!.selector, `少了 .bn-editor 錨：${disabled!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(disabled!.body).toMatch(/border-color:\s*transparent/);
    // 底色**不得**拆掉（2026-10-15 起）：標籤疊在程式碼上，muted 字直接壓在淺色
    // `--code-background` 上只有 4.45:1（< 4.5），留著 `.block-control` 的實底才過。
    expect(disabled!.body, "唯讀標籤疊在程式碼上，不得拆掉實底").not.toMatch(/background(?:-color)?:/);
  });
});
