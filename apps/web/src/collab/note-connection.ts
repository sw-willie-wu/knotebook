import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  COLLAB_CLOSE_NOTE_DELETED,
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_CLIENT_OUTDATED,
  COLLAB_REJECT_FORBIDDEN,
  COLLAB_REJECT_NOTE_DELETING,
  COLLAB_RESTART_DELAYS_MS,
  COLLAB_RESTART_JITTER,
  COLLAB_TOKEN_RETRY_DELAYS_MS,
  NOTE_SCHEMA_VERSION,
  type Role,
} from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import {
  canEdit,
  COLLAB_CLOSE_CLIENT_OUTDATED,
  collabReducer,
  INITIAL_COLLAB_STATE,
  stopsReconnect,
  type CollabEvent,
  type CollabState,
} from "./connection";
import { CURSOR_FIELD } from "./cursor-gate";

export interface CollabTokenResponse {
  token: string;
  /** Authoritative role source. Never decode the JWT: it is a credential between the server and Hocuspocus. */
  role: Role;
}

// Path must match the server's COLLAB_PATH (dev: Vite proxies /collab with ws: true).
export function collabUrl(location: { protocol: string; host: string } = window.location): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/collab`;
}

/**
 * Backoff for the token function (ms), used for 5xx/429/network errors: "can't get a token now"
 * is not an authorization failure and must not kick or log out; 401 is the exception (session
 * gone, no retry). Defined in shared: the server's revocation re-validation deadline is
 * deliberately shorter than their sum (fail-closed) and the delete-gate TTL assumes it
 * (`useCollab.test.tsx` pins the deadline).
 */
const TOKEN_RETRY_DELAYS_MS = COLLAB_TOKEN_RETRY_DELAYS_MS;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Max wait for our own close after entering `reconnecting-once`; on timeout, reconnect anyway. */
const RECONNECT_FALLBACK_MS = 1_000;

/**
 * Whole-connection retry (ms) after the token backoff is exhausted or a non-authorization
 * rejection (#39, #35): the provider then neither closes the socket nor fetches a token, so
 * nothing else recovers. An order of magnitude longer than the token backoff (that 7.5 s round
 * already showed it is not a blip; don't hammer a failing server); the last entry repeats, so it
 * never gives up (slow beats stopping). Capped at 60 s
 * and jittered: the collab-token limit is one per-user 60/min bucket across tabs
 * (`COLLAB_TOKEN_LIMIT` on the server), and a fixed 30 s plus the 7.5 s token backoff would be
 * 5 requests per 37.5 s, so 8 tabs alone would make 64 req/min; a server restart also hits all
 * tabs at once. The server's delete-gate TTL must cover the maximum, or a deleted note
 * reconnects as "you lost access" (#35).
 */
const TOKEN_RESTART_DELAYS_MS = COLLAB_RESTART_DELAYS_MS;

const RESTART_JITTER = COLLAB_RESTART_JITTER;

function jittered(delay: number): number {
  return Math.round(delay * (1 + (Math.random() * 2 - 1) * RESTART_JITTER));
}

/**
 * The `"close"` listener issues the reconnect once our own close arrives (see `openConnection`).
 *
 * The fallback must not clear the pending flag (#34): `connect()` returns early while status is
 * still `Connected`, so clearing it made the late close look like an ordinary disconnect and
 * nobody reconnected. Cost: one extra swallowed close while the socket is open but
 * unauthenticated; harmless (followed by `connect()`, flag cleared). When the close was on time
 * the flag is already false and the fallback must stay a no-op: its `connect()` would tear down
 * the socket being created.
 */
function restartConnection(
  provider: HocuspocusProvider,
  pendingReconnect: { current: boolean },
  isDestroyed: () => boolean,
): () => void {
  pendingReconnect.current = true;
  provider.disconnect();
  const fallback = setTimeout(() => {
    // `connect()` on a destroyed provider opens a socket nobody listens to.
    if (isDestroyed() || !pendingReconnect.current) return;
    void provider.connect();
  }, RECONNECT_FALLBACK_MS);
  return () => clearTimeout(fallback);
}

// Network failures and a non-JSON 2xx throw a plain Error, not ApiFail: treat as transient.
function isRetryableTokenError(err: unknown): boolean {
  if (err instanceof ApiFail) return err.status === 429 || err.status >= 500;
  return true;
}

export interface NoteConnectionHolder {
  kind: "editor" | "queue";
  onUnauthorized: () => void;
}

export interface NoteConnectionHandle {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  getState(): CollabState;
  /** Sticky across disconnects (offline edits after a first sync are merged back, #39). */
  isSynced(): boolean;
  subscribe(listener: () => void): () => void;
  whenWritable(): Promise<"ok" | "rejected">;
  /** Whether an editor of this note is attached in this tab right now. */
  hasEditor(): boolean;
  /** Idempotent. */
  release(): void;
}

interface HolderEntry {
  holder: NoteConnectionHolder;
  listeners: Set<() => void>;
  waiters: Set<(verdict: "ok" | "rejected") => void>;
}

interface NoteConnection {
  attach(holder: NoteConnectionHolder): NoteConnectionHandle;
  hasEditor(): boolean;
}

const connections = new Map<string, NoteConnection>();

/**
 * One connection per note per tab: an editor that opens a note while an upload still holds its
 * connection attaches to the same `Y.Doc`, so the upload's write and the editor never diverge.
 * The connection is destroyed when the last holder releases.
 */
export function acquireNoteConnection(noteId: string, holder: NoteConnectionHolder): NoteConnectionHandle {
  let connection = connections.get(noteId);
  if (!connection) {
    connection = openConnection(noteId);
    connections.set(noteId, connection);
  }
  return connection.attach(holder);
}

/** Whether an editor of this note is attached in this tab right now, whoever holds the connection. */
export function isNoteOnScreen(noteId: string): boolean {
  return connections.get(noteId)?.hasEditor() ?? false;
}

/**
 * Do not pass `websocketProvider`: with a shared socket `provider.disconnect()` is a no-op and
 * revocation stops working. Never enable `sessionAwareness`: the server indexes connections by
 * `(socketId, documentName)`, and documentName would end up in the sessionId and collide (see
 * the header of `apps/server/src/collab/server.ts`).
 *
 * Use `provider.on("close")`, not `onClose` in the configuration: with a self-managed socket the
 * same configuration is handed to the internal `HocuspocusProviderWebsocket`, so `onClose` is
 * registered twice and fires twice per socket close. The callback receives both the
 * application-level CLOSE message (code 1000, reason `COLLAB_CLOSE_*`) and the underlying
 * WebSocket close (reason usually empty); only the reason is looked at.
 *
 * `connect()` must not be called synchronously after `disconnect()`: it only requests the close,
 * status is still `Connected`, and `HocuspocusProviderWebsocket.connect()` returns early without
 * setting `shouldConnect`, so the built-in backoff never starts and the second strike never
 * happens. Issue it in the close listener's branch that swallows our own close: the websocket
 * provider's own close listener (registered first, in its constructor) has already cleared
 * `webSocket` and set status to `Disconnected`.
 */
function openConnection(noteId: string): NoteConnection {
  let state: CollabState = INITIAL_COLLAB_STATE;
  let synced = false;
  let destroyed = false;
  let role: Role = "none";
  const pendingReconnect = { current: false };
  const holders = new Set<HolderEntry>();
  let editorCount = 0;
  /** A 401 logs out even after the last holder left (#36 deliberately leaves 401 unguarded). */
  let lastHolders: NoteConnectionHolder[] = [];
  /**
   * The latest token call threw. When `getToken()` throws the provider calls
   * `permissionDeniedHandler`, so `authenticationFailed` also fires for our own 5xx/network
   * failures, which isn't an authorization verdict; only we can tell them apart.
   * Per connection: a destroyed connection's token request still in backoff (up to 7.5 s) throws
   * on return; a shared flag would be set to true with no listener left to clear it, then swallow
   * the next connection's real revocation (#6).
   */
  let tokenFetchFailed = false;
  /** The latest token failure is final (401: logout started; 404: converged to deleted); a restart would only spend another collab-token request. */
  let tokenFailureFinal = false;
  let restartAttempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelRestartFallback: (() => void) | undefined;
  let restartsStopped = false;
  let cancelPhaseEffect: (() => void) | undefined;
  const doc = new Y.Doc();

  const notify = () => {
    for (const entry of [...holders]) for (const listener of [...entry.listeners]) listener();
  };

  const verdict = (): "ok" | "rejected" | null => {
    if (destroyed || stopsReconnect(state)) return "rejected";
    if (state.phase !== "connected") return null;
    if (!canEdit(state.role)) return "rejected";
    return synced ? "ok" : null;
  };

  const settleWaiters = () => {
    const v = verdict();
    if (v === null) return;
    for (const entry of holders) {
      for (const resolve of entry.waiters) resolve(v);
      entry.waiters.clear();
    }
  };

  const notifyUnauthorized = () => {
    const targets = holders.size > 0 ? [...holders].map((entry) => entry.holder) : lastHolders;
    for (const holder of targets) holder.onUnauthorized();
  };

  const stopRestarts = () => {
    restartsStopped = true;
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    restartTimer = undefined;
    cancelRestartFallback?.();
    cancelRestartFallback = undefined;
  };

  // Runs on every state change, as an effect keyed on the state object would.
  const dispatch = (event: CollabEvent) => {
    const next = collabReducer(state, event);
    if (next === state) return;
    state = next;
    cancelPhaseEffect?.();
    cancelPhaseEffect = undefined;
    if (state.phase === "reconnecting-once") {
      // The server's application-level CLOSE only sends a message, so close this socket; the
      // `"close"` listener issues the reconnect, whose token role is the second-strike criterion.
      cancelPhaseEffect = restartConnection(provider, pendingReconnect, () => destroyed);
    } else if (stopsReconnect(state)) {
      // The 401/404 branches rethrow ⇒ `tokenFetchFailed` ⇒ `authenticationFailed` ⇒ a scheduled
      // restart would revive a terminal connection and send another collab-token request.
      // `disconnect()` sets shouldConnect to false, which stops the built-in backoff.
      stopRestarts();
      pendingReconnect.current = false;
      provider.disconnect();
    }
    notify();
    settleWaiters();
  };

  const fetchTokenWithRetries = async (): Promise<string> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // The server signs the note schema version into the token as `sv` and compares it at handshake (#269).
        const body = await api<CollabTokenResponse>(`/api/notes/${encodeURIComponent(noteId)}/collab-token`, {
          method: "POST",
          body: JSON.stringify({ noteSchemaVersion: NOTE_SCHEMA_VERSION }),
        });
        // Guarded (#36): a response arriving after destroy must not move the state machine or
        // touch the torn-down provider. Returns the token rather than throwing: throwing would
        // just go through the `tokenFetchFailed` path again.
        if (destroyed) return body.token;
        role = body.role;
        dispatch({ type: "token-role", role: body.role });
        return body.token;
      } catch (err) {
        if (err instanceof ApiFail && err.status === 401) {
          // No `destroyed` guard (unlike 404 and success, #36): 401 invalidates the whole session,
          // so even a late one must log the user out.
          tokenFailureFinal = true;
          notifyUnauthorized();
          throw err;
        }
        if (err instanceof ApiFail && err.status === 404) {
          // Safety net: today the token endpoint returns 200 + role 'none' for an inaccessible or
          // deleted note (`routes/notes.ts`), but converge correctly if that contract changes.
          tokenFailureFinal = true;
          if (!destroyed) dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
          throw err;
        }
        const delay = TOKEN_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isRetryableTokenError(err) || destroyed) throw err;
        await sleep(delay);
      }
    }
  };

  // Records a failed fetch so `authenticationFailed` can tell "couldn't get a token" from "the
  // server refused"; cleared on entry so a success leaves no residue that swallows a later real rejection.
  const fetchToken = async (): Promise<string> => {
    tokenFetchFailed = false;
    tokenFailureFinal = false;
    try {
      return await fetchTokenWithRetries();
    } catch (err) {
      tokenFetchFailed = true;
      throw err;
    }
  };

  const provider = new HocuspocusProvider({
    url: collabUrl(),
    name: noteId,
    document: doc,
    token: fetchToken,
    onAuthenticated: () => {
      pendingReconnect.current = false;
      restartAttempt = 0;
      // Also cancel a scheduled restart: it would tear down a connection the provider's own
      // backoff already healed and waste per-user collab-token quota shared across tabs.
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      restartTimer = undefined;
      cancelRestartFallback?.();
      cancelRestartFallback = undefined;
      dispatch({ type: "open", role });
      // The reopen resends the local state with its old clock, which the server ignores; an
      // attached editor's presence hook rewrites it, but with only the queue holding nothing
      // would until the 15 s renewal.
      if (editorCount === 0) republishLocalState();
    },
  });

  const scheduleRestart = () => {
    if (destroyed || restartsStopped || restartTimer !== undefined) return;
    const index = Math.min(restartAttempt, TOKEN_RESTART_DELAYS_MS.length - 1);
    restartAttempt += 1;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (destroyed) return;
      cancelRestartFallback?.();
      cancelRestartFallback = restartConnection(provider, pendingReconnect, () => destroyed);
    }, jittered(TOKEN_RESTART_DELAYS_MS[index]!));
  };

  // `synced` only fires on the false→true edge, so the handler only sets true (sticky).
  // No initial `provider.synced` check: this provider is brand new and connect() is async, so it
  // can't be synced yet.
  provider.on("synced", () => {
    if (destroyed) return;
    synced = true;
    notify();
    settleWaiters();
  });

  provider.on("close", ({ event }: { event?: { reason?: string } }) => {
    if (destroyed) return;
    const reason = event?.reason ?? "";
    const isAppLevel = reason === COLLAB_CLOSE_REVOKED || reason === COLLAB_CLOSE_NOTE_DELETED;
    if (!isAppLevel && pendingReconnect.current) {
      // Our own disconnect()'s close: feeding it to the state machine would knock reconnecting-once
      // back to connecting and reset the revocation window. Reconnect here (see `openConnection`).
      pendingReconnect.current = false;
      void provider.connect();
      return;
    }
    dispatch({ type: "close", reason });
  });

  // #6: revocation before the handshake completes makes `onAuthenticate` throw instead of sending
  // CLOSE(REVOKED), and Hocuspocus 4.5.0 then only sends permission-denied: no close, no reconnect,
  // and `token-role: 'none'` deliberately doesn't transition in `connecting`. Without this handler
  // the user is stuck on "connecting".
  provider.on("authenticationFailed", ({ reason }: { reason?: string }) => {
    if (destroyed) return;
    if (tokenFetchFailed) {
      // Not a verdict; restart, since nothing else will fetch a new token (#39).
      tokenFetchFailed = false;
      if (!tokenFailureFinal) scheduleRestart();
      return;
    }

    // Coerce to a string first: an absent reason on both sides would compare equal and misclassify an unknown rejection as "note deleted".
    const wire = typeof reason === "string" ? reason : "";

    // #35: group A, the only authorization verdicts. forbidden reuses the two-strike REVOKED path so a
    // one-off server hiccup doesn't kick a legitimate user; note-deleting is final.
    // #269: the stale-tab gate is neither a verdict nor transient (a retry gets the same answer), so
    // it goes to `outdated`, which stops restarts and disconnects.
    if (wire === COLLAB_REJECT_CLIENT_OUTDATED) {
      dispatch({ type: "close", reason: COLLAB_CLOSE_CLIENT_OUTDATED });
      return;
    }
    if (wire === COLLAB_REJECT_NOTE_DELETING) {
      dispatch({ type: "close", reason: COLLAB_CLOSE_NOTE_DELETED });
      return;
    }
    if (wire === COLLAB_REJECT_FORBIDDEN) {
      dispatch({ type: "close", reason: COLLAB_CLOSE_REVOKED });
      return;
    }

    // Group B: `invalid-token`/`server-error`/unrecognized reasons (including the literal
    // `"permission-denied"` Hocuspocus uses for unexpected exceptions) don't mean "no
    // permission"; mapping them to revocation told users with intact permissions "you lost
    // access" (#35). Doing nothing is a dead end too (`onAuthenticate`'s throw neither closes
    // the socket nor reconnects), so schedule a restart that re-fetches the token and stay at
    // `connecting`; a revoked tokenVersion then gets 401 and `onUnauthorized` logs out.
    scheduleRestart();
  });

  const republishLocalState = () => {
    const awareness = provider.awareness;
    const local = awareness?.getLocalState();
    if (!awareness || !local || Object.keys(local).length === 0) return;
    awareness.setLocalState({ ...local });
  };

  /**
   * A running upload still counts as being in the note, so the person's presence stays while the
   * queue holds the connection; only the cursor goes, since no view shows it any more. Presence
   * leaves when the last holder releases: the socket closes and the server drops the states this
   * connection registered. Only a published cursor is nulled, so a state that never had one
   * doesn't gain a field (the server shows any non-empty state as presence).
   */
  const dropLocalCursor = () => {
    const awareness = provider.awareness;
    if (awareness?.getLocalState()?.[CURSOR_FIELD] == null) return;
    awareness.setLocalStateField(CURSOR_FIELD, null);
  };

  const destroy = () => {
    destroyed = true;
    if (connections.get(noteId) === connection) connections.delete(noteId);
    // Timers before destroy: after `provider.destroy()` a leaked restart's `connect()` would open a
    // socket nobody listens to.
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    restartTimer = undefined;
    cancelRestartFallback?.();
    cancelRestartFallback = undefined;
    cancelPhaseEffect?.();
    cancelPhaseEffect = undefined;
    provider.destroy();
    doc.destroy();
  };

  const connection: NoteConnection = {
    hasEditor: () => editorCount > 0,
    attach(holder) {
      const entry: HolderEntry = { holder, listeners: new Set(), waiters: new Set() };
      holders.add(entry);
      if (holder.kind === "editor") editorCount += 1;
      let released = false;
      return {
        doc,
        provider,
        getState: () => state,
        isSynced: () => synced,
        subscribe(listener) {
          if (released) return () => {};
          entry.listeners.add(listener);
          return () => entry.listeners.delete(listener);
        },
        whenWritable() {
          if (released) return Promise.resolve("rejected");
          const v = verdict();
          if (v !== null) return Promise.resolve(v);
          return new Promise((resolve) => entry.waiters.add(resolve));
        },
        hasEditor: () => editorCount > 0,
        release() {
          if (released) return;
          released = true;
          holders.delete(entry);
          entry.listeners.clear();
          for (const resolve of entry.waiters) resolve("rejected");
          entry.waiters.clear();
          if (holder.kind === "editor") editorCount -= 1;
          if (holders.size === 0) {
            lastHolders = [holder];
            destroy();
            return;
          }
          if (holder.kind === "editor" && editorCount === 0) dropLocalCursor();
        },
      };
    },
  };
  return connection;
}
