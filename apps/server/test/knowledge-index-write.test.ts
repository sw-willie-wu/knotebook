// The code under test is always the real `writeKnowledgeIndex`; the holder only plays "the other side" (DELETE, trash, move, note_states rewrite).
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { freshDb } from "./helpers.js";
import { seedGroup, seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { noteKnowledge, notes } from "../src/db/schema.js";
import { bumpKnowledgeIndexVersion, extractKnowledgeForIndex, writeKnowledgeIndex } from "../src/knowledge/index-write.js";
import { moveNoteToGroupInTx } from "../src/notes/tx/move.js";
import { purgeTrashedNotesInTx, trashNotesInTx } from "../src/notes/tx/trash.js";
import { markTrashed } from "./trash-helpers.js";
import { captureLog, makeGate, seedNoteState, setNoteState } from "./search-helpers.js";
import { kh, kid, knowledgeDoc, knowledgeRows, knowledgeState, type KBlk } from "./knowledge-helpers.js";

const V1: KBlk[] = [kh("h1", kid(1), "First", { when: "version one", level: 1 })];
const V2: KBlk[] = [kh("h1", kid(1), "First", { when: "version two", level: 1 })];
const ex = (blocks: KBlk[]) => extractKnowledgeForIndex(knowledgeDoc(blocks));
const many = (n: number): KBlk[] => Array.from({ length: n }, (_, i) => kh(`b${i}`, kid(i + 1), `H${i}`, { level: 1 }));

describe("first build and versions", () => {
  it("the same note first built twice at once via Promise.all -> one row per knowledge id, one state row", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const blocks = [kh("a", kid(1), "A"), kh("b", kid(2), "B")];
    await seedNoteState(db, n.id, knowledgeDoc(blocks), 1);
    const out = await Promise.all([writeKnowledgeIndex(db, n.id, 1, ex(blocks)), writeKnowledgeIndex(db, n.id, 1, ex(blocks))]);
    expect(out.sort()).toEqual(["unchanged", "written"]);
    expect((await knowledgeRows(db, n.id)).map((r) => r.knowledgeId)).toEqual([kid(1), kid(2)]);
    expect(await db.execute(sql`select count(*)::int as n from note_knowledge_state where note_id = ${n.id}::uuid`)).toMatchObject({ rows: [{ n: 1 }] });
  });

  it("an old sourceVersion -> stale, tables unchanged, no leftover placeholder state row", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V2), 2);
    expect(await writeKnowledgeIndex(db, n.id, 1, ex(V1))).toBe("stale");
    expect(await knowledgeState(db, n.id)).toBeUndefined();
    expect(await knowledgeRows(db, n.id)).toEqual([]);
  });

  it("no note_states row -> stale; no note -> gone", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    expect(await writeKnowledgeIndex(db, n.id, 1, ex(V1))).toBe("stale");
    expect(await writeKnowledgeIndex(db, "00000000-0000-4000-8000-0000000000aa", 1, ex(V1))).toBe("gone");
  });

  it("same content at a new version -> unchanged, only source_version advances; changed content -> written replaces the note's rows", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    expect(await writeKnowledgeIndex(db, n.id, 1, ex(V1))).toBe("written");
    await setNoteState(db, n.id, knowledgeDoc(V1), 2);
    expect(await writeKnowledgeIndex(db, n.id, 2, ex(V1))).toBe("unchanged");
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(2);
    await setNoteState(db, n.id, knowledgeDoc(V2), 3);
    expect(await writeKnowledgeIndex(db, n.id, 3, ex(V2))).toBe("written");
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
    expect(await knowledgeState(db, n.id)).toMatchObject({ sourceVersion: 3, entries: 1, capped: false });
  });

  it("a note without knowledge -> written, a state row with entries 0 and no knowledge rows", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const plain: KBlk[] = [{ id: "p", text: "no knowledge" }];
    await seedNoteState(db, n.id, knowledgeDoc(plain), 1);
    expect(await writeKnowledgeIndex(db, n.id, 1, ex(plain))).toBe("written");
    expect(await knowledgeRows(db, n.id)).toEqual([]);
    expect(await knowledgeState(db, n.id)).toMatchObject({ sourceVersion: 1, entries: 0, capped: false });
  });

  it("2001 knowledge headings -> 2000 rows (4 INSERT batches) and capped true; rows unchanged but capped flipping is written, not unchanged", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(many(2000)), 1);
    expect(await writeKnowledgeIndex(db, n.id, 1, ex(many(2000)))).toBe("written");
    expect(await knowledgeState(db, n.id)).toMatchObject({ entries: 2000, capped: false });
    await setNoteState(db, n.id, knowledgeDoc(many(2001)), 2);
    expect(await writeKnowledgeIndex(db, n.id, 2, ex(many(2001)))).toBe("written");
    const rows = await knowledgeRows(db, n.id);
    expect(rows).toHaveLength(2000);
    expect(rows.at(-1)!.ord).toBe(1999);
    expect(await knowledgeState(db, n.id)).toMatchObject({ sourceVersion: 2, entries: 2000, capped: true });
  });

  it("every stored column round-trips, including date, parent, superseded ref and descendant counts", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const blocks = [
      kh("p", kid(1), "Parent", { level: 1, when: "w", conclusion: "c", verified: "2026-01-02", evidence: "tested" }),
      kh("c", kid(2), "Child", { level: 2, status: "outdated", supersededBy: `${other}#${kid(9)}` }),
    ];
    await seedNoteState(db, n.id, knowledgeDoc(blocks), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(blocks));
    const [p, c] = await knowledgeRows(db, n.id);
    expect(p).toMatchObject({ knowledgeId: kid(1), blockId: "p", ord: 0, level: 1, heading: "Parent", readWhen: "w", conclusion: "c", evidence: "tested", verified: "2026-01-02", status: "", icon: "verified", parentKnowledgeId: null, descTotal: 1, descOutdated: 1 });
    expect(c).toMatchObject({ parentKnowledgeId: kid(1), status: "outdated", icon: "outdated", supersededNoteId: other, supersededKnowledgeId: kid(9), verified: null });
  });
});

