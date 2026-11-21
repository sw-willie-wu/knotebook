import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  TAG_COLORS,
  TAGS_PER_NOTE_MAX,
  TAGS_PER_SPACE_MAX,
  type NoteDto,
  type NoteTagsDto,
  type SpaceTagDto,
} from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, noteStates, noteTags, notes, tags } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { visibleNoteBranches } from "../src/notes/list-query.js";
import { addNoteTagInTx, finishAdd, setNoteTagsByNamesInTx, type NoteTagsResult } from "../src/tags/tx/note-tags.js";
import { notesHavingAllTagsSql, loadNoteTagNames } from "../src/tags/queries.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole, sleep, waitForBlockedOrSettled } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { inject, markRestored, markTrashed } from "./trash-helpers.js";

const addTag = (app: FastifyInstance, userId: string | null, noteId: string, body: unknown): Promise<LightMyRequestResponse> =>
  inject(app, "POST", `/api/notes/${noteId}/tags`, userId, body);
const removeTag = (app: FastifyInstance, userId: string | null, noteId: string, tagId: string): Promise<LightMyRequestResponse> =>
  inject(app, "DELETE", `/api/notes/${noteId}/tags/${tagId}`, userId);
const listNotes = async (app: FastifyInstance, userId: string): Promise<NoteDto[]> => {
  const res = await inject(app, "GET", "/api/notes", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NoteDto[];
};
const spaceTags = async (app: FastifyInstance, userId: string): Promise<SpaceTagDto[]> => {
  const res = await inject(app, "GET", "/api/tags", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SpaceTagDto[];
};
const names = (list: ReadonlyArray<{ name: string }>): string[] => list.map(t => t.name);

async function tagRows(db: Db): Promise<Array<typeof tags.$inferSelect>> {
  return db.select().from(tags);
}
async function noteTagRows(db: Db, noteId?: string): Promise<Array<typeof noteTags.$inferSelect>> {
  const q = db.select().from(noteTags);
  return noteId === undefined ? q : q.where(eq(noteTags.noteId, noteId));
}
/** Direct inserts: the API refuses what these tests need to start from (many tags, a tag in another space). */
async function seedPersonalTags(db: Db, ownerId: string, labels: readonly string[], color: string = "blue"): Promise<string[]> {
  if (labels.length === 0) return [];
  const rows = await db
    .insert(tags)
    .values(labels.map(name => ({ ownerId, name, color: color as (typeof TAG_COLORS)[number] })))
    .returning({ id: tags.id });
  return rows.map(r => r.id);
}
async function attach(db: Db, noteId: string, tagIds: readonly string[]): Promise<void> {
  if (tagIds.length === 0) return;
  await db.insert(noteTags).values(tagIds.map(tagId => ({ noteId, tagId })));
}
const bulkNames = (n: number, prefix = "t"): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);

describe("POST /api/notes/:id/tags", () => {
  it("the owner adds a new name: 200 with one tag colored blue, stored in the owner's personal space with created_by", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const res = await addTag(app, alice.id, n.id, { name: "aws" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as NoteTagsDto;
    expect(body.tags).toEqual([{ id: expect.any(String), name: "aws", color: "blue" }]);

    const rows = await tagRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.tags[0]!.id, ownerId: alice.id, groupId: null, name: "aws", nameKey: "aws", color: "blue", createdBy: alice.id });
    expect(await noteTagRows(db, n.id)).toHaveLength(1);
  });

  it("' aws ' then 'AWS' attach the same tag once and keep the name 'aws'; a full-width space is trimmed too", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const first = await addTag(app, alice.id, n.id, { name: " aws " });
    expect(first.statusCode, first.body).toBe(200);
    for (const variant of ["AWS", "　Aws　"]) {
      const again = await addTag(app, alice.id, n.id, { name: variant });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual(first.json());
    }
    expect(names(await tagRows(db))).toEqual(["aws"]);
    expect(await noteTagRows(db, n.id)).toHaveLength(1);
  });

  it("POST /api/notes/:id/tags answers with the attached tag, also when it was already on the note", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await addTag(app, alice.id, n.id, { name: "first" });

    const created = await addTag(app, alice.id, n.id, { name: " Second " });
    expect(created.statusCode, created.body).toBe(200);
    const body = created.json() as NoteTagsDto & { tag: { id: string; name: string; color: string } };
    expect(body.tags.map(t => t.name)).toEqual(["first", "Second"]);
    expect(body.tag).toEqual(body.tags[1]);

    const again = await addTag(app, alice.id, n.id, { name: "SECOND" });
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as typeof body).tag).toEqual(body.tag);
    const removed = await removeTag(app, alice.id, n.id, body.tag.id);
    expect("tag" in (removed.json() as object)).toBe(false);
  });

  it("the second new tag in a space is green; the tenth takes the least-used color", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const colors: string[] = [];
    for (let i = 1; i <= 11; i++) {
      const res = await addTag(app, alice.id, n.id, { name: `tag ${i}` });
      expect(res.statusCode, res.body).toBe(200);
      colors.push((res.json() as NoteTagsDto).tags.at(-1)!.color);
    }
    // Nine colors, then blue again (all used once, palette order breaks the tie), then green (blue is used twice).
    expect(colors).toEqual([...TAG_COLORS, "blue", "green"]);
  });

  it("a group member whose role can edit adds a group tag; a role without edit gets 403 forbidden; a non-member gets 404 not_found", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const carol = await seedUser(db, { displayName: "Carol" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }, { userId: bob.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g.id });
    const readOnly = await seedRole(db, g.id, "readers", { canRead: true });
    await setMemberRole(db, g.id, bob.id, readOnly);

    const ok = await addTag(app, alice.id, n.id, { name: "ops" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await tagRows(db)).toMatchObject([{ ownerId: null, groupId: g.id, name: "ops", createdBy: alice.id }]);

    const noEdit = await addTag(app, bob.id, n.id, { name: "other" });
    expect(noEdit.statusCode, noEdit.body).toBe(403);
    expect((noEdit.json() as { error: { code: string } }).error.code).toBe("forbidden");
    const outsider = await addTag(app, carol.id, n.id, { name: "other" });
    expect(outsider.statusCode, outsider.body).toBe(404);
    expect((outsider.json() as { error: { code: string } }).error.code).toBe("not_found");
    expect(names(await tagRows(db))).toEqual(["ops"]);
  });

  it("an edit share and a view share on a personal note both get 403 forbidden and no tag row is created", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const carol = await seedUser(db, { displayName: "Carol" });
    const n = await seedNote(db, { ownerId: alice.id });
    await seedShare(db, n.id, bob.id, "editor");
    await seedShare(db, n.id, carol.id, "viewer");

    for (const who of [bob, carol]) {
      const res = await addTag(app, who.id, n.id, { name: "mine" });
      expect(res.statusCode, res.body).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    }
    expect(await tagRows(db)).toEqual([]);
    expect(await noteTagRows(db)).toEqual([]);
  });

  it("a trashed note is 404 not_found; a malformed id is 404 and isn't charged", async () => {
    const { app, db } = await buildTestApp({ limiters: { tag: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const alice = await seedUser(db, { displayName: "Alice" });
    const live = await seedNote(db, { ownerId: alice.id });
    const trashed = await seedNote(db, { ownerId: alice.id });
    await markTrashed(db.$client, trashed.id, alice.id);

    for (const id of ["not-a-uuid", randomUUID()]) {
      const res = await addTag(app, alice.id, id, { name: "x" });
      expect(res.statusCode, res.body).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe("not_found");
    }
    const inTrash = await addTag(app, alice.id, trashed.id, { name: "x" });
    expect(inTrash.statusCode, inTrash.body).toBe(404);
    expect((inTrash.json() as { error: { code: string } }).error.code).toBe("not_found");
    expect(await tagRows(db)).toEqual([]);

    // None of the 404s above drew the single-call budget.
    expect((await addTag(app, alice.id, live.id, { name: "x" })).statusCode).toBe(200);
  });

  it("'', blank, 41 code points, NUL, newline and a lone surrogate are 400 invalid_tag_name; 40 emoji code points are accepted", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    for (const bad of ["", "   ", "　", "a".repeat(41), "😀".repeat(41), "a\u0000b", "a\nb", "a\ud800b"]) {
      const res = await addTag(app, alice.id, n.id, { name: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code, JSON.stringify(bad)).toBe("invalid_tag_name");
    }
    expect(await tagRows(db)).toEqual([]);

    const emoji = "😀".repeat(40);
    const ok = await addTag(app, alice.id, n.id, { name: emoji });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as NoteTagsDto).tags[0]!.name).toBe(emoji);
    expect((await addTag(app, alice.id, n.id, { name: "a".repeat(40) })).statusCode).toBe(200);
  });

  it("the 51st tag on a note is 409 tag_limit_reached; the 1001st new tag in a space is 409 tag_limit_reached, attaching an existing one still works", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const full = await seedNote(db, { ownerId: alice.id });
    const other = await seedNote(db, { ownerId: alice.id });
    const ids = await seedPersonalTags(db, alice.id, bulkNames(TAGS_PER_NOTE_MAX + 1));
    await attach(db, full.id, ids.slice(0, TAGS_PER_NOTE_MAX));

    // Already on the note: nothing to add, so the limit doesn't apply.
    const already = await addTag(app, alice.id, full.id, { name: "t0000" });
    expect(already.statusCode, already.body).toBe(200);
    // Existing tag not yet on it, and a brand-new name: both would be the 51st.
    for (const name of ["t0050", "brand new"]) {
      const res = await addTag(app, alice.id, full.id, { name });
      expect(res.statusCode, name).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe("tag_limit_reached");
    }
    expect(await noteTagRows(db, full.id)).toHaveLength(TAGS_PER_NOTE_MAX);
    expect(names(await tagRows(db))).not.toContain("brand new");

    // Fill the space: 1000 tags in total.
    await seedPersonalTags(db, alice.id, bulkNames(TAGS_PER_SPACE_MAX - (TAGS_PER_NOTE_MAX + 1), "s"));
    expect(await tagRows(db)).toHaveLength(TAGS_PER_SPACE_MAX);
    const over = await addTag(app, alice.id, other.id, { name: "one too many" });
    expect(over.statusCode, over.body).toBe(409);
    expect((over.json() as { error: { code: string } }).error.code).toBe("tag_limit_reached");
    expect(await tagRows(db)).toHaveLength(TAGS_PER_SPACE_MAX);
    const reuse = await addTag(app, alice.id, other.id, { name: "T0050" });
    expect(reuse.statusCode, reuse.body).toBe(200);
  });

  it("a body other than {name: string} is 400 invalid_body", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    for (const body of [{}, { name: 1 }, { name: null }, { name: "a", extra: true }, []]) {
      const res = await addTag(app, alice.id, n.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code, JSON.stringify(body)).toBe("invalid_body");
    }
    const noBody = await app.inject({ method: "POST", url: `/api/notes/${n.id}/tags`, cookies: await cookieOf(alice.id) });
    expect(noBody.statusCode, noBody.body).toBe(400);
    expect(await tagRows(db)).toEqual([]);
  });

  it("doesn't change notes.updated_at, note_states.version, versionPendingAt or note_ai_edits", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await db.insert(noteStates).values({ noteId: n.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 7 });
    const snapshot = async () => {
      const [note] = await db.$client.query(
        "select updated_at::text as updated_at, version_pending_at::text as pending, last_edited_at::text as last_edited from notes where id = $1",
        [n.id],
      ).then(r => r.rows);
      const [state] = await db.select({ version: noteStates.version, updatedAt: noteStates.updatedAt }).from(noteStates).where(eq(noteStates.noteId, n.id));
      const edits = await db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, n.id));
      return { note, state, edits };
    };
    const before = await snapshot();

    expect((await addTag(app, alice.id, n.id, { name: "a" })).statusCode).toBe(200);
    const tagId = ((await addTag(app, alice.id, n.id, { name: "b" })).json() as NoteTagsDto).tags[1]!.id;
    expect((await removeTag(app, alice.id, n.id, tagId)).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it("charges TAG_LIMIT only after authorization; an exhausted limiter answers 429", async () => {
    const { app, db } = await buildTestApp({ limiters: { tag: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const mine = await seedNote(db, { ownerId: alice.id });
    const bobs = await seedNote(db, { ownerId: bob.id });
    await seedShare(db, bobs.id, alice.id, "editor");

    // Rejected before the charge: bad id, bad body, bad name, no access (404), no right (403).
    expect((await addTag(app, alice.id, "nope", { name: "x" })).statusCode).toBe(404);
    expect((await addTag(app, alice.id, mine.id, { nope: 1 })).statusCode).toBe(400);
    expect((await addTag(app, alice.id, mine.id, { name: "" })).statusCode).toBe(400);
    expect((await addTag(app, alice.id, randomUUID(), { name: "x" })).statusCode).toBe(404);
    expect((await addTag(app, alice.id, bobs.id, { name: "x" })).statusCode).toBe(403);
    expect((await removeTag(app, alice.id, "nope", randomUUID())).statusCode).toBe(404);
    expect((await removeTag(app, alice.id, mine.id, "nope")).statusCode).toBe(404);

    expect((await addTag(app, alice.id, mine.id, { name: "one" })).statusCode).toBe(200);
    expect((await addTag(app, alice.id, mine.id, { name: "two" })).statusCode).toBe(200);
    const over = await addTag(app, alice.id, mine.id, { name: "three" });
    expect(over.statusCode, over.body).toBe(429);
    expect((over.json() as { error: { code: string } }).error.code).toBe("too_many_requests");
    const overDelete = await removeTag(app, alice.id, mine.id, randomUUID());
    expect(overDelete.statusCode, overDelete.body).toBe(429);
    expect(names(await tagRows(db))).toEqual(["one", "two"]);
    // The bucket is per person.
    expect((await addTag(app, bob.id, bobs.id, { name: "bobs" })).statusCode).toBe(200);
  });

  it("a move into a group committed after authorization ends in 409 conflict and leaves no note_tags row in the old space", async () => {
    const seam: { db?: Db; noteId?: string; groupId?: string } = {};
    const points: string[] = [];
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        points.push(point);
        if (point !== "tag-note-authorized") return;
        await seam.db!.update(notes).set({ ownerId: null, groupId: seam.groupId! }).where(eq(notes.id, seam.noteId!));
      },
    });
    seam.db = db;
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: alice.id });
    seam.noteId = n.id;
    seam.groupId = g.id;

    const res = await addTag(app, alice.id, n.id, { name: "late" });
    expect(points).toEqual(["tag-note-authorized"]);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("conflict");
    expect(await noteTagRows(db)).toEqual([]);
    expect(await tagRows(db)).toEqual([]);
  });
});

