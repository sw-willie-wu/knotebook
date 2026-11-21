import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OUTLINE_MIN_PINNED_COLUMN, OUTLINE_PIN_RESERVED_WIDTH, canPinOutline } from "@/components/outline/outline-layout";
import {
  ARTICLE_COLUMN,
  ARTICLE_COLUMN_MAX,
  ARTICLE_COLUMN_PADDING,
  ARTICLE_COLUMN_PIN_MOTION,
  ARTICLE_TEXT_INSET,
  BN_EDITOR_INLINE_PADDING_PX,
  articleColumn,
  articleColumnState,
} from "./article-column";

/**
 * Shared guard for the article column (after #115; same pattern as `rows.equal-height.test.ts`).
 *
 * Since #115 the header and footer span the full card width (left/right aligned); the article column's consumers are the body column itself: the in-site editor,
 * the public page and the single-column version preview (since #297 the three widths come from `articleColumn(width)`). jsdom applies no CSS and cannot compute
 * left-edge coordinates, so the unit level can guard these things:
 *
 *   - the constant literals are fixed (the consumers' assertions are derived from the constants and are tautologies, so this pin is what gives them teeth)
 *   - BlockNote's 54px is an upgrade sentinel: 54 no longer has a production consumer, but the `<md` override
 *     `.bn-editor.bn-editor{padding-inline:1.25rem}` (index.css) was designed assuming the original value 54; an upgrade that changes it must fail
 *     so someone re-evaluates it, not silently misalign
 *   - all three consumers get the column width via `articleColumn()` and the three width classes are written only in article-column.ts;
 *     the header (NotePage) and footer (BacklinksSection) must not add the column back
 *
 *   - `<md` alignment coupling: the `1.25rem` (20px) override in index.css equals the header/footer `px-5` (20px). Nothing else ties these two 20px values together, so
 *     the literals on the three sides are tied together here.
 *
 *   - when #465 pins the outline, the width the column yields (the rem in the `standard-pinned` literal) is tied to the outline's panel width,
 *     the gap, and the constant for the panel's right-edge distance from the container's right edge; the `canPinOutline` threshold derives from the same reserved width.
 *
 * Not guarded (honest limits):
 *   - changing a constant itself to another value: still a legitimate operation with a single consumer.
 *   - whether the `<md` override really ends up in the build output: jsdom cannot read dist and the `<md` check reads only src;
 *     check it after a build with `grep "bn-editor.bn-editor" apps/web/dist/assets/*.css` (see the comment in index.css).
 */

/** Consumers: the body column's three places (since #297 all via `articleColumn(width)`). */
const CONSUMERS = [
  { label: "內文（NoteEditor 置中 wrapper）", path: "src/components/NoteEditor.tsx" },
  { label: "公開頁（PublicNotePage）", path: "src/pages/PublicNotePage.tsx" },
  { label: "版本預覽單欄（VersionPreview）", path: "src/components/versions/VersionPreview.tsx" },
] as const;

/** The two former consumers that must not add the column back (before #115 they were the header / footer). */
const NON_CONSUMERS = [
  { label: "頁首（NotePage）", path: "src/pages/NotePage.tsx" },
  { label: "頁尾（BacklinksSection）", path: "src/components/BacklinksSection.tsx" },
] as const;

function readSource(relativePath: string): string {
  return readFileSync(`${process.cwd()}/${relativePath}`, "utf8");
}

