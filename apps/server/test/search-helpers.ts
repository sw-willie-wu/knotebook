/**
 * #93：全文索引整合測試共用。種子與讀列都直打 DB（被測的是索引寫入／查詢，不是種子路徑）。
 */
import { asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "../src/db/index.js";
import { noteSearchSections, noteSearchState, noteStates } from "../src/db/schema.js";
import { extractForIndex, writeSearchIndex } from "../src/notes/search-index.js";
import type { SearchExtract } from "../src/notes/search-text.js";
import { seedNote } from "./group-helpers.js";
import { searchDoc, type Blk } from "./search-doc.js";

export async function seedNoteState(db: Db, noteId: string, doc: Y.Doc, version = 1): Promise<void> {
  await db.insert(noteStates).values({ noteId, ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version });
}

/** 模擬一次落盤：note_states 換內容、version 設成指定值（`persistNoteState` 的效果；不是被測方）。 */
export async function setNoteState(db: Db, noteId: string, doc: Y.Doc, version: number): Promise<void> {
  await db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)), version }).where(eq(noteStates.noteId, noteId));
}

export const extractOf = (blocks: Blk[]): SearchExtract => extractForIndex(searchDoc(blocks));

export async function indexRows(db: Db, noteId: string): Promise<Array<{ sectionId: string; ord: number; heading: string; body: string; sourceKind: string }>> {
  return db
    .select({ sectionId: noteSearchSections.sectionId, ord: noteSearchSections.ord, heading: noteSearchSections.heading, body: noteSearchSections.body, sourceKind: noteSearchSections.sourceKind })
    .from(noteSearchSections)
    .where(eq(noteSearchSections.noteId, noteId))
    .orderBy(asc(noteSearchSections.ord));
}

export async function stateRow(db: Db, noteId: string) {
  const [row] = await db.select().from(noteSearchState).where(eq(noteSearchState.noteId, noteId));
  return row;
}

export async function noteStateVersion(db: Db, noteId: string): Promise<number | undefined> {
  const [row] = await db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
  return row?.version;
}

/** 建一篇有內容且已建好索引的筆記（version 1）。 */
export async function seedIndexedNote(db: Db, owner: { ownerId: string } | { groupId: string }, title: string, blocks: Blk[]): Promise<{ id: string; slug: string }> {
  const note = await seedNote(db, owner, { title });
  const doc = searchDoc(blocks);
  await seedNoteState(db, note.id, doc, 1);
  const outcome = await writeSearchIndex(db, note.id, 1, extractForIndex(doc));
  if (outcome !== "written") throw new Error(`seedIndexedNote：預期 written，得到 ${outcome}`);
  return note;
}

/** 輪詢直到 pred 對該篇的索引列成立（且狀態列追上 note_states.version）。 */
export async function waitIndexed(db: Db, noteId: string, pred: (bodies: string) => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [rows, st, v] = await Promise.all([indexRows(db, noteId), stateRow(db, noteId), noteStateVersion(db, noteId)]);
    if (st !== undefined && v !== undefined && st.sourceVersion === v && pred(rows.map(r => r.body).join("\n"))) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`waitIndexed 逾時（${ms}ms）：${noteId}`);
}

/** 收 warn／info 的 logger（斷言「warn 一行」用）。 */
export function captureLog(): { log: { warn(obj: object, msg: string): void; info(obj: object, msg: string): void }; warns: Array<{ obj: object; msg: string }>; infos: Array<{ obj: object; msg: string }> } {
  const warns: Array<{ obj: object; msg: string }> = [];
  const infos: Array<{ obj: object; msg: string }> = [];
  return { log: { warn: (obj, msg) => warns.push({ obj, msg }), info: (obj, msg) => infos.push({ obj, msg }) }, warns, infos };
}

/** 一個可外部放行的閘：測試縫裡 `await gate.wait()` 卡住、測試端 `gate.open()` 放行；`reached` 在第一次進入時 resolve。 */
export function makeGate(): { wait: () => Promise<void>; open: () => void; reached: Promise<void> } {
  let open!: () => void;
  let enter!: () => void;
  const opened = new Promise<void>(r => (open = r));
  const reached = new Promise<void>(r => (enter = r));
  return { wait: async () => { enter(); await opened; }, open, reached };
}
