import { eq, sql } from "drizzle-orm";
import pino from "pino";
import type { FastifyBaseLogger, FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, type NotificationListDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteComments, noteShares, notes, notifications, uploads } from "../src/db/schema.js";
import { NOTIFICATION_SCAN_MAX } from "../src/mcp/tools/list-notifications.js";
import { createNotificationPurger } from "../src/notifications/retention.js";
import { actorOf, post, seedNamedUser } from "./comment-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare } from "./group-helpers.js";
import { buildTestApp, freshDb } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject, markTrashed } from "./trash-helpers.js";

const MISSING = "00000000-0000-4000-8000-000000000000";

async function scene() {
  const fresh = await freshDb();
  const { app, db } = await buildTestApp({ db: fresh.db });
  const alice = await seedNamedUser(db, "alice");
  const bob = await seedNamedUser(db, "bob");
  const note = await seedNote(db, { ownerId: alice.id }, { title: "Weekly meeting" });
  await seedShare(db, note.id, bob.id, "editor");
  return { app, db, pool: fresh.pool, alice, bob, noteId: note.id };
}

async function seedUpload(db: Db, noteId: string, uploaderId: string, fileName: string | null = "meeting-recording.mp4", mime = "video/mp4"): Promise<string> {
  const [row] = await db.insert(uploads).values({ noteId, uploaderId, mime, size: 10, fileName }).returning({ id: uploads.id });
  return row!.id;
}

const report = (app: FastifyInstance, userId: string | null, uploadId: string, payload: unknown = { blockId: "blk-1" }): Promise<LightMyRequestResponse> =>
  inject(app, "POST", `/api/uploads/${uploadId}/finished`, userId, payload);
const listOf = async (app: FastifyInstance, userId: string): Promise<NotificationListDto> => {
  const res = await inject(app, "GET", "/api/notifications", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as NotificationListDto;
};
const countOf = async (app: FastifyInstance, userId: string): Promise<number> =>
  ((await inject(app, "GET", "/api/notifications/unread-count", userId)).json() as { count: number }).count;
const rowsOf = async (db: Db) => db.select().from(notifications);
const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string } }).error.code;

