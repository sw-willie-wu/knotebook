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
  // ⚠ 取的是**含 --code-* 的那個** `:root`，不是第一個：index.css 自 issue #111 起有
  // 第二個頂層 `:root`（滾動條的共用變數），靠出現順序抓會變成一條沒人寫下來的相依。
  const light = [...css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes("--code-"));
  // 與上面同理由：抓「含 --code-* 的那個 `.dark`」，不靠出現順序。
  const dark = [...css.matchAll(/(?:^|\n)\.dark\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes("--code-"));
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

  /** 語言下拉的規則（定位／hover-focus／disabled／共用長相），依 body 特徵分辨。 */
  function selectRules(): { selector: string; body: string }[] {
    return codeBlockRules().filter((r) => /select/.test(r.selector));
  }

  /** index.css 全部的頂層規則（`.block-control` 那條的選擇器不含 codeBlock 以外的錨）。 */
  function allRules(): { selector: string; body: string }[] {
    return [...readIndexCss().matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
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
      // `:not(:disabled)` 之類是**基底態**的寫法，不該被當成狀態規則排除掉（會變假紅）
      // ——先把 `:not(…)` 的內容剝掉再判斷。
      const withoutNot = r.selector.replace(/:not\([^)]*\)/g, "");
      return !/>\s*option|::picker/.test(withoutNot) && !/:(?:hover|focus|disabled|open|active)\b/.test(withoutNot);
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

  it("issue #111：語言下拉貼在方塊**外面的上緣、靠右**（bottom:100%，不是算好的負 top）", () => {
    const idle = selectRules().find((r) => /bottom:/.test(r.body) && /opacity:/.test(r.body));
    expect(idle, "缺語言下拉的定位覆寫（bottom ＋ opacity 那條）").toBeDefined();
    expect(idle!.selector, `少了 .bn-editor 錨：${idle!.selector}`).toMatch(/^\.bn-editor\s/);

    // 四個宣告缺一不可，缺哪個都是**靜默**回到內建位置：實測（真實元素上逐一拿掉）
    // 少了 `top:auto` 會落回 block 上緣 ＋8px（方塊內），少了 `left:auto` 會落到
    // block 左緣 ＋18px。`index.css` 那段註解記了完整量測與一個警告——表單控制項在
    // 絕對定位下的**尺寸**解算兩軸不同、且不同環境量到的不一樣，別靠推理，要改就重量。
    expect(idle!.body, "缺 bottom:100%——那是「貼齊方塊上緣」的定位方式").toMatch(/bottom:\s*100%/);
    expect(idle!.body, "缺 top:auto——內建的 top:8px 會贏過 bottom，下拉回到方塊內部").toMatch(/top:\s*auto/);
    expect(idle!.body, "缺 right（要與 mermaid 控制鈕同側）").toMatch(/right:\s*\d/);
    expect(idle!.body, "缺 left:auto——內建的 left:18px 會贏過 right，下拉仍在左上角").toMatch(/left:\s*auto/);
    // 用**負 top** 定位是上一版的錯法：那要自己扣掉控制項高度，字級或內距一改就浮起來
    // （實測浮了 6px，Willie 回報「沒貼在 block 上」）。
    // `(?:^|[;{])\s*top:` 的邊界同上；不加的話 `margin-top: -…` 也會被當成負 top（假紅）。
    expect(idle!.body, "不要退回用負 top 定位——高度一變就浮起來").not.toMatch(/(?:^|[;{])\s*top:\s*-/);

    // 寬度下限：原生 select 的寬度跟著目前選到的標籤走（`C` 36px ↔ `Markdown` 86px），
    // 沒有下限就會每換一個語言跳一次。
    expect(idle!.body, "缺寬度下限——控制項寬度會隨選到的語言縮放").toMatch(/min-width:\s*[0-9.]+rem/);
    // ⚠ 刻意**不是** `width`：那個值是量出來的（字寬看字型），寫死 width 配上
    // `overflow:hidden` 的失敗形是「標籤被靜默截斷」；min-width 的失敗形只是變寬一點，
    // 而它右錨定（`right:0`），右緣不動。
    // ⚠ 邊界要寫成 `[;{])\s*`（不是 `[;{]\s*)`）：body 的第一條宣告前面是換行＋縮排，
    // 前者才吃得到。同形的錯在 `carriesColor` 那條也犯過（寫死 width 當第一條宣告時
    // 這條原本全綠通過，第三輪 gate 突變實測抓到）。
    expect(idle!.body, "不得寫死 width：換字型／更長的語言名會變成靜默截斷").not.toMatch(
      /(?:^|[;{])\s*width:/,
    );
    expect(idle!.body, "有了 min-width 就不該再用 overflow:hidden 去藏溢出").not.toMatch(/overflow:\s*hidden/);
  });

  it("issue #111：保留列高度與控制項樣式都跟著 mermaid 的那顆走（『統一』的實質內容）", () => {
    // 這條直接讀 `MermaidView.tsx` 對值：兩邊各改各的就是 #111 的原狀（一左一右、
    // 一藏一露、兩套長相），只釘 CSS 這一側等於沒釘住「統一」。
    const mermaidSource = readFileSync(`${process.cwd()}/src/components/mermaid/MermaidView.tsx`, "utf8");

    // (1) 工具列高度：mermaid 是 `h-7`（Tailwind：7 × 4px ＝ 28px ＝ 1.75rem），
    //     codeBlock 這側是 block content 讓出的 margin-top。
    const rowHeightClass = mermaidSource.match(/className="flex (h-\d+) items-center justify-end"/)?.[1];
    expect(rowHeightClass, "在 MermaidView.tsx 找不到工具列的高度 class（版面改了就要一起看這條）").toBeDefined();
    const rowRem = (Number(rowHeightClass!.replace("h-", "")) * 4) / 16;
    const reserved = codeBlockRules().find((r) => /margin-top:/.test(r.body));
    expect(reserved, "缺保留列（block content 的 margin-top）").toBeDefined();
    expect(reserved!.selector, `少了 .bn-editor 錨：${reserved!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(
      Number(reserved!.body.match(/margin-top:\s*([0-9.]+)rem/)?.[1]),
      `保留列要與 mermaid 的 ${rowHeightClass} 同高`,
    ).toBe(rowRem);

    // (2) 控制項本身的長相：**一條規則兩個選擇器**，不是兩邊各抄一份。
    //     前一版是「各寫一份、測試逐項對值」，結果把 `rounded-sm` 抄成 `0.125rem`
    //     ——那是 Tailwind **v3** 的值，v4 的 `rounded-sm` 是 `0.25rem`，圓角就差一半
    //     （Willie 實測看出來的）。人工換算沒了，這一族的漂移才真的沒了。
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

    // 消費端：mermaid 那顆鈕要掛這個 class，且不得自己再列一份長相 utility。
    expect(mermaidSource, "MermaidView 的控制鈕要掛 block-control").toContain('"block-control"');
    expect(
      mermaidSource,
      "MermaidView 不得再自己寫一份長相 class（rounded-*＋border-border）——那就是回到兩份真相",
    ).not.toMatch(/rounded-(?:xs|sm|md|lg)[^"]*border-border/);
  });

  it("issue #111：平常隱形、hover 到 block 或聚焦才現身（與 mermaid 同邏輯）", () => {
    const idle = selectRules().find((r) => /bottom:/.test(r.body) && /opacity:/.test(r.body));
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
    const disabled = selectRules().find((r) => /:disabled/.test(r.selector));
    expect(disabled, "缺 select:disabled 的覆寫——唯讀時會是個點不動的按鈕外框").toBeDefined();
    expect(disabled!.selector, `少了 .bn-editor 錨：${disabled!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(disabled!.body).toMatch(/border-color:\s*transparent/);
    expect(disabled!.body).toMatch(/background-color:\s*transparent/);
  });
});
