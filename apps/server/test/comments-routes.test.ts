import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { COMMENT_BODY_MAX, type CommentDto, type CommentListDto, type CommentUnreadCountDto, type MentionCandidateDto } from "@knotebook/shared";
import { COMMENT_BODY_LIMIT } from "../src/http/body-limits.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { decodeCursor, encodeCursor } from "../src/comments/queries.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, noteComments, noteShares, notes, notifications, users } from "../src/db/schema.js";
import { actorOf, post, seedAgentToken, seedNamedUser } from "./comment-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedNote, seedRole, seedShare } from "./group-helpers.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { inject, markTrashed, sixRoleScene } from "./trash-helpers.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

async function scene() {
  const fresh = await freshDb();
  const { app, db } = await buildTestApp({ db: fresh.db });
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const carol = await seedNamedUser(db, "carol");
  const note = await seedNote(db, { ownerId: alice.id });
  await seedShare(db, note.id, bob.id, "editor");
  await seedShare(db, note.id, carol.id, "viewer");
  return { app, db, pool: fresh.pool, alice, bob, carol, noteId: note.id };
}

const say = (app: FastifyInstance, user: { id: string } | null, noteId: string, body: unknown): Promise<LightMyRequestResponse> =>
  inject(app, "POST", `/api/notes/${noteId}/comments`, user?.id ?? null, body);
const list = async (app: FastifyInstance, user: { id: string }, noteId: string, query = ""): Promise<CommentListDto> => {
  const res = await inject(app, "GET", `/api/notes/${noteId}/comments${query}`, user.id);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CommentListDto;
};
const bodies = (l: CommentListDto): string[] => l.comments.map(c => c.body);
const errorOf = (res: LightMyRequestResponse): { code: string; message: string } => (res.json() as { error: { code: string; message: string } }).error;

/** Direct inserts spaced one second apart, oldest first, so cursor tests don't depend on write timing. */
async function seedSpaced(db: Db, noteId: string, authorId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const [row] = await db
      .insert(noteComments)
      .values({ noteId, authorId, body: `c${i}`, createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)) })
      .returning({ id: noteComments.id });
    ids.push(row!.id);
  }
  return ids;
}

