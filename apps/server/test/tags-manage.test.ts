import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { NoteDto, SpaceTagDto, TagColor } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteStates, noteTags, notes, tags } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { mergeTagsInTx } from "../src/tags/tx/manage.js";
import { setNoteTagsByNamesInTx } from "../src/tags/tx/note-tags.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedUser, setMemberRole, sleep, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedDoc } from "./copy-helpers.js";
import { buildTestApp } from "./helpers.js";
import { inject, markTrashed } from "./trash-helpers.js";

const patchTag = (app: FastifyInstance, userId: string | null, tagId: string, body: unknown): Promise<LightMyRequestResponse> =>
  inject(app, "PATCH", `/api/tags/${tagId}`, userId, body);
const mergeTag = (app: FastifyInstance, userId: string | null, tagId: string, into: string): Promise<LightMyRequestResponse> =>
  inject(app, "POST", `/api/tags/${tagId}/merge`, userId, { into });
const deleteTag = (app: FastifyInstance, userId: string | null, tagId: string): Promise<LightMyRequestResponse> =>
  inject(app, "DELETE", `/api/tags/${tagId}`, userId);
const codeOf = (res: LightMyRequestResponse): string => (res.json() as { error: { code: string } }).error.code;
const listNotes = async (app: FastifyInstance, userId: string): Promise<NoteDto[]> => {
  const res = await inject(app, "GET", "/api/notes", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteDto[];
};
const tagNamesOn = (list: NoteDto[], noteId: string): string[] => list.find(n => n.id === noteId)!.tags!.map(t => t.name);

type Space = { ownerId: string } | { groupId: string };
async function seedTag(db: Db, space: Space, name: string, color: TagColor = "blue", id?: string): Promise<string> {
  const [row] = await db.insert(tags).values({ name, color, ...space, ...(id === undefined ? {} : { id }) }).returning({ id: tags.id });
  return row!.id;
}
async function attach(db: Db, noteId: string, tagId: string, createdAt?: Date): Promise<void> {
  await db.insert(noteTags).values({ noteId, tagId, ...(createdAt === undefined ? {} : { createdAt }) });
}
const tagRows = (db: Db): Promise<Array<typeof tags.$inferSelect>> => db.select().from(tags);
const rowsOf = (db: Db, noteId: string): Promise<Array<typeof noteTags.$inferSelect>> => db.select().from(noteTags).where(eq(noteTags.noteId, noteId));

describe("PATCH /api/tags/:tagId", () => {
  it("renaming changes the name on every note in GET /api/notes; renaming only the letter case is allowed", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const a = await seedNote(db, { ownerId: alice.id });
    const b = await seedNote(db, { ownerId: alice.id });
    const work = await seedTag(db, { ownerId: alice.id }, "work");
    const bystander = await seedTag(db, { ownerId: alice.id }, "home", "green");
    await attach(db, a.id, work);
    await attach(db, b.id, work);
    await attach(db, b.id, bystander);

    const res = await patchTag(app, alice.id, work.toUpperCase(), { name: "  Projects " });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: work, name: "Projects", color: "blue", noteCount: 2 });
    const list = await listNotes(app, alice.id);
    expect(tagNamesOn(list, a.id)).toEqual(["Projects"]);
    expect(tagNamesOn(list, b.id)).toEqual(["Projects", "home"]);

    const caseOnly = await patchTag(app, alice.id, work, { name: "projects" });
    expect(caseOnly.statusCode, caseOnly.body).toBe(200);
    expect((caseOnly.json() as SpaceTagDto).name).toBe("projects");
    // The other tag in the space is untouched.
    expect((await tagRows(db)).find(t => t.id === bystander)).toMatchObject({ name: "home", color: "green" });
  });

  it("a name another tag in the space has, in any case, is 409 tag_name_taken; the same name in another space is fine", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const mine = await seedTag(db, { ownerId: alice.id }, "work");
    await seedTag(db, { ownerId: alice.id }, "Home");
    await seedTag(db, { ownerId: bob.id }, "Elsewhere");
    await seedTag(db, { groupId: g.id }, "Shared");

    for (const name of ["home", "HOME", "Home"]) {
      const res = await patchTag(app, alice.id, mine, { name });
      expect(res.statusCode, name).toBe(409);
      expect(codeOf(res)).toBe("tag_name_taken");
    }
    expect((await tagRows(db)).find(t => t.id === mine)!.name).toBe("work");
    for (const name of ["Elsewhere", "Shared"]) {
      const res = await patchTag(app, alice.id, mine, { name });
      expect(res.statusCode, `${name}: ${res.body}`).toBe(200);
    }
  });

  it("color changes; a color outside the nine, an empty body, an extra key and a wrong type are 400 invalid_body; a bad name is 400 invalid_tag_name", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const id = await seedTag(db, { ownerId: alice.id }, "work");

    const ok = await patchTag(app, alice.id, id, { color: "purple" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ id, name: "work", color: "purple", noteCount: 0 });
    const both = await patchTag(app, alice.id, id, { name: "plan", color: "red" });
    expect(both.json()).toEqual({ id, name: "plan", color: "red", noteCount: 0 });

    for (const body of [{}, { color: "default" }, { color: "teal" }, { color: 3 }, { name: 1 }, { name: null }, { color: "red", extra: 1 }, []]) {
      const res = await patchTag(app, alice.id, id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(codeOf(res), JSON.stringify(body)).toBe("invalid_body");
    }
    for (const name of ["", "   ", "a".repeat(41), "a\u0000b", "a\nb", "a\ud800b"]) {
      const res = await patchTag(app, alice.id, id, { name });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
      expect(codeOf(res), JSON.stringify(name)).toBe("invalid_tag_name");
    }
    expect((await tagRows(db))[0]).toMatchObject({ name: "plan", color: "red" });
  });
});

