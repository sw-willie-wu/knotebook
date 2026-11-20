/** Tags follow a note when it changes space: a move into a group, a copy, and a group delete that hands its notes to a member. Cases end with no note_tags row whose tag is in another space than its note, except the one that seeds such a row on purpose. */
import { and, asc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { TAG_COLORS, TAGS_PER_SPACE_MAX } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteTags, tags } from "../src/db/schema.js";
import { buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, waitForBlockedOrSettled } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { markTrashed } from "./trash-helpers.js";

function barrier(n: number): () => Promise<void> {
  let count = 0;
  let release!: () => void;
  const open = new Promise<void>(r => { release = r; });
  return async () => {
    count++;
    if (count >= n) release();
    await open;
  };
}
const MANY_NAMES = Array.from({ length: 40 }, (_, i) => `name-${String(i).padStart(2, "0")}`);

type Color = (typeof TAG_COLORS)[number];
type Space = { ownerId: string } | { groupId: string };

const T0 = Date.UTC(2026, 0, 1);

async function seedTag(db: Db, space: Space, name: string, color: Color = "blue"): Promise<string> {
  const [row] = await db.insert(tags).values({ ...space, name, color }).returning({ id: tags.id });
  return row!.id;
}
/** Attaches in the given order with strictly increasing created_at, so order is observable and not the insertion accident of one statement. */
async function attachInOrder(db: Db, noteId: string, tagIds: readonly string[]): Promise<void> {
  await db.insert(noteTags).values(tagIds.map((tagId, i) => ({ noteId, tagId, createdAt: new Date(T0 + i * 5000) })));
}
interface Attached { name: string; color: string; ownerId: string | null; groupId: string | null; tagId: string; createdAt: number }
async function attached(db: Db, noteId: string): Promise<Attached[]> {
  const rows = await db
    .select({ name: tags.name, color: tags.color, ownerId: tags.ownerId, groupId: tags.groupId, tagId: tags.id, createdAt: noteTags.createdAt })
    .from(noteTags)
    .innerJoin(tags, eq(tags.id, noteTags.tagId))
    .where(eq(noteTags.noteId, noteId))
    .orderBy(asc(noteTags.createdAt), asc(tags.id));
  return rows.map(r => ({ ...r, createdAt: r.createdAt.getTime() }));
}
const namesOf = (rows: readonly Attached[]): string[] => rows.map(r => r.name);
async function spaceTagRows(db: Db, space: Space): Promise<Array<{ id: string; name: string; color: string; createdBy: string | null }>> {
  const where = "groupId" in space ? eq(tags.groupId, space.groupId) : eq(tags.ownerId, space.ownerId);
  return db.select({ id: tags.id, name: tags.name, color: tags.color, createdBy: tags.createdBy }).from(tags).where(where);
}
async function crossSpaceRows(db: Db): Promise<number> {
  const res = await db.$client.query<{ n: number }>(
    `select count(*)::int as n from note_tags nt
       join tags t on t.id = nt.tag_id
       join notes n on n.id = nt.note_id
      where t.owner_id is distinct from n.owner_id or t.group_id is distinct from n.group_id`,
  );
  return res.rows[0]!.n;
}
const noteTagCount = async (db: Db): Promise<number> => (await db.$client.query<{ n: number }>("select count(*)::int as n from note_tags")).rows[0]!.n;

