/**
 * #93：全文索引測試用的 Y.Doc 建構器（純 Yjs、不碰 DB——unit 與整合測試共用）。
 * 形狀＝BlockNote 的結構：fragment > blockGroup > blockContainer(id) > <type …> > 內容。
 * `id` 是 unknown：敵意案要塞數字或空字串；省略＝不設 id 屬性。
 */
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";

export type Inline = string | { wikilink: unknown };
export interface Blk {
  id?: unknown;
  type?: string;
  level?: number;
  text?: string;
  inline?: Inline[];
  attrs?: Record<string, unknown>;
}

export function searchDoc(blocks: Blk[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  blocks.forEach((b, i) => {
    const c = new Y.XmlElement("blockContainer");
    group.insert(i, [c]);
    if (b.id !== undefined) c.setAttribute("id", b.id as string);
    const type = b.type ?? "paragraph";
    const content = new Y.XmlElement(type);
    c.insert(0, [content]);
    if (type === "heading") content.setAttribute("level", String(b.level ?? 1));
    for (const [k, v] of Object.entries(b.attrs ?? {})) content.setAttribute(k, v as string);
    const parts: Inline[] = b.inline ?? (b.text !== undefined ? [b.text] : []);
    for (const part of parts) {
      if (typeof part === "string") {
        const t = new Y.XmlText();
        content.insert(content.length, [t]);
        t.insert(0, part);
      } else {
        const w = new Y.XmlElement("wikilink");
        content.insert(content.length, [w]);
        w.setAttribute("snapshotTitle", part.wikilink as string);
        w.setAttribute("targetNoteId", "00000000-0000-4000-8000-000000000000");
      }
    }
  });
  return doc;
}

export const frag = (doc: Y.Doc): Y.XmlFragment => doc.getXmlFragment(YDOC_FRAGMENT);