/** Strip comments so class names mentioned in comments do not affect the structure checks. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function listSources(): string[] {
  return readdirSync(`${process.cwd()}/src`, { recursive: true, encoding: "utf8" })
    .map((p) => `src/${p.replace(/\\/g, "/")}`)
    .filter((p) => /\.tsx?$/.test(p));
}

describe("article column guard (#115 header/footer span the full card width; #297 three widths via articleColumn)", () => {
  it("constant literals are fixed", () => {
    expect(ARTICLE_COLUMN).toBe("mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)]");
    expect(ARTICLE_COLUMN_PADDING).toBe("px-4 max-md:px-0");
    expect(ARTICLE_COLUMN_MAX).toEqual({
      standard: "max-w-[clamp(42.5rem,85%,66rem)]",
      wide: "max-w-[clamp(42.5rem,92.5%,88rem)]",
      full: "max-w-none",
      "standard-pinned":
        "max-w-[min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem))] left-[min(0px,calc((100%_-_min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem)))/2_-_17.875rem))]",
    });
    expect(articleColumn()).toBe(ARTICLE_COLUMN);
    expect(articleColumn()).toBe("mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)]");
    expect(articleColumn("wide")).toBe("mx-auto w-full max-w-[clamp(42.5rem,92.5%,88rem)]");
    expect(articleColumn("full")).toBe("mx-auto w-full max-w-none");

    // Pinned (#465): without options it has the same shape as above; the transition is added only to the standard width's two states, and unpinned must say left-0 explicitly (`left: auto` cannot transition).
    expect(ARTICLE_COLUMN_PIN_MOTION).toBe("transition-[max-width,left] duration-150 ease-out motion-reduce:transition-none");
    expect(articleColumn("standard-pinned")).toBe(
      "mx-auto w-full max-w-[min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem))] left-[min(0px,calc((100%_-_min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem)))/2_-_17.875rem))]",
    );
    expect(articleColumn("standard", { pinMotion: true })).toBe(
      "mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)] left-0 transition-[max-width,left] duration-150 ease-out motion-reduce:transition-none",
    );
    expect(articleColumn("standard-pinned", { pinMotion: true })).toBe(
      "mx-auto w-full max-w-[min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem))] left-[min(0px,calc((100%_-_min(clamp(42.5rem,85%,66rem),calc(100%_-_17.875rem)))/2_-_17.875rem))] transition-[max-width,left] duration-150 ease-out motion-reduce:transition-none",
    );
    expect(articleColumn("wide", { pinMotion: true })).toBe("mx-auto w-full max-w-[clamp(42.5rem,92.5%,88rem)]");
    expect(articleColumn("full", { pinMotion: true })).toBe("mx-auto w-full max-w-none");
    expect(articleColumn("standard", { pinMotion: false })).toBe(ARTICLE_COLUMN);

    expect(articleColumnState("standard", true)).toBe("standard-pinned");
    expect(articleColumnState("standard", false)).toBe("standard");
    expect(articleColumnState("wide", true)).toBe("wide");
    expect(articleColumnState("full", true)).toBe("full");
  });

  it("BlockNote `.bn-editor` padding-inline is still the 54px the constant declares (upgrade sentinel)", () => {
    // Read the file that is actually loaded: `NoteEditor.tsx` imports only `@blocknote/mantine/style.css`, which `@import`s
    // `@blocknote/react/style.css` (which pulls in core's styles). Core's dist is just one layer; reading only it would silently miss
    // a padding override from the mantine/react layer, which is exactly what this guards against. The way the react bundle path is read follows
    // the existing convention in `theme.blocknote-vars.test.ts`.
    const cssPath = `${process.cwd()}/node_modules/@blocknote/react/dist/style.css`;
    const css = readFileSync(cssPath, "utf8");

    // dist is minified into one line. Take only rules whose selector is `.bn-editor` itself: the previous character must be a rule boundary
    // (`}`, `,` or start of file), otherwise a descendant form like `.bn-comment-editor .bn-editor{padding:0}`
    // (the comment editor's, unrelated to the article column) would be counted.
    const bareRules = [...css.matchAll(/(?:^|[},])\s*\.bn-editor\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(bareRules.length, `${cssPath} 找不到裸 \`.bn-editor{…}\` 規則`).toBeGreaterThan(0);

    // Collect padding declarations across all bare rules: exactly one, and it is 54px. An extra one (an override added by a later layer wins) or a changed value
    // fails; asserting only that 54px appears would stay green after a later `padding-inline:16px` is added
    // while the layout silently misaligns.
    const paddings = bareRules.flatMap((decls) => [...decls.matchAll(/padding(?:-inline)?\s*:\s*[^;]+/g)].map((m) => m[0]));
    expect(paddings).toEqual([`padding-inline:${BN_EDITOR_INLINE_PADDING_PX}px`]);
  });

  it("the three consumers get the column width via articleColumn(); the three width classes are only in article-column.ts; the header/footer must not add the column back", () => {
    for (const { label, path } of CONSUMERS) {
      const source = readSource(path);
      const importLine = /import \{([^}]*)\} from "@\/components\/ui\/article-column";/.exec(source);
      expect(importLine, `${label}（${path}）應從 ui/article-column import`).not.toBeNull();
      expect(/\barticleColumn\b/.test(importLine![1]), `${label} 的 import 應含 articleColumn`).toBe(true);
      const code = stripComments(source);
      expect(/\barticleColumn\(/.test(code), `${label} 應實際呼叫 articleColumn(…)`).toBe(true);
      // The single source of the column width is article-column.ts: consumers must not bypass the function by writing any width's max-w themselves.
      expect(code, `${label} 不得自寫 clamp 欄寬`).not.toMatch(/max-w-\[clamp\(/);
      expect(code, `${label} 不得自寫全寬 class`).not.toMatch(/max-w-none/);
    }

    // Scan all of src once: nobody outside article-column.ts writes the article column's clamp (the 42.5rem lower bound is its fingerprint;
    // the pinned state wraps the clamp in min(), so the match does not require starting with `max-w-[`).
    const offenders = listSources()
      .filter((p) => !/\.test\./.test(p) && p !== "src/components/ui/article-column.ts")
      .filter((p) => /clamp\(42\.5rem/.test(stripComments(readSource(p))));
    expect(offenders).toEqual([]);

    for (const { label, path } of NON_CONSUMERS) {
      const code = stripComments(readSource(path));
      // #115: header/footer span the full card width. Adding the column (or a hand-written clamp) back would restore the pre-#88 style of
      // three aligned places, which was deliberately removed and must not silently return.
      expect(code, `${label}（${path}）不得 import/使用文章欄常數`).not.toMatch(/article-column/);
      expect(code, `${label} 不得自己寫死欄寬`).not.toMatch(/max-w-\[clamp\(/);
    }
  });

  it("`<md` alignment coupling: the 20px override in index.css = the header/footer px-5", () => {
    // The index.css half: the `.bn-editor.bn-editor` override inside `@media (width < 48rem)`.
    // Only the stacked-class form is accepted: a bare `.bn-editor` would lose to BlockNote's (0,1,0) (its CSS loads after this file),
    // and this assertion fails at once on a downgrade to the bare selector instead of it silently not applying.
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
    const override = /@media \(width < 48rem\)\s*\{[^{}]*\.bn-editor\.bn-editor\s*\{([^}]*)\}/.exec(css);
    expect(override, "index.css 應有 `<md` 的 `.bn-editor.bn-editor` 疊 class 覆寫").not.toBeNull();
    const value = /padding-inline:\s*([\d.]+)rem/.exec(override![1]);
    expect(value, "覆寫應宣告 padding-inline（rem）").not.toBeNull();
    const overridePx = Number(value![1]) * 16;

    for (const { label, path } of NON_CONSUMERS) {
      expect(/\bpx-5\b/.test(stripComments(readSource(path))), `${label} 應用 px-5 滿卡寬內距`).toBe(true);
    }
    expect(overridePx, "`<md` 內文左緣應與頁首/頁尾的 px-5（20px）共線").toBe(5 * 4);
  });

  it("ARTICLE_TEXT_INSET puts the tag row on the text edge: 54px = BN_EDITOR_INLINE_PADDING_PX on md and up, px-5 = the 1.25rem override below md", () => {
    expect(ARTICLE_TEXT_INSET).toBe("px-[54px] max-md:px-5");
    const [base, small] = ARTICLE_TEXT_INSET.split(" ");
    expect(Number(/^px-\[(\d+)px\]$/.exec(base!)![1])).toBe(BN_EDITOR_INLINE_PADDING_PX);

    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8");
    const override = /@media \(width < 48rem\)\s*\{[^{}]*\.bn-editor\.bn-editor\s*\{([^}]*)\}/.exec(css);
    const overridePx = Number(/padding-inline:\s*([\d.]+)rem/.exec(override![1])![1]) * 16;
    expect(overridePx).toBe(Number(/^max-md:px-(\d+)$/.exec(small!)![1]) * 4);

    // Same breakpoint as the column padding, or between the two the row and the text would disagree.
    expect(ARTICLE_COLUMN_PADDING).toContain("max-md:");
    expect(small!.startsWith("max-md:")).toBe(true);
  });

  it("the reserved width when pinned is tied to the outline constants", () => {
    const pinned = ARTICLE_COLUMN_MAX["standard-pinned"];
    const standardClamp = /^max-w-\[(clamp\([^)]*\))\]$/.exec(ARTICLE_COLUMN_MAX.standard)![1];

    const maxPart = /^max-w-\[(min\((clamp\([^)]*\)),calc\(100%_-_([\d.]+)rem\)\))\] /.exec(pinned);
    expect(maxPart, "standard-pinned 應以 max-w-[min(標準 clamp, calc(100% - Nrem))] 開頭").not.toBeNull();
    const [, columnWidth, innerClamp, reserveRem] = maxPart!;
    expect(innerClamp, "釘住時欄寬上限仍是標準寬的 clamp").toBe(standardClamp);
    const reservePx = Number(reserveRem) * 16;
    expect(reservePx, "保留＝面板＋間距＋面板右緣離容器右緣").toBe(OUTLINE_PIN_RESERVED_WIDTH);
    expect(reservePx).toBe(286);

    const leftPart = /left-\[min\(0px,calc\(\(100%_-_(.+)\)\/2_-_([\d.]+)rem\)\)\]$/.exec(pinned);
    expect(leftPart, "standard-pinned 應以 left-[min(0px, calc((100% - 欄寬)/2 - Nrem))] 結尾").not.toBeNull();
    expect(leftPart![1], "left 的欄寬式應與 max-w 相同").toBe(columnWidth);
    expect(Number(leftPart![2]) * 16, "欄右緣離容器右緣至少面板＋間距＋面板右緣離容器右緣").toBe(OUTLINE_PIN_RESERVED_WIDTH);

    expect(canPinOutline(OUTLINE_MIN_PINNED_COLUMN + reservePx - 1)).toBe(false);
    expect(canPinOutline(OUTLINE_MIN_PINNED_COLUMN + reservePx)).toBe(true);
    expect(canPinOutline(925)).toBe(false);
    expect(canPinOutline(926)).toBe(true);
  });
});
