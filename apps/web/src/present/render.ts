import type * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { presentationSchema } from "./schema";
import { isBlankBlock, noteToSlides, type SlideKind } from "./slides";
import { sanitizeSlideFragment } from "./sanitize";
import { postprocessSlide, type CodeHighlightJob, type MathJob, type MermaidJob, type PostprocessContext } from "./postprocess";

/**
 * Timing: `createExportEditor` / `renderDeck` may be called only inside a `setTimeout` / `queueMicrotask` callback, never in
 * the body of render, useMemo, useLayoutEffect or useEffect: a wikilink's toExternalHTML goes through flushSync, and React 19
 * does not render synchronously when flushSync is called inside a passive effect (you get `<p><span></span></p>` plus a
 * flushSync warning).
 */
export function createExportEditor() {
  return BlockNoteEditor.create({ schema: presentationSchema });
}

export type ExportEditor = ReturnType<typeof createExportEditor>;

export interface RenderedSlide {
  id: string;
  kind: SlideKind;
  titleOnly: boolean;
  key: string;
  /** null: key unchanged since the previous render; keep the existing DOM. */
  content: { fragment: DocumentFragment; mermaid: MermaidJob[]; math: MathJob[]; code: CodeHighlightJob[] } | null;
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
      // One blocksToHTMLLossy call per slide, so its list items merge into one list.
      template.innerHTML = slide.blocks.length > 0 ? input.editor.blocksToHTMLLossy(slide.blocks) : "";
      const fragment = sanitizeSlideFragment(template.content);
      const { mermaid, math, code } = postprocessSlide(fragment, input.ctx);
      if (slide.kind === "cover") {
        const h1 = document.createElement("h1");
        const untitled = input.title.trim() === "";
        h1.textContent = untitled ? input.titlePlaceholder : input.title;
        if (untitled) h1.className = "kn-present-untitled";
        fragment.prepend(h1);
      }
      return { id: slide.id, kind: slide.kind, titleOnly, key, content: { fragment, mermaid, math, code } };
    }),
  }));
}
