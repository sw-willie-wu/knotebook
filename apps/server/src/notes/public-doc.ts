import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, YDOC_FRAGMENT } from "@knotebook/shared";

export interface PublicDoc {
  ydocB64: string;
  doc: Y.Doc | null;
}

// Matches any element and any casing, not just the heading props the app writes: a client can put these attributes anywhere in the shared document.
const KNOWLEDGE_ATTR_RE = /^knowledge/i;

// Raw bytes, not the decoded doc: a removed attribute leaves its key (and, for a doc written with gc off, its old value) in the update. Latin-1 keeps one char per byte.
export function bytesMayHoldKnowledge(bytes: Uint8Array): boolean {
  return /knowledge/i.test(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"));
}

// Iterative: columns and lists nest, and a pathological note must not overflow the stack.
function stripKnowledgeLikeAttributes(fragment: Y.XmlFragment): void {
  const stack: Array<Y.XmlFragment | Y.XmlElement> = [fragment];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      for (const name of Object.keys(child.getAttributes())) if (KNOWLEDGE_ATTR_RE.test(name)) child.removeAttribute(name);
      stack.push(child);
    }
  }
}

// An unreadable stored state must reach the client as an undecodable payload (an empty string makes its decoder throw), so the page shows the error card instead of an empty note.
const UNREADABLE: PublicDoc = { ydocB64: "", doc: null };
const EMPTY: PublicDoc = { ydocB64: EMPTY_YDOC_UPDATE_B64, doc: null };

export function preparePublicDoc(stored: Uint8Array | null): PublicDoc {
  if (stored === null) return { ...EMPTY };
  const decoded = new Y.Doc();
  try {
    Y.applyUpdate(decoded, stored);
  } catch {
    decoded.destroy();
    return { ...UNREADABLE };
  }
  if (decoded.store.pendingStructs !== null || decoded.store.pendingDs !== null) {
    decoded.destroy();
    return { ...UNREADABLE };
  }
  if (!bytesMayHoldKnowledge(stored)) return { ydocB64: Buffer.from(stored).toString("base64"), doc: decoded };

  // `decoded` is our own copy. Its stripped state is copied into a fresh doc: deleting the attributes in place would leave their keys in the encoded history.
  decoded.transact(() => stripKnowledgeLikeAttributes(decoded.getXmlFragment(YDOC_FRAGMENT)));
  const clean = new Y.Doc();
  const children = decoded.getXmlFragment(YDOC_FRAGMENT).toArray().map((child) => child.clone() as Y.XmlElement | Y.XmlText);
  clean.getXmlFragment(YDOC_FRAGMENT).insert(0, children);
  decoded.destroy();
  return { ydocB64: Buffer.from(Y.encodeStateAsUpdate(clean)).toString("base64"), doc: clean };
}
