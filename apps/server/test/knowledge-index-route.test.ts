import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { KNOWLEDGE_INDEX_MAX, type KnowledgeIndexDto, type NoteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteTags, notes, tags } from "../src/db/schema.js";
import { loadKnowledgeIndex } from "../src/knowledge/index-query.js";
import { resolveKnowledgeScope } from "../src/knowledge/scope.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { markRestored, markTrashed } from "./trash-helpers.js";
import { seedNoteState, setNoteState } from "./search-helpers.js";
import { kh, kid, knowledgeDoc, seedKnowledgeNote } from "./knowledge-helpers.js";
import { writeKnowledgeIndex, extractKnowledgeForIndex } from "../src/knowledge/index-write.js";

async function ctx() {
  const c = await buildTestApp();
  return { ...c, pool: c.db.$client as Pool };
}

const NOT_FOUND = "No folder or group with that id.";
const UNKNOWN = "00000000-0000-4000-8000-00000000dead";

async function getIndex(app: FastifyInstance, userId: string, path: string, qs = "") {
  return app.inject({ method: "GET", url: `/api/knowledge/index/${path}${qs}`, cookies: await cookieOf(userId) });
}
async function okIndex(app: FastifyInstance, userId: string, path: string, qs = ""): Promise<KnowledgeIndexDto> {
  const res = await getIndex(app, userId, path, qs);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as KnowledgeIndexDto;
}
const titles = (dto: KnowledgeIndexDto): string[] => dto.notes.map(n => n.title).sort();
const knowledgeIds = (dto: KnowledgeIndexDto): string[] => dto.entries.map(e => e.knowledgeId).sort();
const one = (id: number, extra: Parameters<typeof kh>[3] = {}) => [kh(`b${id}`, kid(id), `Heading ${id}`, { level: 1, ...extra })];

describe("unauthenticated", () => {
  it("no session -> 401 on every index route", async () => {
    const { app } = await ctx();
    for (const path of ["me", `groups/${UNKNOWN}`, `folders/${UNKNOWN}`]) {
      expect((await app.inject({ method: "GET", url: `/api/knowledge/index/${path}` })).statusCode, path).toBe(401);
    }
  });
});

describe("who can open which index", () => {
  it("anyone gets their own /me; a group member whose role can read gets the group index", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "Research", [{ userId: alice.id, role: "member" }]);
    const me = await okIndex(app, bob.id, "me");
    expect(me.scope).toEqual({ kind: "personal", groupId: null, groupName: null, folderId: null, folderPath: [] });
    expect(me.entries).toEqual([]);
    const grp = await okIndex(app, alice.id, `groups/${g.id}`);
    expect(grp.scope).toEqual({ kind: "group", groupId: g.id, groupName: "Research", folderId: null, folderPath: [] });
  });

  it("a non-member, a member whose role can't read, a site admin who isn't a member, a malformed id and an unknown id all get 404 not_found with the same body", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const outsider = await seedUser(db);
    const blocked = await seedUser(db);
    const siteAdmin = await seedUser(db, { isAdmin: true });
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }, { userId: blocked.id, role: "member" }]);
    await seedKnowledgeNote(db, { groupId: g.id }, "Group note", one(1));
    const noRead = await seedRole(db, g.id, "none", {});
    await setMemberRole(db, g.id, blocked.id, noRead);
    const bodies: string[] = [];
    for (const [who, id] of [[outsider, g.id], [blocked, g.id], [siteAdmin, g.id], [alice, "not-a-uuid"], [alice, UNKNOWN], [alice, g.id.toUpperCase().slice(0, 35)]] as const) {
      const res = await getIndex(app, who.id, `groups/${id}`);
      expect(res.statusCode, `${who.id} ${id}`).toBe(404);
      expect(res.json()).toEqual({ error: { code: "not_found", message: NOT_FOUND } });
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await getIndex(app, alice.id, `groups/${g.id}`)).statusCode).toBe(200);
  });

  it("a folder you can't see, another user's personal folder, your own Shared with me folder and a malformed folder id (404, not 500) are 404", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: bob.id, role: "member" }]);
    const bobFolder = await seedFolder(db, { personal: bob.id });
    const groupFolder = await seedFolder(db, { group: g.id });
    const aliceShared = await seedFolder(db, { shared: alice.id });
    const aliceOwn = await seedFolder(db, { personal: alice.id });
    const bodies: string[] = [];
    for (const id of [bobFolder.id, groupFolder.id, aliceShared.id, "x", `${UNKNOWN}`, "'; select 1 --"]) {
      const res = await getIndex(app, alice.id, `folders/${encodeURIComponent(id)}`);
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toEqual({ error: { code: "not_found", message: NOT_FOUND } });
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await getIndex(app, alice.id, `folders/${aliceOwn.id}`)).statusCode).toBe(200);
    expect((await getIndex(app, bob.id, `folders/${groupFolder.id}`)).statusCode).toBe(200);
  });

  it("access that comes only from a share opens nothing: the sharee can't read the owner's space index, folder index or neighbours through it", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const bobFolder = await seedFolder(db, { personal: bob.id });
    const shared = await seedKnowledgeNote(db, { ownerId: bob.id }, "Shared with alice", one(1), { folderId: bobFolder.id });
    await seedKnowledgeNote(db, { ownerId: bob.id }, "Bob private", one(2), { folderId: bobFolder.id });
    await seedShare(db, shared.id, alice.id, "viewer");
    expect((await getIndex(app, alice.id, `folders/${bobFolder.id}`)).statusCode).toBe(404);
    expect(await okIndex(app, alice.id, "me")).toMatchObject({ notes: [], entries: [] });
    expect(titles(await okIndex(app, bob.id, "me"))).toEqual(["Bob private", "Shared with alice"]);
  });
});

