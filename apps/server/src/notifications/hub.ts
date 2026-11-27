import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fastifyCookie } from "@fastify/cookie";
import { NOTIFICATIONS_CLOSE_TOO_MANY, NOTIFICATIONS_CLOSE_UNAUTHORIZED } from "@knotebook/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveSessionUser, type UserGate } from "../auth/session.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { AppConfig } from "../config.js";
import { notificationSocketOriginAllowed } from "../http/origin.js";

export const NOTIFICATION_SOCKETS_PER_USER = 20;
export const NOTIFICATION_PING_INTERVAL_MS = 25_000;
/** The client sends nothing, so this only bounds what a misbehaving peer can make the server buffer. */
export const NOTIFICATION_MAX_PAYLOAD_BYTES = 1024;
export const NOTIFICATION_SHUTDOWN_DEADLINE_MS = 2_000;

export interface NotificationHubLogger {
  warn(obj: object, msg: string): void;
}

export interface NotificationHubDeps {
  config: Pick<AppConfig, "appSecret" | "publicUrl">;
  gate: UserGate;
  log?: NotificationHubLogger;
  /** Test overrides. */
  pingIntervalMs?: number;
  shutdownDeadlineMs?: number;
}

export interface NotificationHub {
  /** Tells the users' open sockets to refetch. Call only after the transaction committed; carries no content. */
  notify(userIds: readonly string[]): void;
  /** Handles a `/collab/notifications` upgrade; the caller has already matched the path. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Re-checks the user's sockets against the gate now instead of at the next ping; with `sessionId`, only that session's. */
  reverify(userId: string, sessionId?: string): void;
  /** Closes every socket and terminates the ones still open after the deadline, so `app.close()` never waits on them. */
  close(): Promise<void>;
}

interface Entry {
  ws: WebSocket;
  userId: string;
  tv: number;
  sid: string;
  alive: boolean;
}

const MESSAGE = JSON.stringify({ type: "notification" });
const noopLog: NotificationHubLogger = { warn: () => {} };

export function createNotificationHub(deps: NotificationHubDeps): NotificationHub {
  const log = deps.log ?? noopLog;
  const wss = new WebSocketServer({ noServer: true, maxPayload: NOTIFICATION_MAX_PAYLOAD_BYTES });
  const byUser = new Map<string, Set<Entry>>();
  // Sockets that upgraded but haven't been authenticated yet are tracked too, so shutdown reaches them.
  const sockets = new Set<WebSocket>();
  let closing = false;

  function remove(entry: Entry): void {
    const set = byUser.get(entry.userId);
    if (set === undefined) return;
    set.delete(entry);
    if (set.size === 0) byUser.delete(entry.userId);
  }

  // A throwing gate (DB hiccup) keeps the socket: closing on a transient error would make every client reconnect at once.
  async function recheck(entry: Entry): Promise<void> {
    try {
      const result = await deps.gate.check(entry.userId, entry.tv, entry.sid);
      if (result.status !== "ok") entry.ws.close(NOTIFICATIONS_CLOSE_UNAUTHORIZED, "unauthorized");
    } catch (err) {
      log.warn({ err }, "Notification socket session re-check failed");
    }
  }

  async function authenticate(ws: WebSocket, cookieHeader: string | undefined): Promise<void> {
    let session;
    try {
      session = await resolveSessionUser(fastifyCookie.parse(cookieHeader ?? ""), deps.config.appSecret, deps.gate);
    } catch (err) {
      log.warn({ err }, "Notification socket authentication failed");
      ws.close(1011, "server error");
      return;
    }
    if (ws.readyState !== ws.OPEN) return;
    if (session === null) {
      ws.close(NOTIFICATIONS_CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    const userId = session.user.id;
    const existing = byUser.get(userId);
    // No eviction of the oldest: the evicted tab would reconnect and evict another, forever.
    if (existing !== undefined && existing.size >= NOTIFICATION_SOCKETS_PER_USER) {
      ws.close(NOTIFICATIONS_CLOSE_TOO_MANY, "too many connections");
      return;
    }
    const entry: Entry = { ws, userId, tv: session.tv, sid: session.sid, alive: true };
    if (existing === undefined) byUser.set(userId, new Set([entry]));
    else existing.add(entry);
    ws.on("pong", () => {
      entry.alive = true;
    });
    ws.on("close", () => remove(entry));
  }

  const timer = setInterval(() => {
    for (const set of byUser.values()) {
      for (const entry of set) {
        if (!entry.alive) {
          entry.ws.terminate();
          continue;
        }
        entry.alive = false;
        entry.ws.ping();
        void recheck(entry);
      }
    }
  }, deps.pingIntervalMs ?? NOTIFICATION_PING_INTERVAL_MS);
  timer.unref();

  return {
    notify(userIds: readonly string[]): void {
      for (const userId of new Set(userIds)) {
        for (const entry of byUser.get(userId) ?? []) {
          if (entry.ws.readyState === entry.ws.OPEN) entry.ws.send(MESSAGE);
        }
      }
    },

    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      if (!notificationSocketOriginAllowed(request.headers.origin, request.headers.host, deps.config.publicUrl.host)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (closing) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, ws => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        ws.on("error", err => log.warn({ err }, "Notification socket error"));
        void authenticate(ws, request.headers.cookie);
      });
    },

    reverify(userId: string, sessionId?: string): void {
      for (const entry of [...(byUser.get(userId) ?? [])]) {
        if (sessionId === undefined || entry.sid === sessionId) void recheck(entry);
      }
    },

    async close(): Promise<void> {
      closing = true;
      clearInterval(timer);
      wss.close();
      const open = [...sockets];
      for (const ws of open) ws.close(1001, "server shutdown");
      const deadline = setTimeout(() => {
        for (const ws of open) ws.terminate();
      }, deps.shutdownDeadlineMs ?? NOTIFICATION_SHUTDOWN_DEADLINE_MS);
      await Promise.all(
        open.map(ws => (ws.readyState === ws.CLOSED ? Promise.resolve() : new Promise<void>(resolve => ws.once("close", () => resolve())))),
      );
      clearTimeout(deadline);
      byUser.clear();
    },
  };
}

/** The hub holds sockets by session, so the events that re-verify a user's or a session's collab connections re-check them too. */
export function withNotificationReverify(hooks: CollabHooks, hub: NotificationHub): CollabHooks {
  return {
    ...hooks,
    onUserRevoked(userId) {
      hooks.onUserRevoked(userId);
      hub.reverify(userId);
    },
    onSessionRevoked(userId, sessionId) {
      hooks.onSessionRevoked(userId, sessionId);
      hub.reverify(userId, sessionId);
    },
  };
}