const copy = async (app: FastifyInstance, noteId: string, userId: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/copy`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });
const move = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload: { groupId } });
const deleteGroup = async (app: FastifyInstance, groupId: string, userId: string, payload: unknown) =>
  app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

async function mcpCall(app: FastifyInstance, token: string, name: string, args: unknown): Promise<{ isError?: true; structuredContent?: { note?: { id: string } } }> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result;
}

describe("copy", () => {
  it("within the same space the copy has the same tag ids in the same order, with the source's created_at; the source and its neighbours keep their rows", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const [b, a, c] = await Promise.all(["beta", "alpha", "gamma"].map(n => seedTag(db, { ownerId: alice.id }, n)));
    const src = await seedNote(db, { ownerId: alice.id });
    const bystander = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, src.id, [c!, a!, b!]);
    await attachInOrder(db, bystander.id, [a!]);
    const before = await attached(db, src.id);

    const res = await copy(app, src.id, alice.id);

    expect(res.statusCode, res.body).toBe(201);
    const after = await attached(db, res.json().id);
    expect(after.map(r => r.tagId)).toEqual([c, a, b]);
    expect(after.map(r => r.createdAt)).toEqual(before.map(r => r.createdAt));
    expect(await attached(db, src.id)).toEqual(before);
    expect(namesOf(await attached(db, bystander.id))).toEqual(["alpha"]);
    expect((await spaceTagRows(db, { ownerId: alice.id })).length).toBe(3);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("personal into a group creates the group's tags with the source colors and reuses a same-named group tag in another case with its own color and spelling", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const other = await seedGroup(db, "Other", [{ userId: alice.id, role: "member" }]);
    const reading = await seedTag(db, { ownerId: alice.id }, "Reading", "red");
    const work = await seedTag(db, { ownerId: alice.id }, "work", "blue");
    const idea = await seedTag(db, { ownerId: alice.id }, "Idea", "pink");
    const groupWork = await seedTag(db, { groupId: g.id }, "WORK", "green");
    const otherWork = await seedTag(db, { groupId: other.id }, "work", "gray");
    const src = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, src.id, [reading, work, idea]);
    const groupNote = await seedNote(db, { groupId: g.id });
    await attachInOrder(db, groupNote.id, [groupWork]);

    const res = await copy(app, src.id, alice.id, { groupId: g.id });

    expect(res.statusCode, res.body).toBe(201);
    const rows = await attached(db, res.json().id);
    expect(rows.map(r => [r.name, r.color, r.groupId, r.ownerId])).toEqual([
      ["Reading", "red", g.id, null],
      ["WORK", "green", g.id, null],
      ["Idea", "pink", g.id, null],
    ]);
    expect(rows[1]!.tagId).toBe(groupWork);
    const created = (await spaceTagRows(db, { groupId: g.id })).filter(t => t.name !== "WORK");
    expect(created.map(t => t.createdBy)).toEqual([alice.id, alice.id]);
    // Bystanders: the source, the owner's personal tags, another group's same-name tag, the group's own note.
    expect(namesOf(await attached(db, src.id))).toEqual(["Reading", "work", "Idea"]);
    expect((await spaceTagRows(db, { ownerId: alice.id })).length).toBe(3);
    expect((await spaceTagRows(db, { groupId: other.id })).map(t => [t.id, t.name, t.color])).toEqual([[otherWork, "work", "gray"]]);
    expect(namesOf(await attached(db, groupNote.id))).toEqual(["WORK"]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("a group note copied to personal, and a note shared with bob copied into bob's space, carry the tags into the copier's space", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const gTag = await seedTag(db, { groupId: g.id }, "Plan", "orange");
    const gTag2 = await seedTag(db, { groupId: g.id }, "Done", "purple");
    const gNote = await seedNote(db, { groupId: g.id });
    await attachInOrder(db, gNote.id, [gTag2, gTag]);
    const bobPlan = await seedTag(db, { ownerId: alice.id }, "mine", "red");
    const shared = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, shared.id, [bobPlan]);
    await seedShare(db, shared.id, bob.id, "viewer");

    const toPersonal = await copy(app, gNote.id, alice.id);
    expect(toPersonal.statusCode, toPersonal.body).toBe(201);
    const aliceRows = await attached(db, toPersonal.json().id);
    expect(aliceRows.map(r => [r.name, r.color, r.ownerId])).toEqual([["Done", "purple", alice.id], ["Plan", "orange", alice.id]]);

    const toBob = await copy(app, shared.id, bob.id);
    expect(toBob.statusCode, toBob.body).toBe(201);
    expect((await attached(db, toBob.json().id)).map(r => [r.name, r.color, r.ownerId])).toEqual([["mine", "red", bob.id]]);
    // alice's own tag of that name was not touched and bob's tag is a different row.
    expect((await spaceTagRows(db, { ownerId: alice.id })).map(t => t.name).sort()).toEqual(["Done", "Plan", "mine"]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("a role that can create but not edit still carries the tags into the group", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    await setMemberRole(db, g.id, alice.id, await seedRole(db, g.id, "creator", { canRead: true, canCreate: true }));
    const t = await seedTag(db, { ownerId: alice.id }, "carried", "brown");
    const src = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, src.id, [t]);

    const res = await copy(app, src.id, alice.id, { groupId: g.id });

    expect(res.statusCode, res.body).toBe(201);
    expect((await attached(db, res.json().id)).map(r => [r.name, r.groupId])).toEqual([["carried", g.id]]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("works when the target space already has TAGS_PER_SPACE_MAX tags: the carried tag is created anyway", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    await db.insert(tags).values(Array.from({ length: TAGS_PER_SPACE_MAX }, (_, i) => ({ groupId: g.id, name: `filler-${i}`, color: "gray" as const })));
    const t = await seedTag(db, { ownerId: alice.id }, "extra", "red");
    const src = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, src.id, [t]);

    const res = await copy(app, src.id, alice.id, { groupId: g.id });

    expect(res.statusCode, res.body).toBe(201);
    expect(namesOf(await attached(db, res.json().id))).toEqual(["extra"]);
    expect((await spaceTagRows(db, { groupId: g.id })).length).toBe(TAGS_PER_SPACE_MAX + 1);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("a note_tags row left in another space isn't carried", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const mine = await seedTag(db, { ownerId: alice.id }, "mine");
    const stray = await seedTag(db, { groupId: g.id }, "stray");
    const src = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, src.id, [mine, stray]);

    const res = await copy(app, src.id, alice.id);

    expect(res.statusCode, res.body).toBe(201);
    expect(namesOf(await attached(db, res.json().id))).toEqual(["mine"]);
    // Only the seeded stray on the source remains.
    expect(await crossSpaceRows(db)).toBe(1);
  });

  it("MCP copy_note carries tags the same way", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const t1 = await seedTag(db, { ownerId: alice.id }, "one", "red");
    const t2 = await seedTag(db, { ownerId: alice.id }, "two", "pink");
    const src = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, src.id, [t2, t1]);
    const { token } = await seedTokenForUser(db, alice.id, "notes:read notes:write notes:move");

    const same = await mcpCall(app, token, "copy_note", { note_id: src.id });
    expect(same.isError).toBeUndefined();
    expect((await attached(db, same.structuredContent!.note!.id)).map(r => r.tagId)).toEqual([t2, t1]);

    const into = await mcpCall(app, token, "copy_note", { note_id: src.id, group_id: g.id });
    expect(into.isError).toBeUndefined();
    expect((await attached(db, into.structuredContent!.note!.id)).map(r => [r.name, r.color, r.groupId])).toEqual([["two", "pink", g.id], ["one", "red", g.id]]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("a tag-creating copy into a group doesn't deadlock with 'groups FOR UPDATE -> that group's notes FOR UPDATE' (the shape of delete-all)", async () => {
    const holder: { db?: Db; groupId?: string; other?: Promise<string>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        // The first lock point reached: with the groups lock first that is "target-locked" (only groups held); with the source locked first it is "note-copy-locked", and the other side then deadlocks with the copy.
        if ((point !== "note-copy-target-locked" && point !== "note-copy-locked") || holder.other) return;
        holder.other = (async () => {
          const c = await holder.db!.$client.connect();
          try {
            await c.query("begin");
            await c.query("select id from groups where id = $1 for update", [holder.groupId]);
            await c.query("select id from notes where group_id = $1 for update", [holder.groupId]);
            await c.query("commit");
            return "committed";
          } catch (err) {
            await c.query("rollback").catch(() => {});
            return `error ${(err as { code?: string }).code}`;
          } finally {
            c.release();
          }
        })();
        holder.interleave = await waitForBlockedOrSettled(holder.db!.$client, holder.other);
      },
    });
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    Object.assign(holder, { db, groupId: g.id });
    const inGroup = await seedNote(db, { groupId: g.id });
    const groupTag = await seedTag(db, { groupId: g.id }, "shared-name");
    await attachInOrder(db, inGroup.id, [groupTag]);
    const personal = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, personal.id, [await seedTag(db, { ownerId: alice.id }, "fresh")]);

    const res = await copy(app, personal.id, alice.id, { groupId: g.id });

    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode, res.body).toBe(201);
    expect(await holder.other!).toBe("committed");
    expect(namesOf(await attached(db, res.json().id))).toEqual(["fresh"]);
    expect(await crossSpaceRows(db)).toBe(0);
  });
});

describe("move into a group", () => {
  async function scene(db: Db) {
    const alice = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const other = await seedGroup(db, "Other", [{ userId: alice.id, role: "member" }]);
    const y = await seedTag(db, { ownerId: alice.id }, "y", "green");
    const x = await seedTag(db, { ownerId: alice.id }, "x", "blue");
    const z = await seedTag(db, { ownerId: alice.id }, "Zed", "red");
    const groupX = await seedTag(db, { groupId: g.id }, "X", "orange");
    const otherY = await seedTag(db, { groupId: other.id }, "y", "gray");
    const note = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, note.id, [y, x, z]);
    const sibling = await seedNote(db, { ownerId: alice.id });
    await attachInOrder(db, sibling.id, [x]);
    const groupNote = await seedNote(db, { groupId: g.id });
    await attachInOrder(db, groupNote.id, [groupX]);
    return { alice, g, other, note, sibling, groupNote, groupX, otherY, x, y, z };
  }

  it("the note's tags become the group's tags with the same names and order, reusing a same-named group tag; the owner's personal tags and other notes keep theirs", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const before = await attached(db, s.note.id);

    const res = await move(app, s.note.id, s.alice.id, s.g.id);

    expect(res.statusCode, res.body).toBe(200);
    const rows = await attached(db, s.note.id);
    expect(rows.map(r => [r.name, r.color, r.groupId, r.ownerId])).toEqual([
      ["y", "green", s.g.id, null],
      ["X", "orange", s.g.id, null],
      ["Zed", "red", s.g.id, null],
    ]);
    expect(rows[1]!.tagId).toBe(s.groupX);
    // created_at is copied from the source rows, so the order survives the shared now() of one transaction.
    expect(rows.map(r => r.createdAt)).toEqual(before.map(r => r.createdAt));
    expect((await spaceTagRows(db, { groupId: s.g.id })).filter(t => t.name !== "X").map(t => t.createdBy)).toEqual([s.alice.id, s.alice.id]);
    expect((await spaceTagRows(db, { ownerId: s.alice.id })).length).toBe(3);
    expect(namesOf(await attached(db, s.sibling.id))).toEqual(["x"]);
    expect(namesOf(await attached(db, s.groupNote.id))).toEqual(["X"]);
    expect((await spaceTagRows(db, { groupId: s.other.id })).map(t => [t.id, t.color])).toEqual([[s.otherY, "gray"]]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("leaves no row pointing at a tag of the old space, including a stray one", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const stray = await seedTag(db, { groupId: s.other.id }, "stray");
    await db.insert(noteTags).values({ noteId: s.note.id, tagId: stray, createdAt: new Date(T0 + 99_000) });

    const res = await move(app, s.note.id, s.alice.id, s.g.id);

    expect(res.statusCode, res.body).toBe(200);
    expect(namesOf(await attached(db, s.note.id))).toEqual(["y", "X", "Zed"]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("MCP move_note_to_group maps the tags the same way", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const { token } = await seedTokenForUser(db, s.alice.id, "notes:read notes:write notes:move");

    const r = await mcpCall(app, token, "move_note_to_group", { note_id: s.note.id, group_id: s.g.id });

    expect(r.isError).toBeUndefined();
    expect((await attached(db, s.note.id)).map(t => [t.name, t.groupId])).toEqual([["y", s.g.id], ["X", s.g.id], ["Zed", s.g.id]]);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("a note without tags moves as before and creates no tag", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const bare = await seedNote(db, { ownerId: s.alice.id });
    const tagsBefore = (await db.select({ id: tags.id }).from(tags)).length;

    const res = await move(app, bare.id, s.alice.id, s.g.id);

    expect(res.statusCode, res.body).toBe(200);
    expect((await db.select({ id: tags.id }).from(tags)).length).toBe(tagsBefore);
  });

  it("a move that is refused leaves the note's tags where they were", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const stranger = await seedGroup(db, "Closed", []);
    const before = await attached(db, s.note.id);

    const res = await move(app, s.note.id, s.alice.id, stranger.id);

    expect(res.statusCode).toBe(404);
    expect(await attached(db, s.note.id)).toEqual(before);
    expect((await spaceTagRows(db, { groupId: stranger.id })).length).toBe(0);
  });
});

describe("deleting a group and giving its notes to a member", () => {
  it("every group note, trashed ones included, gets the recipient's personal tags by name in the same order; the recipient's existing tag keeps its spelling and color; the group's tags are gone; other spaces are untouched", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const bob = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: admin.id, role: "admin" }, { userId: bob.id, role: "admin" }]);
    const h = await seedGroup(db, "Hedge", [{ userId: bob.id, role: "admin" }]);
    const ga = await seedTag(db, { groupId: g.id }, "alpha", "red");
    const gb = await seedTag(db, { groupId: g.id }, "Beta", "green");
    const gc = await seedTag(db, { groupId: g.id }, "gamma", "pink");
    const hb = await seedTag(db, { groupId: h.id }, "beta", "brown");
    const bobsAlpha = await seedTag(db, { ownerId: bob.id }, "ALPHA", "purple");
    const adminAlpha = await seedTag(db, { ownerId: admin.id }, "alpha", "yellow");
    const live = await seedNote(db, { groupId: g.id });
    const trashed = await seedNote(db, { groupId: g.id });
    const bare = await seedNote(db, { groupId: g.id });
    const hNote = await seedNote(db, { groupId: h.id });
    const bobNote = await seedNote(db, { ownerId: bob.id });
    await attachInOrder(db, live.id, [gb, ga]);
    await attachInOrder(db, trashed.id, [gc, gb]);
    await attachInOrder(db, hNote.id, [hb]);
    await attachInOrder(db, bobNote.id, [bobsAlpha]);
    await markTrashed(db.$client, trashed.id, admin.id);

    const res = await deleteGroup(app, g.id, admin.id, { mode: "transfer", transferTo: bob.id });

    expect(res.statusCode, res.body).toBe(204);
    expect((await attached(db, live.id)).map(r => [r.name, r.color, r.ownerId])).toEqual([["Beta", "green", bob.id], ["ALPHA", "purple", bob.id]]);
    expect((await attached(db, trashed.id)).map(r => [r.name, r.color, r.ownerId])).toEqual([["gamma", "pink", bob.id], ["Beta", "green", bob.id]]);
    expect(await attached(db, bare.id)).toEqual([]);
    const bobTags = await spaceTagRows(db, { ownerId: bob.id });
    expect(bobTags.map(t => t.name).sort()).toEqual(["ALPHA", "Beta", "gamma"]);
    expect(bobTags.find(t => t.name === "ALPHA")!.id).toBe(bobsAlpha);
    expect(await spaceTagRows(db, { groupId: g.id })).toEqual([]);
    expect(await db.select().from(tags).where(inArray(tags.id, [ga, gb, gc]))).toEqual([]);
    // Bystanders: another group's same-name tag and note, the recipient's own note, the previous owner's namesake.
    expect(namesOf(await attached(db, hNote.id))).toEqual(["beta"]);
    expect((await spaceTagRows(db, { groupId: h.id })).map(t => [t.id, t.color])).toEqual([[hb, "brown"]]);
    expect(namesOf(await attached(db, bobNote.id))).toEqual(["ALPHA"]);
    expect((await spaceTagRows(db, { ownerId: admin.id })).map(t => [t.id, t.color])).toEqual([[adminAlpha, "yellow"]]);
    expect(await noteTagCount(db)).toBe(2 + 2 + 1 + 1);
    expect(await crossSpaceRows(db)).toBe(0);
  });

  it("delete-all removes the group's tags and their note_tags rows", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "Garden", [{ userId: admin.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    const t = await seedTag(db, { groupId: g.id }, "gone");
    await attachInOrder(db, n.id, [t]);

    const res = await deleteGroup(app, g.id, admin.id, { mode: "delete" });

    expect(res.statusCode, res.body).toBe(204);
    expect(await db.select().from(tags).where(and(eq(tags.id, t)))).toEqual([]);
    expect(await noteTagCount(db)).toBe(0);
    expect(await crossSpaceRows(db)).toBe(0);
  });
});

describe("callers that reach the same group's tags at the same time", () => {
  /** Two people with the same 40 names attached in opposite order. */
  async function twoSameNamedNotes(db: Db, g: { id: string }, a: { id: string }, b: { id: string }, groupAlreadyHasThem: boolean) {
    if (groupAlreadyHasThem) await db.insert(tags).values(MANY_NAMES.map(name => ({ groupId: g.id, name, color: "green" as const })));
    const na = await seedNote(db, { ownerId: a.id });
    const nb = await seedNote(db, { ownerId: b.id });
    const idsA = await db.insert(tags).values(MANY_NAMES.map(name => ({ ownerId: a.id, name, color: "blue" as const }))).returning({ id: tags.id, name: tags.name });
    const idsB = await db.insert(tags).values([...MANY_NAMES].reverse().map(name => ({ ownerId: b.id, name, color: "red" as const }))).returning({ id: tags.id, name: tags.name });
    await attachInOrder(db, na.id, MANY_NAMES.map(n => idsA.find(t => t.name === n)!.id));
    await attachInOrder(db, nb.id, [...MANY_NAMES].reverse().map(n => idsB.find(t => t.name === n)!.id));
    return { na, nb };
  }

  for (const groupAlreadyHasThem of [false, true]) {
    it(`two moves into one group with the same ${groupAlreadyHasThem ? "existing " : "new "}tag names attached in opposite order both succeed`, async () => {
      for (let round = 0; round < 4; round++) {
        const wait = barrier(2);
        const { app, db } = await buildTestApp({ groupTestHook: async p => { if (p === "note-move-locked") await wait(); } });
        const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
        const g = await seedGroup(db, "Garden", [{ userId: a.id, role: "member" }, { userId: b.id, role: "member" }]);
        const { na, nb } = await twoSameNamedNotes(db, g, a, b, groupAlreadyHasThem);

        const [ra, rb] = await Promise.all([move(app, na.id, a.id, g.id), move(app, nb.id, b.id, g.id)]);

        expect([ra.statusCode, rb.statusCode], `${ra.body} ${rb.body}`).toEqual([200, 200]);
        expect((await attached(db, na.id)).length).toBe(40);
        expect((await attached(db, nb.id)).length).toBe(40);
        expect((await spaceTagRows(db, { groupId: g.id })).length).toBe(40);
        expect(await crossSpaceRows(db)).toBe(0);
      }
    }, 60_000);
  }

  it("two copies into one group with the same tag names attached in opposite order both succeed", async () => {
    for (let round = 0; round < 4; round++) {
      const wait = barrier(2);
      const { app, db } = await buildTestApp({ groupTestHook: async p => { if (p === "note-copy-target-locked") await wait(); } });
      const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
      const g = await seedGroup(db, "Garden", [{ userId: a.id, role: "member" }, { userId: b.id, role: "member" }]);
      const { na, nb } = await twoSameNamedNotes(db, g, a, b, false);

      const [ra, rb] = await Promise.all([copy(app, na.id, a.id, { groupId: g.id }), copy(app, nb.id, b.id, { groupId: g.id })]);

      expect([ra.statusCode, rb.statusCode], `${ra.body} ${rb.body}`).toEqual([201, 201]);
      expect((await attached(db, ra.json().id)).length).toBe(40);
      expect((await attached(db, rb.json().id)).length).toBe(40);
      expect((await spaceTagRows(db, { groupId: g.id })).length).toBe(40);
      expect(await crossSpaceRows(db)).toBe(0);
    }
  }, 60_000);
});

describe("a copy while the source note's tags are being merged or deleted", () => {
  for (const intoGroup of [false, true]) {
    for (const change of ["delete", "merge"] as const) {
      it(`${intoGroup ? "into a group" : "same space"}: waits for a ${change} of one of the tags, then succeeds without it`, async () => {
        const { app, db } = await buildTestApp();
        const alice = await seedUser(db);
        const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
        const gone = await seedTag(db, { ownerId: alice.id }, "gone", "red");
        const kept = await seedTag(db, { ownerId: alice.id }, "kept", "green");
        const target = await seedTag(db, { ownerId: alice.id }, "target", "pink");
        const src = await seedNote(db, { ownerId: alice.id });
        await attachInOrder(db, src.id, [gone, kept]);

        // What a merge or a delete does, held open: the tag row is locked and removed after the copy has started.
        const c = await db.$client.connect();
        let copyRes: ReturnType<typeof copy> | undefined;
        try {
          await c.query("begin");
          await c.query("select id from tags where id = any($1::uuid[]) for update", [[gone, target]]);
          if (change === "merge") {
            await c.query("insert into note_tags (note_id, tag_id, created_at) select note_id, $2::uuid, created_at from note_tags where tag_id = $1::uuid on conflict do nothing", [gone, target]);
          }
          await c.query("delete from tags where id = $1::uuid", [gone]);
          copyRes = copy(app, src.id, alice.id, intoGroup ? { groupId: g.id } : {});
          expect(await waitForBlockedOrSettled(db.$client, copyRes)).toBe("blocked");
          await c.query("commit");
        } finally {
          await c.query("rollback").catch(() => {});
          c.release();
        }

        const res = await copyRes!;
        expect(res.statusCode, res.body).toBe(201);
        expect(namesOf(await attached(db, res.json().id))).toEqual(["kept"]);
        expect(await crossSpaceRows(db)).toBe(0);
        const dangling = await db.$client.query<{ n: number }>("select count(*)::int as n from note_tags nt left join tags t on t.id = nt.tag_id where t.id is null");
        expect(dangling.rows[0]!.n).toBe(0);
      });
    }
  }
});
