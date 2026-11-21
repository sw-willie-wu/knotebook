import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLORS_DARK_MODE_DEFAULT, COLORS_DEFAULT } from "@blocknote/core";
import { TAG_PRESET_COLORS } from "@knotebook/shared";
import { contrastRatio, tagTextColor } from "@/components/tags/tag-color-style";

const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match![1]!;
}

function token(rule: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(rule)?.[1]?.trim();
}

describe("tag colors", () => {
  it.each(TAG_PRESET_COLORS)("%s: the dot is the editor's text color and the pill its background color, in light and under :root.dark", (color) => {
    const light = body(`[data-tag-color="${color}"]`);
    const dark = body(`:root.dark [data-tag-color="${color}"]`);
    expect(token(light, "--tag-dot")).toBe(COLORS_DEFAULT[color]!.text);
    expect(token(light, "--tag-bg")).toBe(COLORS_DEFAULT[color]!.background);
    expect(token(dark, "--tag-dot")).toBe(COLORS_DARK_MODE_DEFAULT[color]!.text);
    expect(token(dark, "--tag-bg")).toBe(COLORS_DARK_MODE_DEFAULT[color]!.background);
  });

  it("every preset's pill text is what tagTextColor derives from its background, and reaches 4.5:1, in light and under :root.dark", () => {
    expect(token(body("[data-tag-color]"), "--tag-fg")).toBe("var(--foreground)");
    for (const color of TAG_PRESET_COLORS) {
      for (const selector of [`[data-tag-color="${color}"]`, `:root.dark [data-tag-color="${color}"]`]) {
        const rule = body(selector);
        const bg = token(rule, "--tag-bg")!;
        const fg = token(rule, "--tag-fg");
        expect(fg, selector).toBe(tagTextColor(bg));
        expect(contrastRatio(bg, fg!), selector).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("covers no color outside TAG_PRESET_COLORS", () => {
    const found = [...css.matchAll(/\[data-tag-color="([a-z]+)"\]/g)].map((m) => m[1]);
    expect(new Set(found)).toEqual(new Set(TAG_PRESET_COLORS));
  });
});