describe("what is listed", () => {
  it("/me lists your own notes' knowledge and not notes shared with you, nor group notes", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Alice own", one(1));
    const shared = await seedKnowledgeNote(db, { ownerId: bob.id }, "Bob shared", one(2));
    await seedShare(db, shared.id, alice.id, "editor");
    await seedKnowledgeNote(db, { groupId: g.id }, "Group note", one(3));
    const dto = await okIndex(app, alice.id, "me");
    expect(titles(dto)).toEqual(["Alice own"]);
    expect(knowledgeIds(dto)).toEqual([kid(1)]);
  });

  it("the group index lists every group note's knowledge for a reader", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }, { userId: bob.id, role: "member" }]);
    await seedKnowledgeNote(db, { groupId: g.id }, "G one", one(1));
    await seedKnowledgeNote(db, { groupId: g.id }, "G two", one(2));
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Personal", one(3));
    for (const who of [alice, bob]) expect(titles(await okIndex(app, who.id, `groups/${g.id}`))).toEqual(["G one", "G two"]);
  });

  it("a folder index includes notes in nested subfolders and not in sibling folders; a note moved out of the folder leaves it", async () => {
    const { app, db, pool } = await ctx();
    const alice = await seedUser(db);
    const top = await seedFolder(db, { personal: alice.id }, { name: "top" });
    const sub = await seedFolder(db, { personal: alice.id }, { name: "sub", parentId: top.id });
    const sibling = await seedFolder(db, { personal: alice.id }, { name: "sibling" });
    await seedKnowledgeNote(db, { ownerId: alice.id }, "In top", one(1), { folderId: top.id });
    const deep = await seedKnowledgeNote(db, { ownerId: alice.id }, "In sub", one(2), { folderId: sub.id });
    await seedKnowledgeNote(db, { ownerId: alice.id }, "In sibling", one(3), { folderId: sibling.id });
    await seedKnowledgeNote(db, { ownerId: alice.id }, "At root", one(4));
    const dto = await okIndex(app, alice.id, `folders/${top.id}`);
    expect(titles(dto)).toEqual(["In sub", "In top"]);
    expect(dto.scope).toMatchObject({ kind: "folder", folderId: top.id, groupId: null, folderPath: ["top"] });
    await pool.query("update notes set folder_id = $2 where id = $1", [deep.id, sibling.id]);
    expect(titles(await okIndex(app, alice.id, `folders/${top.id}`))).toEqual(["In top"]);
  });

  it("a group folder index lists the group folder's notes for a member and names the group", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Team", [{ userId: alice.id, role: "member" }]);
    const f = await seedFolder(db, { group: g.id }, { name: "plans" });
    await seedKnowledgeNote(db, { groupId: g.id }, "Plan", one(1), { folderId: f.id });
    await seedKnowledgeNote(db, { groupId: g.id }, "Elsewhere", one(2));
    const dto = await okIndex(app, alice.id, `folders/${f.id}`);
    expect(titles(dto)).toEqual(["Plan"]);
    expect(dto.scope).toMatchObject({ kind: "folder", groupId: g.id, groupName: "Team", folderPath: ["plans"] });
  });

  it("a trashed note's knowledge isn't listed and comes back on restore; a permanently deleted note's rows are gone", async () => {
    const { app, db, pool } = await ctx();
    const alice = await seedUser(db);
    const keep = await seedKnowledgeNote(db, { ownerId: alice.id }, "Keep", one(1));
    const gone = await seedKnowledgeNote(db, { ownerId: alice.id }, "Gone", one(2));
    await markTrashed(pool, gone.id, alice.id);
    expect(titles(await okIndex(app, alice.id, "me"))).toEqual(["Keep"]);
    await markRestored(pool, gone.id);
    expect(titles(await okIndex(app, alice.id, "me"))).toEqual(["Gone", "Keep"]);
    await db.delete(notes).where(sql`${notes.id} = ${gone.id}`);
    const after = await okIndex(app, alice.id, "me");
    expect(titles(after)).toEqual(["Keep"]);
    expect((await pool.query("select count(*)::int as n from note_knowledge where note_id = $1", [gone.id])).rows[0].n).toBe(0);
    expect(keep.id).toBeTruthy();
  });

  it("a note moved into a group moves from /me to the group index", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const n = await seedKnowledgeNote(db, { ownerId: alice.id }, "Mover", one(1));
    expect(titles(await okIndex(app, alice.id, "me"))).toEqual(["Mover"]);
    await db.update(notes).set({ ownerId: null, groupId: g.id }).where(sql`${notes.id} = ${n.id}`);
    expect(titles(await okIndex(app, alice.id, "me"))).toEqual([]);
    expect(titles(await okIndex(app, alice.id, `groups/${g.id}`))).toEqual(["Mover"]);
  });

  it("entries carry when, conclusion, evidence, verified, status, icon, parentKnowledgeId and summary; notes carry path, folderId and tags", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db, { displayName: "Alice" });
    const f = await seedFolder(db, { personal: alice.id }, { name: "plans" });
    const n = await seedKnowledgeNote(
      db,
      { ownerId: alice.id },
      "Deploy notes",
      [
        kh("p", kid(1), "Parent", { level: 1, when: "Deploying", conclusion: "Use blue-green", evidence: "tested", verified: "2026-01-02" }),
        kh("c", kid(2), "Child", { level: 2, status: "unverified" }),
      ],
      { folderId: f.id },
    );
    const [tag] = await db.insert(tags).values({ ownerId: alice.id, name: "ops", color: "blue" }).returning({ id: tags.id });
    await db.insert(noteTags).values({ noteId: n.id, tagId: tag!.id });
    const dto = await okIndex(app, alice.id, "me");
    expect(dto.notes).toEqual([{ id: n.id, title: "Deploy notes", path: expect.stringMatching(new RegExp(`^/.*${n.slug}`)), folderId: f.id, tags: [{ id: tag!.id, name: "ops", color: "blue" }] }]);
    const [parent, child] = dto.entries;
    expect(parent).toEqual({
      noteId: n.id, knowledgeId: kid(1), blockId: "p", ord: 0, level: 1, heading: "Parent", when: "Deploying", conclusion: "Use blue-green",
      evidence: "tested", verified: "2026-01-02", status: "", icon: "verified", parentKnowledgeId: null, supersededBy: null,
      summary: { total: 1, verified: 0, noVerifiedDate: 0, needsReview: 1, outdated: 0 },
    });
    expect(child).toMatchObject({ knowledgeId: kid(2), parentKnowledgeId: kid(1), status: "unverified", icon: "needsReview", verified: null, summary: null });
    expect(dto.tagOptions).toEqual([{ id: tag!.id, name: "ops", color: "blue" }]);
  });

  it("folders lists the scope subtree with parent ids", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const top = await seedFolder(db, { personal: alice.id }, { name: "top" });
    const sub = await seedFolder(db, { personal: alice.id }, { name: "sub", parentId: top.id });
    const other = await seedFolder(db, { personal: alice.id }, { name: "other" });
    const inFolder = await okIndex(app, alice.id, `folders/${top.id}`);
    expect([...inFolder.folders].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { id: sub.id, name: "sub", parentId: top.id },
      { id: top.id, name: "top", parentId: null },
    ]);
    const space = await okIndex(app, alice.id, "me");
    expect(space.folders.map(f => f.id).sort()).toEqual([other.id, sub.id, top.id].sort());
  });
});

