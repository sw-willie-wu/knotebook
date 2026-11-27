import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { commentNotified, noteCommentMentions, noteCommentReads, noteComments, notifications } from "../src/db/schema.js";
import { actorOf, post, seedNamedUser } from "./comment-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare } from "./group-helpers.js";
import { buildTestApp } from "./helpers.js";
import { inject } from "./trash-helpers.js";

async function scene() {
  const { app, db } = await buildTestApp();
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
  const note = await seedNote(db, { ownerId: alice.id });
  await seedShare(db, note.id, bob.id, "editor");
  const c = (await post(db, { noteId: note.id, actor: actorOf(alice), body: "hello @bob" })).comment;
  await post(db, { noteId: note.id, actor: actorOf(bob), body: "ok", replyToId: c.id });
  await db.insert(noteCommentReads).values({ userId: alice.id, noteId: note.id, readAt: new Date() });
  return { app, db, alice, bob, groupId: g.id, noteId: note.id };
}

const rowCounts = async (db: Db, noteId: string) => ({
  comments: (await db.select().from(noteComments).where(eq(noteComments.noteId, noteId))).length,
  mentions: (await db.select().from(noteCommentMentions)).length,
  notified: (await db.select().from(commentNotified)).length,
  notifications: (await db.select().from(notifications)).length,
  reads: (await db.select().from(noteCommentReads).where(eq(noteCommentReads.noteId, noteId))).length,
});

const move = async (app: FastifyInstance, userId: string, noteId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/notes/${noteId}/move`, cookies: await cookieOf(userId), payload });

describe("moving a note into a group", () => {
  it("without keepHistory (omitted or false) the note's comments, mentions, notified rows and notifications are deleted", async () => {
    for (const payload of [{}, { keepHistory: false }]) {
      const { app, db, alice, groupId, noteId } = await scene();
      expect(await rowCounts(db, noteId)).toMatchObject({ comments: 2, mentions: 1, notified: 2, notifications: 2 });
      const res = await move(app, alice.id, noteId, { groupId, ...payload });
      expect(res.statusCode, res.body).toBe(200);
      expect(await rowCounts(db, noteId)).toEqual({ comments: 0, mentions: 0, notified: 0, notifications: 0, reads: 0 });
    }
  });

  it("other notes' comments are untouched", async () => {
    const { app, db, alice, groupId, noteId } = await scene();
    const other = await seedNote(db, { ownerId: alice.id });
    await post(db, { noteId: other.id, actor: actorOf(alice), body: "stays" });
    expect((await move(app, alice.id, noteId, { groupId })).statusCode).toBe(200);
    expect(await db.select().from(noteComments).where(eq(noteComments.noteId, other.id))).toHaveLength(1);
  });

  it("with keepHistory true everything stays", async () => {
    const { app, db, alice, groupId, noteId } = await scene();
    const res = await move(app, alice.id, noteId, { groupId, keepHistory: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rowCounts(db, noteId)).toEqual({ comments: 2, mentions: 1, notified: 2, notifications: 2, reads: 1 });
  });

  it("a failed move (not a member of the group) deletes nothing", async () => {
    const { app, db, bob, groupId, noteId } = await scene();
    const mine = await seedNote(db, { ownerId: bob.id });
    await post(db, { noteId: mine.id, actor: actorOf(bob), body: "mine" });
    expect((await move(app, bob.id, mine.id, { groupId })).statusCode).toBe(404);
    expect(await db.select().from(noteComments).where(eq(noteComments.noteId, mine.id))).toHaveLength(1);
    expect((await rowCounts(db, noteId)).comments).toBe(2);
  });
});

describe("deleting a group with transfer", () => {
  it("the transferred notes keep their comments, mentions and notifications", async () => {
    const { app, db, alice, groupId } = await scene();
    const n = await seedNote(db, { groupId });
    await post(db, { noteId: n.id, actor: actorOf(alice), body: "group talk @alice" });
    const before = await rowCounts(db, n.id);
    const res = await inject(app, "DELETE", `/api/groups/${groupId}`, alice.id, { mode: "transfer", transferTo: alice.id });
    expect(res.statusCode, res.body).toBe(204);
    expect(await rowCounts(db, n.id)).toEqual(before);
    expect(before.comments).toBe(1);
  });
});