describe("lock order against note deletion, trash and move", () => {
  it("permanent delete while the index transaction holds the state-row lock -> the delete waits on the notes row and completes after release, neither table has the note's rows", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await markTrashed(db.$client, n.id, u.id);
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(V1));
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    const gate = makeGate();
    // Stops holding notes KEY SHARE and the state row FOR UPDATE: without the initial notes KEY SHARE the delete's cascade would lock the knowledge rows and then wait for the state row while this transaction waits for those rows.
    const w = writeKnowledgeIndex(db, n.id, 2, ex(V2), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    const purge = db.transaction((tx) => purgeTrashedNotesInTx(tx, { ids: [n.id], by: u.id }));
    expect(await waitForBlockedOrSettled(db.$client, purge)).toBe("blocked");
    gate.open();
    expect(await w).toBe("written");
    expect((await purge).done).toEqual([n.id]);
    expect(await knowledgeRows(db, n.id)).toEqual([]);
    expect(await knowledgeState(db, n.id)).toBeUndefined();
  });

  it("reverse: delete takes the notes row first -> the index transaction blocks at its first lock and returns gone after the delete commits", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("delete from notes where id = $1", [n.id]);
      const w = writeKnowledgeIndex(db, n.id, 1, ex(V1));
      expect(await waitForBlockedOrSettled(db.$client, w)).toBe("blocked");
      await holder.query("commit");
      expect(await w).toBe("gone");
    } finally {
      await holder.end();
    }
    expect(await knowledgeState(db, n.id)).toBeUndefined();
  });

  it("trashing the note while the index transaction holds its locks -> the trash waits, both finish without 40P01, the rows stay (the query side filters trashed notes)", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(V1));
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    const gate = makeGate();
    const w = writeKnowledgeIndex(db, n.id, 2, ex(V2), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    const trash = db.transaction((tx) => trashNotesInTx(tx, { ids: [n.id], by: u.id }));
    expect(await waitForBlockedOrSettled(db.$client, trash)).toBe("blocked");
    gate.open();
    expect(await w).toBe("written");
    expect((await trash).trashed).toEqual([n.id]);
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
  });

  it("moving the note to a group while the index transaction holds its locks -> the move waits, both finish without 40P01, and the rows need no update", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(V1));
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    const gate = makeGate();
    const w = writeKnowledgeIndex(db, n.id, 2, ex(V2), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    const move = db.transaction((tx) =>
      moveNoteToGroupInTx(tx, { noteId: n.id, userId: u.id, userHandle: "h", groupId: g.id, folderId: null, lockTimeoutMs: 5000 }),
    );
    expect(await waitForBlockedOrSettled(db.$client, move)).toBe("blocked");
    gate.open();
    expect(await w).toBe("written");
    await move;
    const [row] = await db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, n.id));
    expect(row!.groupId).toBe(g.id);
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
  });
});