describe("filters", () => {
  const blocks = [
    kh("a", kid(1), "A", { level: 1, verified: "2026-01-01", evidence: "tested" }),
    kh("b", kid(2), "B", { level: 1, status: "unverified", verified: "2026-01-01", evidence: "docs" }),
    kh("c", kid(3), "C", { level: 1 }),
    kh("d", kid(4), "D", { level: 1, status: "outdated", evidence: "inferred", supersededBy: kid(1) }),
    kh("e", kid(5), "E", { level: 2, verified: "2026-01-01" }),
  ];
  async function setup() {
    const c = await ctx();
    const alice = await seedUser(c.db);
    const n = await seedKnowledgeNote(c.db, { ownerId: alice.id }, "Filtered", blocks);
    const plain = await seedKnowledgeNote(c.db, { ownerId: alice.id }, "Plain", one(9));
    return { ...c, alice, n, plain };
  }

  it("tags=a,b keeps only notes having both; an unknown tag id gives no entries but still returns tagOptions", async () => {
    const { app, db, alice, n, plain } = await setup();
    const [ta, tb] = (await db.insert(tags).values([{ ownerId: alice.id, name: "a", color: "blue" }, { ownerId: alice.id, name: "B", color: "green" }]).returning({ id: tags.id })).map(r => r.id);
    await db.insert(noteTags).values([{ noteId: n.id, tagId: ta! }, { noteId: n.id, tagId: tb! }, { noteId: plain.id, tagId: ta! }]);
    expect(titles(await okIndex(app, alice.id, "me", `?tags=${ta},${tb}`))).toEqual(["Filtered"]);
    expect(titles(await okIndex(app, alice.id, "me", `?tags=${ta!.toUpperCase()},${ta}`))).toEqual(["Filtered", "Plain"]);
    const none = await okIndex(app, alice.id, "me", `?tags=${UNKNOWN}`);
    expect(none.entries).toEqual([]);
    expect(none.notes).toEqual([]);
    expect(none.tagOptions.map(t => t.name)).toEqual(["a", "B"]);
  });

  it("status=needsReview, noVerifiedDate and outdated keep only that icon kind, inherited outdated included", async () => {
    const { app, alice } = await setup();
    const q = async (status: string) => knowledgeIds(await okIndex(app, alice.id, "me", `?status=${status}`)).filter(id => id !== kid(9));
    expect(await q("needsReview")).toEqual([kid(2)]);
    expect(await q("noVerifiedDate")).toEqual([kid(3)]);
    expect(await q("outdated")).toEqual([kid(4), kid(5)]);
  });

  it("evidence=unconfirmed keeps entries with empty evidence; tested keeps tested", async () => {
    const { app, alice } = await setup();
    const q = async (evidence: string) => knowledgeIds(await okIndex(app, alice.id, "me", `?evidence=${evidence}`));
    expect(await q("tested")).toEqual([kid(1)]);
    expect(await q("docs")).toEqual([kid(2)]);
    expect(await q("unconfirmed")).toEqual([kid(3), kid(5), kid(9)]);
    expect(knowledgeIds(await okIndex(app, alice.id, "me", "?status=outdated&evidence=unconfirmed"))).toEqual([kid(5)]);
  });

  it("bad status, bad evidence, 21 tags, a non-uuid tag and an unknown key are 400 invalid_body", async () => {
    const { app, alice } = await setup();
    const tooMany = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    const twenty = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
    for (const qs of ["?status=verified", "?status=", "?evidence=guess", `?tags=${tooMany}`, "?tags=not-a-uuid", `?tags=${UNKNOWN},`, "?foo=1", "?status=outdated&status=outdated"]) {
      const res = await getIndex(app, alice.id, "me", qs);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error.code, qs).toBe("invalid_body");
    }
    expect((await getIndex(app, alice.id, "me", `?tags=${twenty}`)).statusCode).toBe(200);
    expect((await getIndex(app, alice.id, `folders/${UNKNOWN}`, "?foo=1")).statusCode).toBe(400);
  });

  it("tagOptions lists tags of notes with knowledge in the scope, ignoring the filters, and leaves out cross-space note_tags rows", async () => {
    const { app, db, alice, n, plain } = await setup();
    const bob = await seedUser(db);
    const bare = await seedNote(db, { ownerId: alice.id }, { title: "No knowledge" });
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const [b, a, c, other, groupTag] = (
      await db
        .insert(tags)
        .values([
          { ownerId: alice.id, name: "beta", color: "blue" },
          { ownerId: alice.id, name: "Alpha", color: "red" },
          { ownerId: alice.id, name: "only-on-bare", color: "gray" },
          { ownerId: bob.id, name: "bobs", color: "green" },
          { groupId: g.id, name: "grp", color: "green" },
        ])
        .returning({ id: tags.id })
    ).map(r => r.id);
    await db.insert(noteTags).values([
      { noteId: n.id, tagId: b! },
      { noteId: plain.id, tagId: a! },
      { noteId: bare.id, tagId: c! },
      { noteId: n.id, tagId: other! },
      { noteId: n.id, tagId: groupTag! },
    ]);
    const dto = await okIndex(app, alice.id, "me", `?tags=${b}&status=outdated`);
    expect(dto.tagOptions.map(t => t.name)).toEqual(["Alpha", "beta"]);
  });
});