describe("DELETE /api/notes/:id/tags/:tagId", () => {
  it("removes the tag from the note, returns the rest, and keeps the tag row and other notes' rows", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const bystander = await seedNote(db, { ownerId: alice.id });
    const res1 = (await addTag(app, alice.id, n.id, { name: "keep" })).json() as NoteTagsDto;
    const res2 = (await addTag(app, alice.id, n.id, { name: "drop" })).json() as NoteTagsDto;
    const [keep, drop] = res2.tags;
    expect(res1.tags).toHaveLength(1);
    await attach(db, bystander.id, [drop!.id]);

    const res = await removeTag(app, alice.id, n.id, drop!.id.toUpperCase());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ tags: [keep] });
    expect(await tagRows(db)).toHaveLength(2);
    expect((await noteTagRows(db, n.id)).map(r => r.tagId)).toEqual([keep!.id]);
    expect((await noteTagRows(db, bystander.id)).map(r => r.tagId)).toEqual([drop!.id]);
  });

  it("a tag that isn't on the note answers 200 with the tags unchanged; a malformed tagId is 404 tag_not_found", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const [stray] = await seedPersonalTags(db, alice.id, ["stray"]);
    const added = { tags: (await addTag(app, alice.id, n.id, { name: "on" })).json().tags } as NoteTagsDto;

    const absent = await removeTag(app, alice.id, n.id, stray!);
    expect(absent.statusCode, absent.body).toBe(200);
    expect(absent.json()).toEqual(added);
    const unknown = await removeTag(app, alice.id, n.id, randomUUID());
    expect(unknown.statusCode, unknown.body).toBe(200);

    const bad = await removeTag(app, alice.id, n.id, "not-a-uuid");
    expect(bad.statusCode, bad.body).toBe(404);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("tag_not_found");
  });

  it("DELETE draws no budget when the note can't be seen (404) or the caller may not change its tags (403)", async () => {
    const { app, db } = await buildTestApp({ limiters: { tag: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const bobs = await seedNote(db, { ownerId: bob.id });
    const mine = await seedNote(db, { ownerId: alice.id });
    await seedShare(db, bobs.id, alice.id, "editor");
    const [t] = await seedPersonalTags(db, alice.id, ["x"]);

    const unseen = await removeTag(app, alice.id, randomUUID(), t!);
    expect(unseen.statusCode).toBe(404);
    const unseenReal = await removeTag(app, alice.id, (await seedNote(db, { ownerId: bob.id })).id, t!);
    expect(unseenReal.statusCode).toBe(404);
    const noRight = await removeTag(app, alice.id, bobs.id, t!);
    expect(noRight.statusCode).toBe(403);
    const ok = await removeTag(app, alice.id, mine.id, t!);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await removeTag(app, alice.id, mine.id, t!)).statusCode).toBe(429);
  });

  it("an edit share gets 403 forbidden and the row stays; a trashed note is 404", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const n = await seedNote(db, { ownerId: alice.id });
    const t = ((await addTag(app, alice.id, n.id, { name: "mine" })).json() as NoteTagsDto).tags[0]!;
    await seedShare(db, n.id, bob.id, "editor");

    const res = await removeTag(app, bob.id, n.id, t.id);
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("forbidden");
    expect(await noteTagRows(db, n.id)).toHaveLength(1);

    await markTrashed(db.$client, n.id, alice.id);
    expect((await removeTag(app, alice.id, n.id, t.id)).statusCode).toBe(404);
    expect(await noteTagRows(db, n.id)).toHaveLength(1);
  });
});

