import * as Y from "yjs";
import { EMPTY_KNOWLEDGE_PROPS, YDOC_FRAGMENT } from "@knotebook/shared";

export type YjsBlockSpec = { id: string; type: "p" | "h"; text: string; level?: 1 | 2 | 3 };

const defaultSpec = (i: number): YjsBlockSpec => ({ id: `q${i}`, type: "p", text: `p${i}` });

// Same elements and attributes the editor writes for these two block types, so a mounted editor adds no struct.
function container(spec: YjsBlockSpec): Y.XmlElement {
  const box = new Y.XmlElement("blockContainer");
  box.setAttribute("id", spec.id);
  const el: Y.XmlElement<Record<string, string | number | boolean>> = new Y.XmlElement(spec.type === "h" ? "heading" : "paragraph");
  el.setAttribute("backgroundColor", "default");
  el.setAttribute("textColor", "default");
  el.setAttribute("textAlignment", "left");
  if (spec.type === "h") {
    el.setAttribute("level", spec.level ?? 1);
    el.setAttribute("isToggleable", false);
    for (const [name, value] of Object.entries(EMPTY_KNOWLEDGE_PROPS)) el.setAttribute(name, value);
  }
  const text = new Y.XmlText();
  text.insert(0, spec.text);
  el.insert(0, [text]);
  box.insert(0, [el as unknown as Y.XmlElement]);
  return box;
}

/** `blockGroup > blockContainer(id) > paragraph | heading > XmlText`, built directly in Yjs. Inserted in chunks: one `insert` of a 160,000-element array overflows the call stack. */
export function yjsNote(n: number, specOf: (i: number) => YjsBlockSpec = defaultSpec): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  for (let from = 0; from < n; from += 10_000) {
    doc.transact(() => {
      const chunk: Y.XmlElement[] = [];
      for (let i = from; i < Math.min(n, from + 10_000); i++) chunk.push(container(specOf(i)));
      group.insert(group.length, chunk);
    });
  }
  return doc;
}
