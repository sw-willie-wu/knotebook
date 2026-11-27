/**
 * Loads and renders KaTeX (#338). The only place that imports `katex` and its CSS.
 *
 * It is a dynamic import because KaTeX is about 260 KB and only notes with math need it; a static import
 * would be pulled into the NotePage chunk. `scripts/check-bundle-size.mjs` fails the build if KATEX_MARKER is
 * found outside katex-*.js, if the static imports of the entry, NotePage, PublicNotePage or the presentation
 * reach katex-*.js, or if the entry CSS carries KaTeX's stylesheet.
 *
 * Security: `trust: false` (`\href`, `\url` and `\html*` are not run: KaTeX shows the command name in red and drops its arguments); `maxSize` and `maxExpand` cap
 * pathological input; `throwOnError: false` renders a syntax error as red text instead of throwing. The
 * MathML `<annotation>` in the output keeps the raw input as a text node, not an attribute, so it is not
 * executed under `dangerouslySetInnerHTML`.
 * `strict: "ignore"`: the default "warn" logs to the console for every incompatible macro.
 */
export type MathRenderResult = { ok: true; html: string } | { ok: false; message: string };

export const KATEX_OPTIONS = {
  displayMode: true,
  throwOnError: false,
  trust: false,
  strict: "ignore",
  maxSize: 10,
  maxExpand: 1000,
  output: "htmlAndMathml",
} as const;

type KatexModule = typeof import("katex");
let loading: Promise<KatexModule> | null = null;

function loadKatex(): Promise<KatexModule> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([mod]) => mod)
    .catch((err: unknown) => {
      loading = null; // a chunk can 404 after a deploy rotation: retry next time instead of caching the failure
      throw err;
    });
  return loading;
}

/** Resets the module-level loading state, for tests. */
export function resetKatexForTests(): void {
  loading = null;
}

export async function renderMath(tex: string): Promise<MathRenderResult> {
  // A collaborator's client can write any value into the prop: anything that isn't a string is a blank formula.
  if (typeof tex !== "string" || tex.trim().length === 0) return { ok: false, message: "" };
  try {
    const { default: katex } = await loadKatex();
    return { ok: true, html: katex.renderToString(tex, KATEX_OPTIONS) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