describe("GET /api/notes tags", () => {
  it("each row carries its tags in the order they were added; a note without tags has []", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const tagged = await seedNote(db, { ownerId: alice.id });
    const bare = await seedNote(db, { ownerId: alice.id });
    for (const name of ["zulu", "alpha", "mike"]) expect((await addTag(app, alice.id, tagged.id, { name })).statusCode).toBe(200);

    const rows = await listNotes(app, alice.id);
    expect(names(rows.find(r => r.id === tagged.id)!.tags!)).toEqual(["zulu", "alpha", "mike"]);
    expect(rows.find(r => r.id === bare.id)!.tags).toEqual([]);
  });

  it("a share viewer sees the owner's tags on the shared note, while GET /api/tags lists only the viewer's own space", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const n = await seedNote(db, { ownerId: alice.id });
    await addTag(app, alice.id, n.id, { name: "internal" });
    await seedShare(db, n.id, bob.id, "viewer");

    const seen = (await listNotes(app, bob.id)).find(r => r.id === n.id)!;
    expect(names(seen.tags!)).toEqual(["internal"]);
    expect(await spaceTags(app, bob.id)).toEqual([]);
    expect(names(await spaceTags(app, alice.id))).toEqual(["internal"]);
  });

  it("a note_tags row whose tag belongs to another space isn't returned", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const personal = await seedNote(db, { ownerId: alice.id });
    const grouped = await seedNote(db, { groupId: g.id });
    const [own] = await seedPersonalTags(db, alice.id, ["own"]);
    const [foreign] = await seedPersonalTags(db, bob.id, ["foreign"]);
    const [inGroup] = await db.insert(tags).values({ groupId: g.id, name: "garden", color: "blue" }).returning({ id: tags.id });
    await attach(db, personal.id, [own!, foreign!, inGroup!.id]);
    await attach(db, grouped.id, [own!, foreign!, inGroup!.id]);

    const rows = await listNotes(app, alice.id);
    expect(names(rows.find(r => r.id === personal.id)!.tags!)).toEqual(["own"]);
    expect(names(rows.find(r => r.id === grouped.id)!.tags!)).toEqual(["garden"]);
  });

  it("a request with a bearer token gets tags too; GET /api/notes/:id has no tags key", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await addTag(app, alice.id, n.id, { name: "agentic" });
    const { token } = await seedTokenForUser(db, alice.id, "notes:read");

    const res = await app.inject({ method: "GET", url: "/api/notes", headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(names((res.json() as NoteDto[])[0]!.tags!)).toEqual(["agentic"]);

    const single = await inject(app, "GET", `/api/notes/${n.id}`, alice.id);
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json()).not.toHaveProperty("tags");
  });

  it("notesHavingAllTagsSql as extraWhere of visibleNoteBranches keeps only notes having every given tag", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const both = await seedNote(db, { ownerId: alice.id });
    const onlyA = await seedNote(db, { ownerId: alice.id });
    const none = await seedNote(db, { ownerId: alice.id });
    const groupBoth = await seedNote(db, { groupId: g.id });
    const [a, b] = await seedPersonalTags(db, alice.id, ["a", "b"]);
    const [ga, gb] = (await db.insert(tags).values([{ groupId: g.id, name: "a", color: "blue" }, { groupId: g.id, name: "b", color: "green" }]).returning({ id: tags.id })).map(r => r.id);
    await attach(db, both.id, [a!, b!]);
    await attach(db, onlyA.id, [a!]);
    await attach(db, groupBoth.id, [ga!, gb!]);
    void app;

    const run = async (ids: string[]): Promise<string[]> => {
      const { owned, shared, grouped } = visibleNoteBranches(db, alice.id, { extraWhere: notesHavingAllTagsSql(ids) });
      return (await unionAll(owned, shared, grouped)).map(r => r.id).sort();
    };
    expect(await run([a!, b!, a!.toUpperCase()])).toEqual([both.id]);
    expect(await run([a!])).toEqual([both.id, onlyA.id].sort());
    expect(await run([ga!, gb!])).toEqual([groupBoth.id]);
    // A tag of one space never matches a note of another.
    expect(await run([a!, gb!])).toEqual([]);
    // A leftover row pointing at another space's tag doesn't make a note match either.
    const [foreign] = await seedPersonalTags(db, (await seedUser(db, { displayName: "Bob" })).id, ["foreign"]);
    await attach(db, none.id, [foreign!]);
    expect(await run([foreign!])).toEqual([]);
    expect(await run([])).toEqual([both.id, groupBoth.id, none.id, onlyA.id].sort());
  });
});

