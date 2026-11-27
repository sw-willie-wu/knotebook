import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import type { NotificationListDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteComments, noteShares, notifications } from "../src/db/schema.js";
import { actorOf, post, seedAgentToken, seedNamedUser, type NamedUser } from "./comment-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedShare } from "./group-helpers.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { inject, markTrashed } from "./trash-helpers.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

async function scene() {
  const fresh = await freshDb();
  const { app, db } = await buildTestApp({ db: fresh.db });
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const carol = await seedNamedUser(db, "carol");
  const note = await seedNote(db, { ownerId: alice.id }, { title: "Garden plan" });
  await seedShare(db, note.id, bob.id, "editor");
  await seedShare(db, note.id, carol.id, "viewer");
  return { app, db, pool: fresh.pool, alice, bob, carol, noteId: note.id };
}

const say = (db: Db, user: NamedUser, noteId: string, body: string, over: Parameters<typeof actorOf>[1] = {}) =>
  post(db, { noteId, actor: actorOf(user, over), body });
const listOf = async (app: FastifyInstance, user: { id: string }, query = ""): Promise<NotificationListDto> => {
  const res = await inject(app, "GET", `/api/notifications${query}`, user.id);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NotificationListDto;
};
const countOf = async (app: FastifyInstance, user: { id: string }): Promise<number> => {
  const res = await inject(app, "GET", "/api/notifications/unread-count", user.id);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { count: number }).count;
};
const errorOf = (res: LightMyRequestResponse): { code: string; message: string } => (res.json() as { error: { code: string; message: string } }).error;

describe("authentication", () => {
  it("no session is 401 on every route and Bearer is refused as well", async () => {
    const { app, db, alice } = await scene();
    const { token } = await seedTokenForUser(db, alice.id, "notes:read notes:write");
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/api/notifications"],
      ["GET", "/api/notifications/unread-count"],
      ["POST", "/api/notifications/seen", {}],
      ["DELETE", `/api/notifications/${MISSING}`],
      ["DELETE", "/api/notifications"],
    ];
    for (const [method, url, payload] of calls) {
      const base = { method: method as "GET", url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) };
      expect((await app.inject(base)).statusCode, `${method} ${url}`).toBe(401);
      expect((await app.inject({ ...base, headers: bearer(token) })).statusCode, `Bearer ${method} ${url}`).toBe(401);
    }
  });
});

describe("list, badge and seen marker", () => {
  it("a mention shows actor, kind, note title, comment excerpt and link ids; it is new and counted until the panel is opened", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const c = (await say(db, alice, noteId, "look at this @bob")).comment;
    expect(await countOf(app, bob)).toBe(1);
    const l = await listOf(app, bob);
    expect(l.nextCursor).toBeNull();
    expect(l.notifications).toHaveLength(1);
    expect(l.notifications[0]).toMatchObject({
      kind: "mention",
      agentLabel: null,
      actor: { userId: alice.id, handle: "alice", displayName: "Alice", agentLabel: null },
      canOpen: true,
      noteId,
      noteTitle: "Garden plan",
      commentId: c.id,
      excerpt: "look at this @bob",
      isNew: true,
    });
    expect(await countOf(app, alice)).toBe(0);
    expect((await listOf(app, alice)).notifications).toEqual([]);

    const seen = await inject(app, "POST", "/api/notifications/seen", bob.id);
    expect(seen.statusCode, seen.body).toBe(204);
    expect(await countOf(app, bob)).toBe(0);
    expect((await listOf(app, bob)).notifications[0]!.isNew).toBe(false);

    await say(db, alice, noteId, "and again @bob");
    expect(await countOf(app, bob)).toBe(1);
    const after = (await listOf(app, bob)).notifications;
    expect(after.map(n => [n.excerpt, n.isNew])).toEqual([["and again @bob", true], ["look at this @bob", false]]);
  });

  it("a reply notifies the author of the answered comment as a reply", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const first = (await say(db, bob, noteId, "question")).comment;
    await post(db, { noteId, actor: actorOf(alice), body: "answer", replyToId: first.id });
    const l = await listOf(app, bob);
    expect(l.notifications.map(n => [n.kind, n.actor.handle, n.excerpt])).toEqual([["reply", "alice", "answer"]]);
  });

  it("the excerpt is the first 120 code points", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const body = `@bob ${"😀".repeat(200)}`;
    await say(db, alice, noteId, body);
    const [n] = (await listOf(app, bob)).notifications;
    expect([...n!.excerpt!]).toHaveLength(120);
    expect(n!.excerpt).toBe([...body].slice(0, 120).join(""));
  });

  it("an agent author shows as the actor's agent label", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const tokenId = await seedAgentToken(db, alice.id, { label: "claude" });
    await say(db, alice, noteId, "from the agent @bob", { tokenId, agentLabel: "claude" });
    expect((await listOf(app, bob)).notifications[0]!.actor).toMatchObject({ handle: "alice", agentLabel: "claude" });
  });

  it("unknown query keys, a bad cursor and limits outside 1-30 are 400", async () => {
    const { app, alice } = await scene();
    for (const q of ["?x=1", "?before=zzz", "?limit=0", "?limit=31", "?limit=abc", "?limit=-1"]) {
      const res = await inject(app, "GET", `/api/notifications${q}`, alice.id);
      expect(res.statusCode, q).toBe(400);
      expect(errorOf(res).code).toBe("invalid_body");
    }
    expect((await inject(app, "POST", "/api/notifications/seen", alice.id, { x: 1 })).statusCode).toBe(400);
  });
});

