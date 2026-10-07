import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import en from "./i18n/en.json";
import zhTW from "./i18n/zh-TW.json";
import { type Accent, ACCENTS } from "./theme";

/**
 * 主題色（accent）token 的 parity 守門測試（比照 `theme.blocknote-vars.test.ts`
 * 的手法：剝註解→定位塊→抽值）。
 *
 * 背景見 `index.css` 「主題色（accent）十二個套用塊」上方的區塊註解：
 * - 六色 × light/dark 共十二個 `[data-accent=…]` 塊，值必須逐字抄 spec 值表。
 * - `:root`/`:root.dark` 基底塊的五個 `--brand*` token（`--brand-fg` 不算，見下）
 *   是屬性不存在時的 fallback，必須逐字＝indigo 那組——這是「首屏 fallback 與
 *   hydrate 補設同色」的支點。
 * - `--brand-fg` 不分色票——只宣告在 `:root`／`:root.dark` 兩個基底塊，六色共用同一套
 *   前景字色，不隨 accent 變。它不進 `TOKEN_NAMES`（那是給「每色一份」的 token
 *   用的），改在 (g) 另外守：兩個基底塊都要有，且不得出現在任何
 *   `[data-accent=…]` 塊裡。
 * - `--brand-soft`/`--brand-soft-strong` 一律用該色 dark `--brand`（基色）的
 *   oklch 三值推導（light /14%、/20%；dark /16%、/24%），不得誤用 light
 *   `--brand`。
 *
 * 通用規則（F1/F2）：token 比對一律**逐名、以冒號錨定**（`--brand:`／
 * `--brand-soft:`／`--brand-soft-strong:`／`--brand-on-soft:` 四個精確名）。
 * 冒號緊接在名稱後，天然排除 `--brand-soft-strong:` 誤配到 `--brand-soft:`、
 * 也排除 `--brand-swatch-*:` 誤配到 `--brand:`——不需要額外的前綴排除邏輯，
 * 但仍需注意：任何抽值失敗（regex 找不到）一律靠 `expect(...).not.toBeNull()`
 * 立刻讓測試 fail，不得讓 undefined 落入後續比對造成 undefined===undefined
 * 假通過。
 *
 * 色名單一律 import `theme.tsx` 的 `ACCENTS`（不得自抄一份）：新增色只改
 * ACCENTS 一處，缺 CSS 塊會被 (a)–(e) 抓、缺 i18n 色名會被 (f) 抓。
 */

const COLORS = ACCENTS;
type Color = Accent;

const TOKEN_NAMES = ["--brand", "--brand-soft", "--brand-soft-strong", "--brand-on-soft", "--brand-deep"] as const;

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 從 selector 的起點往後找第一組 `{ ... }`，回傳花括號內的原始字串。
 * 這些區塊都不含巢狀花括號，找「起點後第一個 `}`」即可安全定位結尾。 */
function extractBlockBody(css: string, selectorRegex: RegExp, label: string): string {
  const match = selectorRegex.exec(css);
  expect(match, `index.css 找不到區塊：${label}`).not.toBeNull();
  const start = match!.index;
  const braceStart = css.indexOf("{", start);
  expect(braceStart, `${label} 找不到起始 {`).toBeGreaterThan(-1);
  const end = css.indexOf("}", braceStart);
  expect(end, `${label} 找不到結尾 }`).toBeGreaterThan(-1);
  return css.slice(braceStart + 1, end);
}

function extractDataAccentBlock(css: string, prefix: ":root" | ":root.dark", color: Color): string {
  // `:root\[` 不會吃到 `:root.dark[…]`（中間夾著 `.dark`），兩個 prefix 互不重疊。
  const escapedPrefix = prefix === ":root" ? ":root" : ":root\\.dark";
  const regex = new RegExp(`${escapedPrefix}\\[data-accent=${color}\\]\\s*\\{`);
  return extractBlockBody(css, regex, `${prefix}[data-accent=${color}]`);
}

function extractBaseBlock(css: string, prefix: ":root" | ":root.dark"): string {
  const escapedPrefix = prefix === ":root" ? ":root" : ":root\\.dark";
  // 基底塊沒有 `[data-accent=…]` 後綴，選擇器後直接接 `{`（可能夾空白）。
  const regex = new RegExp(`${escapedPrefix}\\s*\\{`);
  return extractBlockBody(css, regex, `基底 ${prefix}`);
}

