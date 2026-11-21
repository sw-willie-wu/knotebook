// The structural guard for the wiring (that index.ts starts the sweep) is in `unit/knowledge-backfill-wiring.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { freshDb } from "./helpers.js";
import { seedNote, seedUser, waitForLockWaiters } from "./group-helpers.js";
import { notes, noteStates } from "../src/db/schema.js";
import { KNOWLEDGE_EXTRACTOR_VERSION } from "../src/knowledge/extract.js";
import { backfillKnowledgeIndex, extractKnowledgeForIndex, startKnowledgeIndexSweep, writeKnowledgeIndex } from "../src/knowledge/index-write.js";
import { captureLog, noteStateVersion, seedNoteState, setNoteState } from "./search-helpers.js";
import { kh, kid, knowledgeDoc, knowledgeRows, knowledgeState, type KBlk } from "./knowledge-helpers.js";

// The wrapper delegates to the real function; it only lets a test count decodes (ESM namespaces can't be spied on).
vi.mock("yjs", async (orig) => {
  const real = await orig<typeof import("yjs")>();
  return { ...real, applyUpdate: vi.fn(real.applyUpdate) };
});

const one = (when: string): KBlk[] => [kh("h", kid(1), "Heading", { when })];
const whens = async (db: Parameters<typeof knowledgeRows>[0], id: string) => (await knowledgeRows(db, id)).map((r) => r.readWhen);

