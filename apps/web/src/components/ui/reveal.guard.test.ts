import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level guard: the classes for hover reveal (`BASE` / `SCOPE` in `ui/reveal.ts`) and the sidebar drag handle's line
 * (`PaneResizeHandle.tsx`, shared by the sidebar and the versions panel) must be complete literals.
 *
 * It guards against the complete literals being turned into template concatenation (`` `group-hover/${scope}:…` ``): Tailwind v4 generates CSS by statically
 * scanning source, so assembled classes are not found and silently produce nothing; jsdom tests only assert class strings and stay green;
 * and a grep of the build output is blind to it too, because Tailwind scans test files as well, and test files that spell out the same classes
 * add them back into the output. So only a guard that reads the source sees this shape. Because they get added back, templating is still correct
 * in today's output: it is a latent regression that breaks silently once the tests are rewritten and drop those literals (this file itself also spells out a few).
 *
 * Not caught: a typo in the literal or a nonexistent class name (still a complete literal, so it passes); forms built with `+` string concatenation
 * (this file looks only for `${` and backticks); anywhere other than `BASE` / `SCOPE` / the handle line.
 *
 * Scan semantics: fragments are cut from the raw source: for `reveal.ts` from `const BASE =` to the end `};` of the `SCOPE` object literal;
 * for `PaneResizeHandle.tsx` the line containing the `w-0.5 rounded-full` anchor. A stale anchor fails first (reveal.ts: the anchor index
 * assertion; PaneResizeHandle: exactly one line must contain the anchor, so the anchor disappearing or being copied into a comment fails either way), so a changed spelling
 * cannot silently turn into scanning an empty string.
 */

const root = `${process.cwd()}/src`;

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `找不到錨點：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `找不到結尾：${end}`).toBeGreaterThan(from);
  return source.slice(from, to + end.length);
}

describe("source-level guard for hover-reveal and drag-handle classes", () => {
  it("BASE and SCOPE in reveal.ts are complete literals (no template concatenation)", () => {
    const source = readFileSync(`${root}/components/ui/reveal.ts`, "utf8").replace(/\r\n/g, "\n");
    const segment = between(source, "const BASE =", "\n};");
    // proves the segment really spans all five scopes (the anchor has not drifted)
    for (const scope of ["grouprow", "noterow", "folderrow", "avatarcell", "tabheader"]) {
      expect(segment).toContain(`group-hover/${scope}:opacity-100`);
    }
    expect(segment).toContain("data-[state=open]:opacity-100");
    expect(segment).not.toContain("${");
    expect(segment).not.toContain("`");
  });

  it("REVEAL_ONLY in reveal.ts is a complete literal (no template concatenation) and is hidden under both touch criteria", () => {
    const source = readFileSync(`${root}/components/ui/reveal.ts`, "utf8").replace(/\r\n/g, "\n");
    const segment = between(source, "const REVEAL_ONLY =", "\n} as const;");
    expect(segment).toContain("group-hover/noterow:opacity-100");
    expect(segment).toContain("[@media(hover:none)]:hidden");
    expect(segment).toContain("[@media(pointer:coarse)]:hidden");
    expect(segment).not.toContain("${");
    expect(segment).not.toContain("`");
  });

  it("the handle line's class in PaneResizeHandle.tsx is a complete literal (no template concatenation)", () => {
    const source = readFileSync(`${root}/components/PaneResizeHandle.tsx`, "utf8").replace(/\r\n/g, "\n");
    const lines = source.split("\n").filter((line) => line.includes("w-0.5 rounded-full"));
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("group-focus-visible/resize:bg-ring");
    expect(line).toContain("group-data-[dragging]/resize:bg-ring");
    expect(line).not.toContain("${");
    expect(line).not.toContain("`");
  });
});
