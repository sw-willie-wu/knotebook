/**
 * Bare `Hocuspocus` on the raw `upgrade` event (`ws` noServer), not its own http `Server` or `@fastify/websocket`:
 * one Fastify process serves REST, /collab and the SPA. The document name travels inside each message, so one
 * socket can carry several documents and connections are keyed by (socketId, documentName). */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import { WebSocketServer, type RawData, type WebSocket as WsWebSocket } from "ws";
import { eq } from "drizzle-orm";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
  COLLAB_REJECT_CLIENT_OUTDATED,
  NOTE_SCHEMA_VERSION,
  NOTIFICATIONS_SOCKET_PATH,
  type PresenceRole,
} from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import type { UserGate } from "../auth/session.js";
// Type-only cycle with session.ts (it imports CollabContext back); erased at compile time.
import type { DirectCtx } from "../notes/editing/session.js";
import { loadNoteAudience, noteIsLive, resolveRole } from "../notes/service.js";
import { verifyCollabToken } from "./token.js";
import { createNoteStore, docClock, type NoteStoreSearchHooks, type StoreLogger } from "./store.js";
import { createVersionService, type VersionService } from "./versions.js";
import type { NotificationHub } from "../notifications/hub.js";
import { LastActiveTracker, type LastActiveTrackerOptions } from "../auth/last-active.js";
import { FixedWindowLimiter } from "../http/rate-limit.js";
import { collabMaxPayloadBytes } from "../notes/note-size.js";
import {
  SERVER_PRESENCE_ORIGIN,
  ServerOwnedClients,
  sanitizeInboundAwareness,
  type AwarenessIssue,
  type ConnectionPresence,
} from "./awareness-sanitize.js";

const STORE_DEBOUNCE_MS = 2_000;

export interface CollabLogger extends StoreLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