describe("space tag lists", () => {
  it("GET /api/tags is sorted case-insensitively and noteCount leaves out trashed notes; restoring the note brings its tags back", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const live = await seedNote(db, { ownerId: alice.id });
    const doomed = await seedNote(db, { ownerId: alice.id });
    const bobs = await seedNote(db, { ownerId: bob.id });
    for (const name of ["banana", "Apple", "cherry"]) await addTag(app, alice.id, live.id, { name });
    await addTag(app, alice.id, doomed.id, { name: "banana" });
    await addTag(app, alice.id, doomed.id, { name: "cherry" });
    await addTag(app, bob.id, bobs.id, { name: "banana" });

    const before = await spaceTags(app, alice.id);
    expect(before.map(t => [t.name, t.noteCount])).toEqual([["Apple", 1], ["banana", 2], ["cherry", 2]]);
    expect(Object.keys(before[0]!).sort()).toEqual(["color", "id", "name", "noteCount"]);

    await markTrashed(db.$client, doomed.id, alice.id);
    expect((await spaceTags(app, alice.id)).map(t => [t.name, t.noteCount])).toEqual([["Apple", 1], ["banana", 1], ["cherry", 1]]);
    expect(await noteTagRows(db, doomed.id)).toHaveLength(2);

    await markRestored(db.$client, doomed.id);
    expect((await spaceTags(app, alice.id)).map(t => [t.name, t.noteCount])).toEqual([["Apple", 1], ["banana", 2], ["cherry", 2]]);
    const restored = (await listNotes(app, alice.id)).find(r => r.id === doomed.id)!;
    expect(names(restored.tags!)).toEqual(["banana", "cherry"]);
  });

  it("GET /api/groups/:id/tags: member with edit 200, manager without edit 200, member with neither 403, non-member 404, non-member site admin 200", async () => {
    const { app, db } = await buildTestApp();
    const editor = await seedUser(db, { displayName: "Alice" });
    const manager = await seedUser(db, { displayName: "Bob" });
    const reader = await seedUser(db, { displayName: "Carol" });
    const outsider = await seedUser(db, { displayName: "Dave" });
    const siteAdmin = await seedUser(db, { displayName: "Erin", isAdmin: true });
    const g = await seedGroup(db, "Garden", [
      { userId: editor.id, role: "member" },
      { userId: manager.id, role: "member" },
      { userId: reader.id, role: "member" },
    ]);
    await setMemberRole(db, g.id, manager.id, await seedRole(db, g.id, "managers", { canRead: true, canManageGroup: true }));
    await setMemberRole(db, g.id, reader.id, await seedRole(db, g.id, "readers", { canRead: true }));
    const n = await seedNote(db, { groupId: g.id });
    await addTag(app, editor.id, n.id, { name: "ops" });
    const url = `/api/groups/${g.id}/tags`;

    for (const who of [editor, manager, siteAdmin]) {
      const res = await inject(app, "GET", url, who.id);
      expect(res.statusCode, who.id).toBe(200);
      expect((res.json() as SpaceTagDto[]).map(t => [t.name, t.noteCount])).toEqual([["ops", 1]]);
    }
    const forbidden = await inject(app, "GET", url, reader.id);
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect((forbidden.json() as { error: { code: string } }).error.code).toBe("forbidden");
    for (const target of [url, `/api/groups/${randomUUID()}/tags`, "/api/groups/not-a-uuid/tags"]) {
      const res = await inject(app, "GET", target, outsider.id);
      expect(res.statusCode, target).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe("not_found");
    }
    expect((await inject(app, "GET", url, null)).statusCode).toBe(401);
  });

  it("noteCount counts only notes of the tag's own space", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const personal = await seedNote(db, { ownerId: alice.id });
    const grouped = await seedNote(db, { groupId: g.id });
    const [t] = await seedPersonalTags(db, alice.id, ["leaky"]);
    await attach(db, personal.id, [t!]);
    await attach(db, grouped.id, [t!]);

    expect((await spaceTags(app, alice.id)).map(x => x.noteCount)).toEqual([1]);
  });
});

