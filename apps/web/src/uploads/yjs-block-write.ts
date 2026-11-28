import * as Y from "yjs";
import { YDOC_FRAGMENT, type UploadResponseDto } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";

export type UploadedBlockWrite = "written" | "missing" | "changed";

const FILE_BLOCK_TYPES = new Set(["image", "audio", "video", "file"]);

function findBlockContainer(node: Y.XmlElement | Y.XmlFragment, blockId: string): Y.XmlElement | null {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) return child;
    const found = findBlockContainer(child, blockId);
    if (found) return found;
  }
  return null;
}

type Target = { container: Y.XmlElement; content: Y.XmlElement } | "missing" | "changed";

function uploadTarget(doc: Y.Doc, blockId: string, expectedUrl: string): Target {
  const container = findBlockContainer(doc.getXmlFragment(YDOC_FRAGMENT), blockId);
  const content = container?.get(0);
  if (!container || !(content instanceof Y.XmlElement)) return "missing";
  if (!FILE_BLOCK_TYPES.has(content.nodeName) || (content.getAttribute("url") ?? "") !== expectedUrl) return "changed";
  return { container, content };
}

/** Whether `writeUploadedBlock` would still find the block waiting for this upload. */
export function uploadBlockWaits(doc: Y.Doc, blockId: string, expectedUrl: string): boolean {
  return typeof uploadTarget(doc, blockId, expectedUrl) !== "string";
}

/**
 * Writes on the `Y.Doc` rather than through the editor: an attached editor shares this doc, and
 * after the person left the note there is no editor at all.
 */
export function writeUploadedBlock(
  doc: Y.Doc,
  blockId: string,
  expectedUrl: string,
  result: UploadResponseDto,
  name: string,
): UploadedBlockWrite {
  const target = uploadTarget(doc, blockId, expectedUrl);
  if (typeof target === "string") return target;
  const { container, content } = target;

  doc.transact(() => {
    if (content.nodeName === result.kind) {
      content.setAttribute("url", result.url);
      content.setAttribute("name", name);
      return;
    }
    // Only the target kind's props carry over: an attribute its schema lacks (a file block's
    // `previewWidth`) would be kept in the doc and come back if the block changes kind again.
    const propSchema = noteSchema.blockSchema[result.kind].propSchema as Record<string, { default?: unknown }>;
    const old = content.getAttributes() as Record<string, unknown>;
    const next = new Y.XmlElement(result.kind);
    for (const [key, spec] of Object.entries(propSchema)) {
      const value = key in old ? old[key] : spec.default;
      if (value !== undefined) next.setAttribute(key, value as string);
    }
    next.setAttribute("url", result.url);
    next.setAttribute("name", name);
    container.insert(0, [next]);
    container.delete(1, 1);
  });
  return "written";
}
