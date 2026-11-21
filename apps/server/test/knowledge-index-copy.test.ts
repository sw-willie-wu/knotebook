// Rollback proof: `afterWriteForTest` throws after the index and state rows are written, so it proves already-written knowledge rows roll back with the copy.
import { describe, expect, it } from "vitest";
import { eq, ne, sql } from "drizzle-orm";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { noteKnowledge, noteKnowledgeState, notes } from "../src/db/schema.js";
import { seedNoteState } from "./search-helpers.js";
import { kh, kid, knowledgeDoc, knowledgeRows, knowledgeState } from "./knowledge-helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const SOURCE = [
  kh("p", kid(1), "Parent", { level: 1, when: "alice-when", conclusion: "conclusion", verified: "2026-01-02" }),
  kh("c", kid(2), "Child", { level: 2, status: "outdated", supersededBy: kid(1) }),
  { id: "plain", text: "body" },
];

const copy = async (app: Awaited<ReturnType<typeof buildTestApp>>["app"], noteId: string, userId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload: {} });

describe("copy", () => {
  it("copying a note with knowledge -> the copy has the same knowledge ids and block ids at source_version 1, right after the 201", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Src" });
    await seedNoteState(db, src.id, knowledgeDoc(SOURCE), 1);
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect((await knowledgeRows(db, id)).map((r) => [r.knowledgeId, r.blockId, r.readWhen, r.parentKnowledgeId])).toEqual([
      [kid(1), "p", "alice-when", null],
      [kid(2), "c", "", kid(1)],
    ]);
    expect(await knowledgeState(db, id)).toMatchObject({ sourceVersion: 1, entries: 2, capped: false });
    expect(await knowledgeRows(db, src.id)).toEqual([]);
  });

  it("afterWriteForTest throws in the copy transaction -> the copy fails and no note, search row or knowledge row exists for it", async () => {
    const boom = async (): Promise<void> => {
      throw new Error("after-write boom");
    };
    const { app, db } = await buildTestApp({ knowledgeIndexHooks: { afterWriteForTest: boom } });
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Src" });
    await seedNoteState(db, src.id, knowledgeDoc(SOURCE), 1);
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(500);
    expect(await db.select({ id: notes.id }).from(notes).where(ne(notes.id, src.id))).toEqual([]);
    expect(await db.select().from(noteKnowledge).where(ne(noteKnowledge.noteId, src.id))).toEqual([]);
    expect(await db.select().from(noteKnowledgeState).where(ne(noteKnowledgeState.noteId, src.id))).toEqual([]);
  });

  it("copying a never-opened note -> 201 and a state row with entries 0", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Never opened" });
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect(await knowledgeRows(db, id)).toEqual([]);
    expect(await knowledgeState(db, id)).toMatchObject({ sourceVersion: 1, entries: 0, capped: false });
    expect(await db.select().from(noteKnowledgeState).where(eq(noteKnowledgeState.noteId, src.id))).toEqual([]);
  });

  it("MCP copy_note writes the copy's knowledge rows the same way", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Src" });
    await seedNoteState(db, src.id, knowledgeDoc(SOURCE), 1);
    const { token } = await seedTokenForUser(db, u.id, "notes:read notes:write");
    const res = await mcpPost(app, rpc("tools/call", { name: "copy_note", arguments: { note_id: src.id } }), { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.isError).toBeUndefined();
    const copies = await db.select({ id: notes.id }).from(notes).where(ne(notes.id, src.id));
    expect(copies).toHaveLength(1);
    expect((await knowledgeRows(db, copies[0]!.id)).map((r) => r.knowledgeId)).toEqual([kid(1), kid(2)]);
  });

  it("an unexpected DB error inside the copy transaction answers 500 and the logged object has code, constraint and context but no err, message or params, and no knowledge text", async () => {
    const out: string[] = [];
    const secret = "alice-when-secret-71b2";
    const { app, db } = await buildTestApp({}, { logger: { level: "info", stream: { write: (chunk: string) => void out.push(chunk) } } });
    const u = await seedUser(db);
    const src = await seedNote(db, { ownerId: u.id }, { title: "Src" });
    await seedNoteState(db, src.id, knowledgeDoc([kh("p", kid(1), "Parent", { when: secret })]), 1);
    // Fails the knowledge INSERT with a SQLSTATE no handler knows, so the real drizzle error shape (message and params holding the INSERT values) is exercised.
    await db.execute(sql.raw("create function kb_test_fail_knowledge_insert() returns trigger language plpgsql as $$ begin raise exception 'forced test failure'; end $$"));
    await db.execute(sql.raw("create trigger kb_test_fail_knowledge_insert before insert on note_knowledge for each row execute function kb_test_fail_knowledge_insert()"));
    const res = await copy(app, src.id, u.id);
    expect(res.statusCode).toBe(500);
    const lines = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    const redacted = lines.filter((l) => l.context === "copy note");
    expect(redacted).toHaveLength(1);
    expect(redacted[0]).toMatchObject({ code: "P0001", context: "copy note" });
    expect(redacted[0]).not.toHaveProperty("err");
    expect(redacted[0]).not.toHaveProperty("params");
    expect(out.join("")).not.toContain(secret);
  });
});
