import type * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { presentationSchema } from "./schema";
import { isBlankBlock, noteToSlides, type SlideKind } from "./slides";
import { sanitizeSlideFragment } from "./sanitize";
import { postprocessSlide, type MermaidJob, type PostprocessContext } from "./postprocess";

/**
 * #229 匯出管線（spec §5.1）：Y.Doc → blocks → noteToSlides → 每張 blocksToHTMLLossy（同張一次，清單才正確合成）
 * → `<template>` → 消毒 → 後處理。封面以 textContent 建 `<h1>`。
 *
 * ⚠ **時機（§5.1-6）**：`createExportEditor`／`renderDeck` 只准在 `setTimeout`／`queueMicrotask` 的 callback 裡
 * 呼叫，**不得**在 render、useMemo、useLayoutEffect、useEffect 本體內——wikilink 的 toExternalHTML 走
 * flushSync（§2.6-10），React 19 在 passive effect 裡呼叫 flushSync 不會同步渲染（Task 5 S2 實測：effect 本體匯出
 * 得 `<p><span></span></p>` 並有 1 則 flushSync 警告；microtask／timeout 得完整 wikilink）。
 */
export function createExportEditor() {
  return BlockNoteEditor.create({ schema: presentationSchema });
}

export type ExportEditor = ReturnType<typeof createExportEditor>;

export interface RenderedSlide {
  id: string;
  kind: SlideKind;
  /** 只有標題（heading 張沒有其他 block、或封面沒有非空白內容）→ 垂直置中（§10-6）。 */
  titleOnly: boolean;
  /** 內容比對鍵（§7.1-3：以該張 blocks 的 JSON 字串比；封面另含標題）。 */
  key: string;
  /** null＝key 與上一版相同，沿用既有 DOM。 */
  content: { fragment: DocumentFragment; mermaid: MermaidJob[] } | null;
}

export interface RenderedSection {
  id: string;
  slides: RenderedSlide[];
}

export interface RenderDeckInput {
  editor: ExportEditor;
  doc: Y.Doc;
  title: string;
  titlePlaceholder: string;
  ctx: PostprocessContext;
  previousKeys?: ReadonlyMap<string, string>;
}

export function renderDeck(input: RenderDeckInput): RenderedSection[] {
  const blocks = yXmlFragmentToBlocks(input.editor, input.doc.getXmlFragment(YDOC_FRAGMENT));
  return noteToSlides(input.title, blocks).map((section) => ({
    id: section.id,
    slides: section.slides.map((slide): RenderedSlide => {
      const key = slide.kind === "cover" ? JSON.stringify(["cover", input.title, slide.blocks]) : JSON.stringify(slide.blocks);
      const titleOnly =
        slide.kind === "cover" ? slide.blocks.every(isBlankBlock) : slide.kind === "heading" && slide.blocks.length === 1;
      if (input.previousKeys?.get(slide.id) === key) return { id: slide.id, kind: slide.kind, titleOnly, key, content: null };

      const template = document.createElement("template");
      template.innerHTML = slide.blocks.length > 0 ? input.editor.blocksToHTMLLossy(slide.blocks) : "";
      const fragment = sanitizeSlideFragment(template.content);
      const mermaid = postprocessSlide(fragment, input.ctx);
      if (slide.kind === "cover") {
        const h1 = document.createElement("h1");
        const untitled = input.title.trim() === "";
        h1.textContent = untitled ? input.titlePlaceholder : input.title;
        if (untitled) h1.className = "kn-present-untitled";
        fragment.prepend(h1);
      }
      return { id: slide.id, kind: slide.kind, titleOnly, key, content: { fragment, mermaid } };
    }),
  }));
}