describe("limits and backfill", () => {
  const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
  async function insertMany(pool: Pool, noteId: string, count: number, icon = "verified"): Promise<void> {
    await pool.query(
      `insert into note_knowledge (note_id, knowledge_id, block_id, ord, level, heading, read_when, conclusion, evidence, status, icon)
       select $1::uuid, 'k_' || lpad(to_hex(g), 8, '0'), 'b' || g, g - 1, 1, 'H' || g, 'w' || g, 'c', '', '', $3::text from generate_series(1, $2::int) g`,
      [noteId, count, icon],
    );
    await pool.query(
      `insert into note_knowledge_state (note_id, extractor_version, source_version, content_hash, entries, capped) values ($1::uuid, 1, 1, 'x', $2::int, false)`,
      [noteId, count],
    );
  }

  it("over KNOWLEDGE_INDEX_MAX entries -> truncated, at most MAX entries, no note cut in half, and the kept notes are the first ones in the folder display order (root notes, then folders by name), not by note id", async () => {
    const { app, db, pool } = await ctx();
    const alice = await seedUser(db);
    const fa = await seedFolder(db, { personal: alice.id }, { name: "a-folder" });
    const fb = await seedFolder(db, { personal: alice.id }, { name: "b-folder" });
    // Display order: r-a, r-b (root, by title), then a-folder's n-a, then b-folder's n-b, n-b2; note ids run in the opposite direction.
    const layout: Array<[string, string, string | null]> = [
      [ids[4]!, "r-a", null], [ids[3]!, "r-b", null], [ids[2]!, "n-a", fa.id], [ids[1]!, "n-b", fb.id], [ids[0]!, "n-b2", fb.id],
    ];
    for (const [id, title, folderId] of layout) {
      await seedNote(db, { ownerId: alice.id }, { id, title });
      if (folderId !== null) await pool.query("update notes set folder_id = $2 where id = $1", [id, folderId]);
      await insertMany(pool, id, 2000);
    }
    const dto = await okIndex(app, alice.id, "me");
    expect(dto.truncated).toBe(true);
    expect(dto.entries.length).toBe(4000);
    expect(dto.entries.length).toBeLessThanOrEqual(KNOWLEDGE_INDEX_MAX);
    expect(dto.notes.map(n => n.title)).toEqual(["r-a", "r-b"]);
    const perNote = new Map<string, number>();
    for (const e of dto.entries) perNote.set(e.noteId, (perNote.get(e.noteId) ?? 0) + 1);
    expect([...perNote.values()]).toEqual([2000, 2000]);
  });

  it("a filter brings back entries that the unfiltered truncated answer left out", async () => {
    const { app, db, pool } = await ctx();
    const alice = await seedUser(db);
    for (const [i, id] of ids.entries()) {
      await seedNote(db, { ownerId: alice.id }, { id, title: `n-${i}` });
      await insertMany(pool, id, 2000);
    }
    await pool.query("update note_knowledge set icon = 'outdated' where note_id = $1 and ord < 3", [ids[4]]);
    const all = await okIndex(app, alice.id, "me");
    expect(all.truncated).toBe(true);
    expect(all.notes.map(n => n.title)).not.toContain("n-4");
    const filtered = await okIndex(app, alice.id, "me", "?status=outdated");
    expect(filtered.truncated).toBe(false);
    expect(filtered.notes.map(n => n.title)).toEqual(["n-4"]);
    expect(filtered.entries.length).toBe(3);
  });

  it("backfillPending is true while a note in scope has no state row or an old extractor version, and false when only source_version lags", async () => {
    const { app, db, pool } = await ctx();
    const alice = await seedUser(db);
    const n = await seedNote(db, { ownerId: alice.id }, { title: "Pending" });
    expect((await okIndex(app, alice.id, "me")).backfillPending, "no note_states row: never opened").toBe(false);
    const doc = knowledgeDoc(one(1));
    await seedNoteState(db, n.id, doc, 1);
    expect((await okIndex(app, alice.id, "me")).backfillPending, "opened, not indexed").toBe(true);
    expect(await writeKnowledgeIndex(db, n.id, 1, extractKnowledgeForIndex(doc))).toBe("written");
    expect((await okIndex(app, alice.id, "me")).backfillPending).toBe(false);
    await setNoteState(db, n.id, doc, 2);
    expect((await okIndex(app, alice.id, "me")).backfillPending, "only source_version lags").toBe(false);
    await pool.query("update note_knowledge_state set extractor_version = 0 where note_id = $1", [n.id]);
    expect((await okIndex(app, alice.id, "me")).backfillPending).toBe(true);
  });

  it("backfillPending only looks at notes in scope and visible to the viewer", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const f = await seedFolder(db, { personal: alice.id });
    const theirs = await seedNote(db, { ownerId: bob.id });
    await seedNoteState(db, theirs.id, knowledgeDoc(one(1)), 1);
    const inGroup = await seedNote(db, { groupId: g.id });
    await seedNoteState(db, inGroup.id, knowledgeDoc(one(2)), 1);
    expect((await okIndex(app, alice.id, "me")).backfillPending).toBe(false);
    expect((await okIndex(app, alice.id, `folders/${f.id}`)).backfillPending).toBe(false);
    expect((await okIndex(app, alice.id, `groups/${g.id}`)).backfillPending).toBe(true);
  });
});