describe("POST /api/tags/:tagId/merge", () => {
  it("notes tagged with the source get the target, a note with both ends up with one, the source is deleted, the target keeps its name and color", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const onlySource = await seedNote(db, { ownerId: alice.id });
    const both = await seedNote(db, { ownerId: alice.id });
    const onlyTarget = await seedNote(db, { ownerId: alice.id });
    const trashed = await seedNote(db, { ownerId: alice.id });
    const source = await seedTag(db, { ownerId: alice.id }, "wip", "red");
    const target = await seedTag(db, { ownerId: alice.id }, "Draft", "green");
    const bystander = await seedTag(db, { ownerId: alice.id }, "other", "gray");
    await attach(db, onlySource.id, source);
    await attach(db, both.id, source);
    await attach(db, both.id, target);
    await attach(db, onlyTarget.id, target);
    await attach(db, trashed.id, source);
    await attach(db, onlySource.id, bystander);
    await markTrashed(db.$client, trashed.id, alice.id);

    const res = await mergeTag(app, alice.id, source.toUpperCase(), target.toUpperCase());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: target, name: "Draft", color: "green", noteCount: 3 });

    expect((await tagRows(db)).map(t => t.name).sort()).toEqual(["Draft", "other"]);
    const list = await listNotes(app, alice.id);
    expect(tagNamesOn(list, onlySource.id).sort()).toEqual(["Draft", "other"]);
    expect(tagNamesOn(list, both.id)).toEqual(["Draft"]);
    expect(tagNamesOn(list, onlyTarget.id)).toEqual(["Draft"]);
    expect((await rowsOf(db, both.id)).map(r => r.tagId)).toEqual([target]);
    // A trashed note takes part too: its tags come back with it.
    expect((await rowsOf(db, trashed.id)).map(r => r.tagId)).toEqual([target]);
  });

  it("the merged tag keeps its place in each note's order: the source's created_at is copied to the target", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const both = await seedNote(db, { ownerId: alice.id });
    const first = await seedTag(db, { ownerId: alice.id }, "first");
    const source = await seedTag(db, { ownerId: alice.id }, "source");
    const last = await seedTag(db, { ownerId: alice.id }, "last");
    const target = await seedTag(db, { ownerId: alice.id }, "target");
    const t = (ms: number): Date => new Date(1_700_000_000_000 + ms);
    await attach(db, n.id, first, t(0));
    await attach(db, n.id, source, t(1000));
    await attach(db, n.id, last, t(2000));
    // Both ends on one note: the target's own time stays.
    await attach(db, both.id, source, t(5000));
    await attach(db, both.id, target, t(100));

    expect((await mergeTag(app, alice.id, source, target)).statusCode).toBe(200);

    expect(tagNamesOn(await listNotes(app, alice.id), n.id)).toEqual(["first", "target", "last"]);
    const copied = (await rowsOf(db, n.id)).find(r => r.tagId === target)!;
    expect(copied.createdAt.getTime()).toBe(t(1000).getTime());
    const kept = await rowsOf(db, both.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.createdAt.getTime()).toBe(t(100).getTime());
  });

  it("into itself is 400 merge_same_tag; a missing target, another user's tag and a tag of another space are 404 tag_not_found", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const source = await seedTag(db, { ownerId: alice.id }, "a");
    const bobs = await seedTag(db, { ownerId: bob.id }, "b");
    const groupTag = await seedTag(db, { groupId: g.id }, "c");

    const same = await mergeTag(app, alice.id, source, source.toUpperCase());
    expect(same.statusCode, same.body).toBe(400);
    expect(codeOf(same)).toBe("merge_same_tag");
    for (const into of [randomUUID(), bobs, groupTag, "not-a-uuid"]) {
      const res = await mergeTag(app, alice.id, source, into);
      expect(res.statusCode, `${into}: ${res.body}`).toBe(404);
      expect(codeOf(res)).toBe("tag_not_found");
    }
    // Nothing moved, nothing deleted.
    expect((await tagRows(db)).map(t => t.name).sort()).toEqual(["a", "b", "c"]);
    // Same-tag for a tag the caller can't see doesn't answer differently from any other foreign tag.
    const foreign = await mergeTag(app, alice.id, bobs, bobs);
    expect(foreign.statusCode).toBe(404);
    expect(codeOf(foreign)).toBe("tag_not_found");
    for (const body of [{}, { into: 1 }, { into: "x", extra: 1 }]) {
      const res = await inject(app, "POST", `/api/tags/${source}/merge`, alice.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(codeOf(res)).toBe("invalid_body");
    }
  });

  it("a note_tags row whose note is in another space isn't merged and doesn't count in noteCount", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const mine = await seedNote(db, { ownerId: alice.id });
    const foreign = await seedNote(db, { ownerId: bob.id });
    const source = await seedTag(db, { ownerId: alice.id }, "src");
    const target = await seedTag(db, { ownerId: alice.id }, "dst");
    await attach(db, mine.id, source);
    await attach(db, foreign.id, source); // a leftover an older move could have left behind

    const res = await mergeTag(app, alice.id, source, target);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as SpaceTagDto).noteCount).toBe(1);
    expect(await rowsOf(db, foreign.id)).toEqual([]);
    expect((await rowsOf(db, mine.id)).map(r => r.tagId)).toEqual([target]);
  });

  it("works in a group space and leaves another group's tag with the same name alone", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g1 = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const g2 = await seedGroup(db, "Orchard", [{ userId: alice.id, role: "admin" }]);
    const n1 = await seedNote(db, { groupId: g1.id });
    const n2 = await seedNote(db, { groupId: g2.id });
    const s1 = await seedTag(db, { groupId: g1.id }, "src");
    const t1 = await seedTag(db, { groupId: g1.id }, "dst");
    const s2 = await seedTag(db, { groupId: g2.id }, "src");
    await attach(db, n1.id, s1);
    await attach(db, n2.id, s2);

    const res = await mergeTag(app, alice.id, s1, t1);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: t1, name: "dst", color: "blue", noteCount: 1 });
    expect((await rowsOf(db, n2.id)).map(r => r.tagId)).toEqual([s2]);
    expect((await tagRows(db)).some(t => t.id === s2)).toBe(true);
  });

  it("mergeTagsInTx answers not_found when either id isn't in the given space", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const a = await seedTag(db, { ownerId: alice.id }, "a");
    const b = await seedTag(db, { ownerId: alice.id }, "b");
    const bobs = await seedTag(db, { ownerId: bob.id }, "c");
    const space = { kind: "personal", ownerId: alice.id } as const;
    expect(await db.transaction(tx => mergeTagsInTx(tx, { sourceId: a, targetId: bobs, space }))).toEqual({ kind: "not_found" });
    expect(await db.transaction(tx => mergeTagsInTx(tx, { sourceId: randomUUID(), targetId: b, space }))).toEqual({ kind: "not_found" });
    expect((await tagRows(db)).map(t => t.name).sort()).toEqual(["a", "b", "c"]);
    expect(await db.transaction(tx => mergeTagsInTx(tx, { sourceId: a, targetId: b, space }))).toEqual({ kind: "ok", tag: { id: b, name: "b", color: "blue", noteCount: 0 } });
  });
});

