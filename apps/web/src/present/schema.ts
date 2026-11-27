import { BlockNoteSchema, createBlockSpec, createCodeBlockSpec } from "@blocknote/core";
import { CODE_BLOCK_BASE_OPTIONS, mathBlockConfig, mermaidBlockConfig } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";

/**
 * Headless export only, never attached to an editor. Differs from noteSchema in four places (parity test in schema.test.ts):
 * 1. mermaid: `toExternalHTML` is a pure-DOM `div[data-kn-mermaid]` with `textContent = code` (same approach as shared
 *    `createHeadlessNoteSchema`); codeBlock(language=mermaid) stays `<pre><code>`.
 * 2. math: same shape as mermaid, `div[data-kn-math]` with `textContent = tex`; KaTeX runs after sanitizing (postprocess.ts).
 * 3. The four file kinds: wrapped around `withGuardedExternalHTML` (`props.url` goes through safeMediaUrl first), marking the
 *    URL-carrying element `data-kn-media=""` so post-processing can tell file links from text links.
 * 4. codeBlock: the uncolored `createCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS)` (so the presentation chunk stays off shiki),
 *    marking `<code>` with `data-kn-code-lang` so postprocess.ts can highlight it lazily (#232).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention (same as shared note-schema-config.ts)
type FileBlockSpecLike = { implementation: { toExternalHTML?: (this: any, block: any, ...rest: any[]) => unknown } };

const MEDIA_TARGET = "img, video, audio, a[href]";

function markMedia(output: unknown): void {
  const dom = (output as { dom?: unknown } | null | undefined)?.dom;
  if (!(dom instanceof Element)) return;
  const target = dom.matches(MEDIA_TARGET) ? dom : dom.querySelector(MEDIA_TARGET);
  target?.setAttribute("data-kn-media", "");
}

function withMediaMarker<Spec extends FileBlockSpecLike>(spec: Spec): Spec {
  const original = spec.implementation.toExternalHTML;
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
      toExternalHTML(this: unknown, ...args: any[]) {
        const output = original.apply(this, args as [unknown, ...unknown[]]);
        markMedia(output);
        return output;
      },
    },
  } as Spec;
}

function markCodeLanguage(output: unknown): void {
  const dom = (output as { dom?: unknown } | null | undefined)?.dom;
  if (!(dom instanceof Element)) return;
  const code = dom.matches("code") ? dom : dom.querySelector("code");
  const lang = code?.getAttribute("data-language");
  if (code && lang) code.setAttribute("data-kn-code-lang", lang);
}

function withCodeLang<Spec extends FileBlockSpecLike>(spec: Spec): Spec {
  const original = spec.implementation.toExternalHTML;
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
      toExternalHTML(this: unknown, ...args: any[]) {
        const output = original.apply(this, args as [unknown, ...unknown[]]);
        markCodeLanguage(output);
        return output;
      },
    },
  } as Spec;
}

const presentationMermaidSpec = createBlockSpec(mermaidBlockConfig, {
  render: () => ({ dom: document.createElement("div") }),
  toExternalHTML: (block) => {
    const div = document.createElement("div");
    div.setAttribute("data-kn-mermaid", "");
    div.textContent = block.props.code;
    return { dom: div };
  },
})(); // createBlockSpec returns a factory

const presentationMathSpec = createBlockSpec(mathBlockConfig, {
  render: () => ({ dom: document.createElement("div") }),
  toExternalHTML: (block) => {
    const div = document.createElement("div");
    div.setAttribute("data-kn-math", "");
    div.textContent = block.props.tex;
    return { dom: div };
  },
})();

const specs = noteSchema.blockSpecs;

export const presentationSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...specs,
    audio: withMediaMarker(specs.audio),
    file: withMediaMarker(specs.file),
    image: withMediaMarker(specs.image),
    video: withMediaMarker(specs.video),
    mermaid: presentationMermaidSpec,
    math: presentationMathSpec,
    codeBlock: withCodeLang(createCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS)),
  },
  inlineContentSpecs: noteSchema.inlineContentSpecs,
  styleSpecs: noteSchema.styleSpecs,
});