describe("replacements", () => {
  const outdated = (id: number, ref: string) => kh(`b${id}`, kid(id), `Old ${id}`, { level: 1, status: "outdated", supersededBy: ref });

  it("a same-note ref and a visible other-note ref resolve with heading, note title and path", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const target = await seedKnowledgeNote(db, { ownerId: alice.id }, "Target note", [kh("t", kid(20), "New way", { level: 1 })]);
    const n = await seedKnowledgeNote(db, { ownerId: alice.id }, "Source", [outdated(1, kid(2)), kh("b2", kid(2), "Newer here", { level: 1 }), outdated(3, `${target.id}#${kid(20)}`)]);
    const dto = await okIndex(app, alice.id, "me");
    const byId = new Map(dto.entries.map(e => [e.knowledgeId, e]));
    expect(byId.get(kid(1))!.supersededBy).toBe(`${n.id}#${kid(2)}`);
    expect(byId.get(kid(3))!.supersededBy).toBe(`${target.id}#${kid(20)}`);
    expect(dto.replacements[`${n.id}#${kid(2)}`]).toEqual({ noteId: n.id, knowledgeId: kid(2), blockId: "b2", heading: "Newer here", noteTitle: "Source", path: expect.stringContaining(n.slug) });
    expect(dto.replacements[`${target.id}#${kid(20)}`]).toMatchObject({ heading: "New way", noteTitle: "Target note", blockId: "t" });
  });

  it("a ref naming the row's own note id is the same note as a ref without a note id", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const n = await seedKnowledgeNote(db, { ownerId: alice.id }, "Self", [kh("b1", kid(1), "Old", { level: 1, status: "outdated" }), kh("b2", kid(2), "New", { level: 1 })]);
    await db.execute(sql`update note_knowledge set superseded_note_id = ${n.id}::uuid, superseded_knowledge_id = ${kid(2)} where note_id = ${n.id}::uuid and knowledge_id = ${kid(1)}`);
    const withOwn = await okIndex(app, alice.id, "me");
    await db.execute(sql`update note_knowledge set superseded_note_id = null where note_id = ${n.id}::uuid and knowledge_id = ${kid(1)}`);
    const withNull = await okIndex(app, alice.id, "me");
    expect(withOwn).toEqual(withNull);
    expect(withNull.entries[0]!.supersededBy).toBe(`${n.id}#${kid(2)}`);
    expect(Object.keys(withNull.replacements)).toEqual([`${n.id}#${kid(2)}`]);
  });

  it("a row whose own status isn't outdated has supersededBy null and its stored ref isn't looked up, even when superseded_knowledge_id is set", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Source", [kh("b1", kid(1), "Current", { level: 1, supersededBy: kid(2) }), kh("b2", kid(2), "Other", { level: 1 })]);
    const dto = await okIndex(app, alice.id, "me");
    expect(dto.entries.map(e => e.supersededBy)).toEqual([null, null]);
    expect(dto.replacements).toEqual({});
  });

  it("a ref to a note the viewer can't see isn't in replacements and its heading isn't anywhere in the response body", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const hidden = await seedKnowledgeNote(db, { ownerId: bob.id }, "bob-secret-title-77aa", [kh("t", kid(20), "bob-secret-heading-4d1e", { level: 1 })]);
    const g = await seedGroup(db, "Other", [{ userId: bob.id, role: "admin" }]);
    const inGroup = await seedKnowledgeNote(db, { groupId: g.id }, "group-secret-title-31c2", [kh("t", kid(21), "group-secret-heading-9b0f", { level: 1 })]);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Source", [kh("b1", kid(1), "Old a", { level: 1, status: "outdated", supersededBy: `${hidden.id}#${kid(20)}` }), kh("b2", kid(2), "Old b", { level: 1, status: "outdated", supersededBy: `${inGroup.id}#${kid(21)}` })]);
    const res = await getIndex(app, alice.id, "me");
    expect(res.statusCode).toBe(200);
    expect(res.json().replacements).toEqual({});
    for (const secret of ["bob-secret", "group-secret", "4d1e", "9b0f"]) expect(res.body).not.toContain(secret);
  });

  it("an unreadable ref looks exactly like a missing one: same replacements and same shape of entry", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const hidden = await seedKnowledgeNote(db, { ownerId: bob.id }, "Hidden", [kh("t", kid(20), "Secret", { level: 1 })]);
    const mk = (ref: string) => [kh("b1", kid(1), "Old", { level: 1, status: "outdated", supersededBy: ref })];
    const a = await seedKnowledgeNote(db, { ownerId: alice.id }, "A", mk(`${hidden.id}#${kid(20)}`));
    const b = await seedKnowledgeNote(db, { ownerId: alice.id }, "B", mk(`${UNKNOWN}#${kid(20)}`));
    const dto = await okIndex(app, alice.id, "me");
    expect(dto.replacements).toEqual({});
    const refs = Object.fromEntries(dto.entries.map(e => [e.noteId, e.supersededBy]));
    expect(refs[a.id]).toBe(`${hidden.id}#${kid(20)}`);
    expect(refs[b.id]).toBe(`${UNKNOWN}#${kid(20)}`);
  });

  it("a ref to a trashed note, or to a knowledge id that doesn't exist, isn't in replacements", async () => {
    const { app, db, pool } = await ctx();
    const alice = await seedUser(db);
    const target = await seedKnowledgeNote(db, { ownerId: alice.id }, "Target", [kh("t", kid(20), "T", { level: 1 })]);
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Source", [kh("b1", kid(1), "Old a", { level: 1, status: "outdated", supersededBy: `${target.id}#${kid(20)}` }), kh("b2", kid(2), "Old b", { level: 1, status: "outdated", supersededBy: `${target.id}#${kid(99)}` }), kh("b3", kid(3), "Old c", { level: 1, status: "outdated", supersededBy: kid(98) })]);
    expect(Object.keys((await okIndex(app, alice.id, "me")).replacements)).toEqual([`${target.id}#${kid(20)}`]);
    await markTrashed(pool, target.id, alice.id);
    expect((await okIndex(app, alice.id, "me")).replacements).toEqual({});
  });

  it("a note shared with the viewer is a visible replacement target", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const shared = await seedKnowledgeNote(db, { ownerId: bob.id }, "Bob shared", [kh("t", kid(20), "Shared heading", { level: 1 })]);
    await seedShare(db, shared.id, alice.id, "viewer");
    await seedKnowledgeNote(db, { ownerId: alice.id }, "Source", [kh("b1", kid(1), "Old", { level: 1, status: "outdated", supersededBy: `${shared.id}#${kid(20)}` })]);
    const dto = await okIndex(app, alice.id, "me");
    expect(dto.replacements[`${shared.id}#${kid(20)}`]).toMatchObject({ heading: "Shared heading", noteTitle: "Bob shared" });
    expect(dto.notes.map(n => n.title)).toEqual(["Source"]);
  });
});

