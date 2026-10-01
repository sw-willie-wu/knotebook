/**
 * #175 PR2 T4（複製）的測試種子與量測。新檔（plan R7：不動 `group-helpers.ts`）。
 * wikilink 節點的形狀照 `packages/shared/src/note-markdown.ts` 的 `extractLinkTargets` 實際讀的：
 * `Y.XmlElement` 節點名 `"wikilink"`、屬性 `targetNoteId`（UUID）；位置不拘（它走整棵樹）。
 */
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteStates, uploads } from "../src/db/schema.js";
import { uploadFilePath } from "../src/uploads/service.js";

/** 最小的 PNG 檔頭＋幾個位元組（複製不驗內容，只逐位元組比對）。 */
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export async function seedDoc(db: Db, noteId: string, doc: Y.Doc): Promise<void> {
  await db.insert(noteStates).values({ noteId, ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version: 1 });
}

/** 插一列 uploads＋把 bytes 寫到磁碟（`opts.noFile`：只插列、不寫檔——RF4）。回 upload id。 */
export async function seedUpload(
  db: Db,
  uploadsDir: string,
  noteId: string,
  uploaderId: string,
  bytes: Buffer = PNG,
  opts: { noFile?: boolean } = {},
): Promise<string> {
  const [u] = await db.insert(uploads).values({ noteId, uploaderId, mime: "image/png", size: bytes.length }).returning({ id: uploads.id });
  if (!opts.noFile) await writeFile(uploadFilePath(uploadsDir, u!.id), bytes);
  return u!.id;
}

/** 解 `note_states` 的快照；沒有列回 `null`。 */
export async function loadDoc(db: Db, noteId: string): Promise<Y.Doc | null> {
  const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
  if (!row) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.ydoc);
  return doc;
}

export const xmlOf = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();

/** 每個 url 一個 `blockContainer > image[url]`（同 `test/unit/copy-doc.test.ts` 的 `docWith`）。 */
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

/** 一個 paragraph，內含每個目標一個 `wikilink[targetNoteId]` 行內節點。 */
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