describe("backfill", () => {
  it("notes without a state row, with extractor_version 0 and with a lagging source_version are all fixed in one run; a second run has 0 candidates", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const fresh = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const n = await seedNote(db, { ownerId: u.id });
        await seedNoteState(db, n.id, knowledgeDoc(one(`fresh ${i}`)), 1);
        return n.id;
      }),
    );
    const oldVer = (await seedNote(db, { ownerId: u.id })).id;
    await seedNoteState(db, oldVer, knowledgeDoc(one("old extractor")), 1);
    await writeKnowledgeIndex(db, oldVer, 1, extractKnowledgeForIndex(knowledgeDoc(one("old extractor"))));
    await db.execute(sql`update note_knowledge_state set extractor_version = 0 where note_id = ${oldVer}::uuid`);
    const behind = (await seedNote(db, { ownerId: u.id })).id;
    await seedNoteState(db, behind, knowledgeDoc(one("behind v1")), 1);
    await writeKnowledgeIndex(db, behind, 1, extractKnowledgeForIndex(knowledgeDoc(one("behind v1"))));
    await setNoteState(db, behind, knowledgeDoc(one("behind v2")), 2);

    const { log, infos, warns } = captureLog();
    const r = await backfillKnowledgeIndex(db, log);
    expect(r).toMatchObject({ candidates: 5, done: 5, skipped: 0, failed: 0, aborted: false });
    for (const [i, id] of fresh.entries()) expect(await whens(db, id)).toEqual([`fresh ${i}`]);
    expect(await whens(db, oldVer)).toEqual(["old extractor"]);
    expect(await whens(db, behind)).toEqual(["behind v2"]);
    for (const id of [...fresh, oldVer, behind]) {
      expect(await knowledgeState(db, id)).toMatchObject({ extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION, sourceVersion: await noteStateVersion(db, id) });
    }
    expect(infos.map((i) => i.msg)).toEqual(["knowledge index backfill started", "knowledge index backfill finished"]);
    expect(warns).toEqual([]);
    expect(await backfillKnowledgeIndex(db, captureLog().log)).toMatchObject({ candidates: 0, done: 0, skipped: 0, failed: 0 });
  });

  it("a note whose bytes hold no knowledge attribute name gets an empty state row without being decoded", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc([{ id: "p", text: "plain" }]), 1);
    vi.mocked(Y.applyUpdate).mockClear();
    const r = await backfillKnowledgeIndex(db, captureLog().log);
    expect(r).toMatchObject({ candidates: 1, done: 1 });
    expect(Y.applyUpdate).not.toHaveBeenCalled();
    expect(await knowledgeState(db, n.id)).toMatchObject({ entries: 0, capped: false });
  });

  it("a never-opened note (no note_states) is not a candidate", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    await seedNote(db, { ownerId: u.id });
    expect(await backfillKnowledgeIndex(db, captureLog().log)).toMatchObject({ candidates: 0, done: 0 });
  });

  it("abort midway -> aborted with only part done; a second run handles only the rest", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    for (let i = 0; i < 6; i += 1) {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, knowledgeDoc(one(`n${i}`)), 1);
    }
    const ac = new AbortController();
    let seen = 0;
    const first = await backfillKnowledgeIndex(db, captureLog().log, {
      signal: ac.signal,
      batchSize: 2,
      afterEachForTest: () => {
        seen += 1;
        if (seen === 3) ac.abort();
      },
    });
    expect(first).toMatchObject({ candidates: 6, done: 3, aborted: true });
    const second = await backfillKnowledgeIndex(db, captureLog().log);
    expect(second).toMatchObject({ candidates: 3, done: 3, aborted: false });
  });

  it("a corrupt ydoc -> failed 1 with one warn that carries no err and no message, the rest done", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    // Contains the attribute key so the decode path is taken, but is not a valid update.
    const BAD = Buffer.concat([Buffer.from("knowledgeId"), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]);
    expect(() => Y.applyUpdate(new Y.Doc(), BAD), "precondition: these bytes must make applyUpdate throw").toThrow();
    const bad = await seedNote(db, { ownerId: u.id });
    await db.insert(noteStates).values({ noteId: bad.id, ydoc: BAD, version: 1 });
    const good = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, good.id, knowledgeDoc(one("good one")), 1);
    const { log, warns } = captureLog();
    const r = await backfillKnowledgeIndex(db, log);
    expect(r).toMatchObject({ candidates: 2, done: 1, failed: 1 });
    expect(warns.map((w) => w.msg)).toEqual(["knowledge index backfill: one note failed (skipped, continuing)"]);
    expect(Object.keys(warns[0]!.obj).sort()).toEqual(["code", "constraint", "name", "noteId"]);
    expect(await whens(db, good.id)).toEqual(["good one"]);
  });

  it("a candidate note deleted during the run is skipped, not a failure, no warn", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, knowledgeDoc(one(`d ${i}`)), 1);
      ids.push(n.id);
    }
    const last = [...ids].sort().at(-1)!;
    let deleted = false;
    const { log, warns } = captureLog();
    const r = await backfillKnowledgeIndex(db, log, {
      afterEachForTest: async () => {
        if (!deleted) {
          deleted = true;
          await db.delete(notes).where(eq(notes.id, last));
        }
      },
    });
    expect(r).toMatchObject({ candidates: 3, done: 2, skipped: 1, failed: 0 });
    expect(warns).toEqual([]);
  });

  it("a note edited during the run keeps the newer content: the backfill's older snapshot never overwrites it", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(one("old")), 1);
    const holder = await db.$client.connect();
    let run!: ReturnType<typeof backfillKnowledgeIndex>;
    let live!: Promise<string>;
    try {
      await holder.query("begin");
      // Holding the note row stops the backfill's write at its first lock, after it already read the version-1 bytes.
      await holder.query("select id from notes where id = $1 for update", [n.id]);
      run = backfillKnowledgeIndex(db, captureLog().log);
      await waitForLockWaiters(db.$client, 1);
      await setNoteState(db, n.id, knowledgeDoc(one("new")), 2);
      live = writeKnowledgeIndex(db, n.id, 2, extractKnowledgeForIndex(knowledgeDoc(one("new"))));
      await waitForLockWaiters(db.$client, 2);
      await holder.query("commit");
    } finally {
      holder.release();
    }
    expect(await live).toBe("written");
    expect(await run).toMatchObject({ candidates: 1, done: 0, skipped: 1, failed: 0 });
    expect(await whens(db, n.id)).toEqual(["new"]);
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(2);
  });
});