describe("DELETE /api/tags/:tagId", () => {
  it("removes the tag from every note and answers 204; other tags and other users' rows stay", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const a = await seedNote(db, { ownerId: alice.id });
    const b = await seedNote(db, { ownerId: alice.id });
    const bobsNote = await seedNote(db, { ownerId: bob.id });
    const doomed = await seedTag(db, { ownerId: alice.id }, "doomed");
    const stays = await seedTag(db, { ownerId: alice.id }, "stays");
    const bobs = await seedTag(db, { ownerId: bob.id }, "doomed");
    await attach(db, a.id, doomed);
    await attach(db, b.id, doomed);
    await attach(db, b.id, stays);
    await attach(db, bobsNote.id, bobs);

    const res = await deleteTag(app, alice.id, doomed.toUpperCase());
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    expect((await tagRows(db)).map(t => t.id).sort()).toEqual([stays, bobs].sort());
    expect((await rowsOf(db, a.id))).toEqual([]);
    expect((await rowsOf(db, b.id)).map(r => r.tagId)).toEqual([stays]);
    expect((await rowsOf(db, bobsNote.id)).map(r => r.tagId)).toEqual([bobs]);
    expect((await deleteTag(app, alice.id, doomed)).statusCode).toBe(404);
    expect(codeOf(await deleteTag(app, alice.id, "nope"))).toBe("tag_not_found");
  });
});

