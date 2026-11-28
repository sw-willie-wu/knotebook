// Markdown round-trips lose wikilink targets and turn mermaid into codeBlock(language=mermaid); restore with the
// web's rules (bind only on a unique title match). Link titles are lost for good: BlockNote links only have href.
// Duplicate or missing titles stay plain text and are counted.
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "./ydoc.js";
import { mapInlineArrays } from "./site-link.js";
import { MERMAID_LANGUAGE } from "./note-schema-config.js";

// Same pattern as the server's notes/service.ts; deliberately not shared.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Blank input parses to one empty paragraph; a looser "no content" test would also count a divider as blank.
export function isBlankParseResult(blocks: unknown[]): boolean {
  if (blocks.length === 0) return true;
  const only = blocks[0] as { type?: string; content?: unknown; children?: unknown };
  return (
    blocks.length === 1 &&
    only?.type === "paragraph" &&
    (!Array.isArray(only.content) || only.content.length === 0) &&
    (!Array.isArray(only.children) || only.children.length === 0)
  );
}

type AnyBlock = { id?: unknown; type: string; props?: Record<string, unknown>; content?: unknown; children?: AnyBlock[] };
type AnyInline = { type: string; text?: string; props?: Record<string, unknown>; styles?: Record<string, unknown> };

export function restoreMermaidBlocks<B>(blocks: B[]): B[] {
  return (blocks as AnyBlock[]).map(b => {
    const children = Array.isArray(b.children) && b.children.length > 0 ? restoreMermaidBlocks(b.children) : b.children;
    if (b.type === "codeBlock" && typeof b.props?.language === "string" && b.props.language.trim().toLowerCase() === MERMAID_LANGUAGE && Array.isArray(b.content)) {
      const code = (b.content as Array<{ text?: string }>).map(c => c.text ?? "").join("");
      // Keep the parsed id: preview diff pairs blocks by id, so an id-less diagram would show as removed and re-added.
      return { ...(typeof b.id === "string" ? { id: b.id } : {}), type: "mermaid", props: { code } } as unknown as B;
    }
    return (children === b.children ? b : { ...b, children }) as unknown as B;
  }) as B[];
}

export interface WikilinkTarget { id: string; title: string }

const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g;

function rebindInline(content: AnyInline[], notes: WikilinkTarget[]): [AnyInline[], number] {
  let unbound = 0;
  const out: AnyInline[] = [];
  for (const node of content) {
    if (node?.type !== "text" || typeof node.text !== "string" || !node.text.includes("[[")) { out.push(node); continue; }
    let last = 0;
    for (const m of node.text.matchAll(WIKILINK_RE)) {
      const title = m[1]!;
      const hits = notes.filter(n => n.title === title);
      if (m.index! > last) out.push({ ...node, text: node.text.slice(last, m.index) });
      if (hits.length === 1) out.push({ type: "wikilink", props: { targetNoteId: hits[0]!.id, snapshotTitle: title } });
      else { unbound += 1; out.push({ ...node, text: m[0] }); }
      last = m.index! + m[0].length;
    }
    if (last < node.text.length) out.push({ ...node, text: node.text.slice(last) });
  }
  return [out, unbound];
}

/** isInlineType filters ordinary blocks only; table cells are always walked (their wikilinks are bound and counted in unbound too). */
export function rebindWikilinks<B>(blocks: B[], notes: WikilinkTarget[], isInlineType: (type: string) => boolean): [B[], number] {
  let unbound = 0;
  const out = mapInlineArrays(
    blocks,
    (inline) => {
      const [content, n] = rebindInline(inline as AnyInline[], notes);
      unbound += n;
      return content;
    },
    isInlineType,
  );
  return [out, unbound];
}

// The tree walker's filter only decides what is yielded; children of rejected nodes are still visited.
// Sorted and deduplicated: web's collab/link-sync.ts compares `join(",")` with the last submitted set.
export function extractLinkTargets(doc: Y.Doc): string[] {
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const found: string[] = [];
  const walker = fragment.createTreeWalker((node): boolean => node instanceof Y.XmlElement && node.nodeName === "wikilink");
  for (const node of walker) {
    if (!(node instanceof Y.XmlElement)) continue;
    const targetNoteId = node.getAttribute("targetNoteId");
    if (typeof targetNoteId === "string" && UUID_RE.test(targetNoteId)) found.push(targetNoteId);
  }
  return [...new Set(found)].sort();
}
