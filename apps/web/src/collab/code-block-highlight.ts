import { createExtension } from "@blocknote/core";
import { resolveCodeBlockLanguage } from "@knotebook/shared";
import { createHighlightPlugin, type Parser } from "prosemirror-highlight";
import { createParser } from "prosemirror-highlight/shiki";
import { createHighlighter } from "@/lib/code-highlight";

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;
type BundledLang = Parameters<Highlighter["loadLanguage"]>[0];
type ShikiHighlighter = Parameters<typeof createParser>[0];

function createLazyShikiParser(loadHighlighter: () => Promise<Highlighter>): Parser {
  let loadedHighlighter: Highlighter | null = null;
  let highlighterPromise: Promise<void> | null = null;
  let shikiParser: Parser | null = null;
  const loadingLanguages = new Map<string, Promise<void>>();

  function ensureHighlighter(): Promise<void> {
    if (highlighterPromise === null) {
      highlighterPromise = loadHighlighter()
        .then((hl) => {
          loadedHighlighter = hl;
          shikiParser = createParser(hl as unknown as ShikiHighlighter);
        })
        .catch((err: unknown) => {
          // Drop a rejected promise so a transient chunk-load failure can recover on the next attempt.
          highlighterPromise = null;
          throw err;
        });
    }
    return highlighterPromise;
  }

  function ensureLanguage(hl: Highlighter, lang: string): Promise<void> {
    let pending = loadingLanguages.get(lang);
    if (!pending) {
      pending = hl.loadLanguage(lang as BundledLang).finally(() => {
        loadingLanguages.delete(lang);
      });
      loadingLanguages.set(lang, pending);
    }
    return pending;
  }

  return (options) => {
    const lang = options.language;
    // Skip before loading shiki so plain-text and unknown-language notes never fetch the shiki chunk.
    if (!lang || lang === "text") return [];
    if (!loadedHighlighter || !shikiParser) return ensureHighlighter();
    if (!loadedHighlighter.getLoadedLanguages().includes(lang)) {
      return ensureLanguage(loadedHighlighter, lang);
    }
    return shikiParser(options);
  };
}

interface SpecWithExtensions {
  extensions?: readonly unknown[];
}

export function withCaseInsensitiveCodeHighlight<S extends SpecWithExtensions>(
  spec: S,
  loadHighlighter: () => Promise<Highlighter> = createHighlighter,
): S {
  const lazyParser = createLazyShikiParser(loadHighlighter);
  const codeHighlightExtension = createExtension(() => ({
    key: "code-block-highlighter",
    prosemirrorPlugins: [
      createHighlightPlugin({
        parser: lazyParser,
        nodeTypes: ["codeBlock"],
        languageExtractor: (node) => resolveCodeBlockLanguage(node.attrs.language as string | undefined),
      }) as never,
    ],
  }))();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote extension factory union isn't narrowed by key
  const extensions = (spec.extensions ?? []).map((ext: any) => {
    const resolved = typeof ext === "function" ? ext({ editor: undefined }) : ext;
    return resolved?.key === "code-block-highlighter" ? codeHighlightExtension : ext;
  });
  return { ...spec, extensions };
}
