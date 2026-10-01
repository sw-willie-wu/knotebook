/**
 * #175 §6.5 (2)、B10：複製的 Y.Doc 處理（純函式，不碰 DB／檔案）。clone 頂層節點進全新 Y.Doc（clientID 不同、被刪
 * 文字不在 update 裡、屬性與 block id 保留——spec §2.8【驗】），並收集 `url` 屬性**恰為** `/api/uploads/<uuid>` 的
 * XmlElement（同一個 id 可能有多個節點，RF2）。已知不改寫（§15 第 9 條）：文字 link mark 裡的上傳網址、同源絕對網址。
 * 走訪比照 `collab/store.ts` 的 `collectUnsafeUrlFindings`（顯式 stack、只展開 XmlElement／XmlFragment）。
 */
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";

const UPLOAD_URL_RE = /^\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface CopyDoc {
  doc: Y.Doc;
  /** key＝小寫 upload id。 */
  uploadNodes: Map<string, Y.XmlElement[]>;
}

export function cloneForCopy(src: Y.Doc): CopyDoc {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment(YDOC_FRAGMENT);
  const items = src.getXmlFragment(YDOC_FRAGMENT).toArray().map(n => n.clone());
  if (items.length > 0) frag.insert(0, items as Array<Y.XmlElement | Y.XmlText>);
  const uploadNodes = new Map<string, Y.XmlElement[]>();
  const stack: unknown[] = [frag];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node instanceof Y.XmlElement) {
      const url: unknown = node.getAttribute("url");
      const m = typeof url === "string" ? UPLOAD_URL_RE.exec(url) : null;
      if (m) {
        const id = m[1]!.toLowerCase();
        uploadNodes.set(id, [...(uploadNodes.get(id) ?? []), node]);
      }
      for (const child of node.toArray()) stack.push(child);
    } else if (node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) stack.push(child);
    }
  }
  return { doc, uploadNodes };
}

export function rewriteUploadUrls(copy: CopyDoc, mapping: ReadonlyMap<string, string>): void {
  copy.doc.transact(() => {
    for (const [oldId, nodes] of copy.uploadNodes) {
      const newId = mapping.get(oldId);
      if (newId === undefined) continue;
      for (const n of nodes) n.setAttribute("url", `/api/uploads/${newId}`);
    }
  });
}