// Not a silent no-op: lock conflicts and handshake rejections must leave a trace (#37).
const consoleCollabLogger: CollabLogger = {
  debug: (obj, msg) => console.debug(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  info: (obj, msg) => console.info(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
};

export const COLLAB_PATH = "/collab";

const APP_CLOSE_CODE = 1000;

// Re-exported so server tests can keep importing them from here.
export {
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_INVALID_TOKEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_REJECT_SERVER_ERROR,
  COLLAB_REJECT_CLIENT_OUTDATED,
};

// Fine-grained causes stay in the logs; the wire keeps only what the client acts on (#35, #37).
// Every handshake rejection must go through `rejectAuth`, or it is not logged with its `cause`.
const REJECT_WIRE_REASON = {
  "note-deleting": COLLAB_REJECT_NOTE_DELETING,
  "bad-token": COLLAB_REJECT_INVALID_TOKEN,
  /** Account disabled, tokenVersion bumped, or the token's session (#388) logged out or expired. */
  "session-revoked": COLLAB_REJECT_INVALID_TOKEN,
  "no-role": COLLAB_REJECT_FORBIDDEN,
  /** Not a verdict: the client backs off and retries. */
  "server-error": COLLAB_REJECT_SERVER_ERROR,
  "client-outdated": COLLAB_REJECT_CLIENT_OUTDATED,
} as const;

export type CollabRejectCause = keyof typeof REJECT_WIRE_REASON;

/** `reason` is all the client receives. Empty message: Hocuspocus console.errors any hook error that has one. */
export class CollabAuthError extends Error {
  constructor(readonly reason: string) {
    super("");
  }
}

// Per user (#37): Hocuspocus keeps the socket open after an auth failure and accepts a fresh attempt, and the
// collab-token rate limit covers issuing, not use, so one valid token can be replayed at line rate almost for free.
const REJECT_LOG_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** Limited too, or the notice itself becomes the amplifier. */
const SUPPRESSION_NOTICE_LIMIT = { limit: 1, windowMs: 60_000 } as const;

/** documentName is client-chosen and bounded only by the WebSocket max payload. */
const LOGGED_NOTE_ID_MAX = 64;

/** Not 1: a provider newer than the server may send unknown types during a rolling upgrade (#50). */
export const BOGUS_MESSAGE_LIMIT = 10;

/** Process-wide, not per user: this path is reachable before authentication. */
const BOGUS_TERMINATE_LOG_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** Bytes. Real awareness messages are under 1 KiB (#312). */
export const AWARENESS_MESSAGE_MAX_BYTES = 16384;

function readVarUintAt(data: Uint8Array, pos: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let cursor = pos;
  // lib0 never writes more than 35 bits; this stops runaway continuation bytes.
  while (cursor < data.length && shift <= 35) {
    const byte = data[cursor]!;
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  return null;
}

export interface ClientMessageCheck {
  verdict: "ok" | "bogus" | "malformed";
  type?: number;
  docNamePrefix?: string;
}

// Hocuspocus 4.5.0 console.errors unknown types and non-Token Auth subtypes and keeps the connection open,
// so those are swallowed and counted by the caller (#50). Malformed frames pass through: Hocuspocus
// throws on them and closes the connection itself.
export function classifyClientMessage(data: Uint8Array): ClientMessageCheck {
  const nameLen = readVarUintAt(data, 0);
  if (nameLen === null) return { verdict: "malformed" };
  const nameEnd = nameLen.next + nameLen.value;
  if (nameEnd > data.length) return { verdict: "malformed" };
  const type = readVarUintAt(data, nameEnd);
  if (type === null) return { verdict: "malformed" };

  const bogus = (): ClientMessageCheck => ({
    verdict: "bogus",
    type: type.value,
    docNamePrefix: new TextDecoder().decode(data.subarray(nameLen.next, Math.min(nameEnd, nameLen.next + LOGGED_NOTE_ID_MAX))),
  });

  if (type.value === 2) {
    // Token(0) is the only Auth subtype a client may send.
    const subtype = readVarUintAt(data, type.next);
    if (subtype === null) return { verdict: "malformed" };
    return subtype.value === 0 ? { verdict: "ok" } : bogus();
  }
  if (type.value === 1 && data.length > AWARENESS_MESSAGE_MAX_BYTES) return bogus();
  // Allowlist = types MessageReceiver.apply (4.5.0) handles, not the MessageType enum range:
  // SyncStatus(8)/Ping(9)/Pong(10) fall through to its log-and-continue default.
  // 6 (BroadcastStateless) makes Hocuspocus throw and close, so it passes through like malformed.
  // A provider's bare Pong frame has no document name (malformed); revisit if the server starts sending Ping.
  if ([0, 1, 3, 4, 5, 6, 7].includes(type.value)) return { verdict: "ok" };
  return bogus();
}

const DESTROY_UNLOAD_TIMEOUT_MS = 2_000;

export interface CollabContext {
  userId: string;
  /** Session that obtained the collab token (#388); absent on direct AI/API contexts. */
  sessionId?: string;
  /** Absent on direct contexts. Name and avatar are a connect-time snapshot; the current role is the handle's (#312). */
  presence?: ConnectionPresence;
}

export interface CollabDeps {
  db: Db;
  config: AppConfig;
  gate: UserGate;
  /** Created before `buildApp()`, so it cannot be the Fastify logger. */
  log?: CollabLogger;
  /** Test hook (#93); not set in production. */
  storeSearchHooks?: NoteStoreSearchHooks;
  /** Test override in ms; unset reads the site setting each time (#272). */
  versionAutoWaitMs?: number;
  /** Test hook (#267). */
  lastActiveOptions?: LastActiveTrackerOptions;
  /** Gets the `/collab/notifications` upgrades; they share this upgrade listener because a second one would race it. */
  notifications?: NotificationHub;
}

export interface ConnectionHandle {
  /** Per WebSocket; unique only together with noteId. */
  socketId: string;
  noteId: string;
  userId: string;
  /** `sid` of the last token that passed verification (#388); logout finds the connection by it. */
  sessionId: string | undefined;
  /** Updated on every successful reverify (#312). */
  presenceRole: PresenceRole;
  /** Fire-and-forget; no timeout. */
  requestToken(): void;
  /** Closes only this document's connection; other connections and the socket stay open. */
  close(reason: string): void;
  setReadOnly(v: boolean): void;
}

export interface CollabServer {
  hocuspocus: Hocuspocus<CollabContext>;
  versions: VersionService;
  /** Shared with REST session requests so the process has one throttle table (#267). */
  lastActive: LastActiveTracker;
  attach(app: FastifyInstance): void;
  connectionsOf(userId: string): ReadonlySet<ConnectionHandle>;
  connectionsOfNote(noteId: string): ReadonlySet<ConnectionHandle>;
  /** `ok` only when the note is loaded and `userId` has a registered connection on it. */
  linkSyncState(noteId: string, userId: string): { ok: true; clock: number } | { ok: false };
  /** One-shot. A set: a connection can be reverified twice before the deadline, and overwriting would
   * leave the first timer waiting and kill a connection that re-verified. */
  onNextTokenSync(handle: ConnectionHandle, cb: () => void): void;
  /** Await before the trash/delete transaction: it snapshots who can see the note, which authorization
   * can no longer tell after commit. Only they (or anyone who still has a role) are told `note-deleting`;
   * others get `no-role`, so the gate is no existence oracle (#35). A permanent delete from the trash opens no gate.
   * Returns the epoch to release it with. */
  markDeleting(noteId: string): Promise<number>;
  /** Releases only the gate opened with `epoch`, and only if the note still exists. */
  releaseDeletingGate(noteId: string, epoch: number): Promise<boolean>;
  unmarkDeleting(noteId: string): void;
  /** In memory, no DB query. */
  isDeleting(noteId: string): boolean;
  /** Must be awaited before `app.close()`, which leaves upgraded sockets open. */
  destroy(): Promise<void>;
}

// socketIds are UUIDs and never contain NUL, so the key is unambiguous.
const KEY_SEPARATOR = "\u0000";

function connectionKey(socketId: string, documentName: string): string {
  return `${socketId}${KEY_SEPARATOR}${documentName}`;
}

function addToIndex(index: Map<string, Set<ConnectionHandle>>, key: string, handle: ConnectionHandle): void {
  const existing = index.get(key);
  if (existing) existing.add(handle);
  else index.set(key, new Set([handle]));
}

function removeFromIndex(index: Map<string, Set<ConnectionHandle>>, key: string, handle: ConnectionHandle): void {
  const existing = index.get(key);
  if (!existing) return;
  existing.delete(handle);
  if (existing.size === 0) index.delete(key);
}

const EMPTY_HANDLES: ReadonlySet<ConnectionHandle> = new Set();

/** URL and headers only: Hocuspocus reads nothing else from the request. */
function toWebRequest(url: URL, headers: IncomingHttpHeaders): Request {
  const webHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const one of value) webHeaders.append(name, one);
    else if (value !== undefined) webHeaders.set(name, value);
  }
  return new Request(url, { headers: webHeaders });
}

/** Copies: Hocuspocus queues messages, and a view into Node's pooled Buffer could be overwritten first. */
function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  return new Uint8Array(Buffer.from(data));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCollabServer(deps: CollabDeps): CollabServer {
  const handles = new Map<string, ConnectionHandle>();
  const byUser = new Map<string, Set<ConnectionHandle>>();
  const byNote = new Map<string, Set<ConnectionHandle>>();
  const tokenSyncCallbacks = new Map<string, Set<() => void>>();
  /** noteId → users who could see it when deletion started (`null`: lookup failed). Kept in memory until the TTL (a long list for a widely shared note). Blocking depends only on
   * the key and the user's current role; the audience only decides who hears `note-deleting` instead of `no-role`. */
  const deletingGates = new Map<string, { epoch: number; audience: ReadonlySet<string> | null }>();
  let deletingEpoch = 0;
  const sockets = new Set<WsWebSocket>();

  let attached = false;
  let destroyPromise: Promise<void> | undefined;

  /** No-op unless this handle is still the registered one: a late teardown after a resubscribe must not drop the
   * live registration. `connected` unregisters a stale handle itself, so each handle is still removed exactly once. */
  function unregister(key: string, handle: ConnectionHandle): void {
    if (handles.get(key) !== handle) return;
    handles.delete(key);
    tokenSyncCallbacks.delete(key);
    removeFromIndex(byUser, handle.userId, handle);
    removeFromIndex(byNote, handle.noteId, handle);
  }

  const log = deps.log ?? consoleCollabLogger;
  const bogusTerminateLogLimiter = new FixedWindowLimiter(BOGUS_TERMINATE_LOG_LIMIT);
  const bogusTerminateNoticeLimiter = new FixedWindowLimiter(SUPPRESSION_NOTICE_LIMIT);
  const rejectLogLimiter = new FixedWindowLimiter(REJECT_LOG_LIMIT);
  const serverErrorLogLimiter = new FixedWindowLimiter(REJECT_LOG_LIMIT);
  const suppressionNoticeLimiter = new FixedWindowLimiter(SUPPRESSION_NOTICE_LIMIT);
  const awarenessLogLimiter = new FixedWindowLimiter(REJECT_LOG_LIMIT);
  const awarenessNoticeLimiter = new FixedWindowLimiter(SUPPRESSION_NOTICE_LIMIT);
  const awarenessErrorLogLimiter = new FixedWindowLimiter(REJECT_LOG_LIMIT);
  const awarenessErrorNoticeLimiter = new FixedWindowLimiter(SUPPRESSION_NOTICE_LIMIT);
  /** Awareness client ids the server writes itself (AI agent avatars). */
  const serverOwned = new ServerOwnedClients();

  /** `null` never means everyone: any user can sign a token for any UUID, so a failed lookup would reveal that
   * the id was just deleted. onAuthenticate falls back to the user's current role. */
  function deletingAudienceHas(noteId: string, userId: string): boolean {
    const audience = deletingGates.get(noteId)?.audience;
    return audience !== undefined && audience !== null && audience.has(userId);
  }
  const noteStore = createNoteStore({ ...deps.storeSearchHooks, db: deps.db, log });
  const versions = createVersionService({ db: deps.db, log, ...(deps.versionAutoWaitMs !== undefined ? { autoWaitMs: deps.versionAutoWaitMs } : {}) });
  const lastActive = new LastActiveTracker(deps.db, log, deps.lastActiveOptions);

  /**
   * Rejections must be logged: the client is redirected away and the empty `CollabAuthError` message leaves
   * no other trace (#37). Never log the token. Handshake `bad-token` is debug: it needs no session and no DB
   * work, so it would cost a log line per tiny message. Reverify `bad-token` is info: it kicks an authenticated
   * user, so keep `phase` in the condition. Info and error lines are limited per user (`REJECT_LOG_LIMIT`).
   */
  function logReject(
    phase: "handshake" | "reverify",
    cause: CollabRejectCause,
    reason: string,
    ctx: { noteId: string; userId?: string; err?: unknown }
  ): void {
    const line = {
      phase,
      noteId: ctx.noteId.slice(0, LOGGED_NOTE_ID_MAX),
      userId: ctx.userId,
      cause,
      reason,
    };
    if (phase === "handshake" && cause === "bad-token") {
      log.debug(line, "collab 握手被拒");
      return;
    }
    const key = ctx.userId ?? "anonymous";
    const budget = cause === "server-error" ? serverErrorLogLimiter : rejectLogLimiter;
    if (!budget.consume(key)) {
      // So an empty grep can be told apart from suppressed lines.
      if (suppressionNoticeLimiter.consume(key)) {
        log.warn({ userId: ctx.userId }, "collab 拒連日誌已達每分鐘上限，其餘略過");
      }
      return;
    }
    if (cause === "server-error") log.error({ ...line, err: ctx.err }, "collab 握手被拒");
    else log.info(line, phase === "handshake" ? "collab 握手被拒" : "collab 重驗後關閉連線");
  }

  /** The connection stays open. Issues are deduplicated (one message can carry thousands of entries);
   * state content is client-reported and never logged. */
  function logAwarenessIssues(documentName: string, userId: string | undefined, issues: readonly AwarenessIssue[]): void {
    const key = userId ?? "anonymous";
    if (!awarenessLogLimiter.consume(key)) {
      if (awarenessNoticeLimiter.consume(key)) {
        log.warn({ userId }, "collab awareness 日誌已達每分鐘上限，其餘略過");
      }
      return;
    }
    log.warn(
      { noteId: documentName.slice(0, LOGGED_NOTE_ID_MAX), userId, issues: [...new Set(issues)] },
      "collab awareness 含不合規內容，已丟棄或改寫"
    );
  }

  function rejectAuth(cause: CollabRejectCause, ctx: { noteId: string; userId?: string; err?: unknown }): never {
    const reason = REJECT_WIRE_REASON[cause];
    logReject("handshake", cause, reason, ctx);
    throw new CollabAuthError(reason);
  }

  // `lastContext` is the context of the edits that scheduled this store. A direct connection's `disconnect()`
  // stores immediately, replacing a pending debounced store, so human edits may be attributed to that AI write
  // (content is kept). The rejection path's `disconnect()` also stores; `applied === false` keeps it unstamped.
  // Must not throw: a failing onStoreDocument keeps the document in memory and stops saving.
  async function stampLastEdited(documentName: string, lastContext: unknown): Promise<void> {
    const ctx = lastContext as Partial<DirectCtx> | undefined;
    if (typeof ctx?.userId !== "string") return;
    const isDirect = ctx.source !== undefined;
    if (isDirect && ctx.applied !== true) return;
    try {
      await deps.db
        .update(notes)
        .set({
          lastEditedAt: new Date(),
          lastEditedBy: ctx.userId,
          lastEditedTokenId: isDirect ? (ctx.tokenId ?? null) : null,
          lastEditedAgentLabel: isDirect ? (ctx.agentLabel ?? null) : null,
        })
        .where(eq(notes.id, documentName));
    } catch (err) {
      log.warn({ err, noteId: documentName }, "last_edited 落款失敗（不影響落盤）");
    }
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,

    // `maxDebounce` stays at the default 10s, so continuous typing still saves.
    debounce: STORE_DEBOUNCE_MS,

    // After noteStore: it applies note_states to this doc, and noteLoaded fingerprints that content.
    // On failure versions stay uninitialized: no auto versions this load cycle, manual save returns 503.
    onLoadDocument: async ({ documentName, document }) => {
      const update = await noteStore.onLoadDocument(documentName, document);
      try {
        await versions.noteLoaded(documentName, document);
      } catch (err) {
        log.warn({ err, noteId: documentName }, "版本狀態初始化失敗（這個載入週期不切自動版本）");
      }
      return update;
    },
    onChange: async ({ documentName, context }) => {
      const c = context as Partial<DirectCtx> | undefined;
      if (typeof c?.userId !== "string") return;
      versions.noteChanged(documentName, { userId: c.userId, agentLabel: c.source !== undefined ? (c.agentLabel ?? null) : null });
      // Only human WebSocket edits count (#267). Not awaited: `touch` is throttled in memory and never rejects.
      if (c.source === undefined) void lastActive.touch(c.userId);
    },
    onStoreDocument: async ({ documentName, document, lastContext }) => {
      await noteStore.onStoreDocument(documentName, document);
      await stampLastEdited(documentName, lastContext);
      // Awaited so unload waits for it (#272); must not fail the store.
      try {
        await versions.noteStored(documentName, document, lastContext);
      } catch (err) {
        log.warn({ err, noteId: documentName }, "版本歷史：落盤後寫待切失敗（不影響落盤）");
      }
    },
    afterUnloadDocument: async ({ documentName }) => {
      noteStore.afterUnloadDocument(documentName);
      versions.forget(documentName);
    },

    // Re-resolves role and gate: the token's role is only a snapshot, so revocations apply before it expires.
    // AI writes and reads use a direct connection and never reach this hook; their routes authorize them.
    onAuthenticate: async ({ token, documentName, connectionConfig }) => {
      // Outside `try` so the server-error log line can include the user.
      let userId: string | undefined;
      try {
        const claims = token ? await verifyCollabToken(deps.config.appSecret, token) : null;
        if (!claims || claims.noteId !== documentName) {
          rejectAuth("bad-token", { noteId: documentName });
        }
        userId = claims.userId;

        // Before the deletion gate: needs no DB and says nothing about the note (#269). `!==`, not `<`:
        // after a server rollback, newer clients must reload too. onTokenSync skips this check because
        // a schema bump restarts the process; revisit with hot reload (`collab-gate.test.ts` pins it).
        if (claims.sv !== NOTE_SCHEMA_VERSION) {
          rejectAuth("client-outdated", { noteId: documentName, userId: claims.userId });
        }

        // After token verification: this is the only place that reveals a noteId exists (and was just deleted),
        // so asking takes a validly signed token for that note. Before resolveRole: once the delete commits there
        // is no role, and the user would wrongly be told access was lost. Fast path, no DB.
        if (deletingAudienceHas(documentName, claims.userId)) {
          rejectAuth("note-deleting", { noteId: documentName, userId: claims.userId });
        }

        const role = await resolveRole(deps.db, claims.userId, documentName);

        // Slow path: anyone who still has a role may hear note-deleting. Covers a failed audience
        // lookup, a fast-path read racing `markDeleting`, and users granted access during deletion.
        // Everyone else gets `no-role`, same as for an existing note that isn't theirs.
        if (deletingGates.has(documentName) && (role !== "none" || deletingAudienceHas(documentName, claims.userId))) {
          rejectAuth("note-deleting", { noteId: documentName, userId: claims.userId });
        }
        if (role === "none") {
          rejectAuth("no-role", { noteId: documentName, userId: claims.userId });
        }
        const gateResult = await deps.gate.check(claims.userId, claims.tv, claims.sid);
        if (gateResult.status !== "ok") {
          // Not a note permission problem: the client refetches a token, gets 401 and logs out (#35).
          rejectAuth("session-revoked", { noteId: documentName, userId: claims.userId });
        }

        // onAuthenticate has no `connection` in v4, so read-only can only be set here.
        if (role === "viewer") {
          connectionConfig.readOnly = true;
        }

        // Awareness identity comes only from here (#312); a pending avatar is still referenced, as on the web.
        const { displayName, avatar } = gateResult.user;
        const presence: ConnectionPresence = {
          name: displayName,
          avatar: avatar ? { id: avatar.id, v: avatar.v } : null,
          since: Date.now(),
          role,
        };
        return { userId: claims.userId, sessionId: claims.sid, presence };
      } catch (err) {
        if (err instanceof CollabAuthError) throw err;
        // Otherwise Hocuspocus sends a literal "permission-denied", which old clients treat as
        // revocation, and nothing is logged. Through `rejectAuth` so it shows up under `cause`.
        rejectAuth("server-error", { noteId: documentName, userId, err });
      }
    },

    connected: async ({ connection, socketId, documentName, context }) => {
      // Hocuspocus already applies messages between onAuthenticate and here. A connection that
      // passed before `markDeleting` must not register, or the deletion sweep can't find it.
      if (deletingGates.has(documentName)) {
        connection.close({ code: APP_CLOSE_CODE, reason: COLLAB_CLOSE_NOTE_DELETED });
        return;
      }

      const key = connectionKey(socketId, documentName);

      // A socket can unsubscribe and resubscribe the same note (SPA navigation), reusing the key;
      // drop the stale handle or connectionsOf keeps counting a closed connection.
      const stale = handles.get(key);
      if (stale) unregister(key, stale);

      const handle: ConnectionHandle = {
        socketId,
        noteId: documentName,
        userId: context.userId,
        sessionId: context.sessionId,
        presenceRole: context.presence?.role ?? "viewer",
        requestToken: () => connection.requestToken(),
        close: (reason: string) => connection.close({ code: APP_CLOSE_CODE, reason }),
        setReadOnly: (v: boolean) => {
          connection.readOnly = v;
        },
      };
      handles.set(key, handle);
      addToIndex(byUser, handle.userId, handle);
      addToIndex(byNote, handle.noteId, handle);

      // Not onDisconnect: it has no Connection, so after a quick resubscribe it could remove the
      // new live registration and hide the user from revocation.
      connection.onClose(() => unregister(key, handle));

      // The connection may have closed before `connected` ran, firing onClose before it was set.
      if (!connection.document.hasConnection(connection)) unregister(key, handle);

      // Counts as session activity: collab tokens are only issued to sessions. Not awaited (#267).
      void lastActive.touch(context.userId);
    },

    // Don't use `connection.context`: it is a stale snapshot here. The new token's user must match the
    // handle's, otherwise it's treated as a hijack and closed. Reject by closing, not throwing: a throw
    // closes as Unauthorized and is console.error'd. Take the callbacks before verifying and fire them in
    // `finally` whatever the outcome: `handle.close()` synchronously unregisters the key, and the
    // revocation deadline would otherwise never clear. Errors still propagate.
    onTokenSync: async ({ socketId, documentName, token }) => {
      const key = connectionKey(socketId, documentName);
      const callbacks = tokenSyncCallbacks.get(key);
      tokenSyncCallbacks.delete(key);

      try {
        const handle = handles.get(key);
        if (!handle) return;

        // Mid-connection revocations happen here, so log them like handshake rejections (#37).
        const closeWith = (cause: CollabRejectCause, reason: string): void => {
          logReject("reverify", cause, reason, { noteId: documentName, userId: handle.userId });
          handle.close(reason);
        };

        if (deletingGates.has(documentName)) {
          closeWith("note-deleting", COLLAB_CLOSE_NOTE_DELETED);
          return;
        }

        const claims = token ? await verifyCollabToken(deps.config.appSecret, token) : null;
        if (!claims || claims.userId !== handle.userId || claims.noteId !== documentName) {
          closeWith("bad-token", COLLAB_CLOSE_REVOKED);
          return;
        }

        const role = await resolveRole(deps.db, claims.userId, documentName);
        if (role === "none") {
          closeWith("no-role", COLLAB_CLOSE_REVOKED);
          return;
        }

        const gateResult = await deps.gate.check(claims.userId, claims.tv, claims.sid);
        if (gateResult.status !== "ok") {
          closeWith("session-revoked", COLLAB_CLOSE_REVOKED);
          return;
        }

        // Logout finds the connection by the latest sid (#388).
        handle.sessionId = claims.sid;
        handle.setReadOnly(role === "viewer");
        handle.presenceRole = role;
      } finally {
        for (const cb of callbacks ?? []) {
          try {
            cb();
          } catch {
            // A failing caller callback must not affect the connection.
          }
        }
      }
    },

    // Role from the handle (updated on reverify); messages queued before `connected` have no
    // handle yet, so fall back to the handshake role (#312). A throw here closes the connection.
    beforeHandleAwareness: async ({ states, document, connection, context, socketId, documentName }) => {
      const ctx = context as Partial<CollabContext> | undefined;
      try {
        const role = handles.get(connectionKey(socketId, documentName))?.presenceRole ?? ctx?.presence?.role;
        const issues = sanitizeInboundAwareness({
          states,
          document,
          connection,
          userId: ctx?.userId,
          presence: ctx?.presence && role ? { ...ctx.presence, role } : undefined,
          readOnly: connection?.readOnly ?? true,
          serverOwned: serverOwned.get(document),
        });
        // Messages still queued after a close land here; that is normal teardown, not bad content.
        const closedConnection = connection !== undefined && !document.hasConnection(connection);
        if (issues.length > 0 && !closedConnection) logAwarenessIssues(documentName, ctx?.userId, issues);
      } catch (err) {
        states.clear();
        const errKey = ctx?.userId ?? "anonymous";
        if (awarenessErrorLogLimiter.consume(errKey)) {
          log.error({ err, userId: ctx?.userId, noteId: documentName.slice(0, LOGGED_NOTE_ID_MAX) }, "collab awareness 淨化失敗，整則丟棄");
        } else if (awarenessErrorNoticeLimiter.consume(errKey)) {
          log.warn({ userId: ctx?.userId }, "collab awareness 淨化失敗日誌已達每分鐘上限，其餘略過");
        }
      }
    },

    // Mark server-written states (AI avatars) as server-owned so no connection can overwrite them, and drop
    // those ids from every connection, or one that sent the id would remove it on close. Must not throw (not awaited).
    onAwarenessUpdate: async ({ document, transactionOrigin, added, updated }) => {
      if (transactionOrigin !== SERVER_PRESENCE_ORIGIN) return;
      try {
        const ids = [...added, ...updated];
        serverOwned.mark(document, ids);
        for (const connection of document.getConnections()) {
          const clients = document.getClients(connection);
          for (const id of ids) clients.delete(id);
        }
      } catch (err) {
        log.error({ err, noteId: document.name.slice(0, LOGGED_NOTE_ID_MAX) }, "collab AI 頭像登記失敗");
      }
    },
  });

  versions.bind(hocuspocus);

  const wss = new WebSocketServer({ noServer: true, maxPayload: collabMaxPayloadBytes(deps.config.limitEnv.noteMaxBytes) });

  function handleUpgrade(app: FastifyInstance, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === NOTIFICATIONS_SOCKET_PATH && deps.notifications !== undefined) {
      deps.notifications.handleUpgrade(request, socket, head);
      return;
    }

    // With an upgrade listener registered, Node no longer destroys unhandled upgrade sockets.
    if (url.pathname !== COLLAB_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws);
      const clientConnection = hocuspocus.handleConnection(
        ws as unknown as WebSocketLike,
        toWebRequest(url, request.headers)
      );

      // Hocuspocus logs these and never closes the connection, so swallow them and terminate (#50).
      let bogusCount = 0;
      let bogusTerminated = false;
      // Read now: undefined once the socket is destroyed. Frames already queued still fire after
      // terminate, hence `bogusTerminated`. Raw peer address (no XFF parsing): a proxy's if behind one.
      const remoteAddress = request.socket.remoteAddress;
      ws.on("message", data => {
        if (bogusTerminated) return;
        const bytes = toUint8Array(data);
        const check = classifyClientMessage(bytes);
        if (check.verdict === "bogus") {
          bogusCount += 1;
          if (bogusCount >= BOGUS_MESSAGE_LIMIT) {
            bogusTerminated = true;
            if (bogusTerminateLogLimiter.consume("global")) {
              log.warn(
                {
                  noteId: (check.docNamePrefix ?? "").slice(0, LOGGED_NOTE_ID_MAX),
                  remoteAddress,
                  bogusCount,
                  lastType: check.type,
                },
                "collab 連線持續送出無法處理的訊息型別，強制斷線"
              );
            } else if (bogusTerminateNoticeLimiter.consume("global")) {
              log.warn({}, "collab 強制斷線日誌已達每分鐘上限");
            }
            ws.terminate();
          }
          return;
        }
        clientConnection.handleMessage(bytes);
      });
      ws.on("close", (code, reason) => {
        sockets.delete(ws);
        clientConnection.handleClose({ code, reason: reason.toString() });
      });
      ws.on("error", error => {
        app.log.warn({ err: error }, "collab websocket 錯誤");
      });
    });
  }

  async function runDestroy(): Promise<void> {
    // Close sockets first: the normal disconnect path flushes each document's pending store.
    for (const ws of sockets) ws.close(1001, "server shutdown");
    wss.close();
    hocuspocus.flushPendingStores();

    const deadline = Date.now() + DESTROY_UNLOAD_TIMEOUT_MS;
    while (hocuspocus.documents.size > 0 && Date.now() < deadline) {
      await sleep(25);
    }

    // Sockets still open at the deadline would hang `app.close()`.
    for (const ws of sockets) ws.terminate();
    sockets.clear();

    await hocuspocus.hooks("onDestroy", { instance: hocuspocus });

    handles.clear();
    byUser.clear();
    byNote.clear();
    tokenSyncCallbacks.clear();
    deletingGates.clear();
  }

  return {
    hocuspocus,
    versions,
    lastActive,

    attach(app: FastifyInstance): void {
      if (attached) throw new Error("CollabServer.attach 只能呼叫一次");
      attached = true;
      app.server.on("upgrade", (request, socket, head) => {
        try {
          handleUpgrade(app, request, socket, head);
        } catch (error) {
          // Nothing catches errors here; an escaping one (e.g. `new Headers()` rejecting) crashes the process.
          app.log.error({ err: error }, "collab upgrade 失敗");
          socket.destroy();
        }
      });
    },

    connectionsOf(userId: string): ReadonlySet<ConnectionHandle> {
      return byUser.get(userId) ?? EMPTY_HANDLES;
    },

    connectionsOfNote(noteId: string): ReadonlySet<ConnectionHandle> {
      return byNote.get(noteId) ?? EMPTY_HANDLES;
    },

    linkSyncState(noteId: string, userId: string): { ok: true; clock: number } | { ok: false } {
      const doc = hocuspocus.documents.get(noteId);
      if (!doc) return { ok: false };
      const hasConnection = [...(byNote.get(noteId) ?? EMPTY_HANDLES)].some(c => c.userId === userId);
      if (!hasConnection) return { ok: false };
      return { ok: true, clock: docClock(doc) };
    },

    onNextTokenSync(handle: ConnectionHandle, cb: () => void): void {
      const key = connectionKey(handle.socketId, handle.noteId);
      const existing = tokenSyncCallbacks.get(key);
      if (existing) existing.add(cb);
      else tokenSyncCallbacks.set(key, new Set([cb]));
    },

    async markDeleting(noteId: string): Promise<number> {
      let audience: ReadonlySet<string> | null = null;
      try {
        audience = await loadNoteAudience(deps.db, noteId);
      } catch (err) {
        // Must not block the deletion; who hears "deleted" falls back to the current role.
        log.warn({ err, noteId }, "collab 刪除閘門取不到可見名單，改用角色判斷");
      }
      // Merge, don't overwrite: a concurrent second DELETE may load an empty audience after the
      // first commits. A known list wins over `null`.
      const existing = deletingGates.get(noteId)?.audience;
      const merged =
        existing === undefined || existing === null
          ? audience
          : audience === null
            ? existing
            : new Set([...existing, ...audience]);
      const epoch = (deletingEpoch += 1);
      deletingGates.set(noteId, { epoch, audience: merged });
      return epoch;
    },

    async releaseDeletingGate(noteId: string, epoch: number): Promise<boolean> {
      // A failed concurrent DELETE must not close the gate a successful one opened.
      if (deletingGates.get(noteId)?.epoch !== epoch) return false;

      // Also require a live row (#181), or a concurrent DELETE that got 404 releases the gate of
      // the one that moved the note to the trash.
      try {
        if (!(await noteIsLive(deps.db, noteId))) return false;
      } catch (err) {
        // Trust the caller (its delete just failed) rather than declare a live note deleted.
        log.warn({ err, noteId }, "collab 刪除失敗後查不到筆記是否還在，仍收閘門");
      }

      // Another gate may have opened during the await.
      if (deletingGates.get(noteId)?.epoch !== epoch) return false;
      deletingGates.delete(noteId);
      return true;
    },

    unmarkDeleting(noteId: string): void {
      deletingGates.delete(noteId);
    },

    isDeleting(noteId: string): boolean {
      return deletingGates.has(noteId);
    },

    async destroy(): Promise<void> {
      // Signal handling and test teardown may both call it.
      destroyPromise ??= runDestroy();
      return destroyPromise;
    },
  };
}
