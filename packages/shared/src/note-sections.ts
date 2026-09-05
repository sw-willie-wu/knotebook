import * as Y from "yjs";

// 結構層：fragment > blockGroup > blockContainer > blockContent [+ blockGroup]。nodeName 是 camelCase
// （toString() 印小寫——apps/web/src/collab/undo.ts:200-211 的雷）。段落只定義在唯一 blockGroup 的
// 直接 blockContainer 子節點；更深的是內容。正規序列化排除 id；指紋（server 端 hash）不是安全邊界。
export const TOP_SECTION_ID = "_top";
export const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface SectionInfo {
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  blockIds: string[];
}

export function topLevelContainers(fragment: Y.XmlFragment): Y.XmlElement[] {
  const group = fragment.get(0);
  if (!(group instanceof Y.XmlElement) || group.nodeName !== "blockGroup") return [];
  const out: Y.XmlElement[] = [];
  for (let i = 0; i < group.length; i += 1) {
    const child = group.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === "blockContainer") out.push(child);
  }
  return out;
}

function blockContent(container: Y.XmlElement): Y.XmlElement | null {
  const first = container.get(0);
  return first instanceof Y.XmlElement && first.nodeName !== "blockGroup" ? first : null;
}

/** 純文字：XmlText 走 delta 的 insert 串接（toString 會把 mark 印成 XML 標籤）。 */
function textOf(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as Array<{ insert: unknown }>).map(d => (typeof d.insert === "string" ? d.insert : "")).join("");
  }
  let s = "";
  for (let i = 0; i < node.length; i += 1) {
    const c = node.get(i);
    if (c instanceof Y.XmlText || c instanceof Y.XmlElement) s += textOf(c);
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
  for (const c of topLevelContainers(fragment)) {
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
  const kept = Object.keys(attrs).filter(k => k !== "id").sort().map(k => `${k}=${stable(attrs[k])}`);
  const children: string[] = [];
  for (let i = 0; i < node.length; i += 1) {
    const c = node.get(i);
    if (c instanceof Y.XmlElement || c instanceof Y.XmlText) children.push(canonicalizeNode(c));
  }
  return `E${node.nodeName}(${kept.join(";")})[${children.join("|")}]`;
}

export function canonicalizeElements(elements: Y.XmlElement[]): string {
  return elements.map(canonicalizeNode).join("\n");
}

/** `blockIds` 必須是頂層、且與文件順序一致；否則 null（＝指紋不符）。空陣列 → ""。 */
export function canonicalizeSection(fragment: Y.XmlFragment, blockIds: string[]): string | null {
  if (blockIds.length === 0) return "";
  const containers = topLevelContainers(fragment);
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
