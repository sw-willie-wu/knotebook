// Importing this file doesn't touch the DOM; the builders use global `document` (server: `EditingRuntime.installGlobals()`).
import { clampSizePx } from "./note-sizes.js";

type MediaBlockType = "audio" | "video" | "file";
const MEDIA_BLOCK_TYPES: readonly string[] = ["audio", "video", "file"];

const TAG = { audio: "audio", video: "video", file: "embed" } as const;

/** Elements built by `buildMediaElement`, so read output can tell them from the empty `<video>`/`<embed>` of a block without a URL. */
const built = new WeakSet<Element>();
export const isBuiltMediaElement = (el: Element): boolean => built.has(el);

export interface MediaBlockLike {
  type: MediaBlockType;
  props: { url?: string; name?: string; caption?: string; showPreview?: boolean; previewWidth?: number };
}

export function isMediaBlockWithUrl(b: unknown): b is MediaBlockLike {
  if (b === null || typeof b !== "object") return false;
  const { type, props } = b as { type?: unknown; props?: { url?: unknown } };
  return typeof type === "string" && MEDIA_BLOCK_TYPES.includes(type) && typeof props?.url === "string" && props.url !== "";
}

/**
 * Fixed attribute order: src, data-name, data-show-preview, width. A caption wraps the element in a figure, which is the form
 * BlockNote's own parse reads back. `url` is already guarded by the caller.
 */
export function buildMediaElement(block: MediaBlockLike, url: string): Element {
  const { name, caption, showPreview, previewWidth } = block.props;
  const el = document.createElement(TAG[block.type]);
  el.setAttribute("src", url);
  if (name) el.setAttribute("data-name", name);
  if (block.type !== "file" && showPreview === false) el.setAttribute("data-show-preview", "false");
  const width = block.type === "video" && previewWidth !== undefined ? clampSizePx(previewWidth) : null;
  if (width !== null) el.setAttribute("width", String(width));
  built.add(el);
  if (!caption) return el;
  const figure = document.createElement("figure");
  const figcaption = document.createElement("figcaption");
  figcaption.textContent = caption;
  figure.append(el, figcaption);
  built.add(figure);
  return figure;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention, as in note-schema-config.ts)
type ParseSpecLike = { implementation: { parse?: (element: HTMLElement, ...rest: any[]) => any } };

/**
 * BlockNote's parse for audio and file ignores `data-name` and for audio and video ignores `data-show-preview`; this adds both.
 * Video already reads `data-name` and `width`.
 */
export function withMediaHtmlParse<Spec extends ParseSpecLike>(spec: Spec): Spec {
  const original = spec.implementation.parse;
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
      parse(this: unknown, element: HTMLElement, ...rest: any[]) {
        const props = original.call(this, element, ...rest);
        if (props === undefined || props === null) return props;
        const target = element.matches("audio,video,embed") ? element : element.querySelector("audio,video,embed");
        if (target === null) return props;
        const out = { ...props };
        const name = target.getAttribute("data-name");
        if (name) out.name = name;
        if (target.tagName !== "EMBED" && target.getAttribute("data-show-preview") === "false") out.showPreview = false;
        return out;
      },
    },
  } as Spec;
}
