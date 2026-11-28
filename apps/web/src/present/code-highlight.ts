import { resolveCodeBlockLanguage } from "@knotebook/shared";
import { createHighlighter } from "@/lib/code-highlight";

export interface HighlightToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

export type HighlightLines = readonly (readonly HighlightToken[])[];

/** Bounded LRU via Map insertion order; covers a large deck without retaining unbounded history. */
export const CODE_HIGHLIGHT_CACHE_LIMIT = 200;

// TextMate FontStyle bitmask (`@shikijs/vscode-textmate`); `NotSet` is -1 so callers guard `> 0`.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;
type BundledLang = Parameters<Highlighter["loadLanguage"]>[0];
type CodeLang = NonNullable<Parameters<Highlighter["codeToTokens"]>[1]>["lang"];

let highlighterPromise: Promise<Highlighter> | null = null;
const loadingLanguages = new Map<string, Promise<void>>();
const tokenCache = new Map<string, HighlightLines>();

function cacheKey(lang: string, code: string): string {
  return `${lang}\0${code}`;
}

/**
 * Resolves a raw language name or alias to a canonical `SUPPORTED_LANGUAGES` shiki id.
 * Returns `null` for `text` (plain text) and unsupported/empty names so shiki is never loaded for them.
 */
export function resolveHighlightLanguage(raw: string | null | undefined): string | null {
  const resolved = resolveCodeBlockLanguage(raw);
  return resolved && resolved !== "text" ? resolved : null;
}

export function cachedCodeTokens(lang: string, code: string): HighlightLines | null {
  const canonical = resolveHighlightLanguage(lang);
  if (canonical === null || code.trim() === "") return null;
  const key = cacheKey(canonical, code);
  const entry = tokenCache.get(key);
  if (entry === undefined) return null;
  tokenCache.delete(key);
  tokenCache.set(key, entry);
  return entry;
}

function storeInCache(lang: string, code: string, lines: HighlightLines): void {
  const key = cacheKey(lang, code);
  tokenCache.delete(key);
  tokenCache.set(key, lines);
  while (tokenCache.size > CODE_HIGHLIGHT_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value as string;
    tokenCache.delete(oldest);
  }
}

function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter().catch((err: unknown) => {
      // Drop a rejected promise so a transient chunk-load failure can recover on the next attempt.
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(hl: Highlighter, lang: string): Promise<void> {
  if (hl.getLoadedLanguages().includes(lang)) return;
  let pending = loadingLanguages.get(lang);
  if (!pending) {
    pending = hl.loadLanguage(lang as BundledLang).finally(() => {
      loadingLanguages.delete(lang);
    });
    loadingLanguages.set(lang, pending);
  }
  await pending;
}

/**
 * Tokenizes `code` using the shared lazy CSS-variables highlighter. Returns `null` without loading
 * shiki when the language is unsupported/`text` or the code is blank, and returns `null` on failure
 * so callers leave plain text intact.
 */
export async function tokenizeCode(lang: string, code: string): Promise<HighlightLines | null> {
  const canonical = resolveHighlightLanguage(lang);
  if (canonical === null || code.trim() === "") return null;
  const cached = cachedCodeTokens(canonical, code);
  if (cached !== null) return cached;

  try {
    const hl = await getHighlighter();
    await ensureLanguage(hl, canonical);
    const theme = hl.getLoadedThemes()[0];
    if (!theme) return null;
    const { tokens } = hl.codeToTokens(code, { lang: canonical as CodeLang, theme });
    const lines: HighlightLines = tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color,
        fontStyle: token.fontStyle,
      })),
    );
    storeInCache(canonical, code, lines);
    return lines;
  } catch {
    return null;
  }
}

/** Writes tokens purely with DOM nodes (`textContent` / CSSOM properties), never `innerHTML`. */
export function applyHighlightTokens(codeEl: HTMLElement, lines: HighlightLines): void {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) fragment.append(document.createTextNode("\n"));
    for (const token of lines[i]!) {
      const span = document.createElement("span");
      span.textContent = token.content;
      if (token.color) span.style.color = token.color;
      const fs = token.fontStyle;
      if (fs && fs > 0) {
        if (fs & FONT_STYLE_ITALIC) span.style.fontStyle = "italic";
        if (fs & FONT_STYLE_BOLD) span.style.fontWeight = "bold";
        const decorations: string[] = [];
        if (fs & FONT_STYLE_UNDERLINE) decorations.push("underline");
        if (fs & FONT_STYLE_STRIKETHROUGH) decorations.push("line-through");
        if (decorations.length > 0) span.style.textDecoration = decorations.join(" ");
      }
      fragment.append(span);
    }
  }
  codeEl.replaceChildren(fragment);
}

export function resetCodeHighlightForTests(): void {
  highlighterPromise = null;
  loadingLanguages.clear();
  tokenCache.clear();
}
