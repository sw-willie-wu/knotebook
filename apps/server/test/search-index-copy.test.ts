// Rollback proof: `afterWriteForTest` throws after the index and state rows are written - `note-copy-files-copied` fires before the
// transaction, so it cannot prove that already-written index rows are rolled back.
import { describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { noteSearchSections, noteSearchState, notes } from "../src/db/schema.js";
import { searchDoc } from "./search-doc.js";
import { indexRows, seedNoteState, stateRow } from "./search-helpers.js";

const copy = async (app: Awaited<ReturnType<typeof buildTestApp>>["app"], noteId: string, userId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload: {} });

describe("copy", () => {
  it("copying a note with content -> the new note is searchable at once, source_version = 1", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Src" });
    await seedNoteState(db, src.id, searchDoc([{ id: "p", text: "copy-alpha" }, { id: "h", type: "heading", text: "H" }, { id: "q", text: "copy-bravo" }]), 1);
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect((await indexRows(db, id)).map(r => [r.sectionId, r.body])).toEqual([["_top", "copy-alpha"], ["h", "H\ncopy-bravo"]]);
    expect(await stateRow(db, id)).toMatchObject({ sourceVersion: 1, capped: false });
  });

  it("rollback proof: afterWriteForTest throws after the index is written -> copy fails, the new note does not exist, neither table has any row for it", async () => {
    const boom = async (): Promise<void> => { throw new Error("after-write boom"); };
    const { app, db } = await buildTestApp({ searchIndexHooks: { afterWriteForTest: boom } });
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Src" });
    await seedNoteState(db, src.id, searchDoc([{ id: "p", text: "rollback-me" }]), 1);
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(500);
    expect(await db.select({ id: notes.id }).from(notes).where(ne(notes.id, src.id))).toEqual([]);
    expect(await db.select().from(noteSearchSections).where(ne(noteSearchSections.noteId, src.id))).toEqual([]);
    expect(await db.select().from(noteSearchState).where(ne(noteSearchState.noteId, src.id))).toEqual([]);
  });

  it("copying a note that was never opened (no note_states) -> 201, the new note has a state row and 0 section rows", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Never opened" });
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect(await indexRows(db, id)).toEqual([]);
    expect(await stateRow(db, id)).toMatchObject({ sourceVersion: 1, indexedUnits: 0, capped: false });
    expect(await db.select().from(noteSearchState).where(eq(noteSearchState.noteId, src.id))).toEqual([]);
  });
});
