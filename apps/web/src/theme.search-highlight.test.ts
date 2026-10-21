import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 搜尋高亮底色 token（`--search-highlight`）的守門測試（比照 `theme.accent-vars.test.ts`：
 * 剝註解→定位塊→抽值）。值與 `index.css` 上方的對比量測註解綁在一起——改值要重跑
 * 對比腳本並更新註解。
 */

const SRC = `${process.cwd()}/src`;

function readCssWithoutComments(): string {
  return readFileSync(`${SRC}/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function blockBody(css: string, selector: RegExp, label: string): string {
  const match = selector.exec(css);
  expect(match, `index.css 找不到區塊：${label}`).not.toBeNull();
  const open = css.indexOf("{", match!.index);
  const close = css.indexOf("}", open);
  expect(open, `${label} 找不到 {`).toBeGreaterThan(-1);
  expect(close, `${label} 找不到 }`).toBeGreaterThan(-1);
  return css.slice(open + 1, close);
}

const norm = (value: string) => value.replace(/\s+/g, " ").trim();

describe("--search-highlight token", () => {
  it("SH1：淺／深色基底塊各宣告一次、值逐字、全檔只這兩次", () => {
    const css = readCssWithoutComments();
    const light = norm(blockBody(css, /:root\s*\{/, ":root"));
    const dark = norm(blockBody(css, /:root\.dark\s*\{/, ":root.dark"));
    expect(light).toContain("--search-highlight: oklch(0.924 0.12 95.746);");
    expect(dark).toContain("--search-highlight: oklch(0.420 0.080 85);");
    expect(css.match(/--search-highlight\s*:/g)).toHaveLength(2);
  });

  it("SH2：@theme inline 把它接成 --color-search-highlight", () => {
    const css = readCssWithoutComments();
    const theme = norm(blockBody(css, /@theme inline\s*\{/, "@theme inline"));
    expect(theme).toContain("--color-search-highlight: var(--search-highlight);");
  });

  it("SH3：SearchResults 的 mark 用 bg-search-highlight utility", () => {
    const source = readFileSync(`${SRC}/components/sidebar/SearchResults.tsx`, "utf8");
    expect(source).toContain("bg-search-highlight");
  });
});