describe("setNoteTagsByNamesInTx", () => {
  const set = (db: Db, input: { noteId: string; ownerId: string | null; groupId: string | null; names: string[]; createdBy: string }): Promise<NoteTagsResult> =>
    db.transaction(tx =>
      setNoteTagsByNamesInTx(tx, {
        noteId: input.noteId,
        expected: { ownerId: input.ownerId, groupId: input.groupId },
        names: input.names,
        createdBy: input.createdBy,
      }),
    );

  it("replaces the note's tags by names, creating missing ones and keeping existing colors and spelling", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const bystander = await seedNote(db, { ownerId: alice.id });
    const [old, kept] = await seedPersonalTags(db, alice.id, ["old", "AWS"], "red");
    await attach(db, n.id, [old!]);
    await attach(db, bystander.id, [old!, kept!]);

    const out = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["aws", "Brand New"], createdBy: alice.id });
    expect(out.kind).toBe("ok");
    const got = (out as Extract<NoteTagsResult, { kind: "ok" }>).tags;
    expect(got).toEqual([
      { id: kept, name: "AWS", color: "red" },
      { id: expect.any(String), name: "Brand New", color: "blue" },
    ]);
    expect(await loadNoteTagNames(db, n.id)).toEqual(["AWS", "Brand New"]);
    // The tag taken off the note still exists, and another note keeps its rows.
    expect(names(await tagRows(db)).sort()).toEqual(["AWS", "Brand New", "old"]);
    expect(await noteTagRows(db, bystander.id)).toHaveLength(2);
  });

  it("deduplicates names case-insensitively; an empty list removes every tag without touching other notes", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const bystander = await seedNote(db, { ownerId: alice.id });
    const ids = await seedPersonalTags(db, alice.id, ["x", "y"]);
    await attach(db, bystander.id, ids);

    const deduped = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["Same", "same", " SAME "], createdBy: alice.id });
    expect((deduped as Extract<NoteTagsResult, { kind: "ok" }>).tags.map(t => t.name)).toEqual(["Same"]);
    expect(await noteTagRows(db, n.id)).toHaveLength(1);

    const cleared = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: [], createdBy: alice.id });
    expect(cleared).toEqual({ kind: "ok", tags: [] });
    expect(await noteTagRows(db, n.id)).toEqual([]);
    expect(await noteTagRows(db, bystander.id)).toHaveLength(2);
  });

  it("an invalid name returns invalid_tag_name with the original string and writes nothing", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const [old] = await seedPersonalTags(db, alice.id, ["old"]);
    await attach(db, n.id, [old!]);

    const out = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["fine", "  ", "also fine"], createdBy: alice.id });
    expect(out).toEqual({ kind: "invalid_tag_name", name: "  " });
    const control = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["fine", "bad\u0001"], createdBy: alice.id });
    expect(control).toEqual({ kind: "invalid_tag_name", name: "bad\u0001" });
    expect(names(await tagRows(db))).toEqual(["old"]);
    expect((await noteTagRows(db, n.id)).map(r => r.tagId)).toEqual([old]);
  });

  it("a group id that no longer matches returns conflict; a trashed note returns not_found", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const personal = await seedNote(db, { ownerId: alice.id });
    const other = await seedGroup(db, "Orchard", [{ userId: alice.id, role: "member" }]);
    const grouped = await seedNote(db, { groupId: g.id });
    const trashed = await seedNote(db, { ownerId: alice.id });
    await markTrashed(db.$client, trashed.id, alice.id);

    // Authorized as a personal note, but it now belongs to the group (and the other way round); only the owner side differs in the last one.
    expect((await set(db, { noteId: grouped.id, ownerId: alice.id, groupId: null, names: ["a"], createdBy: alice.id })).kind).toBe("conflict");
    expect((await set(db, { noteId: personal.id, ownerId: null, groupId: g.id, names: ["a"], createdBy: alice.id })).kind).toBe("conflict");
    expect((await set(db, { noteId: personal.id, ownerId: randomUUID(), groupId: null, names: ["a"], createdBy: alice.id })).kind).toBe("conflict");
    expect((await set(db, { noteId: grouped.id, ownerId: null, groupId: other.id, names: ["a"], createdBy: alice.id })).kind).toBe("conflict");
    expect((await set(db, { noteId: trashed.id, ownerId: alice.id, groupId: null, names: ["a"], createdBy: alice.id })).kind).toBe("not_found");
    expect((await set(db, { noteId: randomUUID(), ownerId: alice.id, groupId: null, names: ["a"], createdBy: alice.id })).kind).toBe("not_found");
    // The group itself is gone: nothing to lock.
    expect((await set(db, { noteId: grouped.id, ownerId: null, groupId: randomUUID(), names: ["a"], createdBy: alice.id })).kind).toBe("not_found");
    expect(await tagRows(db)).toEqual([]);
  });

  it("new names keep the input order on the note even though they are written in one transaction", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const out = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["zulu", "alpha", "mike", "bravo"], createdBy: alice.id });
    expect(out.kind).toBe("ok");
    expect(await loadNoteTagNames(db, n.id)).toEqual(["zulu", "alpha", "mike", "bravo"]);
    // Tags that were already on the note keep their position; the new ones go after them in input order.
    const again = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["yankee", "mike", "xray", "zulu"], createdBy: alice.id });
    expect(again.kind).toBe("ok");
    expect(await loadNoteTagNames(db, n.id)).toEqual(["zulu", "mike", "yankee", "xray"]);
  });

  it("names that are distinct in JS but share a name_key in the database end up as one tag, without an error", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    // JS lowercases a word-final capital sigma to the final form, PostgreSQL lower() does not.
    const pair = ["ΑΣ", "ασ"];
    expect(pair[0]!.toLowerCase()).not.toBe(pair[1]!.toLowerCase());
    const { rows } = await db.$client.query("select lower($1) = lower($2) as same", pair);
    expect(rows[0].same, "the test database must fold Greek capitals").toBe(true);

    const out = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: pair, createdBy: alice.id });
    expect(out.kind).toBe("ok");
    expect(await tagRows(db)).toHaveLength(1);
    expect(await noteTagRows(db, n.id)).toHaveLength(1);
  });

  it("past TAGS_PER_SPACE_MAX it returns tag_limit_reached and writes nothing", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    await seedPersonalTags(db, alice.id, bulkNames(TAGS_PER_SPACE_MAX - 1));

    const out = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["fresh one", "fresh two"], createdBy: alice.id });
    expect(out).toMatchObject({ kind: "tag_limit_reached" });
    expect(await tagRows(db)).toHaveLength(TAGS_PER_SPACE_MAX - 1);
    expect(await noteTagRows(db, n.id)).toEqual([]);

    const fits = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: ["fresh one", "t0000"], createdBy: alice.id });
    expect(fits.kind).toBe("ok");
    expect(await tagRows(db)).toHaveLength(TAGS_PER_SPACE_MAX);
  });

  it("more than TAGS_PER_NOTE_MAX distinct names returns tag_limit_reached and writes nothing", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const out = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: bulkNames(TAGS_PER_NOTE_MAX + 1), createdBy: alice.id });
    expect(out).toMatchObject({ kind: "tag_limit_reached", limit: TAGS_PER_NOTE_MAX });
    expect(await tagRows(db)).toEqual([]);
    const exact = await set(db, { noteId: n.id, ownerId: alice.id, groupId: null, names: bulkNames(TAGS_PER_NOTE_MAX), createdBy: alice.id });
    expect(exact.kind).toBe("ok");
  });

  it("addNoteTagInTx ignores cross-space leftovers when counting a note's tags", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const bob = await seedUser(db, { displayName: "Bob" });
    const n = await seedNote(db, { ownerId: alice.id });
    const foreign = await seedPersonalTags(db, bob.id, bulkNames(TAGS_PER_NOTE_MAX, "f"));
    await attach(db, n.id, foreign);

    const out = await db.transaction(tx => addNoteTagInTx(tx, { noteId: n.id, expected: { ownerId: alice.id, groupId: null }, name: "mine", createdBy: alice.id }));
    const mine = { id: expect.any(String), name: "mine", color: "blue" };
    expect(out).toEqual({ kind: "ok", tags: [mine], tag: mine });
  });
});