/** 逐名、以冒號錨定抽值；找不到就讓 expect 立刻 fail，絕不回傳 undefined。 */
function extractToken(body: string, name: (typeof TOKEN_NAMES)[number], label: string): string {
  const regex = new RegExp(`${name}:\\s*([^;]+);`);
  const match = regex.exec(body);
  expect(match, `${label} 找不到 token ${name}`).not.toBeNull();
  return match![1].trim();
}

function extractSwatch(body: string, color: Color, label: string): string {
  const regex = new RegExp(`--brand-swatch-${color}:\\s*([^;]+);`);
  const match = regex.exec(body);
  expect(match, `${label} 找不到 --brand-swatch-${color}`).not.toBeNull();
  return match![1].trim();
}

/** 從一顆 `--brand` 值（如 `oklch(0.700 0.046 183.3)`）取出括號內的 oklch 三值。 */
function extractOklchTriple(value: string, label: string): string {
  const match = /oklch\(([^)/]+)\)/.exec(value);
  expect(match, `${label} 的 --brand 值不是純 oklch(三值) 型式：${value}`).not.toBeNull();
  return match![1].trim();
}

describe("主題色（accent）token parity", () => {
  const cssNoComments = readIndexCssWithoutComments();

  it("(a) 十二個 [data-accent=…] 塊與 :root/:root.dark 基底塊都齊全四個精確名 token", () => {
    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);
      for (const name of TOKEN_NAMES) {
        extractToken(lightBody, name, `:root[data-accent=${color}]`);
        extractToken(darkBody, name, `:root.dark[data-accent=${color}]`);
      }
    }

    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ":root.dark");
    for (const name of TOKEN_NAMES) {
      extractToken(baseLight, name, "基底 :root");
      extractToken(baseDark, name, "基底 :root.dark");
    }
  });

  it("(b) 所有 :root.dark[data-accent=…] 塊位置在所有 :root[data-accent=…] 塊之後", () => {
    const lightIndices = COLORS.map((color) => {
      const regex = new RegExp(`:root\\[data-accent=${color}\\]\\s*\\{`);
      const match = regex.exec(cssNoComments);
      expect(match, `找不到 :root[data-accent=${color}]`).not.toBeNull();
      return match!.index;
    });
    const darkIndices = COLORS.map((color) => {
      const regex = new RegExp(`:root\\.dark\\[data-accent=${color}\\]\\s*\\{`);
      const match = regex.exec(cssNoComments);
      expect(match, `找不到 :root.dark[data-accent=${color}]`).not.toBeNull();
      return match!.index;
    });

    const maxLightIndex = Math.max(...lightIndices);
    const minDarkIndex = Math.min(...darkIndices);
    expect(maxLightIndex).toBeLessThan(minDarkIndex);
  });

  it("(c) swatch 與對應塊 --brand 等值；基底 :root/:root.dark 四 token 值 = indigo 塊值", () => {
    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ":root.dark");

    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);

      const swatchLight = extractSwatch(baseLight, color, "基底 :root");
      const swatchDark = extractSwatch(baseDark, color, "基底 :root.dark");

      expect(swatchLight, `--brand-swatch-${color}（:root）應等於 :root[data-accent=${color}] 的 --brand`).toBe(
        extractToken(lightBody, "--brand", `:root[data-accent=${color}]`),
      );
      expect(swatchDark, `--brand-swatch-${color}（:root.dark）應等於 :root.dark[data-accent=${color}] 的 --brand`).toBe(
        extractToken(darkBody, "--brand", `:root.dark[data-accent=${color}]`),
      );
    }

    const indigoLightBody = extractDataAccentBlock(cssNoComments, ":root", "indigo");
    const indigoDarkBody = extractDataAccentBlock(cssNoComments, ":root.dark", "indigo");
    for (const name of TOKEN_NAMES) {
      expect(extractToken(baseLight, name, "基底 :root"), `基底 :root 的 ${name} 應等於 :root[data-accent=indigo]`).toBe(
        extractToken(indigoLightBody, name, ":root[data-accent=indigo]"),
      );
      expect(extractToken(baseDark, name, "基底 :root.dark"), `基底 :root.dark 的 ${name} 應等於 :root.dark[data-accent=indigo]`).toBe(
        extractToken(indigoDarkBody, name, ":root.dark[data-accent=indigo]"),
      );
    }
  });

  it("(d) 六行 --color-brand* 映射出現在 @theme inline 區塊內", () => {
    const themeInlineSelector = /@theme inline\s*\{/;
    const match = themeInlineSelector.exec(cssNoComments);
    expect(match, "找不到 @theme inline 區塊").not.toBeNull();
    const start = match!.index;
    const braceStart = cssNoComments.indexOf("{", start);
    const blockEnd = cssNoComments.indexOf("}", braceStart);
    expect(blockEnd).toBeGreaterThan(-1);

    const mappingNames = [
      "--color-brand",
      "--color-brand-soft",
      "--color-brand-soft-strong",
      "--color-brand-on-soft",
      "--color-brand-deep",
      "--color-brand-fg",
    ];
    for (const name of mappingNames) {
      const regex = new RegExp(`${name}:`, "g");
      let found = false;
      let occurrence: RegExpExecArray | null;
      while ((occurrence = regex.exec(cssNoComments))) {
        if (occurrence.index > braceStart && occurrence.index < blockEnd) {
          found = true;
          break;
        }
      }
      expect(found, `${name}: 應出現在 @theme inline 區塊內（不是 @theme 或其他地方）`).toBe(true);
    }
  });

  it("(e) 每色 --brand-soft/--brand-soft-strong = 該色 :root.dark --brand 三值 + 對應 alpha", () => {
    for (const color of COLORS) {
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);
      const darkBrand = extractToken(darkBody, "--brand", `:root.dark[data-accent=${color}]`);
      const triple = extractOklchTriple(darkBrand, `:root.dark[data-accent=${color}]`);

      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);

      const expectedLightSoft = normalizeWhitespace(`oklch(${triple} / 14%)`);
      const expectedLightStrong = normalizeWhitespace(`oklch(${triple} / 20%)`);
      const expectedDarkSoft = normalizeWhitespace(`oklch(${triple} / 16%)`);
      const expectedDarkStrong = normalizeWhitespace(`oklch(${triple} / 24%)`);

      expect(
        normalizeWhitespace(extractToken(lightBody, "--brand-soft", `:root[data-accent=${color}]`)),
        `:root[data-accent=${color}] 的 --brand-soft 應＝該色 dark --brand 三值 /14%`,
      ).toBe(expectedLightSoft);
      expect(
        normalizeWhitespace(extractToken(lightBody, "--brand-soft-strong", `:root[data-accent=${color}]`)),
        `:root[data-accent=${color}] 的 --brand-soft-strong 應＝該色 dark --brand 三值 /20%`,
      ).toBe(expectedLightStrong);
      expect(
        normalizeWhitespace(extractToken(darkBody, "--brand-soft", `:root.dark[data-accent=${color}]`)),
        `:root.dark[data-accent=${color}] 的 --brand-soft 應＝該色 dark --brand 三值 /16%`,
      ).toBe(expectedDarkSoft);
      expect(
        normalizeWhitespace(extractToken(darkBody, "--brand-soft-strong", `:root.dark[data-accent=${color}]`)),
        `:root.dark[data-accent=${color}] 的 --brand-soft-strong 應＝該色 dark --brand 三值 /24%`,
      ).toBe(expectedDarkStrong);
    }
  });

  it("(f) 每個 accent 都有兩語系的 i18n 色名", () => {
    // 缺 key 時 UI 只會把 raw key（如 accent.purple）當 aria-label/tooltip 靜默顯示，
    // en↔zh-TW 的 parity 測試抓不到「兩邊都缺」——這裡直接對 ACCENTS 驗覆蓋。
    for (const color of COLORS) {
      expect(en.accent, `en 缺 accent.${color}`).toHaveProperty(color);
      expect(zhTW.accent, `zh-TW 缺 accent.${color}`).toHaveProperty(color);
    }
  });

  it("(g) --brand-fg 只宣告在 :root/:root.dark 兩個基底塊——不分色票，六色都共用同一套", () => {
    const brandFgRe = /--brand-fg:\s*([^;]+);/;
    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ":root.dark");
    expect(brandFgRe.exec(baseLight), "基底 :root 找不到 --brand-fg").not.toBeNull();
    expect(brandFgRe.exec(baseDark), "基底 :root.dark 找不到 --brand-fg").not.toBeNull();

    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);
      expect(
        brandFgRe.exec(lightBody),
        `:root[data-accent=${color}] 不該宣告 --brand-fg（不分色票，改色不該讓它跟著換）`,
      ).toBeNull();
      expect(
        brandFgRe.exec(darkBody),
        `:root.dark[data-accent=${color}] 不該宣告 --brand-fg（不分色票，改色不該讓它跟著換）`,
      ).toBeNull();
    }
  });

  it("(h) 宣告主題變數的規則，選擇器清單裡每一項都必須錨在 :root／html（#154：編輯器子樹不得重設主題變數）", () => {
    // BlockNote 把 light/dark 當 class 寫在 `.bn-root` 與 `portalElement` 上，也在 `.bn-root`
    // 寫 `data-color-scheme`。任何**沒錨在根元素**的規則只要宣告了主題變數，就可能在編輯器
    // 子樹（或任何其他子樹）裡再命中一次，把使用者選的主題色（以及其他主題變數）在那裡重設
    // ——`text-brand` 這類 utility 在元素上求值，於是編輯器內變回 indigo（#154 原貌）。
    // 所以判準**不看**選擇器有沒有提到 `.dark`：`[data-color-scheme=dark]`、`.bn-root` 一樣危險。
    // 主題變數本來就只該在根元素宣告一次、往下繼承。其他測試全都看不到這件事。
    //
    // 主題變數＝兩個基底塊宣告的全部自訂屬性（含 `--brand*`、`--code-*`、`--card`…）。
    const declaredNames = (body: string) => [...body.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map((m) => m[1]!);
    const themeVars = new Set([
      ...declaredNames(extractBaseBlock(cssNoComments, ":root")),
      ...declaredNames(extractBaseBlock(cssNoComments, ":root.dark")),
    ]);
    expect(themeVars.has("--brand"), "主題變數集合應含 --brand（抽基底塊失敗就會是空集合、守衛形同虛設）").toBe(true);

    // 合法形：以 `:root` 或 `html` 起頭的**單一複合選擇器**（中間沒有空白或組合子），
    // 例如 `:root`、`:root.dark`、`:root.dark[data-accent=gold]`、`html.dark`。
    const anchored = /^(?::root|html)(?![\w-])[^\s>+~]*$/;

    const offenders: string[] = [];
    let checked = 0;
    // 最內層的 `selector { body }`：`@media`／`@supports` 裡的規則、CSS 巢狀的 `&.dark { … }`
    // 也都會被這條命中（巢狀那形抽到的選擇器是 `&.dark`，不以 :root 起頭 ⇒ 判違規）。
    for (const m of cssNoComments.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      // 頂層第一塊前面還夾著 `@import …;`／`@custom-variant …;`，取最後一個 `;` 之後才是選擇器。
      const selectorText = m[1]!.split(";").at(-1)!;
      const declared = declaredNames(m[2]!).filter((name) => themeVars.has(name));
      if (declared.length === 0) continue;
      // ⚠ 逗號清單必拆開逐一判（repo 慣例）：`:root.dark, .dark { … }` 整串測會被合法那半騙過。
      for (const selector of selectorText.split(",").map((s) => s.trim())) {
        checked += 1;
        if (!anchored.test(selector)) offenders.push(`${selector}  （宣告了 ${declared.slice(0, 3).join("、")}…）`);
      }
    }
    // 不得空轉：兩個基底塊＋十二個 accent 塊至少十四條要被檢查到。
    expect(checked, "應至少檢查到 14 條宣告主題變數的規則").toBeGreaterThanOrEqual(2 + 2 * COLORS.length);
    expect(
      offenders,
      "這些規則會在 BlockNote 的 `.bn-root`／浮層（或任何子樹）上把主題變數重設；選擇器要錨在 :root（例如 `:root.dark`）",
    ).toEqual([]);
  });
});