describe("seen marker precision", () => {
  it("a row created in the same millisecond as seen_at but after it is counted and listed as new; one at seen_at exactly is not", async () => {
    const { app, db, pool, alice, bob, noteId } = await scene();
    const [c] = await db.insert(noteComments).values({ noteId, authorId: alice.id, body: "x" }).returning({ id: noteComments.id });
    await pool.query(`insert into notification_seen (user_id, seen_at) values ($1, '2030-01-01T00:00:00.000100Z')`, [bob.id]);
    for (const ts of ["2030-01-01T00:00:00.000100Z", "2030-01-01T00:00:00.000900Z"]) {
      await pool.query(
        `insert into notifications (user_id, kind, note_id, comment_id, actor_id, created_at) values ($1, 'mention', $2, $3, $4, $5)`,
        [bob.id, noteId, c!.id, alice.id, ts],
      );
    }
    expect(await countOf(app, bob)).toBe(1);
    const l = (await listOf(app, bob)).notifications;
    expect(l.map(n => n.isNew)).toEqual([true, false]);
  });
});

describe("paging", () => {
  it("30 per page, newest first, a cursor for the rest and none at the end", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const [c] = await db.insert(noteComments).values({ noteId, authorId: alice.id, body: "x" }).returning({ id: noteComments.id });
    for (let i = 1; i <= 35; i += 1) {
      await db.insert(notifications).values({
        userId: bob.id,
        kind: "mention",
        noteId,
        commentId: c!.id,
        actorId: alice.id,
        createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)),
      });
    }
    const first = await listOf(app, bob);
    expect(first.notifications).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const second = await listOf(app, bob, `?before=${first.nextCursor}`);
    expect(second.notifications).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const times = [...first.notifications, ...second.notifications].map(n => n.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(new Set([...first.notifications, ...second.notifications].map(n => n.id)).size).toBe(35);

    const small = await listOf(app, bob, "?limit=2");
    expect(small.notifications).toHaveLength(2);
    expect(small.nextCursor).not.toBeNull();
  });
});

