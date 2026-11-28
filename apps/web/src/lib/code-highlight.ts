import type { CodeBlockOptions } from "@blocknote/core";
import { CODE_BLOCK_BASE_OPTIONS } from "@knotebook/shared";

/**
 * Not the official `@blocknote/code-block` (MPL-2.0 in an MIT repo). One CSS-variables theme
 * because `prosemirror-highlight/shiki`'s `createParser` defaults to `getLoadedThemes()[0]`, so
 * light/dark cannot be switched by loading two themes; the values live in `index.css` `:root` /
 * `:root.dark`, following `resolvedTheme` and independent of the accent color.
 */

/**
 * Keys must be shiki bundle language ids: `loadLanguage()` throws for unknown ids (the test loads
 * every key). `text` is first because the highlight plugin skips it.
 */
export { SUPPORTED_LANGUAGES } from "@knotebook/shared";

/**
 * Lazy, so neither shiki nor its grammars land in the entry bundle (`check-bundle-size.mjs`). JS
 * regex engine, not oniguruma: the CSP has no `'wasm-unsafe-eval'`, so WASM would be blocked and
 * highlighting would silently fail; switching engines requires adding it to script-src in
 * `apps/server/src/http/security-headers.ts`.
 */
export async function createHighlighter() {
  const [{ createHighlighter: create, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki"),
    import("shiki/engine/javascript"),
  ]);
  const theme = createCssVariablesTheme({
    name: "knotebook-code",
    variablePrefix: "--code-",
    fontStyle: true,
  });
  return create({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() });
}

export const CODE_BLOCK_OPTIONS: CodeBlockOptions = {
  ...CODE_BLOCK_BASE_OPTIONS,
  createHighlighter,
};
