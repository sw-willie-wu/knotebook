import { BLOCK_ANCHOR_RE, COMMENT_QUOTE_MAX, wikilinkVisibleText } from "@knotebook/shared";
import type { PMLike } from "@/ai/selection";
import type { CommentDraftAnchor } from "@/lib/comments-context";

type PMNode = PMLike["doc"];

const ELLIPSIS = "…";

/** The server counts the quote in code points, and the "…" is one of them. */
export function cutQuote(text: string): string {
  const points = Array.from(text);
  return points.length <= COMMENT_QUOTE_MAX ? text : points.slice(0, COMMENT_QUOTE_MAX - 1).join("") + ELLIPSIS;
}

// The quote shows what the reader saw, so a site link reads as its visible text rather than the markdown the AI box sends.
function leaf(node: PMNode): string {
  if (node.type.name === "wikilink") return wikilinkVisibleText(node.attrs);
  if (node.type.name === "hardBreak") return "\n";
  return node.textContent;
}

function containerIdAt(doc: PMNode, pos: number): string | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "blockContainer") {
      const id = node.attrs.id;
      return typeof id === "string" && BLOCK_ANCHOR_RE.test(id) ? id : null;
    }
  }
  return null;
}

/**
 * Anchor = the innermost block holding the first selected text, so a nested list item or a column child is anchored by its own id; table
 * cells have no block of their own and give the table's. Null when the range covers no text block. The quote is "" for a whitespace-only selection.
 */
export function passageOf(doc: PMNode, from: number, to: number): CommentDraftAnchor | null {
  if (to <= from) return null;
  let blockId: string | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (blockId !== null) return false;
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1);
    const end = Math.min(to, pos + node.nodeSize - 1);
    if (end > start) blockId = containerIdAt(doc, pos);
    return false;
  });
  if (blockId === null) return null;
  return { blockId, quote: cutQuote(doc.textBetween(from, to, "\n", leaf).trim()) };
}
