import * as Y from "yjs";
import { isIgnorableKnowledgeDefault } from "./knowledge-schema.js";

// Sections are only the single blockGroup's direct blockContainer/columnList children; deeper nodes are content.
// nodeName is camelCase even though toString() prints lowercase.
// The canonical serialization excludes ids; the fingerprint is not a security boundary.
export const TOP_SECTION_ID = "_top";
export const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface SectionInfo {
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  blockIds: string[];
}

/** Also returns columnList rows, not only blockContainers. */
export function topLevelBlocks(fragment: Y.XmlFragment): Y.XmlElement[] {
  const group = fragment.get(0);
  if (!(group instanceof Y.XmlElement) || group.nodeName !== "blockGroup") return [];
  const out: Y.XmlElement[] = [];
  // Y types' get(i) walks from the start, so an index loop is quadratic on paragraphs with ~100k children.
  for (const child of group.toArray()) {
    if (child instanceof Y.XmlElement && (child.nodeName === "blockContainer" || child.nodeName === "columnList")) out.push(child);
  }
  return out;
}

/** For each wanted id found anywhere in the document (nested list items and column children included), the id of the top-level block or columns row that holds it. */
export function topLevelIdsOf(fragment: Y.XmlFragment, wanted: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  for (const top of topLevelBlocks(fragment)) {
    const topId = top.getAttribute("id") ?? "";
    // Iterative: nesting depth is client-controlled.
    const stack: Y.XmlElement[] = [top];
    while (stack.length > 0) {
      const n = stack.pop()!;
      const id = n.getAttribute("id");
      if (typeof id === "string" && wanted.has(id) && !out.has(id)) out.set(id, topId);
      for (const c of n.toArray()) if (c instanceof Y.XmlElement) stack.push(c);
    }
    if (out.size === wanted.size) break;
  }
  return out;
}

// A columnList reaches here too: its first child is a column, not a blockGroup, so it returns the first column; headingLevel only
// matches headings, so a row is never treated as a heading.
function blockContent(container: Y.XmlElement): Y.XmlElement | null {
  const first = container.get(0);
  return first instanceof Y.XmlElement && first.nodeName !== "blockGroup" ? first : null;
}

// Iterative: nesting depth is client-controlled. Delta inserts, because toString() prints marks as XML tags.
// Children are pushed in reverse so pops come out in preorder; only XmlText/XmlElement are taken (XmlHook is filtered).
function textOf(node: Y.XmlElement | Y.XmlText): string {
  let s = "";
  const stack: Array<Y.XmlElement | Y.XmlText> = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n instanceof Y.XmlText) {
      s += (n.toDelta() as Array<{ insert: unknown }>).map(d => (typeof d.insert === "string" ? d.insert : "")).join("");
      continue;
    }
    const kids = n.toArray();
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const c = kids[i];
      if (c instanceof Y.XmlText || c instanceof Y.XmlElement) stack.push(c);
    }
  }
  return s;
}

function headingLevel(content: Y.XmlElement | null): number | null {
  if (!content || content.nodeName !== "heading") return null;
  const level = Number(content.getAttribute("level") ?? "1");
  return Number.isFinite(level) ? level : 1;
}

export function sectionize(fragment: Y.XmlFragment): SectionInfo[] {
  const sections: SectionInfo[] = [{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0, blockIds: [] }];
  let current = sections[0]!;
  for (const c of topLevelBlocks(fragment)) {
    const content = blockContent(c);
    const level = headingLevel(content);
    const id = c.getAttribute("id") ?? "";
    if (level !== null && (current.level === 0 || level <= current.level)) {
      current = { sectionId: id, level, heading: textOf(content!), chars: 0, blockIds: [] };
      sections.push(current);
    }
    current.blockIds.push(id);
    current.chars += textOf(c).length;
  }
  return sections;
}

function stable(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalizeNode(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
    return `T${stable(delta.map(d => ({ insert: d.insert, attributes: d.attributes ?? {} })))}`;
  }
  const attrs = node.getAttributes() as Record<string, unknown>;
  const kept = Object.keys(attrs).filter(k => k !== "id" && !isIgnorableKnowledgeDefault(node.nodeName, k, attrs[k])).sort().map(k => `${k}=${stable(attrs[k])}`);
  const children: string[] = [];
  for (const c of node.toArray()) {
    if (c instanceof Y.XmlElement || c instanceof Y.XmlText) children.push(canonicalizeNode(c));
  }
  return `E${node.nodeName}(${kept.join(";")})[${children.join("|")}]`;
}

export function canonicalizeElements(elements: Y.XmlElement[]): string {
  return elements.map(canonicalizeNode).join("\n");
}

/** `blockIds` must be top-level and in document order, else null (fingerprint mismatch). */
export function canonicalizeSection(fragment: Y.XmlFragment, blockIds: string[]): string | null {
  if (blockIds.length === 0) return "";
  const containers = topLevelBlocks(fragment);
  const byId = new Map(containers.map((c, i) => [c.getAttribute("id") ?? "", { c, i }]));
  const picked: Y.XmlElement[] = [];
  let lastIndex = -1;
  for (const id of blockIds) {
    const hit = byId.get(id);
    if (!hit || hit.i <= lastIndex) return null;
    lastIndex = hit.i;
    picked.push(hit.c);
  }
  return canonicalizeElements(picked);
}