describe("backfill interleaved with live persist (two named stop points)", () => {
  it("case A (beforeStateLockForTest): backfill stops before the state-row lock; live persist writes V+1; release -> stale, table has V+1; a later bump with the same content changes nothing", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    const gate = makeGate();
    const b = writeKnowledgeIndex(db, n.id, 1, ex(V1), { hooks: { beforeStateLockForTest: gate.wait } });
    await gate.reached;
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    expect(await writeKnowledgeIndex(db, n.id, 2, ex(V2))).toBe("written");
    gate.open();
    expect(await b).toBe("stale");
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
    await setNoteState(db, n.id, knowledgeDoc(V2), 3);
    expect(await bumpKnowledgeIndexVersion(db, n.id, 3, ex(V2).contentHash)).toBe(1);
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(3);
  });

  it("case B (afterVersionReadForTest): backfill holds the state-row lock and has read V; live persist writes V+1 and waits; release -> V then V+1, final rows are V+1", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    const gate = makeGate();
    const b = writeKnowledgeIndex(db, n.id, 1, ex(V1), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    const l = writeKnowledgeIndex(db, n.id, 2, ex(V2));
    expect(await waitForBlockedOrSettled(db.$client, l)).toBe("blocked");
    gate.open();
    expect(await b).toBe("written");
    expect(await l).toBe("written");
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(2);
  });

  it("case C: note_states.version written backwards (below the state row's source_version) -> still written, one warn", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 5);
    await writeKnowledgeIndex(db, n.id, 5, ex(V1));
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    const { log, warns } = captureLog();
    expect(await writeKnowledgeIndex(db, n.id, 2, ex(V2), { log })).toBe("written");
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version two"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ noteId: n.id, stateSourceVersion: 5, noteStateVersion: 2 });
  });
});

describe("rollback on the normal write path", () => {
  it("afterWriteForTest throws after the INSERT and the state-row UPDATE -> the error surfaces, old rows and state row are unchanged", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(V1));
    const before = await knowledgeState(db, n.id);
    await setNoteState(db, n.id, knowledgeDoc(V2), 2);
    const boom = async (): Promise<void> => {
      throw new Error("after-write boom");
    };
    await expect(writeKnowledgeIndex(db, n.id, 2, ex(V2), { hooks: { afterWriteForTest: boom } })).rejects.toThrow("after-write boom");
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["version one"]);
    expect(await knowledgeState(db, n.id)).toEqual(before);
  });
});

describe("bumpKnowledgeIndexVersion", () => {
  it("advances only when hash and extractor version match and source_version is smaller; otherwise returns 0", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(V1));
    const h = ex(V1).contentHash;
    expect(await bumpKnowledgeIndexVersion(db, n.id, 2, "deadbeef")).toBe(0);
    expect(await bumpKnowledgeIndexVersion(db, n.id, 1, h)).toBe(0);
    expect(await bumpKnowledgeIndexVersion(db, n.id, 2, h)).toBe(1);
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(2);
    await db.execute(sql`update note_knowledge_state set extractor_version = 0 where note_id = ${n.id}::uuid`);
    expect(await bumpKnowledgeIndexVersion(db, n.id, 3, h)).toBe(0);
  });
});

describe("table access", () => {
  it("the knowledge rows are removed with the note's permanent deletion", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(V1), 1);
    await writeKnowledgeIndex(db, n.id, 1, ex(V1));
    await db.delete(notes).where(eq(notes.id, n.id));
    expect(await db.select().from(noteKnowledge).where(eq(noteKnowledge.noteId, n.id))).toEqual([]);
  });
});