describe("finishAdd", () => {
  // The race itself (a delete between two statements of one transaction) has no test seam, so the state it leaves behind is built directly.
  it("answers conflict when the tag is no longer on the note", async () => {
    const { db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });
    const out = await db.transaction(tx => finishAdd(tx, n.id, randomUUID()));
    expect(out).toEqual({ kind: "conflict" });
  });
});

describe("note row locking", () => {
  it("tagging waits for a transaction that holds FOR UPDATE on the note (a move) and then reports the changed space", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: alice.id });

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from notes where id = $1 for update", [n.id]);
      const pending = addTag(app, alice.id, n.id, { name: "waits" });
      expect(await waitForBlockedOrSettled(db.$client, pending)).toBe("blocked");
      await holder.query("update notes set owner_id = null, group_id = $2 where id = $1", [n.id, g.id]);
      await holder.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe("conflict");
    } finally {
      holder.release();
    }
    expect(await tagRows(db)).toEqual([]);
    expect(await noteTagRows(db)).toEqual([]);
  });

  it("creating a group tag while another transaction does 'groups FOR UPDATE -> the group's notes FOR UPDATE' (group delete shape): the other waits for the tag transaction, both complete, no 40P01", async () => {
    const holder: { db?: Db; groupId?: string; other?: Promise<string>; interleave?: string } = {};
    const { app, db } = await buildTestApp({
      groupTestHook: async point => {
        if (point !== "tag-note-locked" || holder.other) return;
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
    const alice = await seedUser(db, { displayName: "Alice" });
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "member" }]);
    Object.assign(holder, { db, groupId: g.id });
    const n = await seedNote(db, { groupId: g.id });

    const res = await addTag(app, alice.id, n.id, { name: "fresh" });

    expect(holder.interleave).toBe("blocked");
    expect(res.statusCode, res.body).toBe(200);
    expect(await holder.other!).toBe("committed");
    expect(names(await tagRows(db))).toEqual(["fresh"]);
  });

  it("tagging doesn't wait for a content save (FOR NO KEY UPDATE on the note)", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id });

    const holder = await db.$client.connect();
    try {
      await holder.query("begin");
      await holder.query("update notes set title = 'saving' where id = $1", [n.id]);
      const outcome = await Promise.race([addTag(app, alice.id, n.id, { name: "free" }), sleep(5_000).then(() => "stuck" as const)]);
      expect(outcome).not.toBe("stuck");
      expect((outcome as LightMyRequestResponse).statusCode).toBe(200);
      await holder.query("commit");
    } finally {
      holder.release();
    }
  });
});

describe("public notes", () => {
  it("a public note's response doesn't contain its tag names", async () => {
    const { app, db } = await buildTestApp();
    const alice = await seedUser(db, { displayName: "Alice" });
    const n = await seedNote(db, { ownerId: alice.id }, { title: "Open page" });
    await db.insert(noteStates).values({ noteId: n.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
    expect((await addTag(app, alice.id, n.id, { name: "PublicLeakProbe" })).statusCode).toBe(200);
    const link = await inject(app, "PUT", `/api/notes/${n.id}/public-link`, alice.id);
    expect(link.statusCode, link.body).toBe(200);
    const token = (link.json() as { token: string }).token;

    const res = await app.inject({ method: "GET", url: `/api/public/notes/${token}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("PublicLeakProbe");
    expect(res.body.toLowerCase()).not.toContain("tags");
  });
});

