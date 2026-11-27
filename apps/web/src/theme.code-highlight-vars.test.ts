import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CARET_INSIDE_ATTR } from "@/collab/code-block-caret";

/**
 * Structural guard for the code highlight variables (issue #96) (same technique as `theme.block-selection-guard.test.ts`).
 *
 * shiki uses `createCssVariablesTheme`: token colours are always output as `var(--code-...)`,
 * and **the actual colour values live only in `index.css`**. This guards three things, each of the kind where breakage turns no test red
 * and only silently makes the screen ugly / unreadable:
 *
 * 1. **Both colour sets must be complete**: `--code-*` is defined once in `:root` (light) and once in `:root.dark`. If dark misses a variable,
 *    that token silently inherits the light value (CSS variable inheritance), and the contrast of light text on a dark background is gone.
 * 2. **The codeBlock background override must beat the built-in**: BlockNote hard-codes `color:#fff` + a `#161616` dark background
 *    (specificity (0,2,0), loaded after index.css) - an override without the `.bn-editor` anchor
 *    (falling back to (0,2,0)) silently brings the dark block back in light mode.
 * 3. **Decoupled from accent**: the issue's design constraint - code colours are semantic colours and must not reference the
 *    `--brand` / `--color-brand` family (changing the accent must not change any colour of a code block).
 */

