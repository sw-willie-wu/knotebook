import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** jsdom doesn't apply CSS, so this guards only the source; the computed layout is measured in a browser. */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): { body: string; depth: number } | null {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const before = css.slice(0, at);
  const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
  const open = css.indexOf("{", at);
  return { body: css.slice(open + 1, css.indexOf("}", open)), depth };
}

describe("knowledge heading styles", () => {
  it("top-level knowledge headings reserve 1.75rem after their text, outside any media query", () => {
    const found = rule(
      '.bn-editor > .bn-block-group > .bn-block-outer > .bn-block > .bn-block-content[data-content-type="heading"][data-knowledge-id] .bn-inline-content',
    );
    expect(found).not.toBeNull();
    expect(found!.depth).toBe(0);
    expect(found!.body).toMatch(/padding-right:\s*1\.75rem;/);
  });

  it("an outdated knowledge heading's text is struck through and faded", () => {
    const found = rule(".bn-editor [data-kb-knowledge-outdated] .bn-inline-content");
    expect(found).not.toBeNull();
    expect(found!.depth).toBe(0);
    expect(found!.body).toMatch(/text-decoration:\s*line-through;/);
    expect(found!.body).toMatch(/color:\s*var\(--muted-foreground\);/);
  });
});