describe("GET /api/notes hasKnowledge", () => {
  it("true for a note with knowledge rows, false otherwise; GET /api/notes/:id has no hasKnowledge key", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const withK = await seedKnowledgeNote(db, { ownerId: alice.id }, "With", one(1));
    const without = await seedNote(db, { ownerId: alice.id }, { title: "Without" });
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const groupWith = await seedKnowledgeNote(db, { groupId: g.id }, "Group with", one(2));
    const cookies = await cookieOf(alice.id);
    const list = (await app.inject({ method: "GET", url: "/api/notes", cookies })).json() as NoteDto[];
    expect(new Map(list.map(n => [n.id, n.hasKnowledge]))).toEqual(new Map([[withK.id, true], [without.id, false], [groupWith.id, true]]));
    const single = (await app.inject({ method: "GET", url: `/api/notes/${withK.id}`, cookies })).json();
    expect("hasKnowledge" in single).toBe(false);
  });

  it("a shared note carries the owner's knowledge flag for the sharee as well", async () => {
    const { app, db } = await ctx();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const n = await seedKnowledgeNote(db, { ownerId: bob.id }, "Bob's", one(1));
    await seedShare(db, n.id, alice.id, "viewer");
    const list = (await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(alice.id) })).json() as NoteDto[];
    expect(list.find(x => x.id === n.id)!.hasKnowledge).toBe(true);
  });
});

