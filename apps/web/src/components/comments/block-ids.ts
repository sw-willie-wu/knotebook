import { useEffect, useState } from "react";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";

export function collectBlockIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer") {
        const id = child.getAttribute("id");
        if (typeof id === "string") ids.add(id);
      }
      walk(child);
    }
  };
  walk(doc.getXmlFragment(YDOC_FRAGMENT));
  return ids;
}

const RECOUNT_DEBOUNCE_MS = 300;

/** Block ids of the live document, kept current while `enabled`; null while not computed or while it has no blocks (not synced yet: a synced one always has one). */
export function useBlockIds(doc: Y.Doc, enabled: boolean): Set<string> | null {
  const [ids, setIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const recount = () => {
      const found = collectBlockIds(doc);
      setIds(found.size === 0 ? null : found);
    };
    recount();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(recount, RECOUNT_DEBOUNCE_MS);
    };
    doc.on("update", onUpdate);
    return () => {
      doc.off("update", onUpdate);
      clearTimeout(timer);
    };
  }, [doc, enabled]);
  return enabled ? ids : null;
}
