/**
 * wikilink node shape follows what `extractLinkTargets` in `packages/shared/src/note-markdown.ts` actually reads:
 * a `Y.XmlElement` named "wikilink" with attribute `targetNoteId` (UUID); position doesn't matter (it walks the whole tree).
 */
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteStates, uploads } from "../src/db/schema.js";
import { uploadFilePath } from "../src/uploads/service.js";

/** Minimal PNG header plus a few bytes (copy doesn't validate content, only compares byte for byte). */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export async function seedDoc(db: Db, noteId: string, doc: Y.Doc): Promise<void> {
  await db.insert(noteStates).values({ noteId, ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version: 1 });
}

export async function seedUpload(
  db: Db,
  uploadsDir: string,
  noteId: string,
  uploaderId: string,
  bytes: Buffer = PNG,
  opts: { noFile?: boolean; fileName?: string; mime?: string } = {},
): Promise<string> {
  const [u] = await db.insert(uploads).values({ noteId, uploaderId, mime: opts.mime ?? "image/png", size: bytes.length, fileName: opts.fileName ?? null }).returning({ id: uploads.id });
  if (!opts.noFile) await writeFile(uploadFilePath(uploadsDir, u!.id), bytes);
  return u!.id;
}

export async function loadDoc(db: Db, noteId: string): Promise<Y.Doc | null> {
  const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
  if (!row) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.ydoc);
  return doc;
}

export const xmlOf = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();

/** One `blockContainer > image[url]` per url (same as `docWith` in `test/unit/copy-doc.test.ts`). */
export function imageDoc(urls: string[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  group.insert(0, urls.map((u, i) => {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", `b${i}`);
    const img = new Y.XmlElement("image");
    img.setAttribute("url", u);
    c.insert(0, [img]);
    return c;
  }));
  return doc;
}

export function wikilinkDoc(targetIds: string[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  const c = new Y.XmlElement("blockContainer");
  c.setAttribute("id", "w0");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, targetIds.map(id => {
    const w = new Y.XmlElement("wikilink");
    w.setAttribute("targetNoteId", id);
    return w;
  }));
  c.insert(0, [p]);
  group.insert(0, [c]);
  return doc;
}