describe("POST /api/uploads/:id/finished", () => {
  it("records one upload_finished notification for the uploader; a second report is a no-op", async () => {
    const { app, db, alice, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id);
    expect(await countOf(app, alice.id)).toBe(0);

    const first = await report(app, alice.id, uploadId);
    expect(first.statusCode, first.body).toBe(204);
    expect(await countOf(app, alice.id)).toBe(1);
    const again = await report(app, alice.id, uploadId, { blockId: "blk-2" });
    expect(again.statusCode, again.body).toBe(204);
    expect(await countOf(app, alice.id)).toBe(1);

    const rows = await rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice.id, actorId: alice.id, kind: "upload_finished", noteId, uploadId, blockId: "blk-1", commentId: null, agentLabel: null });

    const [n] = (await listOf(app, alice.id)).notifications;
    expect(n).toEqual({
      id: rows[0]!.id,
      kind: "upload_finished",
      createdAt: rows[0]!.createdAt.toISOString(),
      canOpen: true,
      noteId,
      noteTitle: "Weekly meeting",
      blockId: "blk-1",
      fileName: "meeting-recording.mp4",
      isNew: true,
    });
  });

  it("an uppercase upload id is the same upload", async () => {
    const { app, db, alice, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id);
    expect((await report(app, alice.id, uploadId.toUpperCase())).statusCode).toBe(204);
    expect((await report(app, alice.id, uploadId)).statusCode).toBe(204);
    expect(await rowsOf(db)).toHaveLength(1);
  });

  it("someone else's upload is 403 and records nothing, even for an editor of the note", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id);
    const res = await report(app, bob.id, uploadId);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toBe("forbidden");
    expect(await rowsOf(db)).toEqual([]);
    expect(await countOf(app, bob.id)).toBe(0);
  });

  it("an unknown or malformed upload id is 404", async () => {
    const { app, alice } = await scene();
    for (const id of [MISSING, "not-a-uuid"]) {
      const res = await report(app, alice.id, id);
      expect(res.statusCode, id).toBe(404);
      expect(errorOf(res)).toBe("not_found");
    }
  });

  it("a malformed body or block id is 400", async () => {
    const { app, db, alice, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id);
    for (const payload of [{}, { blockId: "" }, { blockId: "a b" }, { blockId: "x".repeat(65) }, { blockId: "_top" }, { blockId: 7 }, { blockId: "b1", extra: 1 }]) {
      const res = await report(app, alice.id, uploadId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorOf(res)).toBe("invalid_body");
    }
    expect((await report(app, alice.id, uploadId, { blockId: "x".repeat(64) })).statusCode).toBe(204);
  });

  it("a note the uploader can no longer read is refused with 403, also when it is in the trash", async () => {
    const { app, db, pool, alice, bob, noteId } = await scene();
    const bobs = await seedUpload(db, noteId, bob.id);
    await db.delete(noteShares).where(eq(noteShares.userId, bob.id));
    expect((await report(app, bob.id, bobs)).statusCode).toBe(403);

    const alices = await seedUpload(db, noteId, alice.id);
    await markTrashed(pool, noteId, alice.id);
    expect((await report(app, alice.id, alices)).statusCode).toBe(403);
    expect(await rowsOf(db)).toEqual([]);
  });

  it("a viewer who uploaded earlier can still report: read access is enough", async () => {
    const { app, db, bob, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, bob.id);
    await db.update(noteShares).set({ role: "viewer" }).where(eq(noteShares.userId, bob.id));
    expect((await report(app, bob.id, uploadId)).statusCode).toBe(204);
  });

  it("needs a session: none is 401 and a Bearer token is refused", async () => {
    const { app, db, alice, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id);
    const { token } = await seedTokenForUser(db, alice.id, "notes:read notes:write");
    expect((await report(app, null, uploadId)).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: `/api/uploads/${uploadId}/finished`, headers: bearer(token), payload: { blockId: "b1" } });
    expect(res.statusCode).toBe(401);
    expect(await rowsOf(db)).toEqual([]);
  });

  it("a body that isn't JSON is refused before the route runs", async () => {
    const { app, db, alice, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/uploads/${uploadId}/finished`,
      cookies: await cookieOf(alice.id),
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ blockId: "b1" }),
    });
    expect(res.statusCode).toBe(415);
    expect(await rowsOf(db)).toEqual([]);
  });
});

describe("listing an upload_finished notification", () => {
  it("once the note can't be read it keeps only the file name, kind and time", async () => {
    const { app, db, bob, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, bob.id, "plan.pdf", "application/pdf");
    expect((await report(app, bob.id, uploadId)).statusCode).toBe(204);
    await db.delete(noteShares).where(eq(noteShares.userId, bob.id));

    const res = await inject(app, "GET", "/api/notifications", bob.id);
    const [n] = (res.json() as NotificationListDto).notifications;
    expect(n).toMatchObject({ kind: "upload_finished", canOpen: false, noteId: null, noteTitle: null, blockId: null, fileName: "plan.pdf" });
    for (const secret of ["Weekly meeting", noteId, "blk-1"]) expect(res.body).not.toContain(secret);
    expect(await countOf(app, bob.id)).toBe(1);
  });

  it("an upload stored without a name shows the name it is served under", async () => {
    const { app, db, alice, noteId } = await scene();
    const uploadId = await seedUpload(db, noteId, alice.id, null);
    expect((await report(app, alice.id, uploadId)).statusCode).toBe(204);
    expect((await listOf(app, alice.id)).notifications[0]).toMatchObject({ fileName: `${uploadId}.mp4` });
  });

  it("shows the name the file is served under, the one its block and download use, not the stored one", async () => {
    const { app, db, alice, noteId } = await scene();
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const uploadId = await seedUpload(db, noteId, alice.id, "report.jar", docx);
    expect((await report(app, alice.id, uploadId)).statusCode).toBe(204);
    expect((await listOf(app, alice.id)).notifications[0]).toMatchObject({ fileName: "report.docx" });
  });

  it("mixes with comment notifications, newest first, and both count", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    await post(db, { noteId, actor: actorOf(bob), body: "look @alice" });
    const uploadId = await seedUpload(db, noteId, alice.id);
    expect((await report(app, alice.id, uploadId)).statusCode).toBe(204);
    const list = await listOf(app, alice.id);
    expect(list.notifications.map(n => n.kind)).toEqual(["upload_finished", "mention"]);
    expect(list.notifications[1]).toMatchObject({ actor: { handle: "bob" }, excerpt: "look @alice" });
    expect(await countOf(app, alice.id)).toBe(2);
  });

  it("delete one and clear all remove it like any other", async () => {
    const { app, db, alice, noteId } = await scene();
    const a = await seedUpload(db, noteId, alice.id);
    const b = await seedUpload(db, noteId, alice.id);
    await report(app, alice.id, a);
    await report(app, alice.id, b);
    const [first] = (await listOf(app, alice.id)).notifications;
    expect((await inject(app, "DELETE", `/api/notifications/${first!.id}`, alice.id)).statusCode).toBe(204);
    expect(await rowsOf(db)).toHaveLength(1);
    expect((await inject(app, "DELETE", "/api/notifications", alice.id)).statusCode).toBe(204);
    expect(await rowsOf(db)).toEqual([]);
  });
});

describe("lifetime", () => {
  it("goes with its upload and with its note", async () => {
    const { app, db, alice, noteId } = await scene();
    const a = await seedUpload(db, noteId, alice.id);
    const b = await seedUpload(db, noteId, alice.id);
    await report(app, alice.id, a);
    await report(app, alice.id, b);
    await db.delete(uploads).where(eq(uploads.id, a));
    expect((await rowsOf(db)).map(r => r.uploadId)).toEqual([b]);
    await db.delete(notes).where(eq(notes.id, noteId));
    expect(await rowsOf(db)).toEqual([]);
  });

  it("the retention purge removes it once it is due", async () => {
    const { app, db, alice, noteId } = await scene();
    await report(app, alice.id, await seedUpload(db, noteId, alice.id));
    await report(app, alice.id, await seedUpload(db, noteId, alice.id));
    await db.execute(sql`update notifications set created_at = now() - interval '31 days' where id = (select id from notifications order by created_at limit 1)`);
    const purger = createNotificationPurger({ db, log: pino({ level: "silent" }) as unknown as FastifyBaseLogger });
    expect(await purger.runOnce()).toBe(1);
    expect(await rowsOf(db)).toHaveLength(1);
  });

  it("a history-clearing move into a group keeps it, while the note's comment notifications go", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const g = await seedGroup(db, "Garden", [{ userId: alice.id, role: "admin" }]);
    await post(db, { noteId, actor: actorOf(bob), body: "hi @alice" });
    await report(app, alice.id, await seedUpload(db, noteId, alice.id));
    const res = await inject(app, "POST", `/api/notes/${noteId}/move`, alice.id, { groupId: g.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(await db.select().from(noteComments)).toEqual([]);
    expect((await rowsOf(db)).map(r => r.kind)).toEqual(["upload_finished"]);
  });
});

describe("MCP list_notifications", () => {
  it("never lists upload_finished, also over the person's own session, and they don't use up a call's scan", async () => {
    const { app, db, alice, bob, noteId } = await scene();
    const many = await db
      .insert(uploads)
      .values(Array.from({ length: NOTIFICATION_SCAN_MAX }, () => ({ noteId, uploaderId: alice.id, mime: "video/mp4", size: 1 })))
      .returning({ id: uploads.id });
    await db.insert(notifications).values(many.map(u => ({ userId: alice.id, kind: "upload_finished", noteId, uploadId: u.id, blockId: "b1", actorId: alice.id })));
    const comment = (await post(db, { noteId, actor: actorOf(bob), body: "look @alice" })).comment;
    await db.execute(sql`update notifications set created_at = created_at - interval '3 seconds'`);
    const cookie = (await cookieOf(alice.id))[SESSION_COOKIE]!;
    const res = await mcpPost(app, rpc("tools/call", { name: "list_notifications", arguments: {} }), { cookie });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json().result.structuredContent as { notifications: Array<{ kind: string; commentId: string }>; truncated: boolean };
    expect(page.notifications.map(n => [n.kind, n.commentId])).toEqual([["mention", comment.id]]);
    expect(page.truncated).toBe(false);
  });
});