describe("who can manage", () => {
  it("personal: the owner; anyone else, a site admin included, gets 404 tag_not_found and nothing changes", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const admin = await seedUser(db, { displayName: "Root", isAdmin: true });
    const id = await seedTag(db, { ownerId: alice.id }, "mine");
    const other = await seedTag(db, { ownerId: alice.id }, "other");

    for (const who of [bob, admin]) {
      for (const res of [await patchTag(app, who.id, id, { name: "x" }), await mergeTag(app, who.id, id, other), await deleteTag(app, who.id, id)]) {
        expect(res.statusCode, res.body).toBe(404);
        expect(codeOf(res)).toBe("tag_not_found");
      }
    }
    const unauthenticated = await patchTag(app, null, id, { name: "x" });
    expect(unauthenticated.statusCode).toBe(401);
    expect((await tagRows(db)).map(t => t.name).sort()).toEqual(["mine", "other"]);
    expect((await patchTag(app, alice.id, id, { name: "renamed" })).statusCode).toBe(200);
  });

  it("group: a role that can manage the group, and a non-member site admin; a member who can edit but not manage gets 403; a non-member gets 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const carol = await seedUser(db, { displayName: "Carol" });
    const dave = await seedUser(db, { displayName: "Dave" });
    const admin = await seedUser(db, { displayName: "Root", isAdmin: true });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }, { userId: bob.id, role: "member" }, { userId: dave.id, role: "member" }]);
    const manager = await seedRole(db, g.id, "managers", { canRead: true, canManageGroup: true });
    await setMemberRole(db, g.id, dave.id, manager);
    const a = await seedTag(db, { groupId: g.id }, "a");
    const b = await seedTag(db, { groupId: g.id }, "b");
    const c = await seedTag(db, { groupId: g.id }, "c");
    const d = await seedTag(db, { groupId: g.id }, "d");

    // Member (edit, no manage): 403 on every route.
    for (const res of [await patchTag(app, bob.id, a, { name: "x" }), await mergeTag(app, bob.id, a, b), await deleteTag(app, bob.id, a)]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(codeOf(res)).toBe("forbidden");
    }
    // Non-member: 404, the same answer as for a tag that doesn't exist.
    for (const res of [await patchTag(app, carol.id, a, { name: "x" }), await mergeTag(app, carol.id, a, b), await deleteTag(app, carol.id, a)]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(codeOf(res)).toBe("tag_not_found");
    }
    expect((await tagRows(db)).map(t => t.name).sort()).toEqual(["a", "b", "c", "d"]);

    expect((await patchTag(app, alice.id, a, { name: "a2" })).statusCode).toBe(200);
    expect((await patchTag(app, dave.id, b, { color: "pink" })).statusCode).toBe(200);
    expect((await mergeTag(app, admin.id, c, d)).statusCode).toBe(200);
    expect((await deleteTag(app, admin.id, d)).statusCode).toBe(204);
  });

  it("a merge target in a space the caller can't manage is 404 tag_not_found, like a target that doesn't exist", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const mine = await seedTag(db, { ownerId: alice.id }, "mine");
    const groupTag = await seedTag(db, { groupId: g.id }, "group");

    const res = await mergeTag(app, alice.id, mine, groupTag);
    expect(res.statusCode, res.body).toBe(404);
    expect(codeOf(res)).toBe("tag_not_found");
    expect((await tagRows(db))).toHaveLength(2);
  });

  it("charges TAG_LIMIT after authorization; renaming or merging doesn't touch notes.updated_at or note_states", async () => {
    const { app, db } = await buildTestApp({ limiters: { tag: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) } });
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const n = await seedNote(db, { ownerId: alice.id });
    await db.insert(noteStates).values({ noteId: n.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 4 });
    const a = await seedTag(db, { ownerId: alice.id }, "a");
    const b = await seedTag(db, { ownerId: alice.id }, "b");
    const c = await seedTag(db, { ownerId: alice.id }, "c");
    const bobs = await seedTag(db, { ownerId: bob.id }, "bobs");
    await attach(db, n.id, a);
    const snapshot = async () => {
      const { rows } = await db.$client.query("select updated_at::text as u, version_pending_at::text as p, last_edited_at::text as l from notes where id = $1", [n.id]);
      const [state] = await db.select({ version: noteStates.version, updatedAt: noteStates.updatedAt }).from(noteStates).where(eq(noteStates.noteId, n.id));
      return { note: rows[0], state };
    };
    const before = await snapshot();

    // Rejected before the charge: bad id, bad body, bad name, malformed target, not found, not allowed, same tag.
    expect((await patchTag(app, alice.id, "nope", { name: "x" })).statusCode).toBe(404);
    expect((await patchTag(app, alice.id, a, { nope: 1 })).statusCode).toBe(400);
    expect((await patchTag(app, alice.id, a, { name: "" })).statusCode).toBe(400);
    expect((await patchTag(app, alice.id, randomUUID(), { name: "x" })).statusCode).toBe(404);
    expect((await patchTag(app, alice.id, bobs, { name: "x" })).statusCode).toBe(404);
    expect((await mergeTag(app, alice.id, a, a)).statusCode).toBe(400);
    expect((await mergeTag(app, alice.id, a, "nope")).statusCode).toBe(404);
    expect((await mergeTag(app, alice.id, a, bobs)).statusCode).toBe(404);
    expect((await mergeTag(app, alice.id, a, randomUUID())).statusCode).toBe(404);
    expect((await deleteTag(app, alice.id, "nope")).statusCode).toBe(404);
    expect((await deleteTag(app, alice.id, bobs)).statusCode).toBe(404);

    expect((await patchTag(app, alice.id, a, { name: "a1" })).statusCode).toBe(200);
    expect((await patchTag(app, alice.id, a, { color: "red" })).statusCode).toBe(200);
    expect((await mergeTag(app, alice.id, a, b)).statusCode).toBe(200);
    for (const res of [await patchTag(app, alice.id, b, { name: "b2" }), await mergeTag(app, alice.id, b, c), await deleteTag(app, alice.id, b)]) {
      expect(res.statusCode, res.body).toBe(429);
      expect(codeOf(res)).toBe("too_many_requests");
    }
    expect((await patchTag(app, bob.id, bobs, { name: "bobs2" })).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
});