describe("one snapshot", () => {
  it("the index reads inside a single repeatable read, read only transaction and takes no row lock", async () => {
    const { db, pool } = await ctx();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: alice.id, role: "admin" }]);
    const target = await seedKnowledgeNote(db, { groupId: g.id }, "T", [kh("t", kid(20), "T", { level: 1 })]);
    await seedKnowledgeNote(db, { groupId: g.id }, "S", [kh("b1", kid(1), "Old", { level: 1, status: "outdated", supersededBy: `${target.id}#${kid(20)}` })]);
    const queries: string[] = [];
    const logged = drizzle(pool, { logger: { logQuery: (q: string) => queries.push(q.trim().toLowerCase()) } }) as unknown as Db;
    const scope = await resolveKnowledgeScope(logged, alice.id, { kind: "group", groupId: g.id });
    queries.length = 0;
    const dto = await loadKnowledgeIndex(logged, { userId: alice.id, scope: scope!, filters: { tagIds: [], status: null, evidence: null } });
    expect(Object.keys(dto.replacements)).toHaveLength(1);
    expect(queries[0]).toBe("begin");
    expect(queries[1]).toContain("repeatable read");
    expect(queries[1]).toContain("read only");
    expect(queries.at(-1)).toBe("commit");
    expect(queries.filter(q => q === "begin")).toHaveLength(1);
    expect(queries.filter(q => /for (key share|update|share|no key update)/.test(q))).toEqual([]);
  });
});
