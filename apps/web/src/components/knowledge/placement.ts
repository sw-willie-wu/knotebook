export const KNOWLEDGE_ICON_PX = 16;
export const KNOWLEDGE_ICON_GAP_PX = 8;

/** For a block id inside a double-quoted attribute selector; escaping only quotes and backslashes would let a raw newline break the selector. */
export function attrValue(id: string): string {
  return CSS.escape(id);
}

// A toggleable heading wraps its inline content in `.bn-toggle-wrapper`, so this is a descendant selector.
const INLINE = ":scope > .bn-block > .bn-block-content .bn-inline-content";

/**
 * Where the status icon goes, relative to `container`: after the end of the heading's last line, centred on that line.
 * Empty text has no client rects, so the icon goes to the start of the line. The CSS keeps `KNOWLEDGE_ICON_PX + KNOWLEDGE_ICON_GAP_PX` free after the text, and the clamp is the safety net for a line that fills the column anyway.
 */
export function knowledgeIconPlace(outer: HTMLElement, container: HTMLElement): { top: number; left: number } | null {
  const inline = outer.querySelector<HTMLElement>(INLINE);
  if (!inline) return null;
  const box = container.getBoundingClientRect();
  const text = inline.getBoundingClientRect();
  if (text.width === 0 && text.height === 0) return null;
  const range = document.createRange();
  range.selectNodeContents(inline);
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1]! : null;
  if (!last) {
    return { top: text.top - box.top + (text.height - KNOWLEDGE_ICON_PX) / 2, left: text.left - box.left };
  }
  return {
    top: last.top - box.top + (last.height - KNOWLEDGE_ICON_PX) / 2,
    left: Math.min(last.right - box.left + KNOWLEDGE_ICON_GAP_PX, box.width - KNOWLEDGE_ICON_PX),
  };
}