function readIndexCss(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The variables shiki's `createCssVariablesTheme` (prefix `--code-`) references, except its 16 `--code-ansi-*` ones. */
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

function themeBlocks(): { light: string; dark: string } {
  const css = readIndexCss();
  // Takes the `:root` **that contains `--code-*`**, not the first one: since issue #111 index.css has a second top-level `:root`
  // (shared scrollbar variables), and relying on order would become an undocumented dependency.
  const light = [...css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes("--code-"));
  // Same reason as above: take the `:root.dark` that contains `--code-*`, don't rely on order. The dark base block is anchored at `:root` since #154
  // (a bare `.dark` would match again on BlockNote's `.bn-root.dark`).
  const dark = [...css.matchAll(/(?:^|\n):root\.dark\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes("--code-"));
  expect(light, "index.css 應有頂層 :root 區塊").toBeDefined();
  expect(dark, "index.css 應有頂層 :root.dark 區塊").toBeDefined();
  return { light: light!, dark: dark! };
}

/** The value of a variable in a theme block (trailing comments are already stripped by readIndexCss). */
function varValue(block: string, name: string): string {
  const value = block.match(new RegExp(`(?:^|[;{\\s])--${name}:\\s*([^;]+);`))?.[1]?.trim();
  expect(value, `主題區塊缺 --${name}`).toBeDefined();
  return value!;
}

/** `#rrggbb` or `oklch(L C H)` -> linear sRGB (0-1). Translucent values aren't accepted: contrast has to be judged on the actual composited colour, and if it can't be computed it should go red. */
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
  // OKLab -> LMS -> linear sRGB (coefficients from Bjorn Ottosson).
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

/** WCAG 2.x contrast ratio. */
function contrast(x: [number, number, number], y: [number, number, number]): number {
  const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("code highlight variables (--code-*)", () => {
  it("light (:root) and dark (:root.dark) each define the full set - dark missing one means that token silently inherits the light colour", () => {
    const { light, dark } = themeBlocks();
    for (const name of CODE_VARS) {
      expect(light, `light 缺 ${name}`).toContain(`${name}:`);
      expect(dark, `dark 缺 ${name}`).toContain(`${name}:`);
    }
  });

  it("colour values don't reference accent (the --brand family) - changing the accent must not change any colour of a code block", () => {
    const { light, dark } = themeBlocks();
    for (const block of [light, dark]) {
      for (const line of block.split("\n").filter((l) => l.trimStart().startsWith("--code-"))) {
        expect(line, `程式碼配色不得跟 accent 走：${line.trim()}`).not.toMatch(/--(?:color-)?brand/);
      }
    }
  });
});

describe("latex math colour", () => {
  it("--code-token-constant (the colour shiki gives LaTeX math) reaches WCAG AA text contrast on --code-background in light and dark", () => {
    const { light, dark } = themeBlocks();
    for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
      const color = (name: string) => parseColor(varValue(block, name), `${theme} --${name}`);
      const ratio = contrast(color("code-token-constant"), color("code-background"));
      expect(ratio, `${theme}: --code-token-constant on --code-background is only ${ratio.toFixed(2)}:1 (need >= 4.5)`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("codeBlock background override", () => {
  function codeBlockRules(): { selector: string; body: string }[] {
    const css = readIndexCss();
    return [...css.matchAll(/([^{}]*\[data-content-type=codeBlock\][^{}]*)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
  }

  it("an override anchored at .bn-editor exists (specificity must beat the built-in (0,2,0)), and background and text both use --code-* variables", () => {
    const rules = codeBlockRules();
    const main = rules.find((r) => /background/.test(r.body));
    expect(main, "index.css 缺 codeBlock 底色覆寫——淺色模式會是 BlockNote 寫死的 #161616 深色方塊").toBeDefined();
    expect(main!.selector, "少了 .bn-editor 錨點就墊不到 (0,3,0)，載入順序上必輸給 BlockNote 的 CSS").toMatch(/^\.bn-editor\s/);
    expect(main!.body).toContain("var(--code-background)");
    expect(main!.body).toContain("var(--code-foreground)");
    expect(main!.body, "不該把 BlockNote 寫死的深底抄過來").not.toContain("#161616");
  });

  function selectRules(): { selector: string; body: string }[] {
    return codeBlockRules().filter((r) => /select/.test(r.selector));
  }

  /**
   * Strips `:not(...)` from the selector before doing state checks.
   *
   * `select:not(:disabled)` is the way **base state** is written, but literally contains `:disabled` - the three places that pick rules
   * by selector (base state, hover/focus, disabled) must all strip it first, otherwise they would pick the wrong rule and **falsely go red**.
   */
  function stateOf(selector: string): string {
    return selector.replace(/:not\([^)]*\)/g, "");
  }

  function allRules(): { selector: string; body: string }[] {
    return [...readIndexCss().matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
  }

  function baseSelectRule(): { selector: string; body: string } | undefined {
    return selectRules().find(
      (r) =>
        /\[data-content-type=codeBlock\]\s*>\s*div\s*>\s*select$/.test(r.selector) && /(?:^|[;{])\s*opacity:/.test(r.body),
    );
  }

  function applyTokens(body: string): string[] {
    return (body.match(/@apply\s+([^;]*);/)?.[1] ?? "").trim().split(/\s+/);
  }


  it("the language dropdown's text colour must also change - the built-in hard-codes color:#fff, which is invisible on a light background", () => {
    // In #96 this was a `color:` override on the select itself; since #111 the colour is shared with the mermaid button's rule
    // (`.block-control`'s `@apply ... text-muted-foreground`).
    const rules = selectRules();
    expect(rules.length, "index.css 完全沒有接住語言下拉的規則").toBeGreaterThan(0);
    for (const rule of rules) {
      // The anchor check has the same reason as the background one: the built-in select rule is also in the lazy chunk, loaded after index.css,
      // and without the .bn-editor anchor it loses at equal specificity, and the built-in look (#fff, top-left, invisible) silently
      // comes back.
      expect(rule.selector, `少了 .bn-editor 錨：${rule.selector}`).toMatch(/\.bn-editor\s/);
      expect(rule.body, `不得留下寫死色：${rule.selector}`).not.toContain("#fff");
    }

    // This section must be pinned to the **base state** rule (no state pseudo-class) that **applies to the select itself**.
    // Loosening it gives two kinds of false green:
    //   `some(/color:\s*var\(--/)` over every rule containing `select` - `background-color`,
    //           `border-color` and even the picker's `scrollbar-color` all match.
    //   Excluding only option / picker isn't enough - writing the colour only on `select:disabled` still
    //           passes, but the dropdown on an **editable** note has already fallen back to the built-in `color:#fff` (white text
    //           on a white background on a light surface, exactly the #96 failure).
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

  it("the language dropdown overlays the **inside** top-right corner of the block: position comes from the shared .block-control (top/right), not the outer-top-edge bottom:100%", () => {
    const idle = baseSelectRule();
    expect(idle, "缺語言下拉的基底覆寫（opacity:0 那條）").toBeDefined();
    expect(idle!.selector, `少了 .bn-editor 錨：${idle!.selector}`).toMatch(/^\.bn-editor\s/);

    // Position is written only in the shared rule: both block types' controls overlap in the same corner (the "unified" position half).
    const shared = allRules().find((r) => /\.block-control\b/.test(r.selector));
    expect(shared, "index.css 缺 `.block-control` 共用規則").toBeDefined();
    const apply = applyTokens(shared!.body);
    expect(apply, "共用規則要絕對定位（疊在方塊內容上）").toContain("absolute");
    // An inset top/right (positive, via utilities rather than copied by hand) = the top-right corner **inside** the block.
    expect(apply.some((t) => /^top-\d+(?:\.\d+)?$/.test(t)), `缺 top-N：${apply.join(" ")}`).toBe(true);
    expect(apply.some((t) => /^right-\d+(?:\.\d+)?$/.test(t)), `缺 right-N：${apply.join(" ")}`).toBe(true);
    // Falling back to the outer top edge (#111's bottom:100% / bottom-full) or a negative top both go back outside the block.
    expect(apply.some((t) => /^(?:bottom-|-top-|-right-)/.test(t)), `不得把控制項推出方塊：${apply.join(" ")}`).toBe(false);
    for (const rule of selectRules()) {
      // The boundary `(?:^|[;{])\s*`: a bare regex would be fed by `margin-bottom` / `margin-top` and the like (#111).
      expect(rule.body, `select 規則不得再用 bottom 定位：${rule.selector}`).not.toMatch(/(?:^|[;{])\s*bottom:/);
      expect(rule.body, `select 規則不得用負 top 把它推到方塊外：${rule.selector}`).not.toMatch(/(?:^|[;{])\s*top:\s*-/);
    }

    // `left:auto` can't be omitted: the built-in `left:18px` is still there, and without it the dropdown would stretch from the left edge + 18px to the top-right corner,
    // covering the whole first line of code (headless Chromium 151, see the index.css comment).
    expect(idle!.body, "缺 left:auto——內建的 left:18px 會把下拉撐成一整條").toMatch(/(?:^|[;{])\s*left:\s*auto/);

    // Width lower bound: a native select's width follows the label currently chosen (`C` 36px <-> `Markdown` 86px);
    // without a lower bound it would jump at every language change.
    expect(idle!.body, "缺寬度下限——控制項寬度會隨選到的語言縮放").toMatch(/min-width:\s*[0-9.]+rem/);
    // Deliberately **not** `width`: that value would have to be measured (character width depends on the font), and a hard-coded width with
    // `overflow:hidden` fails as "label silently truncated"; min-width fails only as slightly wider,
    // and it is right-anchored so the right edge doesn't move.
    // The boundary has to be written `[;{])\s*` (not `[;{]\s*)`): the first declaration of a body is preceded by a newline + indentation,
    // and only the former matches it. The same mistake was made in the `carriesColor` check (when a hard-coded width was the first declaration
    // that check passed green).
    expect(idle!.body, "不得寫死 width：換字型／更長的語言名會變成靜默截斷").not.toMatch(
      /(?:^|[;{])\s*width:/,
    );
    expect(idle!.body, "有了 min-width 就不該再用 overflow:hidden 去藏溢出").not.toMatch(/overflow:\s*hidden/);
  });

  it("no reserved row (#111's 1.75rem is gone): codeBlock no longer has margin-top, mermaid no longer has the h-7 row", () => {
    // The control overlaps inside the block and is invisible most of the time, so no extra height needs to be reserved. Both sides must be removed - removing only one side makes the spacing differ between the two block types.
    for (const rule of codeBlockRules()) {
      expect(rule.body, `codeBlock 不得再讓出保留列：${rule.selector}`).not.toMatch(/(?:^|[;{])\s*margin-top:/);
    }
    const mermaidSource = readFileSync(`${process.cwd()}/src/components/mermaid/MermaidView.tsx`, "utf8");
    expect(mermaidSource, "MermaidView 不得再有固定高度的工具列（h-7 那列）").not.toMatch(/className="[^"]*\bh-\d+\b[^"]*justify-end/);
  });

  it("the control's look has a single source of truth: one rule with two selectors (mermaid button + language dropdown)", () => {
    // This reads `MermaidView.tsx` directly against its consumer: if each side changed on its own that is #111's original state (one on the left, one on the right,
    // one hidden and one shown, two looks), and pinning only the CSS side wouldn't pin "unified".
    const mermaidSource = readFileSync(`${process.cwd()}/src/components/mermaid/MermaidView.tsx`, "utf8");

    // **One rule with two selectors**, not a copy on each side. An earlier version was "write one each and compare the values in tests", which resulted in
    // `rounded-sm` being copied as `0.125rem` - that is Tailwind **v3**'s value, while v4's `rounded-sm` is
    // `0.25rem`, half the corner radius. With no manual conversion, this family of drift is really gone.
    const shared = allRules().find((r) => /\.block-control\b/.test(r.selector));
    expect(shared, "index.css 缺 `.block-control` 共用規則").toBeDefined();
    expect(
      shared!.selector,
      "共用規則要同時接上 codeBlock 的語言下拉（原生 select 拿不到 className，只能用選擇器接進來）",
    ).toMatch(/\.bn-editor\s[^,]*\[data-content-type=codeBlock\][^,]*>\s*div\s*>\s*select/);
    expect(shared!.body, "長相要走 @apply 吃同一組 utility，不得手抄數值").toMatch(/@apply\s+[^;]*rounded-sm/);
    expect(shared!.body, "手抄 border-radius 就是圓角差一半的那個錯法").not.toMatch(/border-radius:/);
    // The one thing specific to the native select: CSS has no "inherit font" default, so without this it uses the OS UI font,
    // clearly a different font from the neighbouring <button>.
    expect(shared!.body, "缺 font-family: inherit").toMatch(/font-family:\s*inherit/);

    // Consumer: the mermaid button must carry this class and must not list its own look or position utilities.
    expect(mermaidSource, "MermaidView 的控制鈕要掛 block-control").toContain('"block-control"');
    expect(
      mermaidSource,
      "MermaidView 不得再自己寫一份長相 class（rounded-*＋border-*）——那就是回到兩份真相",
    ).not.toMatch(/rounded-(?:xs|sm|md|lg)[^"]*border-border/);
    // "Must not write its own position" is asserted against the rendered className tokens in `MermaidView.test.tsx` (order-insensitive, unaffected by comments).
  });

  it("when shown it has a solid background plus a border, and the WCAG contrast passes in both light and dark (text >= 4.5, border against the block background >= 3)", () => {
    // The control sits over code / diagrams: without its own background it can't be read, and without a dark enough border it blurs into the block background.
    // This takes the tokens `.block-control`'s @apply **actually uses** and computes contrast against the variable values of index.css's two themes -
    // changing a token or a colour value so that contrast drops turns it red, no need to re-measure.
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
    // A transparent background / border is the same as none (`bg-transparent`, `border-transparent`, translucent `/NN` don't count as solid).
    for (const name of [bg, border]) expect(name, `不得用透明或半透明：${name}`).not.toMatch(/transparent|\//);

    // utility name -> theme variable: `@theme inline`'s `--color-X: var(--X)` (confirm this mapping really exists,
    // otherwise what is computed below would be the wrong variable).
    const css = readIndexCss();
    // codeBlock's background uses var(--code-background) directly (pinned by the background override test above), not via a utility.
    for (const name of [fg, bg, border, "card"]) {
      expect(css, `@theme inline 缺 --color-${name}: var(--${name})`).toMatch(new RegExp(`--color-${name}:\\s*var\\(--${name}\\)`));
    }

    const { light, dark } = themeBlocks();
    for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
      const color = (name: string) => parseColor(varValue(block, name), `${theme} --${name}`);
      const text = contrast(color(fg), color(bg));
      // Block background: for codeBlock it is `--code-background`; mermaid sits on the editor surface `--card`
      // (`--bn-colors-editor-background: var(--color-card)`).
      const onCode = contrast(color(border), color("code-background"));
      const onCard = contrast(color(border), color("card"));
      expect(text, `${theme}：--${fg} 對 --${bg} 只有 ${text.toFixed(2)}:1（文字要 ≥ 4.5）`).toBeGreaterThanOrEqual(4.5);
      expect(onCode, `${theme}：邊框 --${border} 對 --code-background 只有 ${onCode.toFixed(2)}:1（要 ≥ 3）`).toBeGreaterThanOrEqual(3);
      expect(onCard, `${theme}：邊框 --${border} 對 --card 只有 ${onCard.toFixed(2)}:1（要 ≥ 3）`).toBeGreaterThanOrEqual(3);
    }
  });

  it("invisible and click-through when idle; appears when hovering the whole block, with the cursor in the code (data-caret-inside), or on focus", () => {
    const idle = baseSelectRule();
    expect(Number(idle!.body.match(/(?:^|[;{])\s*opacity:\s*([0-9.]+)/)?.[1]), "閒置態要 opacity:0").toBe(0);
    // When invisible it overlaps the code: a touch on that corner must not be swallowed by an invisible dropdown (wanting to place the cursor but opening the language menu).
    expect(idle!.body, "閒置態要 pointer-events:none").toMatch(/(?:^|[;{])\s*pointer-events:\s*none/);

    // The appearing rule = has a state selector **and declares `opacity:1`** (hover / pressed colour feedback also carries :hover but doesn't touch opacity).
    const raised = selectRules().find(
      (r) => /:hover|:focus|data-caret-inside/.test(stateOf(r.selector)) && /(?:^|[;{])\s*opacity:\s*1\b/.test(r.body),
    );
    expect(raised, "缺現身規則").toBeDefined();
    // Split the selector list **by commas and compare one by one** (a rule set by scrollbar-guard): with a whole-string test, whichever of the three conditions
    // is missing is still fooled if a string elsewhere happens to contain it.
    const parts = raised!.selector.split(",").map((s) => s.trim());
    for (const part of parts) expect(part, `少了 .bn-editor 錨：${part}`).toMatch(/^\.bn-editor\s/);
    // hover must hang on the **whole block** (not the select's own hover) - otherwise you'd have to touch the
    // invisible small box before it appears, which means it can't be reached.
    expect(
      parts.some((p) => /\[data-content-type=codeBlock\]:hover\s*>\s*div\s*>\s*select$/.test(p)),
      `hover 要吃整個 block：${parts.join(" | ")}`,
    ).toBe(true);
    // Touch has no hover: when the cursor taps into the code it must appear. The attribute is attached by the decoration in `collab/code-block-caret.ts` -
    // a name mismatch leaves both sides green and the feature dead, so compare against the constant exported by that file directly.
    expect(
      parts.some((p) => new RegExp(`\\[data-content-type=codeBlock\\]\\[${CARET_INSIDE_ATTR}\\]\\s*>\\s*div\\s*>\\s*select$`).test(p)),
      `缺 [${CARET_INSIDE_ATTR}]——觸控裝置叫不出語言下拉：${parts.join(" | ")}`,
    ).toBe(true);
    // The `:focus` half is the only keyboard entry (hiding with opacity instead of display is to keep the Tab order).
    expect(parts.some((p) => /select:focus$/.test(p)), `缺 :focus——鍵盤使用者會構不到：${parts.join(" | ")}`).toBe(true);
    // It must be at full contrast when shown: the built-in hover only goes to .5 (effective contrast in light is 3.1:1 < AA 4.5).
    expect(Number(raised!.body.match(/(?:^|[;{])\s*opacity:\s*([0-9.]+)/)?.[1]), "現身時不得半透明").toBe(1);
    expect(raised!.body, "現身時要把 pointer-events 還回來，否則點不到").toMatch(/(?:^|[;{])\s*pointer-events:\s*auto/);
  });

  it("issue #111: option colour and color-scheme of the expanded list (OS widget) follow the theme - the built-in hard-codes color:#000, invisible in dark mode", () => {
    const rules = codeBlockRules();
    const option = rules.find((r) => /select\s*>\s*option/.test(r.selector));
    expect(option, "缺 option 的顏色覆寫——內建 `option{color:#000}` 在深色清單上等於看不見").toBeDefined();
    expect(option!.selector, `少了 .bn-editor 錨：${option!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(option!.body).toMatch(/color:\s*var\(--color-foreground\)/);
    expect(option!.body).toMatch(/background-color:\s*var\(--color-background\)/);
    expect(option!.body, "不得把內建寫死的黑抄過來").not.toContain("#000");

    // Both colour-scheme sets must be present, otherwise the native list's background / scrollbar is still the other theme's.
    const schemes = rules.filter((r) => /color-scheme:/.test(r.body));
    expect(schemes.map((r) => r.body.match(/color-scheme:\s*(\w+)/)?.[1]).sort()).toEqual(["dark", "light"]);
    const darkScheme = schemes.find((r) => /dark/.test(r.body.match(/color-scheme:\s*(\w+)/)?.[1] ?? ""));
    expect(darkScheme!.selector, "深色那條要以 .dark 起頭（主題切換靠 class，不是 media query）").toMatch(
      /^\.dark\s/,
    );
  });

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

  it("issue #111: the customisable select is only **progressive enhancement** - the native list set must stay outside @supports", () => {
    const block = baseSelectBlock();
    // The spec requires both select and ::picker(select) to switch to the base appearance; with only select the list
    // is still an OS widget (looks like it didn't take effect, with no error).
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

    // Under the base appearance select becomes a flex container, and `::picker-icon` (the arrow) sticks to the right edge through this; without
    // it the arrow follows right after the language name floating in the middle, and the space `min-width` creates all falls on the right.
    expect(block, "缺 justify-content: space-between——箭頭不會貼在控制項右緣").toMatch(
      /justify-content:\s*space-between/,
    );

    // The fallback (for browsers like Firefox that don't support it yet) must be **outside** @supports: moving it inside is the same as going back to
    // BlockNote's hard-coded `option{color:#000}`, and the list is invisible in dark mode again.
    const css = readIndexCss();
    const outside = css.replace(block, "");
    expect(outside, "option 的顏色退路被搬進 @supports 了").toMatch(/option\s*\{[^}]*color:\s*var\(--color-foreground\)/);
    expect(outside, "color-scheme 退路被搬進 @supports 了").toMatch(/color-scheme:\s*dark/);
  });

  it("while the list is expanded (select:open) the dropdown itself stays visible - focus has moved into the option, so :focus can't hold it", () => {
    // When base-select is expanded, focus moves into `<option>` and neither :focus nor :focus-within holds on the select (Chromium 151 with touch emulation);
    // the editor blurs at the same time and the caret attribute is removed. Without this rule the dropdown fades as soon as the finger / mouse leaves the block while the list is still open. The real-browser half is covered by e2e/tests/30-code-block-touch.spec.ts.
    const rules = [...baseSelectBlock().matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
    const open = rules.find((r) => r.selector.split(",").some((s) => /\[data-content-type=codeBlock\]\s*>\s*div\s*>\s*select:open$/.test(s.trim())));
    expect(open, "@supports (appearance: base-select) 裡缺 select:open 的現身規則").toBeDefined();
    expect(open!.body).toMatch(/(?:^|[;{])\s*opacity:\s*1\b/);
    expect(open!.body).toMatch(/(?:^|[;{])\s*pointer-events:\s*auto/);
    // Browsers that don't recognise `:open` invalidate the whole selector list - it must not be merged into the appearing rule outside @supports.
    const outside = readIndexCss().replace(baseSelectBlock(), "");
    expect(outside, ":open 不得出現在 @supports 外（會讓不支援的瀏覽器整條現身規則作廢）").not.toMatch(/select:open\b/);
  });

  it("read-only (disabled): base-select's arrow is hidden, kept in the editable state (public page report: hover showed a dropdown that can't be pressed)", () => {
    // Dropping this rule turns no render test red (jsdom can't draw ::picker-icon) - the failure shape = the reported bug silently
    // comes back, so it is pinned at source level (the existing convention in this describe).
    const block = baseSelectBlock();
    const rules = [...block.matchAll(/([^{}]*)\{([^}]*)\}/g)];
    // The selector list must be **split by commas and checked one by one** (a rule set by scrollbar-guard): with a whole-string test,
    // the mutation "enabled, disabled merged into one rule" - the arrow also disappears in the editable state, breaking #111's caret
    // claim - would fool both the positive and the negative pin. After splitting: exactly one selector hides the arrow,
    // and it must be the disabled state.
    const iconSelectors = rules
      .filter((m) => /::picker-icon/.test(m[1]!) && /display:\s*none/.test(m[2]!))
      .flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    expect(iconSelectors, "缺隱藏箭頭的規則——唯讀 hover 又會長出箭頭").toHaveLength(1);
    expect(
      iconSelectors.every((s) => /select:disabled::picker-icon$/.test(s)),
      `隱藏箭頭的規則只能命中 disabled 態，可編輯態被一併藏掉：${iconSelectors.join(" | ")}`,
    ).toBe(true);
    // For a single item sticking right: once the arrow is gone space-between degrades to flex-start, and the language label floats at the left end of the empty
    // box that min-width creates - add flex-end for the disabled state (same position as the read-only mermaid button).
    const disabledSelect = rules.filter(
      (m) => /select:disabled\s*$/.test(m[1]!.trim()) && /justify-content:\s*flex-end/.test(m[2]!),
    );
    expect(disabledSelect, "缺 select:disabled 的 justify-content: flex-end——唯讀標籤浮在空盒左端").toHaveLength(1);
  });

  it("issue #111: the list's look matches the app's existing menu (a list in the same app should look the same)", () => {
    const block = baseSelectBlock();
    const menuSource = readFileSync(`${process.cwd()}/src/components/ui/dropdown-menu.tsx`, "utf8");

    // container <-> DropdownMenuContent; option <-> DropdownMenuItem. Both use the **same set of Tailwind
    // class names** (not converted values), so comparing token by token is enough.
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
    // The selected / hover highlight also uses the same accent tokens.
    expect(optionBodies, "option 的 hover/focus 要用 bg-accent／text-accent-foreground").toMatch(
      /bg-accent[^;]*text-accent-foreground/,
    );
  });

  it("issue #111: when read-only it falls back to a plain-text label (BlockNote still renders the select, just disabled)", () => {
    const disabled = selectRules().find((r) => /:disabled/.test(stateOf(r.selector)));
    expect(disabled, "缺 select:disabled 的覆寫——唯讀時會是個點不動的按鈕外框").toBeDefined();
    expect(disabled!.selector, `少了 .bn-editor 錨：${disabled!.selector}`).toMatch(/^\.bn-editor\s/);
    expect(disabled!.body).toMatch(/border-color:\s*transparent/);
    // The background **must not** be removed: the label overlaps the code, and muted text directly over the light
    // `--code-background` is only 4.45:1 (< 4.5); keeping `.block-control`'s solid background is what passes.
    expect(disabled!.body, "唯讀標籤疊在程式碼上，不得拆掉實底").not.toMatch(/background(?:-color)?:/);
  });
});
