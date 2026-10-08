/**
 * #93 §5.4：複製在**同一交易**內寫索引（S10、RF5 複製）。
 * rollback 證明（m-X6）：`afterWriteForTest` 在索引列與狀態列**已寫入之後**丟例外——`note-copy-files-copied` 在索引之前
 * 觸發，證明不了「已寫入的索引列被 rollback」。
 */
import { describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { noteSearchSections, noteSearchState, notes } from "../src/db/schema.js";
import { searchDoc } from "./search-doc.js";
import { indexRows, seedNoteState, stateRow } from "./search-helpers.js";

const copy = async (app: Awaited<ReturnType<typeof buildTestApp>>["app"], noteId: string, userId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload: {} });

describe("S10 複製", () => {
  it("複製有內容的筆記 → 新筆記立即可搜、source_version = 1", async () => {
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

  it("rollback 證明：afterWriteForTest 在索引已寫入之後丟例外 → 複製失敗、新筆記不存在、兩表沒有新筆記的任何列", async () => {
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

  it("RF5：複製一篇從沒開過（沒有 note_states）的筆記 → 201、新筆記有狀態列、0 個 section 列", async () => {
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