describe("locking", () => {
  it("a group merge takes the group's lock before any note lock: with the group row held FOR UPDATE it waits without holding the note", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id });
    const source = await seedTag(db, { groupId: g.id }, "src");
    const target = await seedTag(db, { groupId: g.id }, "dst");
    await attach(db, n.id, source);

    const holder = await db.$client.connect();
    const probe = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from groups where id = $1 for update", [g.id]);
      const pending = mergeTag(app, alice.id, source, target);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");

      // The same lock a group delete takes on the notes; it must still be free while the merge waits for the group.
      await probe.query("begin");
      await probe.query("set local lock_timeout = '1s'");
      await expect(probe.query("select id from notes where id = $1 for update nowait", [n.id])).resolves.toBeDefined();
      await probe.query("rollback");

      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      holder.release();
      probe.release();
    }
  });

  it("a group merge and a group delete's lock order (group, then notes) finish without a deadlock", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const notesInGroup = await Promise.all(Array.from({ length: 6 }, () => seedNote(db, { groupId: g.id })));
    const source = await seedTag(db, { groupId: g.id }, "src");
    const target = await seedTag(db, { groupId: g.id }, "dst");
    for (const n of notesInGroup) await attach(db, n.id, source);

    const other = (async () => {
      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        const c = await db.$client.connect();
        try {
          await c.query("begin");
          await c.query("select id from groups where id = $1 for update", [g.id]);
          await c.query("select id from notes where group_id = $1 order by id for update", [g.id]);
          await sleep(10);
          await c.query("commit");
          results.push("committed");
        } catch (err) {
          await c.query("rollback").catch(() => {});
          results.push(`error ${(err as { code?: string }).code}`);
        } finally {
          c.release();
        }
      }
      return results;
    })();
    const res = await mergeTag(app, alice.id, source, target);
    expect(res.statusCode, res.body).toBe(200);
    expect(await other).toEqual(Array(5).fill("committed"));
  });

  it("a note that moves out of the space while the merge waits for its lock is left out, and no row ends up in the wrong space", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const staying = await seedNote(db, { groupId: g.id });
    const leaving = await seedNote(db, { groupId: g.id });
    const source = await seedTag(db, { groupId: g.id }, "src");
    const target = await seedTag(db, { groupId: g.id }, "dst");
    await attach(db, staying.id, source);
    await attach(db, leaving.id, source);

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from notes where id = $1 for update", [leaving.id]);
      const pending = mergeTag(app, alice.id, source, target);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("update notes set group_id = null, owner_id = $2 where id = $1", [leaving.id, alice.id]);
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      holder.release();
    }
    expect((await rowsOf(db, staying.id)).map(r => r.tagId)).toEqual([target]);
    expect(await rowsOf(db, leaving.id)).toEqual([]);
    const moved = await db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(and(eq(notes.id, leaving.id)));
    expect(moved).toEqual([{ ownerId: alice.id, groupId: null }]);
  });

  /** What a lock probe sees right now: false when another transaction holds a conflicting lock on the row. */
  const rowFree = async (db: Db, query: string, id: string): Promise<boolean> => {
    const probe = await db.$client.connect();
    try {
      await probe.query("begin");
      await probe.query("set local lock_timeout = '1s'");
      try {
        await probe.query(query, [id]);
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === "55P03") return false;
        throw err;
      } finally {
        await probe.query("rollback");
      }
    } finally {
      probe.release();
    }
  };

  const groupWrites: Array<[string, (app: FastifyInstance, uid: string, t: { source: string; target: string }) => Promise<LightMyRequestResponse>, number]> = [
    ["rename", (app, uid, t) => patchTag(app, uid, t.source, { color: "pink" }), 200],
    ["delete", (app, uid, t) => deleteTag(app, uid, t.source), 204],
    ["merge", (app, uid, t) => mergeTag(app, uid, t.source, t.target), 200],
  ];
  for (const [label, run, okStatus] of groupWrites) {
    it(`${label} in a group takes the group's lock before any tag, note or note_tags lock: with the group row held FOR UPDATE it waits holding none of them`, async () => {
      const { app, db } = await buildTestApp();
      const alice = await seedUser(db, { displayName: "Alice" });
      const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
      const n = await seedNote(db, { groupId: g.id });
      const source = await seedTag(db, { groupId: g.id }, "src");
      const target = await seedTag(db, { groupId: g.id }, "dst");
      await attach(db, n.id, source);

      const holder = await db.$client.connect();
      try {
        await holder.query("begin");
        await holder.query("select id from groups where id = $1 for update", [g.id]);
        const pending = run(app, alice.id, { source, target });
        expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
        expect(await rowFree(db, "select id from tags where id = $1 for update nowait", source)).toBe(true);
        expect(await rowFree(db, "select id from notes where id = $1 for update nowait", n.id)).toBe(true);
        expect(await rowFree(db, "select note_id from note_tags where tag_id = $1 for update nowait", source)).toBe(true);
        await holder.query("commit");
        const res = await pending;
        expect(res.statusCode, res.body).toBe(okStatus);
      } finally {
        holder.release();
      }
    });

    it(`${label} racing a group delete that removes the notes and then the group ends in 404 tag_not_found, not a deadlock`, async () => {
      const { app, db } = await buildTestApp();
      const alice = await seedUser(db, { displayName: "Alice" });
      const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
      const n = await seedNote(db, { groupId: g.id });
      const source = await seedTag(db, { groupId: g.id }, "src");
      const target = await seedTag(db, { groupId: g.id }, "dst");
      await attach(db, n.id, source);

      const holder = await db.$client.connect();
      try {
        await holder.query("begin");
        await holder.query("select id from groups where id = $1 for update", [g.id]);
        await holder.query("select id from notes where group_id = $1 order by id for update", [g.id]);
        await holder.query("delete from notes where id = $1", [n.id]);
        const pending = run(app, alice.id, { source, target });
        expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
        await holder.query("delete from groups where id = $1", [g.id]);
        await holder.query("commit");
        const res = await pending;
        expect(res.statusCode, res.body).toBe(404);
        expect(codeOf(res)).toBe("tag_not_found");
      } finally {
        holder.release();
      }
    });
  }

  it("a rename that collides with another tag's name is still 409 tag_name_taken inside the group-locked transaction", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const mine = await seedTag(db, { groupId: g.id }, "one");
    await seedTag(db, { groupId: g.id }, "Two");
    const res = await patchTag(app, alice.id, mine, { name: "TWO" });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe("tag_name_taken");
    expect((await patchTag(app, alice.id, mine, { name: "three" })).statusCode).toBe(200);
  });

  // Ids are chosen so that id order and name_key order disagree: a lock taken in id order would take "zeta" first, in name_key order "alpha".
  const LOW_ID = "00000000-0000-4000-8000-000000000001";
  const HIGH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  it("deleting a tag waits for a purge that holds its notes instead of cycling on their note_tags rows", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const first = await seedNote(db, { ownerId: alice.id });
    const second = await seedNote(db, { ownerId: alice.id });
    const doomed = await seedTag(db, { ownerId: alice.id }, "doomed");
    await attach(db, first.id, doomed);
    await attach(db, second.id, doomed);
    for (const n of [first, second]) await markTrashed(db.$client, n.id, alice.id);

    // A purge locks its notes FOR UPDATE, then removes their note_tags rows; it has already removed the row the tag delete reaches last.
    const purge = await db.$client.connect();
    try {
      await purge.query("begin");
      await purge.query("select id from notes where id = any($1) order by id for update", [[first.id, second.id]]);
      await purge.query("delete from note_tags where note_id = $1", [second.id]);
      const pending = deleteTag(app, alice.id, doomed);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await purge.query("delete from notes where id = any($1)", [[first.id, second.id]]);
      await purge.query("commit");
      expect((await pending).statusCode).toBe(204);
    } finally {
      purge.release();
    }
    expect(await db.select().from(noteTags)).toEqual([]);
    expect(await tagRows(db)).toEqual([]);
  });

  it("a merge locks its two tags in name_key order: while it waits for the later one it already holds the earlier one", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const zeta = await seedTag(db, { ownerId: alice.id }, "zeta", "blue", LOW_ID);
    const alpha = await seedTag(db, { ownerId: alice.id }, "alpha", "blue", HIGH_ID);

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tags where id = $1 for update", [zeta]);
      const pending = mergeTag(app, alice.id, alpha, zeta);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      expect(await rowFree(db, "select id from tags where id = $1 for update nowait", alpha)).toBe(false);
      await holder.query("commit");
      expect((await pending).statusCode).toBe(200);
    } finally {
      holder.release();
    }
  });

  it("setNoteTagsByNamesInTx locks the existing tags in name_key order whatever order the names come in, and the note keeps the given order", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const zeta = await seedTag(db, { ownerId: alice.id }, "zeta", "blue", LOW_ID);
    const alpha = await seedTag(db, { ownerId: alice.id }, "alpha", "blue", HIGH_ID);
    const set = (names: string[]) =>
      db.transaction(tx => setNoteTagsByNamesInTx(tx, { noteId: n.id, expected: { ownerId: alice.id, groupId: null }, names, createdBy: alice.id }));

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tags where id = $1 for update", [zeta]);
      const pending = set(["zeta", "ALPHA"]);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      expect(await rowFree(db, "select id from tags where id = $1 for update nowait", alpha)).toBe(false);
      await holder.query("commit");
      expect(await pending).toEqual({ kind: "ok", tags: [expect.objectContaining({ name: "zeta" }), expect.objectContaining({ name: "alpha" })] });
    } finally {
      holder.release();
    }
  });

  it("setNoteTagsByNamesInTx with new names: colors and the order on the note follow the given order, not the lock order", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const out = await db.transaction(tx =>
      setNoteTagsByNamesInTx(tx, { noteId: n.id, expected: { ownerId: alice.id, groupId: null }, names: ["zulu", "Mike", "alpha", "ZULU"], createdBy: alice.id }),
    );
    expect(out).toEqual({
      kind: "ok",
      tags: [
        { id: expect.any(String), name: "zulu", color: "blue" },
        { id: expect.any(String), name: "Mike", color: "green" },
        { id: expect.any(String), name: "alpha", color: "orange" },
      ],
    });
  });

  it("a rename doesn't wait for a content save on a tagged note", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const id = await seedTag(db, { ownerId: alice.id }, "work");
    await attach(db, n.id, id);

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("update notes set title = 'saving' where id = $1", [n.id]);
      const outcome = await Promise.race([patchTag(app, alice.id, id, { name: "plan" }), sleep(5_000).then(() => "stuck" as const)]);
      expect(outcome).not.toBe("stuck");
      expect((outcome as LightMyRequestResponse).statusCode).toBe(200);
      await holder.query("commit");
    } finally {
      holder.release();
    }
  });
});

