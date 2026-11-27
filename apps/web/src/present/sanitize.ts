import DOMPurify, { type Config } from "dompurify";
import { COLUMN_WIDTH_MAX, COLUMN_WIDTH_MIN, COLUMNS_STYLE } from "@knotebook/shared";

/**
 * #229: a load-bearing guard. Layers: BlockNote builds HTML with the DOM API (text is always text nodes); `<template>` parses
 * into an inert fragment; **this file** (a private DOMPurify with a hard-coded allowlist); the only two `innerHTML` are the mermaid
 * SVG (trusting `lib/mermaid.ts`'s locked config) and the KaTeX HTML (trusting `lib/katex.ts`'s `trust: false`), both produced
 * after sanitizing (postprocess.ts). `style` is kept only on
 * side-by-side rows and columns, and only verbatim in the canonical form.
 * - Private instance: mermaid 11 attaches persistent hooks to DOMPurify's default singleton, and ours would affect mermaid's
 *   sanitizing. Use only `DOMPurify(window)` (source guard in sanitize.test.ts).
 * - Hooks are registered once at module top level (addHook inside a function would stack a layer per call).
 * - The element hook runs before the attribute hook: whether an `input` is kept is decided in `uponSanitizeElement`.
 * - `ADD_URI_SAFE_ATTR`: the allowlisted data-* values are not URLs and must not go through the URI check ("Meeting: notes" would be deleted).
 * - A lowercase `data:` is the form DOMPurify itself lets through (DATA_URI_TAGS) and that we have to block.
 */
const ALLOWED_DATA = [
  "data-text-color", "data-background-color", "data-style-type", "data-value",
  "data-text-alignment", "data-inline-content-type", "data-target-note-id", "data-snapshot-title",
  "data-label", "data-anchor-block-id",
  "data-kn-mermaid", "data-kn-math", "data-kn-media", "data-kn-code-lang",
  "data-kb-columns", "data-kb-column",
];

/** Canonical column form `flex:N`; the value is additionally clamped to [0.1, 10]. */
const COLUMN_FLEX_RE = /^flex:(?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?$/;

function canonicalColumnsStyle(el: Element, value: string): boolean {
  if (el.nodeName !== "DIV") return false;
  if (el.hasAttribute("data-kb-columns")) return value === COLUMNS_STYLE;
  if (!el.hasAttribute("data-kb-column") || !COLUMN_FLEX_RE.test(value)) return false;
  const width = Number(value.slice("flex:".length));
  return width >= COLUMN_WIDTH_MIN && width <= COLUMN_WIDTH_MAX;
}

const purify = DOMPurify(window);

// Typed as Config + RETURN_DOM_FRAGMENT: a readonly array from `as const` cannot be given to Config's mutable array.
const CFG: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
    "strong", "b", "em", "i", "u", "s", "del", "span", "a", "br", "table", "colgroup", "col", "thead", "tbody",
    "tr", "th", "td", "figure", "figcaption", "img", "video", "audio", "details", "summary", "input", "div", "#text"],
  ALLOWED_ATTR: ["href", "src", "alt", "width", "type", "checked", "colspan", "rowspan", "start", "open", "style", ...ALLOWED_DATA],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ADD_URI_SAFE_ATTR: ALLOWED_DATA,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: true,
};

/** Browsers drop ASCII whitespace and C0 controls when parsing a URL, so strip them before the scheme check (otherwise "\tdata:" passes). */
function normalizedScheme(value: string): string {
  return value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
}

purify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName !== "input") return;
  const type = ((node as Element).getAttribute("type") ?? "").trim().toLowerCase();
  if (type !== "checkbox") (node as Element).remove();
});

purify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "src") {
    const scheme = normalizedScheme(data.attrValue);
    if (scheme.startsWith("data:") || scheme.startsWith("mailto:")) data.keepAttr = false;
  } else if (data.attrName === "href" && (node as Element).nodeName.toLowerCase() !== "a") {
    data.keepAttr = false;
  } else if (data.attrName === "style" && !canonicalColumnsStyle(node as Element, data.attrValue)) {
    data.keepAttr = false;
  }
});

export function sanitizeSlideFragment(input: string | DocumentFragment): DocumentFragment {
  return purify.sanitize(input, CFG) as unknown as DocumentFragment;
}
