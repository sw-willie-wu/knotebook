// The WS form goes through buildCollabTestApp; deterministic timing (logger / extraction failures) calls createNoteStore directly.
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { KNOWLEDGE_INDEX_NOTE_MAX, YDOC_FRAGMENT } from "@knotebook/shared";
import { createNoteStore } from "../src/collab/store.js";
import { notes, noteStateBackups } from "../src/db/schema.js";
import { bumpKnowledgeIndexVersion, writeKnowledgeIndex } from "../src/knowledge/index-write.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { buildCollabTestApp, freshDb } from "./helpers.js";
import { bearer, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { captureLog, noteStateVersion } from "./search-helpers.js";
import { kid, knowledgeRows, knowledgeState } from "./knowledge-helpers.js";
import type { Db } from "../src/db/index.js";

const PASSWORD = "correct-horse-battery";

type Props = Record<string, unknown>;

/** Appends a heading block with the given attributes (a paragraph when `props` has no heading level). */
function writeHeading(doc: Y.Doc, id: string, text: string, props: Props): Y.XmlElement {
  const f = doc.getXmlFragment(YDOC_FRAGMENT);
  let group = f.get(0) as Y.XmlElement | undefined;
  if (!(group instanceof Y.XmlElement)) {
    group = new Y.XmlElement("blockGroup");
    f.insert(0, [group]);
  }
  const c = new Y.XmlElement("blockContainer");
  group.insert(group.length, [c]);
  c.setAttribute("id", id);
  const h = new Y.XmlElement("heading");
  c.insert(0, [h]);
  h.setAttribute("level", "2");
  for (const [k, v] of Object.entries(props)) h.setAttribute(k, v as string);
  const t = new Y.XmlText();
  h.insert(0, [t]);
  t.insert(0, text);
  return h;
}

function writeParagraph(doc: Y.Doc, id: string, text: string): void {
  const f = doc.getXmlFragment(YDOC_FRAGMENT);
  let group = f.get(0) as Y.XmlElement | undefined;
  if (!(group instanceof Y.XmlElement)) {
    group = new Y.XmlElement("blockGroup");
    f.insert(0, [group]);
  }
  const c = new Y.XmlElement("blockContainer");
  group.insert(group.length, [c]);
  c.setAttribute("id", id);
  const p = new Y.XmlElement("paragraph");
  c.insert(0, [p]);
  const t = new Y.XmlText();
  p.insert(0, [t]);
  t.insert(0, text);
}

const kprops = (id: string, when: string): Props => ({ knowledgeId: id, knowledgeWhen: when });

async function waitKnowledge(db: Db, noteId: string, pred: (whens: string[]) => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [rows, st, v] = await Promise.all([knowledgeRows(db, noteId), knowledgeState(db, noteId), noteStateVersion(db, noteId)]);
    if (st !== undefined && v !== undefined && st.sourceVersion === v && pred(rows.map((r) => r.readWhen))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitKnowledge timed out: ${noteId}`);
}

describe("normal persist (WS)", () => {
  it("a WS edit that turns a heading into knowledge -> after persist its row is in note_knowledge with the persisted version; removing the knowledge info removes the row", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "k1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("k1@example.com", PASSWORD);
    const client = await session.connect(note.id);
    const h = writeHeading(client.doc, "h1", "Retries", {});
    await new Promise((r) => setTimeout(r, 100));
    h.setAttribute("knowledgeId", kid(1));
    h.setAttribute("knowledgeWhen", "when retrying uploads");
    await waitKnowledge(ctx.db, note.id, (w) => w.includes("when retrying uploads"));
    expect((await knowledgeRows(ctx.db, note.id)).map((r) => [r.knowledgeId, r.heading, r.blockId])).toEqual([[kid(1), "Retries", "h1"]]);
    h.removeAttribute("knowledgeId");
    h.removeAttribute("knowledgeWhen");
    await waitKnowledge(ctx.db, note.id, (w) => w.length === 0);
    expect(await knowledgeRows(ctx.db, note.id)).toEqual([]);
    client.disconnect();
  });

  it("a note that never has knowledge ends up with a state row of 0 entries and no rows", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "k1b@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("k1b@example.com", PASSWORD);
    const client = await session.connect(note.id);
    writeParagraph(client.doc, "p1", "plain text");
    await waitKnowledge(ctx.db, note.id, (w) => w.length === 0);
    expect(await knowledgeState(ctx.db, note.id)).toMatchObject({ entries: 0, capped: false });
    client.disconnect();
  });
});

describe("AI path", () => {
  it("right after an append response the knowledge heading's row is still there and the state row is at the persisted version", async () => {
    const ctx = await buildCollabTestApp({ limiters: { edit: new FixedWindowLimiter({ limit: 1000, windowMs: 60_000 }) } });
    const u = await ctx.createUser({ email: "k2@example.com", password: PASSWORD });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("k2@example.com", PASSWORD);
    const client = await session.connect(note.id);
    writeHeading(client.doc, "h1", "Keep me", kprops(kid(7), "when keeping"));
    writeParagraph(client.doc, "p1", "body");
    await waitKnowledge(ctx.db, note.id, (w) => w.includes("when keeping"));
    const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: { op: "append", markdown: "delta line" } });
    expect(res.statusCode).toBe(201);
    expect((await knowledgeRows(ctx.db, note.id)).map((r) => r.readWhen)).toEqual(["when keeping"]);
    expect((await knowledgeState(ctx.db, note.id))!.sourceVersion).toBeLessThanOrEqual((await noteStateVersion(ctx.db, note.id))!);
    client.disconnect();
  });
});

describe("failure isolation", () => {
  it("the knowledge indexer throws (via the collab wrapper) -> persist, backup and last_edited are still written; one warn whose object has code, constraint and name but no err and no message", async () => {
    const ctx = await buildCollabTestApp({
      storeSearchHooks: {
        knowledgeIndexer: async () => {
          throw Object.assign(new Error("failed with alice-secret-when"), { code: "XX000", constraint: "some_chk", params: ["alice-secret-when"] });
        },
      },
    });
    const owner = await ctx.createUser({ email: "k3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("k3@example.com", PASSWORD);
    const client = await session.connect(note.id);
    writeHeading(client.doc, "h1", "H", kprops(kid(1), "alice-secret-when"));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await ctx.db.select({ at: notes.lastEditedAt }).from(notes).where(eq(notes.id, note.id));
      if (row?.at) break;
      if (Date.now() > deadline) throw new Error("timed out waiting for last_edited");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await noteStateVersion(ctx.db, note.id)).toBe(1);
    expect(await ctx.db.select().from(noteStateBackups).where(eq(noteStateBackups.noteId, note.id))).toHaveLength(1);
    const warns = ctx.collabLogs.filter((l) => l.msg.startsWith("knowledge index update failed"));
    expect(warns).toHaveLength(1);
    expect(Object.keys(warns[0]!.obj as object).sort()).toEqual(["code", "constraint", "name", "noteId"]);
    expect(JSON.stringify(ctx.collabLogs)).not.toContain("alice-secret-when");
    client.disconnect();
  });

  it("knowledge extraction throws -> persist and the search index as usual, no knowledge transaction, one warn", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const { log, warns } = captureLog();
    let calls = 0;
    const store = createNoteStore({
      db,
      log,
      extractKnowledge: () => {
        throw new Error("extract boom");
      },
      knowledgeIndexer: async () => {
        calls += 1;
        return "written";
      },
    });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "searchable");
    await store.onStoreDocument(n.id, doc);
    expect(await noteStateVersion(db, n.id)).toBe(1);
    expect(calls).toBe(0);
    const [{ n: searchRows }] = (await db.execute(sql`select count(*)::int as n from note_search_sections where note_id = ${n.id}::uuid`)).rows as Array<{ n: number }>;
    expect(searchRows).toBe(1);
    expect(warns.filter((w) => w.msg.startsWith("knowledge index extraction failed"))).toHaveLength(1);
  });

  it("the knowledge indexer and the logger both throw -> onStoreDocument still resolves", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const store = createNoteStore({
      db,
      log: {
        warn: () => {
          throw new Error("logger boom");
        },
      },
      knowledgeIndexer: async () => {
        throw new Error("indexer boom");
      },
    });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeHeading(doc, "h", "H", kprops(kid(1), "w"));
    await expect(store.onStoreDocument(n.id, doc)).resolves.toBeUndefined();
    expect(await noteStateVersion(db, n.id)).toBe(1);
  });

  it("extraction and the logger both throw -> onStoreDocument still resolves", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const store = createNoteStore({
      db,
      log: {
        warn: () => {
          throw new Error("logger boom");
        },
      },
      extractKnowledge: () => {
        throw new Error("extract boom");
      },
    });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "x");
    await expect(store.onStoreDocument(n.id, doc)).resolves.toBeUndefined();
    expect(await noteStateVersion(db, n.id)).toBe(1);
  });

  it("a database failure inside the knowledge write (constraint refused) leaves persist and backup intact", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const { log, warns } = captureLog();
    const store = createNoteStore({
      db,
      log,
      extractKnowledge: () => ({
        rows: [{ knowledgeId: "not-an-id", blockId: "b", ord: 0, level: 2, heading: "H", when: "alice-secret-71b2", conclusion: "", evidence: "", verified: null, status: "", icon: "verified", parentKnowledgeId: null, supersededNoteId: null, supersededKnowledgeId: null, descTotal: 0, descVerified: 0, descNoDate: 0, descNeedsReview: 0, descOutdated: 0 }],
        capped: false,
        contentHash: "h",
        extractorVersion: 1,
      }),
    });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "x");
    await store.onStoreDocument(n.id, doc);
    expect(await noteStateVersion(db, n.id)).toBe(1);
    expect(await knowledgeRows(db, n.id)).toEqual([]);
    const w = warns.filter((x) => x.msg.startsWith("knowledge index update failed"));
    expect(w).toHaveLength(1);
    expect(w[0]!.obj).toMatchObject({ code: "23514", constraint: "nk_knowledge_id_chk" });
    expect(JSON.stringify(warns)).not.toContain("alice-secret-71b2");
  });
});

describe("hostile and huge documents", () => {
  it("WS sends 5000 levels deep, NUL in when, a 300 000-char conclusion, 2001 knowledge headings and duplicate ids -> persist succeeds, the doc unloads, 2000 rows and capped", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "k4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("k4@example.com", PASSWORD);
    const client = await session.connect(note.id);
    client.doc.transact(() => {
      writeHeading(client.doc, "first", "First", { knowledgeId: kid(1), knowledgeWhen: "nul\u0000and\uD800lone", knowledgeConclusion: "c".repeat(300_000) });
      const group = client.doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
      let parent = group.get(0) as Y.XmlElement;
      for (let i = 0; i < 5000; i += 1) {
        const child = new Y.XmlElement("blockContainer");
        parent.insert(parent.length, [child]);
        parent = child;
      }
      for (let i = 0; i < KNOWLEDGE_INDEX_NOTE_MAX + 1; i += 1) writeHeading(client.doc, `h${i}`, `head ${i}`, { knowledgeId: kid(i + 2), knowledgeWhen: `w${i}` });
      writeHeading(client.doc, "dup", "Duplicate", { knowledgeId: kid(1), knowledgeWhen: "duplicate" });
    });
    await waitKnowledge(ctx.db, note.id, (w) => w.length === KNOWLEDGE_INDEX_NOTE_MAX, 30_000);
    client.disconnect();
    await waitFor("document unload", 15_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const rows = await knowledgeRows(ctx.db, note.id);
    expect(rows).toHaveLength(KNOWLEDGE_INDEX_NOTE_MAX);
    expect(rows[0]).toMatchObject({ knowledgeId: kid(1) });
    expect(rows[0]!.readWhen).toBe("nul�and�lone");
    expect(rows[0]!.conclusion.length).toBe(300);
    expect(rows.map((r) => r.knowledgeId)).toEqual([...new Set(rows.map((r) => r.knowledgeId))]);
    expect(rows.some((r) => r.readWhen === "duplicate")).toBe(false);
    expect((await knowledgeState(ctx.db, note.id))!.capped).toBe(true);
  });
});

describe("calling createNoteStore directly, deterministic", () => {
  async function storeWithCounters() {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const calls = { index: 0, bump: 0 };
    const { log, warns } = captureLog();
    const store = createNoteStore({
      db,
      log,
      knowledgeIndexer: (id, v, e) => {
        calls.index += 1;
        return writeKnowledgeIndex(db, id, v, e);
      },
      knowledgeBumper: (id, v, h) => {
        calls.bump += 1;
        return bumpKnowledgeIndexVersion(db, id, v, h);
      },
    });
    return { db, n, calls, store, warns };
  }

  it("same content persisted twice -> the second opens no index transaction and only bumps; afterUnloadDocument clears the cache", async () => {
    const { db, n, calls, store } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeHeading(doc, "h", "H", kprops(kid(1), "cached"));
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 0 });
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 1 });
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(2);
    store.afterUnloadDocument(n.id);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 1 });
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(3);
  });

  it("a note without knowledge costs no knowledge query after its first store (neither a bump nor a transaction)", async () => {
    const { db, n, calls, store } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeParagraph(doc, "p", "plain one");
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 0 });
    writeParagraph(doc, "q", "plain two");
    await store.onStoreDocument(n.id, doc);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 0 });
    expect(await knowledgeState(db, n.id)).toMatchObject({ entries: 0, sourceVersion: 1 });
  });

  it("bump hits 0 rows -> the same persist switches to a full write, then back to bump", async () => {
    const { db, n, calls, store } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeHeading(doc, "h", "H", kprops(kid(1), "heal"));
    await store.onStoreDocument(n.id, doc);
    const goodHash = (await knowledgeState(db, n.id))!.contentHash;
    await db.execute(sql`update note_knowledge_state set content_hash = 'other' where note_id = ${n.id}::uuid`);
    await db.execute(sql`update note_knowledge set read_when = 'stale' where note_id = ${n.id}::uuid`);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 1 });
    expect((await knowledgeState(db, n.id))!.contentHash).toBe(goodHash);
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["heal"]);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 2 });
  });

  it("new knowledge added to the doc after persist but before indexing -> indexed content is the persisted snapshot", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const store = createNoteStore({
      db,
      afterPersistForTest: async (_id, d) => {
        writeHeading(d, "late", "Late", kprops(kid(9), "LATEWORD"));
      },
    });
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeHeading(doc, "h", "H", kprops(kid(1), "persisted"));
    await store.onStoreDocument(n.id, doc);
    expect((await knowledgeRows(db, n.id)).map((r) => r.readWhen)).toEqual(["persisted"]);
    expect((await knowledgeState(db, n.id))!.sourceVersion).toBe(await noteStateVersion(db, n.id));
  });

  it("note already deleted at persist time -> the knowledge indexer is not called, no warn, cache cleared too", async () => {
    const { db, n, calls, store, warns } = await storeWithCounters();
    const doc = new Y.Doc();
    await store.onLoadDocument(n.id, doc);
    writeHeading(doc, "h", "H", kprops(kid(1), "x"));
    await store.onStoreDocument(n.id, doc);
    expect(calls.index).toBe(1);
    const [noteRow] = await db.select().from(notes).where(eq(notes.id, n.id));
    await db.delete(notes).where(eq(notes.id, n.id));
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 1, bump: 0 });
    expect(warns).toEqual([]);
    await db.insert(notes).values(noteRow!);
    await store.onStoreDocument(n.id, doc);
    expect(calls).toEqual({ index: 2, bump: 0 });
  });
});