describe("tag writes meeting moves, copies and group hand-overs", () => {
  const copyNote = async (app: FastifyInstance, noteId: string, userId: string, payload: Record<string, unknown> = {}) =>
    inject(app, "POST", `/api/notes/${noteId}/copy`, userId, payload);
  const moveNote = async (app: FastifyInstance, noteId: string, userId: string, groupId: string) =>
    inject(app, "POST", `/api/notes/${noteId}/move`, userId, { groupId });
  const handOver = async (app: FastifyInstance, groupId: string, userId: string, transferTo: string) =>
    app.inject({ method: "DELETE", url: `/api/groups/${groupId}`, cookies: await cookieOf(userId), payload: { mode: "transfer", transferTo } });
  const namesOn = async (db: Db, noteId: string): Promise<string[]> =>
    (await db.$client.query<{ name: string }>("select t.name from note_tags nt join tags t on t.id = nt.tag_id where nt.note_id = $1 order by nt.created_at, t.id", [noteId])).rows.map(r => r.name);
  const strayRows = async (db: Db): Promise<{ cross: number; dangling: number }> => ({
    cross: (await db.$client.query<{ n: number }>(
      `select count(*)::int as n from note_tags nt join tags t on t.id = nt.tag_id join notes n on n.id = nt.note_id
       where t.owner_id is distinct from n.owner_id or t.group_id is distinct from n.group_id`,
    )).rows[0]!.n,
    dangling: (await db.$client.query<{ n: number }>("select count(*)::int as n from note_tags nt left join tags t on t.id = nt.tag_id where t.id is null")).rows[0]!.n,
  });
  const rowFree = async (db: Db, id: string): Promise<boolean> => {
    const probe = await db.$client.connect();
    try {
      await probe.query("begin");
      await probe.query("set local lock_timeout = '1s'");
      try {
        await probe.query("select id from tags where id = $1 for update nowait", [id]);
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === "55P03") return false;
        throw err;
      } finally {
        await probe.query("rollback");
      }
    } finally {
      probe.release();
    }
  };
  /** Two names whose byte order ("C") is the reverse of the database's default collation, which is what the shipped images use. */
  const PUNCT = "_z";
  const PLAIN = "a";

  it("the two names used below really sort in opposite ways under the default collation and under C", async () => {
    const { db } = await buildTestApp();
    const { rows } = await db.$client.query<{ dflt: boolean; c: boolean }>(
      `select (${"'" + PUNCT + "'"} < ${"'" + PLAIN + "'"}) as dflt, (${"'" + PUNCT + "'"} collate "C" < ${"'" + PLAIN + "'"} collate "C") as c`,
    );
    expect(rows[0]).toEqual({ dflt: false, c: true });
  });

  it("a merge locks its tags in C order, not the default collation's and not id order", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    // Default collation and id order both put PLAIN first; C order puts PUNCT first.
    const plain = await seedTag(db, { ownerId: alice.id }, PLAIN, "blue", "00000000-0000-4000-8000-000000000002");
    const punct = await seedTag(db, { ownerId: alice.id }, PUNCT, "blue", "ffffffff-ffff-4fff-8fff-fffffffffffe");

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tags where id = $1 for update", [plain]);
      const pending = mergeTag(app, alice.id, punct, plain);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      expect(await rowFree(db, punct)).toBe(false);
      await holder.query("commit");
      expect((await pending).statusCode).toBe(200);
    } finally {
      holder.release();
    }
  });

  it("a move into a group locks the group's tags in C order: waiting for the later one it already holds the earlier one", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const groupPlain = await seedTag(db, { groupId: g.id }, PLAIN);
    const groupPunct = await seedTag(db, { groupId: g.id }, PUNCT);
    const n = await seedNote(db, { ownerId: alice.id });
    await attach(db, n.id, await seedTag(db, { ownerId: alice.id }, PLAIN), new Date(1_700_000_000_000));
    await attach(db, n.id, await seedTag(db, { ownerId: alice.id }, PUNCT), new Date(1_700_000_001_000));

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tags where id = $1 for update", [groupPlain]);
      const pending = moveNote(app, n.id, alice.id, g.id);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      expect(await rowFree(db, groupPunct)).toBe(false);
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      holder.release();
    }
    expect(await namesOn(db, n.id)).toEqual([PLAIN, PUNCT]);
    expect(await strayRows(db)).toEqual({ cross: 0, dangling: 0 });
  });

  it("a copy locks the source note's tags in C order too", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await seedDoc(db, n.id, new Y.Doc());
    const plain = await seedTag(db, { ownerId: alice.id }, PLAIN);
    const punct = await seedTag(db, { ownerId: alice.id }, PUNCT);
    await attach(db, n.id, plain, new Date(1_700_000_000_000));
    await attach(db, n.id, punct, new Date(1_700_000_001_000));

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from tags where id = $1 for update", [plain]);
      const pending = copyNote(app, n.id, alice.id);
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      expect(await rowFree(db, punct)).toBe(false);
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(201);
      expect(await namesOn(db, (res.json() as { id: string }).id)).toEqual([PLAIN, PUNCT]);
    } finally {
      holder.release();
    }
  });

  for (const intoGroup of [false, true]) {
    for (const change of ["merge", "delete"] as const) {
      it(`${intoGroup ? "a copy into a group" : "a same-space copy"} waits for a real ${change} of one of its tags and then succeeds without dangling or cross-space rows`, async () => {
        const { app, db } = await buildTestApp();
        const alice = await seedUser(db, { displayName: "Alice" });
        const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
        const space: Space = { ownerId: alice.id };
        const src = await seedNote(db, space);
        await seedDoc(db, src.id, new Y.Doc());
        const blocker = await seedNote(db, space);
        const s = await seedTag(db, space, "src");
        const t = await seedTag(db, space, "dst");
        const kept = await seedTag(db, space, "kept");
        await attach(db, src.id, s, new Date(1_700_000_000_000));
        await attach(db, src.id, kept, new Date(1_700_000_001_000));
        await attach(db, blocker.id, s);

        const holder = await db.$client.connect();
        try {
          // The change is in flight: the merge waits for the blocker note's lock, the delete for its note_tags row; each holds the tag rows meanwhile.
          await holder.query("begin");
          if (change === "merge") await holder.query("select id from notes where id = $1 for update", [blocker.id]);
          else await holder.query("select note_id from note_tags where note_id = $1 for update", [blocker.id]);
          const changing = change === "merge" ? mergeTag(app, alice.id, s, t) : deleteTag(app, alice.id, s);
          expect(await waitForBlockedOrSettled(db.$client, changing)).toBe("blocked");
          const copying = copyNote(app, src.id, alice.id, intoGroup ? { groupId: g.id } : {});
          expect(await waitForBlockedOrSettled(db.$client, copying)).toBe("blocked");
          await holder.query("commit");
          const [c, copied] = await Promise.all([changing, copying]);
          expect(c.statusCode, c.body).toBe(change === "merge" ? 200 : 204);
          expect(copied.statusCode, copied.body).toBe(201);
          // The copy read the note's tags before the change landed, so it carries the ones that survived; "src" itself is gone.
          const copyNames = await namesOn(db, (copied.json() as { id: string }).id);
          expect(copyNames).toContain("kept");
          expect(copyNames).not.toContain("src");
        } finally {
          await holder.query("rollback").catch(() => {});
          holder.release();
        }
        expect(await strayRows(db)).toEqual({ cross: 0, dangling: 0 });
      });
    }
  }

  it("a move into a group, and adding a tag by name, while that group merges the tag with the same name: both succeed and nothing strays", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const mover = await seedNote(db, { ownerId: alice.id });
    await attach(db, mover.id, await seedTag(db, { ownerId: alice.id }, "s"));
    const adder = await seedNote(db, { groupId: g.id });
    const blocker = await seedNote(db, { groupId: g.id });
    const gs = await seedTag(db, { groupId: g.id }, "S");
    const gt = await seedTag(db, { groupId: g.id }, "T");
    await attach(db, blocker.id, gs);

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from notes where id = $1 for update", [blocker.id]);
      const merging = mergeTag(app, alice.id, gs, gt);
      expect(await waitForBlockedOrSettled(db.$client, merging)).toBe("blocked");
      const moving = moveNote(app, mover.id, alice.id, g.id);
      const adding = inject(app, "POST", `/api/notes/${adder.id}/tags`, alice.id, { name: "s" });
      await sleep(400);
      await holder.query("commit");
      const [m, mv, ad] = await Promise.all([merging, moving, adding]);
      expect([m.statusCode, mv.statusCode, ad.statusCode], `${m.body} ${mv.body} ${ad.body}`).toEqual([200, 200, 200]);
    } finally {
      holder.release();
    }
    expect(await namesOn(db, mover.id)).toEqual(["s"]);
    expect(await namesOn(db, adder.id)).toEqual(["s"]);
    expect(await namesOn(db, blocker.id)).toEqual(["T"]);
    expect(await strayRows(db)).toEqual({ cross: 0, dangling: 0 });
  });

  for (const change of ["merge", "rename"] as const) {
    it(`handing a group's notes to bob while bob ${change}s the personal tag of the same name: both finish, the notes keep their tags, nothing strays`, async () => {
      const { app, db } = await buildTestApp();
      const bob = await seedUser(db, { displayName: "Bob" });
      const g = await seedGroup(db, "Garden", [{ userId: bob.id, role: "admin" }]);
      const groupNote = await seedNote(db, { groupId: g.id });
      await attach(db, groupNote.id, await seedTag(db, { groupId: g.id }, "S"), new Date(1_700_000_000_000));
      await attach(db, groupNote.id, await seedTag(db, { groupId: g.id }, "T"), new Date(1_700_000_001_000));
      const own = await seedNote(db, { ownerId: bob.id });
      const blocker = await seedNote(db, { ownerId: bob.id });
      const ps = await seedTag(db, { ownerId: bob.id }, "s");
      const pt = await seedTag(db, { ownerId: bob.id }, "t");
      await attach(db, own.id, ps);
      await attach(db, blocker.id, ps);

      const holder = await db.$client.connect();
      try {
        await holder.query("begin");
        let changing: Promise<LightMyRequestResponse>;
        if (change === "merge") {
          await holder.query("select id from notes where id = $1 for update", [blocker.id]);
          changing = mergeTag(app, bob.id, ps, pt);
          expect(await waitForBlockedOrSettled(db.$client, changing)).toBe("blocked");
        } else {
          // An uncommitted rename: the row is locked and renamed until the holder commits.
          await holder.query("update tags set name = 's2' where id = $1", [ps]);
          changing = Promise.resolve(inject(app, "GET", "/api/tags", bob.id));
        }
        const handing = handOver(app, g.id, bob.id, bob.id);
        const st = await waitForBlockedOrSettled(db.$client, handing);
        expect(st).toBe("blocked");
        await holder.query("commit");
        const [c, h] = await Promise.all([changing, handing]);
        expect(c.statusCode, c.body).toBe(200);
        expect(h.statusCode, h.body).toBe(204);
      } finally {
        await holder.query("rollback").catch(() => {});
        holder.release();
      }
      expect(await namesOn(db, groupNote.id)).toEqual(["S", "t"]);
      expect(await strayRows(db)).toEqual({ cross: 0, dangling: 0 });
    });
  }
});