describe("access filtering", () => {
  it("a person who lost access sees the actor, kind and time only: no title, comment id, note id or text anywhere in the response", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    await say(db, alice, noteId, "secret plans @bob");
    expect((await listOf(app, bob)).notifications[0]!.canOpen).toBe(true);
    await db.delete(noteShares).where(eq(noteShares.userId, bob.id));

    const res = await inject(app, "GET", "/api/notifications", bob.id);
    expect(res.statusCode).toBe(200);
    const [n] = (res.json() as NotificationListDto).notifications;
    expect(n).toMatchObject({
      kind: "mention",
      actor: { handle: "alice" },
      canOpen: false,
      noteId: null,
      noteTitle: null,
      commentId: null,
      excerpt: null,
    });
    expect(typeof n!.createdAt).toBe("string");
    for (const secret of ["secret plans", "Garden plan", noteId]) expect(res.body).not.toContain(secret);
    expect(await countOf(app, bob)).toBe(1);
  });

  it("a trashed note can't be opened from the bell until it is restored", async () => {
    const { app, db, pool, alice, bob, noteId } = await scene();
    await say(db, alice, noteId, "hello @bob");
    await markTrashed(pool, noteId, alice.id);
    expect((await listOf(app, bob)).notifications[0]).toMatchObject({ canOpen: false, noteTitle: null, excerpt: null });
    await pool.query(`update notes set deleted_at = null, deleted_by = null where id = $1`, [noteId]);
    expect((await listOf(app, bob)).notifications[0]).toMatchObject({ canOpen: true, noteTitle: "Garden plan" });
  });

  it("access is decided per note on one page: readable and unreadable notes mix", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const other = await seedNote(db, { ownerId: alice.id }, { title: "Private" });
    const [c] = await db.insert(noteComments).values({ noteId: other.id, authorId: alice.id, body: "no access" }).returning({ id: noteComments.id });
    await db.insert(notifications).values({ userId: bob.id, kind: "mention", noteId: other.id, commentId: c!.id, actorId: alice.id });
    await say(db, alice, noteId, "yes @bob");
    const l = (await listOf(app, bob)).notifications;
    expect(l.map(n => [n.excerpt, n.canOpen]).sort()).toEqual([["yes @bob", true], [null, false]].sort());
  });
});

describe("agent-addressed rows", () => {
  it("a mention of the person's agent is in the person's own list, labelled with the agent", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    await seedAgentToken(db, alice.id, { label: "claude" });
    await say(db, bob, noteId, "@alice/claude please check");
    await say(db, bob, noteId, "@alice thanks");
    const l = (await listOf(app, alice)).notifications;
    expect(l.map(n => [n.agentLabel, n.excerpt]).sort()).toEqual([["claude", "@alice/claude please check"], [null, "@alice thanks"]].sort());
    expect(await countOf(app, alice)).toBe(2);
  });
});

describe("delete one and clear all", () => {
  async function two() {
    const s = await scene();
    await seedAgentToken(s.db, s.alice.id, { label: "claude" });
    await say(s.db, s.bob, s.noteId, "@alice/claude one");
    await say(s.db, s.bob, s.noteId, "@alice two");
    await say(s.db, s.alice, s.noteId, "@bob three");
    return s;
  }

  it("delete one removes only that row, agent-addressed ones included; someone else's id or a bad id is 404 notification_not_found and removes nothing", async () => {
    const { app, db, alice, bob } = await two();
    const mine = (await listOf(app, alice)).notifications;
    expect(mine).toHaveLength(2);
    const bobsId = (await listOf(app, bob)).notifications[0]!.id;

    for (const id of [bobsId, MISSING, "not-a-uuid"]) {
      const res = await inject(app, "DELETE", `/api/notifications/${id}`, alice.id);
      expect(res.statusCode, id).toBe(404);
      expect(errorOf(res).code).toBe("notification_not_found");
    }
    expect(await db.select().from(notifications)).toHaveLength(3);

    const agentRow = mine.find(n => n.agentLabel === "claude")!;
    const del = await inject(app, "DELETE", `/api/notifications/${agentRow.id}`, alice.id);
    expect(del.statusCode, del.body).toBe(204);
    expect((await listOf(app, alice)).notifications.map(n => n.agentLabel)).toEqual([null]);
    expect((await inject(app, "DELETE", `/api/notifications/${agentRow.id}`, alice.id)).statusCode).toBe(404);
    expect(await db.select().from(notifications)).toHaveLength(2);
  });

  it("clear all removes the caller's rows, agent-addressed ones included, and nobody else's", async () => {
    const { app, alice, bob } = await two();
    const res = await inject(app, "DELETE", "/api/notifications", alice.id);
    expect(res.statusCode, res.body).toBe(204);
    expect((await listOf(app, alice)).notifications).toEqual([]);
    expect(await countOf(app, alice)).toBe(0);
    expect((await listOf(app, bob)).notifications).toHaveLength(1);
    expect((await inject(app, "DELETE", "/api/notifications", alice.id)).statusCode).toBe(204);
  });
});
