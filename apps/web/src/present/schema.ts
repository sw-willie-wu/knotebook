import { BlockNoteSchema, createBlockSpec, createCodeBlockSpec } from "@blocknote/core";
import { CODE_BLOCK_BASE_OPTIONS, mermaidBlockConfig } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";

/**
 * #229 簡報專用匯出 schema（spec §5.2、A6）——只給 headless 匯出用，絕不掛到編輯器上。
 * 與 noteSchema 的差異只有三處（其餘沿用；parity 測試在 schema.test.ts）：
 * 1. mermaid：`toExternalHTML` 換成純 DOM 的 `div[data-kn-mermaid]`＋`textContent = code`（不經 React；
 *    與 shared `createHeadlessNoteSchema` 同手法，`note-schema-config.ts:89-98`）——codeBlock(language=mermaid)
 *    仍是 `<pre><code>`，不靠 data-language 猜（§2.6-9）。
 * 2. 檔案類四種：在既有 `withGuardedExternalHTML`（`props.url` 先過 safeMediaUrl）外再包一層，把帶網址的那個
 *    元素標上 `data-kn-media=""`——消毒前就存在，消毒白名單放行，後處理靠它分辨檔案連結與文字連結（§5.2-2）。
 * 3. codeBlock：不上色的 `createCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS)`（同 server headless），不經
 *    `lib/code-highlight.ts` 的 highlighter（§5.2-3；Q1）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例，同 shared note-schema-config.ts）
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
      toExternalHTML(this: unknown, ...args: any[]) {
        const output = original.apply(this, args as [unknown, ...unknown[]]);
        markMedia(output);
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
})(); // createBlockSpec 回 factory（shared note-schema-config.ts:99 同註）

const specs = noteSchema.blockSpecs;

export const presentationSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...specs,
    audio: withMediaMarker(specs.audio),
    file: withMediaMarker(specs.file),
    image: withMediaMarker(specs.image),
    video: withMediaMarker(specs.video),
    mermaid: presentationMermaidSpec,
    codeBlock: createCodeBlockSpec(CODE_BLOCK_BASE_OPTIONS),
  },
  inlineContentSpecs: noteSchema.inlineContentSpecs,
  styleSpecs: noteSchema.styleSpecs,
});