describe("authentication and who gets in", () => {
  it("no session is 401 on every route, a public link gives nothing, and Bearer is refused on the session-only routes", async () => {
    const { app, db, alice, noteId } = await scene();
    await db.update(notes).set({ publicToken: `tok-${randomUUID().slice(0, 8)}` }).where(eq(notes.id, noteId));
    const [c] = await db.insert(noteComments).values({ noteId, authorId: alice.id, body: "x" }).returning({ id: noteComments.id });
    const { token } = await seedTokenForUser(db, alice.id, "notes:read notes:write");

    const calls: Array<[string, string, unknown?]> = [
      ["GET", `/api/notes/${noteId}/comments`],
      ["GET", `/api/notes/${noteId}/comments/unread-count`],
      ["GET", `/api/comments/${c!.id}`],
      ["POST", `/api/notes/${noteId}/comments`, { body: "hi" }],
      ["PATCH", `/api/comments/${c!.id}`, { body: "hi" }],
      ["DELETE", `/api/comments/${c!.id}`],
      ["POST", `/api/notes/${noteId}/comments/read`, {}],
      ["GET", `/api/notes/${noteId}/mention-candidates`],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as "GET", url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    for (const [method, url, payload] of calls.slice(6)) {
      const res = await app.inject({ method: method as "GET", url, headers: bearer(token), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
      expect(res.statusCode, `Bearer ${method} ${url}`).toBe(401);
    }
    expect(await db.select().from(noteComments)).toHaveLength(1);
  });

  it("a read-only token reads and is refused writes; a write token posts as the person with the agent label, and a person may edit and delete it", async () => {
    const { app, db, alice, noteId } = await scene();
    const read = await seedTokenForUser(db, alice.id, "notes:read");
    const write = await seedTokenForUser(db, alice.id, "notes:read notes:write", "Claude Code");

    const refused = await app.inject({ method: "POST", url: `/api/notes/${noteId}/comments`, headers: bearer(read.token), payload: { body: "hi" } });
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused).code).toBe("insufficient_scope");
    expect((await app.inject({ method: "GET", url: `/api/notes/${noteId}/comments`, headers: bearer(read.token) })).statusCode).toBe(200);

    const made = await app.inject({ method: "POST", url: `/api/notes/${noteId}/comments`, headers: bearer(write.token), payload: { body: "from the agent" } });
    expect(made.statusCode, made.body).toBe(201);
    const dto = made.json() as CommentDto;
    expect(dto).toMatchObject({ authorId: alice.id, authorHandle: "alice", agentLabel: expect.any(String), body: "from the agent", canEdit: true });
    const [row] = await db.select().from(noteComments).where(eq(noteComments.id, dto.id));
    expect(row!.tokenId).toBe(write.tokenId);

    const edited = await inject(app, "PATCH", `/api/comments/${dto.id}`, alice.id, { body: "edited by the person" });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json() as CommentDto).agentLabel).toBe(dto.agentLabel);
    const denied = await app.inject({ method: "DELETE", url: `/api/comments/${dto.id}`, headers: bearer(read.token) });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/comments/${dto.id}`, headers: bearer(write.token) })).statusCode).toBe(204);
  });

  it("someone without access, a bad id and a missing note are the same 404; a trashed note is in_trash only for people with trash rights", async () => {
    const { app, db, pool, alice, bob, carol, noteId } = await scene();
    const dave = await seedNamedUser(db, "dave");
    await say(app, alice, noteId, { body: "hello" });

    const gone = await inject(app, "GET", `/api/notes/${noteId}/comments`, dave.id);
    expect(gone.statusCode).toBe(404);
    for (const id of [MISSING, "not-a-uuid"]) {
      const res = await inject(app, "GET", `/api/notes/${id}/comments`, alice.id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(gone.body);
    }
    expect(errorOf(gone).code).toBe("not_found");

    await markTrashed(pool, noteId, alice.id);
    const owner = await inject(app, "GET", `/api/notes/${noteId}/comments`, alice.id);
    expect(owner.statusCode).toBe(404);
    expect(owner.json()).toMatchObject({ error: { code: "in_trash" }, noteId });
    for (const who of [bob, carol, dave]) {
      const res = await inject(app, "GET", `/api/notes/${noteId}/comments`, who.id);
      expect(res.body, who.handle).toBe(gone.body);
    }
    for (const [method, url, payload] of [
      ["POST", `/api/notes/${noteId}/comments`, { body: "x" }],
      ["GET", `/api/notes/${noteId}/comments/unread-count`],
      ["POST", `/api/notes/${noteId}/comments/read`, {}],
      ["GET", `/api/notes/${noteId}/mention-candidates`],
    ] as const) {
      const res = await inject(app, method, url, alice.id, payload);
      expect(res.statusCode, url).toBe(404);
      expect(errorOf(res).code, url).toBe("in_trash");
    }
    expect(await db.select().from(noteComments)).toHaveLength(1);
  });

  it("losing access hides the text: a removed share can't list or fetch, a comment in the trash is in_trash for the owner and comment_not_found for others", async () => {
    const { app, db, pool, alice, bob, carol, noteId } = await scene();
    const made = (await say(app, alice, noteId, { body: "secret" })).json() as CommentDto;
    expect((await inject(app, "GET", `/api/comments/${made.id}`, bob.id)).statusCode).toBe(200);

    await db.delete(noteShares).where(eq(noteShares.userId, bob.id));
    const res = await inject(app, "GET", `/api/comments/${made.id}`, bob.id);
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe("comment_not_found");
    expect(res.body).not.toContain("secret");
    expect((await inject(app, "GET", `/api/notes/${noteId}/comments`, bob.id)).statusCode).toBe(404);

    await markTrashed(pool, noteId, alice.id);
    const owner = await inject(app, "GET", `/api/comments/${made.id}`, alice.id);
    expect(owner.json()).toMatchObject({ error: { code: "in_trash" }, noteId });
    expect((await inject(app, "DELETE", `/api/comments/${made.id}`, alice.id)).statusCode).toBe(404);
    const viewer = await inject(app, "GET", `/api/comments/${made.id}`, carol.id);
    expect(viewer.statusCode).toBe(404);
    expect(errorOf(viewer).code).toBe("comment_not_found");
  });

  it("on a group note a role that reads can read and post, a role without read and a non-member can't", async () => {
    const { db } = await freshDb();
    const { app } = await buildTestApp({ db });
    const g = await sixRoleScene(db);
    const n = await seedNote(db, { groupId: g.groupId });
    for (const u of [g.admin, g.member, g.editDelete, g.deleteOnly, g.editOnly, g.readOnly]) {
      expect((await say(app, u, n.id, { body: `from ${u.handle}` })).statusCode, u.handle).toBe(201);
    }
    expect((await list(app, g.readOnly, n.id)).comments).toHaveLength(6);
    const blind = await seedNamedUser(db, "blind");
    await db.insert(groupMembers).values({ groupId: g.groupId, userId: blind.id, roleId: await seedRole(db, g.groupId, "blind", {}) });
    for (const u of [blind, g.outsider]) {
      expect((await inject(app, "GET", `/api/notes/${n.id}/comments`, u.id)).statusCode).toBe(404);
      expect((await say(app, u, n.id, { body: "x" })).statusCode).toBe(404);
    }
    // delete: a role with the delete flag may remove another person's comment, one without may not.
    const own = (await say(app, g.member, n.id, { body: "mine" })).json() as CommentDto;
    expect((await inject(app, "DELETE", `/api/comments/${own.id}`, g.editOnly.id)).statusCode).toBe(403);
    expect((await inject(app, "DELETE", `/api/comments/${own.id}`, g.deleteOnly.id)).statusCode).toBe(204);
  });
});

describe("POST /api/notes/:id/comments", () => {
  it("201 with the comment: author, mentions as written, canEdit; the body limit and strict bodies are enforced", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const res = await say(app, alice, noteId, { body: "hi @bob and @nobody" });
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as CommentDto;
    expect(dto).toMatchObject({
      noteId,
      authorId: alice.id,
      authorHandle: "alice",
      authorDisplayName: "Alice",
      agentLabel: null,
      replyToId: null,
      replyTo: null,
      anchor: null,
      body: "hi @bob and @nobody",
      editedAt: null,
      canEdit: true,
      canDelete: true,
    });
    expect(dto.mentions).toEqual([{ start: 3, length: 4, userId: bob.id, handle: "bob", displayName: "Bob", avatar: null, agentLabel: null }]);

    for (const body of [
      { body: "x", extra: 1 },
      { body: 5 },
      { text: "x" },
      { body: "x", anchor: { blockId: "b1", quote: "q", extra: true } },
      { body: "x", replyToId: 7 },
    ]) {
      const bad = await say(app, alice, noteId, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(bad).code).toBe("invalid_body");
    }
    for (const body of [{ body: "" }, { body: "   " }, { body: "a".repeat(COMMENT_BODY_MAX + 1) }, { body: "a\u0000b" }, { body: "x", replyToId: "nope" }, { body: "x", anchor: { blockId: "", quote: "q" } }]) {
      const bad = await say(app, alice, noteId, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(bad).code).toBe("invalid_comment");
    }
    expect(await db.select().from(noteComments)).toHaveLength(1);

    const big = await app.inject({
      method: "POST",
      url: `/api/notes/${noteId}/comments`,
      cookies: await cookieOf(alice.id),
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ body: "a".repeat(COMMENT_BODY_LIMIT) }),
    });
    expect(big.statusCode).toBe(413);
    expect(errorOf(big).code).toBe("content_too_large");
  });

  it("an anchor and a reply come back; the reply summary shows the answered comment and drops out when that comment is deleted", async () => {
    const { app, alice, bob, noteId } = await scene();
    const first = (await say(app, alice, noteId, { body: "first", anchor: { blockId: "blk-1", quote: "a passage" } })).json() as CommentDto;
    expect(first.anchor).toEqual({ blockId: "blk-1", quote: "a passage" });
    const noQuote = (await say(app, alice, noteId, { body: "no quote", anchor: { blockId: "blk-2" } })).json() as CommentDto;
    expect(noQuote.anchor).toEqual({ blockId: "blk-2", quote: null });

    const reply = (await say(app, bob, noteId, { body: "second", replyToId: first.id })).json() as CommentDto;
    expect(reply.replyTo).toEqual({ id: first.id, authorHandle: "alice", excerpt: "first" });
    expect((await inject(app, "DELETE", `/api/comments/${first.id}`, alice.id)).statusCode).toBe(204);
    const after = (await inject(app, "GET", `/api/comments/${reply.id}`, bob.id)).json() as CommentDto;
    expect(after.replyToId).toBe(first.id);
    expect(after.replyTo).toBeNull();
  });

  it("the mention chip follows a handle rename while the body keeps the text as typed", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const made = (await say(app, alice, noteId, { body: "ping @bob please" })).json() as CommentDto;
    await db.update(users).set({ handle: "robert" }).where(eq(users.id, bob.id));
    const got = (await inject(app, "GET", `/api/comments/${made.id}`, alice.id)).json() as CommentDto;
    expect(got.body).toBe("ping @bob please");
    expect(got.mentions).toEqual([{ start: 5, length: 4, userId: bob.id, handle: "robert", displayName: "Bob", avatar: null, agentLabel: null }]);
  });

  it("the comment limiter answers 429 on the third post and edit share one bucket; 400s and 404s before authorization don't charge", async () => {
    const fresh = await freshDb();
    const { app, db } = await buildTestApp({ db: fresh.db, limiters: { comment: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) } });
    const alice = await seedNamedUser(db, "alice");
    const n = await seedNote(db, { ownerId: alice.id });
    expect((await say(app, alice, n.id, { nope: 1 })).statusCode).toBe(400);
    expect((await say(app, alice, MISSING, { body: "x" })).statusCode).toBe(404);
    const first = (await say(app, alice, n.id, { body: "one" })).json() as CommentDto;
    expect((await say(app, alice, n.id, { body: "two" })).statusCode).toBe(201);
    expect((await inject(app, "PATCH", `/api/comments/${first.id}`, alice.id, { body: "one!" })).statusCode).toBe(200);
    const limited = await say(app, alice, n.id, { body: "three" });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe("too_many_requests");
    expect((await inject(app, "PATCH", `/api/comments/${first.id}`, alice.id, { body: "one!!" })).statusCode).toBe(429);
    expect((await inject(app, "DELETE", `/api/comments/${first.id}`, alice.id)).statusCode).toBe(204);
    expect(await db.select().from(noteComments)).toHaveLength(1);
  });
});

describe("PATCH and DELETE /api/comments/:id", () => {
  it("only the author edits (403 for anyone else who can read); an unknown or unreadable comment is comment_not_found; the edit marks editedAt and refreshes mentions", async () => {
    const { app, db, alice, bob, carol, noteId } = await scene();
    const dave = await seedNamedUser(db, "dave");
    const made = (await say(app, alice, noteId, { body: "hi @bob" })).json() as CommentDto;

    const stranger = await inject(app, "PATCH", `/api/comments/${made.id}`, bob.id, { body: "hijack" });
    expect(stranger.statusCode).toBe(403);
    expect(errorOf(stranger).code).toBe("forbidden");
    for (const [who, id] of [[dave, made.id], [alice, MISSING], [alice, "not-a-uuid"]] as const) {
      const res = await inject(app, "PATCH", `/api/comments/${id}`, who.id, { body: "x" });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe("comment_not_found");
    }
    expect((await inject(app, "PATCH", `/api/comments/${made.id}`, alice.id, { body: "hi @carol", extra: 1 })).statusCode).toBe(400);
    expect((await inject(app, "PATCH", `/api/comments/${made.id}`, alice.id, { body: "" })).statusCode).toBe(400);

    const edited = await inject(app, "PATCH", `/api/comments/${made.id}`, alice.id, { body: "hi @carol" });
    expect(edited.statusCode, edited.body).toBe(200);
    const dto = edited.json() as CommentDto;
    expect(dto.body).toBe("hi @carol");
    expect(dto.editedAt).not.toBeNull();
    expect(dto.mentions.map(m => m.userId)).toEqual([carol.id]);
  });

  it("delete: the author, the owner of a personal note and a site admin who can read may; another sharee may not; the comment's mentions and notifications go with it", async () => {
    const { app, db, alice, bob, carol, noteId } = await scene();
    const admin = await seedNamedUser(db, "erin", { isAdmin: true });
    await seedShare(db, noteId, admin.id, "viewer");

    const byBob = (await say(app, bob, noteId, { body: "hi @alice" })).json() as CommentDto;
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect((await inject(app, "DELETE", `/api/comments/${byBob.id}`, carol.id)).statusCode).toBe(403);
    expect((await inject(app, "DELETE", `/api/comments/${byBob.id}`, alice.id)).statusCode).toBe(204);
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect((await inject(app, "DELETE", `/api/comments/${byBob.id}`, alice.id)).statusCode).toBe(404);

    const own = (await say(app, bob, noteId, { body: "mine" })).json() as CommentDto;
    expect((await inject(app, "DELETE", `/api/comments/${own.id}`, bob.id)).statusCode).toBe(204);
    const other = (await say(app, bob, noteId, { body: "again" })).json() as CommentDto;
    expect((await inject(app, "GET", `/api/comments/${other.id}`, admin.id)).json()).toMatchObject({ canDelete: true, canEdit: false });
    expect((await inject(app, "DELETE", `/api/comments/${other.id}`, admin.id)).statusCode).toBe(204);
    expect((await inject(app, "GET", `/api/comments/${other.id}`, carol.id)).json()).toMatchObject({ error: { code: "comment_not_found" } });
  });
});

describe("GET /api/notes/:id/comments cursors", () => {
  it("the newest page is oldest-first with an older cursor only; before and after walk the whole list without gaps or repeats", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    await seedSpaced(db, noteId, bob.id, 7);

    const newest = await list(app, alice, noteId, "?limit=3");
    expect(bodies(newest)).toEqual(["c5", "c6", "c7"]);
    expect(newest.newerCursor).toBeNull();
    expect(newest.olderCursor).not.toBeNull();

    const middle = await list(app, alice, noteId, `?limit=3&before=${newest.olderCursor}`);
    expect(bodies(middle)).toEqual(["c2", "c3", "c4"]);
    expect(middle.newerCursor).not.toBeNull();
    const oldest = await list(app, alice, noteId, `?limit=3&before=${middle.olderCursor}`);
    expect(bodies(oldest)).toEqual(["c1"]);
    expect(oldest.olderCursor).toBeNull();

    const forward = await list(app, alice, noteId, `?limit=3&after=${oldest.newerCursor}`);
    expect(bodies(forward)).toEqual(["c2", "c3", "c4"]);
    expect(forward.olderCursor).not.toBeNull();
    const last = await list(app, alice, noteId, `?limit=3&after=${forward.newerCursor}`);
    expect(bodies(last)).toEqual(["c5", "c6", "c7"]);
    expect(last.newerCursor).toBeNull();

    const all = await list(app, alice, noteId);
    expect(bodies(all)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
    expect([all.olderCursor, all.newerCursor]).toEqual([null, null]);
    expect((await list(app, alice, noteId, `?limit=3&after=${last.newerCursor ?? encodeCursor({ ts: "2031-01-01T00:00:00.000000Z", id: MISSING })}`)).comments).toEqual([]);
  });

  it("around centres on the comment, shifts the unused half to the other side at either end, and offers cursors to continue both ways", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const ids = await seedSpaced(db, noteId, bob.id, 9);

    const mid = await list(app, alice, noteId, `?around=${ids[4]}&limit=5`);
    expect(bodies(mid)).toEqual(["c3", "c4", "c5", "c6", "c7"]);
    expect(mid.olderCursor).not.toBeNull();
    expect(mid.newerCursor).not.toBeNull();
    expect(bodies(await list(app, alice, noteId, `?limit=2&before=${mid.olderCursor}`))).toEqual(["c1", "c2"]);
    expect(bodies(await list(app, alice, noteId, `?limit=2&after=${mid.newerCursor}`))).toEqual(["c8", "c9"]);

    const start = await list(app, alice, noteId, `?around=${ids[0]}&limit=5`);
    expect(bodies(start)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(start.olderCursor).toBeNull();
    expect(start.newerCursor).not.toBeNull();

    const near = await list(app, alice, noteId, `?around=${ids[1]}&limit=5`);
    expect(bodies(near)).toEqual(["c1", "c2", "c3", "c4", "c5"]);

    const end = await list(app, alice, noteId, `?around=${ids[8]}&limit=5`);
    expect(bodies(end)).toEqual(["c5", "c6", "c7", "c8", "c9"]);
    expect(end.newerCursor).toBeNull();
    expect(end.olderCursor).not.toBeNull();

    const whole = await list(app, alice, noteId, `?around=${ids[4]}&limit=100`);
    expect(whole.comments).toHaveLength(9);
    expect([whole.olderCursor, whole.newerCursor]).toEqual([null, null]);
    const one = await list(app, alice, noteId, `?around=${ids[4]}&limit=1`);
    expect(bodies(one)).toEqual(["c5"]);
  });

  it("comments written in the same millisecond keep their order across pages (the cursor carries microseconds and the id)", async () => {
    const { app, pool, alice, bob, noteId } = await scene();
    const ids: string[] = [];
    for (const [i, ts] of ["2030-01-01 00:00:00.000100", "2030-01-01 00:00:00.000200", "2030-01-01 00:00:00.000200", "2030-01-01 00:00:00.000900"].entries()) {
      const { rows } = await pool.query<{ id: string }>(`insert into note_comments (note_id, author_id, body, created_at) values ($1, $2, $3, $4::timestamptz) returning id`, [noteId, bob.id, `m${i}`, ts]);
      ids.push(rows[0]!.id);
    }
    const seen: string[] = [];
    let page = await list(app, alice, noteId, "?limit=1");
    seen.unshift(...page.comments.map(c => c.id));
    while (page.olderCursor !== null) {
      page = await list(app, alice, noteId, `?limit=1&before=${page.olderCursor}`);
      seen.unshift(...page.comments.map(c => c.id));
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen[0]).toBe(ids[0]);
    expect(seen[3]).toBe(ids[3]);
    const forward: string[] = [];
    let f = await list(app, alice, noteId, `?limit=1&around=${seen[0]}`);
    forward.push(...f.comments.map(c => c.id));
    while (f.newerCursor !== null) {
      f = await list(app, alice, noteId, `?limit=1&after=${f.newerCursor}`);
      forward.push(...f.comments.map(c => c.id));
    }
    expect(forward).toEqual(seen);
  });

  it("rejects more than one cursor kind, malformed cursors, a bad limit, and an around comment that isn't on this note", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const ids = await seedSpaced(db, noteId, bob.id, 2);
    const other = await seedNote(db, { ownerId: alice.id });
    const [foreign] = await db.insert(noteComments).values({ noteId: other.id, authorId: alice.id, body: "elsewhere" }).returning({ id: noteComments.id });
    const cursor = encodeCursor({ ts: "2030-01-01T00:00:01.000000Z", id: ids[0]! });

    for (const query of [`?before=${cursor}&after=${cursor}`, `?before=${cursor}&around=${ids[0]}`, "?before=garbage", `?before=${encodeCursor({ ts: "2030-02-31T00:00:00.000000Z", id: ids[0]! })}`, `?after=${encodeCursor({ ts: "2030-99-01T00:00:00.000000Z", id: ids[0]! })}`, `?before=${encodeCursor({ ts: "0000-01-01T00:00:00.000000Z", id: ids[0]! })}`, `?after=${Buffer.from("[1,2]").toString("base64url")}`, "?around=nope", "?limit=0", "?limit=101", "?limit=abc", "?limit=5.5", "?nope=1"]) {
      const res = await inject(app, "GET", `/api/notes/${noteId}/comments${query}`, alice.id);
      expect(res.statusCode, query).toBe(400);
      expect(errorOf(res).code, query).toBe("invalid_body");
    }
    const res = await inject(app, "GET", `/api/notes/${noteId}/comments?around=${foreign!.id}`, alice.id);
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe("comment_not_found");
    expect(res.body).not.toContain("elsewhere");
    expect(decodeCursor(cursor)).toEqual({ ts: "2030-01-01T00:00:01.000000Z", id: ids[0] });
    expect(decodeCursor("%%%")).toBeNull();
    expect((await list(app, alice, noteId, "?limit=100")).comments).toHaveLength(2);
  });
});

describe("unread count and read marker", () => {
  it("counts other people's comments after the marker, never the caller's own, and the marker resets it", async () => {
    const { app, alice, bob, noteId } = await scene();
    const unread = async (u: { id: string }): Promise<number> => ((await inject(app, "GET", `/api/notes/${noteId}/comments/unread-count`, u.id)).json() as CommentUnreadCountDto).count;
    expect(await unread(alice)).toBe(0);
    await say(app, bob, noteId, { body: "one" });
    await say(app, bob, noteId, { body: "two" });
    await say(app, alice, noteId, { body: "mine" });
    expect(await unread(alice)).toBe(2);
    expect(await unread(bob)).toBe(1);

    expect((await inject(app, "POST", `/api/notes/${noteId}/comments/read`, alice.id)).statusCode).toBe(204);
    expect((await inject(app, "POST", `/api/notes/${noteId}/comments/read`, alice.id, {})).statusCode).toBe(204);
    expect(await unread(alice)).toBe(0);
    expect(await unread(bob)).toBe(1);
    await say(app, bob, noteId, { body: "three" });
    expect(await unread(alice)).toBe(1);
    expect((await inject(app, "POST", `/api/notes/${noteId}/comments/read`, alice.id, { extra: 1 })).statusCode).toBe(400);
  });

  it("the read marker has its own limiter; a user without access can't set one", async () => {
    const fresh = await freshDb();
    const { app, db } = await buildTestApp({ db: fresh.db, limiters: { commentRead: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const alice = await seedNamedUser(db, "alice");
    const dave = await seedNamedUser(db, "dave");
    const n = await seedNote(db, { ownerId: alice.id });
    expect((await inject(app, "POST", `/api/notes/${n.id}/comments/read`, dave.id)).statusCode).toBe(404);
    expect((await inject(app, "POST", `/api/notes/${n.id}/comments/read`, alice.id)).statusCode).toBe(204);
    expect((await inject(app, "POST", `/api/notes/${n.id}/comments/read`, alice.id)).statusCode).toBe(204);
    expect((await inject(app, "POST", `/api/notes/${n.id}/comments/read`, alice.id)).statusCode).toBe(429);
  });
});

describe("GET /api/notes/:id/mention-candidates", () => {
  it("lists the people who can read the note including the caller, with explicit agent labels only; others and the unreadable are excluded", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const dave = await seedNamedUser(db, "dave");
    await seedAgentToken(db, alice.id, { label: "claude" });
    await seedAgentToken(db, alice.id, { name: "Private Name" });

    const res = await inject(app, "GET", `/api/notes/${noteId}/mention-candidates?q=al`, alice.id);
    expect(res.statusCode, res.body).toBe(200);
    const { candidates } = res.json() as { candidates: MentionCandidateDto[] };
    expect(candidates).toEqual([{ userId: alice.id, handle: "alice", displayName: "Alice", avatar: null, agentLabels: ["claude"] }]);
    expect(((await inject(app, "GET", `/api/notes/${noteId}/mention-candidates?q=dave`, alice.id)).json() as { candidates: unknown[] }).candidates).toEqual([]);
    expect(((await inject(app, "GET", `/api/notes/${noteId}/mention-candidates`, bob.id)).json() as { candidates: unknown[] }).candidates).toHaveLength(3);
    expect((await inject(app, "GET", `/api/notes/${noteId}/mention-candidates`, dave.id)).statusCode).toBe(404);
    expect((await inject(app, "GET", `/api/notes/${noteId}/mention-candidates?q=${"a".repeat(65)}`, alice.id)).statusCode).toBe(400);
    expect((await inject(app, "GET", `/api/notes/${noteId}/mention-candidates?other=1`, alice.id)).statusCode).toBe(400);
  });

  it("uses the userSuggest limiter", async () => {
    const fresh = await freshDb();
    const { app, db } = await buildTestApp({ db: fresh.db, limiters: { userSuggest: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const alice = await seedNamedUser(db, "alice");
    const n = await seedNote(db, { ownerId: alice.id });
    expect((await inject(app, "GET", `/api/notes/${n.id}/mention-candidates`, alice.id)).statusCode).toBe(200);
    expect((await inject(app, "GET", `/api/notes/${n.id}/mention-candidates`, alice.id)).statusCode).toBe(429);
  });
});

describe("GET /api/comments/:id", () => {
  it("returns the comment with the caller's own canEdit / canDelete", async () => {
    const { app, db, alice, bob, carol, noteId } = await scene();
    const made = await post(db, { noteId, actor: actorOf(bob), body: "hi" });
    const asBob = (await inject(app, "GET", `/api/comments/${made.comment.id}`, bob.id)).json() as CommentDto;
    expect(asBob).toMatchObject({ id: made.comment.id, canEdit: true, canDelete: true });
    expect(await inject(app, "GET", `/api/comments/${made.comment.id}`, alice.id).then(r => r.json())).toMatchObject({ canEdit: false, canDelete: true });
    expect(await inject(app, "GET", `/api/comments/${made.comment.id}`, carol.id).then(r => r.json())).toMatchObject({ canEdit: false, canDelete: false });
    expect((await inject(app, "GET", `/api/comments/${MISSING}`, alice.id)).statusCode).toBe(404);
  });
});
