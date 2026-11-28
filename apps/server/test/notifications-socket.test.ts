import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { NOTIFICATIONS_CLOSE_TOO_MANY, NOTIFICATIONS_CLOSE_UNAUTHORIZED, NOTIFICATIONS_SOCKET_PATH } from "@knotebook/shared";
import { apiTokens, sessions, uploads, users } from "../src/db/schema.js";
import { NOTIFICATION_SOCKETS_PER_USER } from "../src/notifications/hub.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, sleep } from "./group-helpers.js";
import { buildCollabTestApp, signTestSession, testConfig, type CollabTestCtx } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

const PASSWORD = "correct-horse-battery";

interface Client {
  ws: WebSocket;
  messages: string[];
  closed: Promise<{ code: number }>;
  /** Resolves once the upgrade was refused with an HTTP status instead. */
  refused: Promise<number>;
  opened: Promise<void>;
}

function connect(ctx: CollabTestCtx, headers: { origin?: string; cookie?: string }): Client {
  const url = ctx.baseUrl.replace("http", "ws") + NOTIFICATIONS_SOCKET_PATH;
  const ws = new WebSocket(url, { headers });
  const messages: string[] = [];
  ws.on("message", data => messages.push(data.toString()));
  const refused = new Promise<number>(resolve => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
  const closed = new Promise<{ code: number }>(resolve => ws.on("close", code => resolve({ code })));
  const opened = new Promise<void>(resolve => ws.on("open", () => resolve()));
  ws.on("error", () => {});
  return { ws, messages, closed, refused, opened };
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Deletes the rows without going through logout, so only the hub's own periodic check can notice. */
async function dropSessions(ctx: CollabTestCtx, userId: string): Promise<void> {
  const rows = await ctx.db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  for (const row of rows) ctx.gate.invalidateSession(row.id);
}

async function setup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const alice = await ctx.createUser({ email: "alice@example.com", password: PASSWORD });
  const bob = await ctx.createUser({ email: "bob@example.com", password: PASSWORD });
  await ctx.db.update(users).set({ handle: "alice" }).where(eq(users.id, alice.id));
  await ctx.db.update(users).set({ handle: "bob" }).where(eq(users.id, bob.id));
  const note = await ctx.createNote(alice.id);
  await ctx.share(note.id, bob.id, "editor");
  const aliceSession = await ctx.loginAs("alice@example.com", PASSWORD);
  const bobSession = await ctx.loginAs("bob@example.com", PASSWORD);
  return { ctx, alice, bob, note, aliceSession, bobSession };
}

describe("notifications socket: connect", () => {
  it("accepts a logged-in user whose Origin is the app's address, and closes 4401 without a session", async () => {
    const { ctx, bobSession } = await setup();
    const good = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await good.opened;
    await sleep(150);
    expect(good.ws.readyState).toBe(WebSocket.OPEN);

    const anonymous = connect(ctx, { origin: ctx.baseUrl });
    expect((await anonymous.closed).code).toBe(NOTIFICATIONS_CLOSE_UNAUTHORIZED);

    const forged = connect(ctx, { origin: ctx.baseUrl, cookie: "knotebook_session=not-a-jwt" });
    expect((await forged.closed).code).toBe(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
  });

  it("refuses a missing, foreign or unparseable Origin before upgrading", async () => {
    const { ctx, bobSession } = await setup();
    for (const origin of [undefined, "http://evil.example", "null", "not a url", `http://127.0.0.1:${Number(new URL(ctx.baseUrl).port) + 1}`]) {
      const c = connect(ctx, { ...(origin === undefined ? {} : { origin }), cookie: bobSession.cookie });
      expect(await c.refused, String(origin)).toBe(403);
    }
  });

  it("accepts the PUBLIC_URL host as Origin even though the raw Host differs, and the raw Host as Origin", async () => {
    const { ctx, bobSession } = await setup();
    // The test config's public address is not the listening address, so this is the reverse-proxy shape.
    const viaPublic = connect(ctx, { origin: testConfig.publicUrl.origin, cookie: bobSession.cookie });
    await viaPublic.opened;
    const viaHost = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await viaHost.opened;
    await sleep(150);
    expect(viaPublic.ws.readyState).toBe(WebSocket.OPEN);
    expect(viaHost.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes 4429 over the per-user cap and leaves the existing sockets alone", async () => {
    const { ctx, bobSession, aliceSession } = await setup();
    const open: Client[] = [];
    for (let i = 0; i < NOTIFICATION_SOCKETS_PER_USER; i += 1) {
      const c = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
      await c.opened;
      open.push(c);
    }
    // The cap is per user: another user still gets in.
    const other = connect(ctx, { origin: ctx.baseUrl, cookie: aliceSession.cookie });
    await other.opened;

    const extra = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    expect((await extra.closed).code).toBe(NOTIFICATIONS_CLOSE_TOO_MANY);
    await sleep(200);
    expect(open.every(c => c.ws.readyState === WebSocket.OPEN)).toBe(true);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);

    // A freed slot is reusable.
    open[0]!.ws.close();
    await open[0]!.closed;
    const again = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await again.opened;
    await sleep(150);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a socket that sends more than the payload limit", async () => {
    const { ctx, bobSession } = await setup();
    const c = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await c.opened;
    c.ws.send("x".repeat(2048));
    expect((await c.closed).code).toBe(1009);
  });

  it("leaves /collab working", async () => {
    const { ctx, bobSession, note } = await setup();
    const sock = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await sock.opened;
    const client = await bobSession.connect(note.id);
    expect(client.provider.synced).toBe(true);
  });
});

describe("notifications socket: session loss", () => {
  it("closes 4401 right after logout, leaving the same user's other session connected", async () => {
    const { ctx, bobSession } = await setup();
    const second = await ctx.loginAs("bob@example.com", PASSWORD);
    const first = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    const other = connect(ctx, { origin: ctx.baseUrl, cookie: second.cookie });
    await first.opened;
    await other.opened;
    await sleep(100);

    expect((await bobSession.fetch("/api/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await first.closed).code).toBe(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes 4401 right after an admin disables the user, leaving other users connected", async () => {
    const { ctx, bob, bobSession, aliceSession } = await setup();
    await ctx.createUser({ email: "carol@example.com", password: PASSWORD, isAdmin: true });
    const carolSession = await ctx.loginAs("carol@example.com", PASSWORD);
    const forBob = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    const forAlice = connect(ctx, { origin: ctx.baseUrl, cookie: aliceSession.cookie });
    await forBob.opened;
    await forAlice.opened;
    await sleep(100);

    expect((await carolSession.fetch(`/api/admin/users/${bob.id}/disable`, { method: "POST" })).status).toBe(204);
    expect((await forBob.closed).code).toBe(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    expect(forAlice.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes 4401 at the next ping when the session is gone without any hook firing", async () => {
    const { ctx, bob, bobSession } = await setup({ notificationHub: { pingIntervalMs: 100 } });
    const c = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await c.opened;
    await sleep(250);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);

    // Pings keep a healthy socket open (the client answers with pongs on its own).
    await sleep(300);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);

    await dropSessions(ctx, bob.id);
    expect((await c.closed).code).toBe(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
  });

  it("does not close sockets when the gate throws", async () => {
    const { ctx, bobSession } = await setup({ notificationHub: { pingIntervalMs: 100 } });
    const c = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await c.opened;
    await sleep(150);
    ctx.breakGate(new Error("db down"));
    await sleep(500);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes 4401 when the session row is gone by the time the upgrade is authenticated", async () => {
    const { ctx, bob } = await setup();
    const token = await signTestSession({ userId: bob.id, tv: 0 });
    await dropSessions(ctx, bob.id);
    const c = connect(ctx, { origin: ctx.baseUrl, cookie: `knotebook_session=${token}` });
    expect((await c.closed).code).toBe(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
  });
});

describe("notifications socket: delivery", () => {
  it("tells a mentioned user over the socket after a comment posted over REST, and nobody else", async () => {
    const { ctx, note, aliceSession, bobSession } = await setup();
    const forBob = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    const forAlice = connect(ctx, { origin: ctx.baseUrl, cookie: aliceSession.cookie });
    await forBob.opened;
    await forAlice.opened;
    await sleep(100);

    const res = await aliceSession.fetch(`/api/notes/${note.id}/comments`, { method: "POST", body: JSON.stringify({ body: "hello @bob" }) });
    expect(res.status).toBe(201);
    await until(() => forBob.messages.length === 1, "bob's message");
    expect(JSON.parse(forBob.messages[0]!)).toEqual({ type: "notification" });
    await sleep(200);
    expect(forAlice.messages).toEqual([]);

    // Editing in a second mention notifies only the person not yet notified.
    const comment = (await res.json()) as { id: string };
    const carol = await ctx.createUser({ email: "carol@example.com", password: PASSWORD });
    await ctx.db.update(users).set({ handle: "carol" }).where(eq(users.id, carol.id));
    await ctx.share(note.id, carol.id, "viewer");
    const carolSession = await ctx.loginAs("carol@example.com", PASSWORD);
    const forCarol = connect(ctx, { origin: ctx.baseUrl, cookie: carolSession.cookie });
    await forCarol.opened;
    await sleep(100);
    expect((await aliceSession.fetch(`/api/comments/${comment.id}`, { method: "PATCH", body: JSON.stringify({ body: "hello @bob and @carol" }) })).status).toBe(200);
    await until(() => forCarol.messages.length === 1, "carol's message");
    await sleep(200);
    expect(forBob.messages).toHaveLength(1);
  });

  it("sends nothing for a comment that mentions no one", async () => {
    const { ctx, note, aliceSession, bobSession } = await setup();
    const forBob = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await forBob.opened;
    await sleep(100);
    expect((await aliceSession.fetch(`/api/notes/${note.id}/comments`, { method: "POST", body: JSON.stringify({ body: "no mention" }) })).status).toBe(201);
    await sleep(300);
    expect(forBob.messages).toEqual([]);
  });

  it("tells a mentioned user after a comment posted over MCP", async () => {
    const { ctx, alice, note, bobSession } = await setup();
    const { token, tokenId } = await seedTokenForUser(ctx.db, alice.id, "notes:read notes:write", "agent");
    await ctx.db.update(apiTokens).set({ agentLabel: "claude" }).where(eq(apiTokens.id, tokenId));
    const forBob = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await forBob.opened;
    await sleep(100);

    const res = await mcpPost(ctx.app, rpc("tools/call", { name: "post_comment", arguments: { note_id: note.id, body: "ping @bob" } }), { token });
    expect(res.statusCode, res.body).toBe(200);
    await until(() => forBob.messages.length === 1, "bob's message");
    expect(JSON.parse(forBob.messages[0]!)).toEqual({ type: "notification" });
  });
});

describe("notifications socket: upload finished", () => {
  it("tells every open tab of the uploader once, and nobody else; a repeated report sends nothing", async () => {
    const { ctx, alice, note, aliceSession, bobSession } = await setup();
    const [upload] = await ctx.db.insert(uploads).values({ noteId: note.id, uploaderId: alice.id, mime: "video/mp4", size: 10, fileName: "clip.mp4" }).returning({ id: uploads.id });
    const tabOne = connect(ctx, { origin: ctx.baseUrl, cookie: aliceSession.cookie });
    const tabTwo = connect(ctx, { origin: ctx.baseUrl, cookie: aliceSession.cookie });
    const forBob = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await Promise.all([tabOne.opened, tabTwo.opened, forBob.opened]);
    await sleep(100);

    const res = await aliceSession.fetch(`/api/uploads/${upload!.id}/finished`, { method: "POST", body: JSON.stringify({ blockId: "v1" }) });
    expect(res.status).toBe(204);
    await until(() => tabOne.messages.length === 1 && tabTwo.messages.length === 1, "both of alice's tabs");
    expect(JSON.parse(tabTwo.messages[0]!)).toEqual({ type: "notification" });

    expect((await aliceSession.fetch(`/api/uploads/${upload!.id}/finished`, { method: "POST", body: JSON.stringify({ blockId: "v1" }) })).status).toBe(204);
    await sleep(300);
    expect(tabOne.messages).toHaveLength(1);
    expect(forBob.messages).toEqual([]);
  });
});

describe("notifications socket: history-clearing move", () => {
  it("tells the user whose notification the move deleted, and only when the history is cleared", async () => {
    for (const keepHistory of [false, true]) {
      const { ctx, alice, note, aliceSession, bobSession } = await setup();
      const group = await seedGroup(ctx.db, "Garden", [{ userId: alice.id, role: "admin" }]);
      expect((await aliceSession.fetch(`/api/notes/${note.id}/comments`, { method: "POST", body: JSON.stringify({ body: "ping @bob" }) })).status).toBe(201);
      const forBob = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
      await forBob.opened;
      await sleep(100);

      const moved = await aliceSession.fetch(`/api/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ groupId: group.id, keepHistory }) });
      expect(moved.status).toBe(200);
      if (keepHistory) {
        await sleep(400);
        expect(forBob.messages).toEqual([]);
      } else {
        await until(() => forBob.messages.length === 1, "bob's message");
        expect(JSON.parse(forBob.messages[0]!)).toEqual({ type: "notification" });
      }
    }
  });

  it("doesn't tell an uploader whose only notification on the note is an upload_finished one, which the move keeps", async () => {
    const { ctx, alice, note, aliceSession } = await setup();
    const group = await seedGroup(ctx.db, "Garden", [{ userId: alice.id, role: "admin" }]);
    const [upload] = await ctx.db.insert(uploads).values({ noteId: note.id, uploaderId: alice.id, mime: "video/mp4", size: 10 }).returning({ id: uploads.id });
    expect((await aliceSession.fetch(`/api/uploads/${upload!.id}/finished`, { method: "POST", body: JSON.stringify({ blockId: "v1" }) })).status).toBe(204);
    const forAlice = connect(ctx, { origin: ctx.baseUrl, cookie: aliceSession.cookie });
    await forAlice.opened;
    await sleep(100);

    expect((await aliceSession.fetch(`/api/notes/${note.id}/move`, { method: "POST", body: JSON.stringify({ groupId: group.id }) })).status).toBe(200);
    await sleep(400);
    expect(forAlice.messages).toEqual([]);
  });
});

describe("notifications socket: shutdown", () => {
  it("lets app.close() resolve with sockets open", async () => {
    const { ctx, bobSession } = await setup();
    const clients = [connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie }), connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie })];
    for (const c of clients) await c.opened;
    await sleep(100);
    const started = Date.now();
    await ctx.destroy();
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const c of clients) expect((await c.closed).code).toBe(1001);
  });

  it("terminates a peer that never answers the close handshake once the deadline passes", async () => {
    const { ctx, bobSession } = await setup({ notificationHub: { shutdownDeadlineMs: 300 } });
    const c = connect(ctx, { origin: ctx.baseUrl, cookie: bobSession.cookie });
    await c.opened;
    await sleep(100);
    // A peer that stops reading never sees the close frame, so only terminate() can end it.
    c.ws.pause();
    const started = Date.now();
    await ctx.destroy();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(5_000);
  });
});