describe("restore runbook", () => {
  async function restored(variant: { bump: boolean; purge: boolean }) {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(one("before restore")), 1);
    await writeKnowledgeIndex(db, n.id, 1, extractKnowledgeForIndex(knowledgeDoc(one("before restore"))));
    const ydoc = Buffer.from(Y.encodeStateAsUpdate(knowledgeDoc(one("restored content"))));
    await db.transaction(async (tx) => {
      await tx.execute(sql`update note_states set ydoc = ${ydoc}, version = version + ${variant.bump ? 1 : 0} where note_id = ${n.id}::uuid`);
      if (variant.purge) {
        await tx.execute(sql`delete from note_knowledge_state where note_id = ${n.id}::uuid`);
        await tx.execute(sql`delete from note_knowledge where note_id = ${n.id}::uuid`);
      }
    });
    await backfillKnowledgeIndex(db, captureLog().log);
    return whens(db, n.id);
  }
  it("version +1 and delete both tables (state first) -> after backfill the rows match the restored content", async () => {
    expect(await restored({ bump: true, purge: true })).toEqual(["restored content"]);
  });
  it("delete only, no version bump -> still correct after backfill", async () => {
    expect(await restored({ bump: false, purge: true })).toEqual(["restored content"]);
  });
  it("version bump only, no delete -> still correct after backfill", async () => {
    expect(await restored({ bump: true, purge: false })).toEqual(["restored content"]);
  });
  it("neither done -> pre-restore knowledge stays in the index (the consequence documented in docs/backup-restore.md)", async () => {
    expect(await restored({ bump: false, purge: false })).toEqual(["before restore"]);
  });
});

describe("sweep", () => {
  it("self-healing: a note whose first index write failed (no state row) after the startup run is indexed by the next run", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(one("heal")), 1);
    const { log } = captureLog();
    let runs = 0;
    let sweep!: { stop(): void };
    const second = new Promise<void>((resolve) => {
      sweep = startKnowledgeIndexSweep(db, log, {
        intervalMs: 200,
        afterRunForTest: async () => {
          runs += 1;
          if (runs === 1) {
            // Simulates the first write having failed: the note has no state row again.
            await db.execute(sql`delete from note_knowledge_state where note_id = ${n.id}::uuid`);
            await db.execute(sql`delete from note_knowledge where note_id = ${n.id}::uuid`);
          } else if (runs === 2) resolve();
        },
      });
    });
    await second;
    sweep.stop();
    expect(await whens(db, n.id)).toEqual(["heal"]);
  });

  it("a run still going when the next is due is skipped; stop() aborts the run and no run starts afterwards", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    for (let i = 0; i < 4; i += 1) {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, knowledgeDoc(one(`s${i}`)), 1);
    }
    const holder = await db.$client.connect();
    let finished = 0;
    let sweep: { stop(): void };
    try {
      await holder.query("begin");
      // A held lock on a state row's note keeps the first run busy across several intervals.
      const [first] = (await db.select({ id: noteStates.noteId }).from(noteStates).orderBy(noteStates.noteId).limit(1))!;
      await holder.query("select id from notes where id = $1 for update", [first!.id]);
      sweep = startKnowledgeIndexSweep(db, captureLog().log, { intervalMs: 50, afterRunForTest: () => { finished += 1; } });
      await new Promise((r) => setTimeout(r, 400));
      expect(finished).toBe(0);
      sweep.stop();
      await holder.query("commit");
    } finally {
      holder.release();
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBeLessThanOrEqual(1);
    const after = finished;
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(after);
  });

  it("a run with 0 candidates writes no log line", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, knowledgeDoc(one("x")), 1);
    await backfillKnowledgeIndex(db, captureLog().log);
    const { log, infos, warns } = captureLog();
    await backfillKnowledgeIndex(db, log);
    expect([infos, warns]).toEqual([[], []]);
  });
});
