import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 主題色（accent）token 的 parity 守門測試（比照 `theme.blocknote-vars.test.ts`
 * 的手法：剝註解→定位塊→抽值）。
 *
 * 背景見 `index.css` 「主題色（accent）十二個套用塊」上方的區塊註解：
 * - 六色 × light/dark 共十二個 `[data-accent=…]` 塊，值必須逐字抄 spec 值表。
 * - `:root`/`.dark` 基底塊的四個 `--brand*` token 是屬性不存在時的 fallback，
 *   必須逐字＝indigo 那組——這是「首屏 fallback 與 hydrate 補設同色」的支點。
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
 */

const COLORS = ["indigo", "blue", "teal", "sage", "rose", "gold"] as const;
type Color = (typeof COLORS)[number];

const TOKEN_NAMES = ["--brand", "--brand-soft", "--brand-soft-strong", "--brand-on-soft"] as const;

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

function extractDataAccentBlock(css: string, prefix: ":root" | ".dark", color: Color): string {
  const escapedPrefix = prefix === ":root" ? ":root" : "\\.dark";
  const regex = new RegExp(`${escapedPrefix}\\[data-accent=${color}\\]\\s*\\{`);
  return extractBlockBody(css, regex, `${prefix}[data-accent=${color}]`);
}

function extractBaseBlock(css: string, prefix: ":root" | ".dark"): string {
  const escapedPrefix = prefix === ":root" ? ":root" : "\\.dark";
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

  it("(a) 十二個 [data-accent=…] 塊與 :root/.dark 基底塊都齊全四個精確名 token", () => {
    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ".dark", color);
      for (const name of TOKEN_NAMES) {
        extractToken(lightBody, name, `:root[data-accent=${color}]`);
        extractToken(darkBody, name, `.dark[data-accent=${color}]`);
      }
    }

    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ".dark");
    for (const name of TOKEN_NAMES) {
      extractToken(baseLight, name, "基底 :root");
      extractToken(baseDark, name, "基底 .dark");
    }
  });

  it("(b) 所有 .dark[data-accent=…] 塊位置在所有 :root[data-accent=…] 塊之後", () => {
    const lightIndices = COLORS.map((color) => {
      const regex = new RegExp(`:root\\[data-accent=${color}\\]\\s*\\{`);
      const match = regex.exec(cssNoComments);
      expect(match, `找不到 :root[data-accent=${color}]`).not.toBeNull();
      return match!.index;
    });
    const darkIndices = COLORS.map((color) => {
      const regex = new RegExp(`\\.dark\\[data-accent=${color}\\]\\s*\\{`);
      const match = regex.exec(cssNoComments);
      expect(match, `找不到 .dark[data-accent=${color}]`).not.toBeNull();
      return match!.index;
    });

    const maxLightIndex = Math.max(...lightIndices);
    const minDarkIndex = Math.min(...darkIndices);
    expect(maxLightIndex).toBeLessThan(minDarkIndex);
  });

  it("(c) swatch 與對應塊 --brand 等值；基底 :root/.dark 四 token 值 = indigo 塊值", () => {
    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ".dark");

    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ".dark", color);

      const swatchLight = extractSwatch(baseLight, color, "基底 :root");
      const swatchDark = extractSwatch(baseDark, color, "基底 .dark");

      expect(swatchLight, `--brand-swatch-${color}（:root）應等於 :root[data-accent=${color}] 的 --brand`).toBe(
        extractToken(lightBody, "--brand", `:root[data-accent=${color}]`),
      );
      expect(swatchDark, `--brand-swatch-${color}（.dark）應等於 .dark[data-accent=${color}] 的 --brand`).toBe(
        extractToken(darkBody, "--brand", `.dark[data-accent=${color}]`),
      );
    }

    const indigoLightBody = extractDataAccentBlock(cssNoComments, ":root", "indigo");
    const indigoDarkBody = extractDataAccentBlock(cssNoComments, ".dark", "indigo");
    for (const name of TOKEN_NAMES) {
      expect(extractToken(baseLight, name, "基底 :root"), `基底 :root 的 ${name} 應等於 :root[data-accent=indigo]`).toBe(
        extractToken(indigoLightBody, name, ":root[data-accent=indigo]"),
      );
      expect(extractToken(baseDark, name, "基底 .dark"), `基底 .dark 的 ${name} 應等於 .dark[data-accent=indigo]`).toBe(
        extractToken(indigoDarkBody, name, ".dark[data-accent=indigo]"),
      );
    }
  });

  it("(d) 四行 --color-brand* 映射出現在 @theme inline 區塊內", () => {
    const themeInlineSelector = /@theme inline\s*\{/;
    const match = themeInlineSelector.exec(cssNoComments);
    expect(match, "找不到 @theme inline 區塊").not.toBeNull();
    const start = match!.index;
    const braceStart = cssNoComments.indexOf("{", start);
    const blockEnd = cssNoComments.indexOf("}", braceStart);
    expect(blockEnd).toBeGreaterThan(-1);

    const mappingNames = ["--color-brand", "--color-brand-soft", "--color-brand-soft-strong", "--color-brand-on-soft"];
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

  it("(e) 每色 --brand-soft/--brand-soft-strong = 該色 .dark --brand 三值 + 對應 alpha", () => {
    for (const color of COLORS) {
      const darkBody = extractDataAccentBlock(cssNoComments, ".dark", color);
      const darkBrand = extractToken(darkBody, "--brand", `.dark[data-accent=${color}]`);
      const triple = extractOklchTriple(darkBrand, `.dark[data-accent=${color}]`);

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
        normalizeWhitespace(extractToken(darkBody, "--brand-soft", `.dark[data-accent=${color}]`)),
        `.dark[data-accent=${color}] 的 --brand-soft 應＝該色 dark --brand 三值 /16%`,
      ).toBe(expectedDarkSoft);
      expect(
        normalizeWhitespace(extractToken(darkBody, "--brand-soft-strong", `.dark[data-accent=${color}]`)),
        `.dark[data-accent=${color}] 的 --brand-soft-strong 應＝該色 dark --brand 三值 /24%`,
      ).toBe(expectedDarkStrong);
    }
  });
});
