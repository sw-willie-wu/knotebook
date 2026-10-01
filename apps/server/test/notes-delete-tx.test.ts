import { describe, expect, it } from "vitest";
import { eq, inArray, or } from "drizzle-orm";
import * as Y from "yjs";
import { noteAiEdits, noteLinks, noteRedirects, noteShares, noteStateBackups, noteStates, notes, uploads } from "../src/db/schema.js";
import { deleteNotesInTx } from "../src/notes/tx/delete-notes.js";
import { buildTestApp } from "./helpers.js";
import { seedNote, seedRedirect, seedShare, seedUser } from "./group-helpers.js";

describe("#175 deleteNotesInTx（T14，PR4 全刪共用）", () => {
  it("多篇：notes 與其 states／backups／shares／兩方向 links／uploads／轉址／AI 紀錄都消失（CASCADE），回被刪的 upload id；名單外的列不動", async () => {
    const { db } = await buildTestApp();
    const [u, v] = await Promise.all([seedUser(db), seedUser(db)]);
    const [a, b, keep] = await Promise.all([seedNote(db, { ownerId: u.id }), seedNote(db, { ownerId: u.id }), seedNote(db, { ownerId: u.id })]);
    const ydoc = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
    await db.insert(noteStates).values([{ noteId: a.id, ydoc, version: 1 }, { noteId: keep.id, ydoc, version: 1 }]);
    await db.insert(noteStateBackups).values({ noteId: b.id, ydoc });
    await seedRedirect(db, `/n/${u.handle}/gone-a`, a.id);
    await db.insert(noteAiEdits).values({ noteId: b.id, userId: u.id, op: "append" });
    await seedShare(db, a.id, v.id, "viewer");
    await db.insert(noteLinks).values([{ sourceNoteId: keep.id, targetNoteId: a.id }, { sourceNoteId: b.id, targetNoteId: keep.id }]);
    const [ua] = await db.insert(uploads).values({ noteId: a.id, uploaderId: u.id, mime: "image/png", size: 1 }).returning({ id: uploads.id });
    const [uk] = await db.insert(uploads).values({ noteId: keep.id, uploaderId: u.id, mime: "image/png", size: 1 }).returning({ id: uploads.id });

    const deleted = await db.transaction(tx => deleteNotesInTx(tx, [a.id, b.id]));

    expect(deleted).toEqual([ua!.id]);
    expect(await db.select().from(notes).where(inArray(notes.id, [a.id, b.id]))).toEqual([]);
    expect((await db.select().from(notes).where(eq(notes.id, keep.id))).length).toBe(1);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, keep.id))).toHaveLength(1);
    expect(await db.select().from(noteStates).where(eq(noteStates.noteId, a.id))).toEqual([]);
    expect(await db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, b.id))).toEqual([]);
    expect(await db.select().from(noteShares).where(eq(noteShares.noteId, a.id))).toEqual([]);
    expect(await db.select().from(uploads).where(eq(uploads.id, ua!.id))).toEqual([]);
    expect(await db.select().from(noteRedirects).where(eq(noteRedirects.noteId, a.id))).toEqual([]);
    expect(await db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, b.id))).toEqual([]);
    expect(await db.select().from(noteLinks).where(or(inArray(noteLinks.sourceNoteId, [a.id, b.id]), inArray(noteLinks.targetNoteId, [a.id, b.id])))).toEqual([]);
    expect((await db.select().from(uploads).where(eq(uploads.id, uk!.id))).length).toBe(1);
  });

  it("空名單：no-op、回 []（drizzle 0.44 的 `inArray(col, [])` 渲染成 `false`）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    expect(await db.transaction(tx => deleteNotesInTx(tx, []))).toEqual([]);
    expect((await db.select().from(notes).where(eq(notes.id, n.id))).length).toBe(1);
  });
});
