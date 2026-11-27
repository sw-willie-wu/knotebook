import type { Role } from "./note-dto.js";

export const COLLAB_CLOSE_REVOKED = "knotebook:revoked";
export const COLLAB_CLOSE_NOTE_DELETED = "knotebook:note-deleted";

/**
 * Reasons sent when onAuthenticate rejects a collab handshake. Unlike `COLLAB_CLOSE_*` (sent after auth), Hocuspocus
 * neither closes nor reconnects here (Hocuspocus 4.5.0), so the client must map them to state events or it stays "connecting" (#6).
 * `note-deleting` and `forbidden` are authorization verdicts. `invalid-token` and `server-error` are not: the client must
 * restart the connection rather than report lost access (#35), and treats unknown or missing reasons the same way
 * (including Hocuspocus's literal "permission-denied" for unexpected errors). State stays "connecting"; a dead session
 * surfaces as a 401 on the token refetch, which logs out.
 * No separate "note not found" reason: it would let any user probe whether a note id exists. Only users who could see
 * the note when it was deleted get `note-deleting`; everyone else gets `forbidden`.
 */
export const COLLAB_REJECT_NOTE_DELETING = "note-deleting";
export const COLLAB_REJECT_INVALID_TOKEN = "invalid-token";
export const COLLAB_REJECT_FORBIDDEN = "forbidden";
export const COLLAB_REJECT_SERVER_ERROR = "server-error";
/** Not an authorization verdict: the client goes read-only (`outdated`), not terminal. Older clients retry it like any unknown reason.
 * Independent of the note, so it reveals nothing about whether the note exists. */
export const COLLAB_REJECT_CLIENT_OUTDATED = "client-outdated";
// The last entry repeats; actual delay is entry × [0.75, 1.25). In shared because the server's `DELETING_GATE_TTL_MS` must
// exceed the maximum, or a reconnecting user who could see a deleted note gets `forbidden` (collab-deleting-gate.test.ts).
export const COLLAB_RESTART_DELAYS_MS = [5_000, 15_000, 60_000] as const;
export const COLLAB_RESTART_JITTER = 0.25;

/** For 5xx, 429 and network errors (401 logs out instead); failing to get a token is not an authorization failure. The deleting-gate TTL and the reverify deadline are sized against this sum. */
export const COLLAB_TOKEN_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

// On timeout the server closes with COLLAB_CLOSE_REVOKED: the fail-closed end of the revocation SLA (a revoked share
// loses access within 10 s). Deliberately shorter than the client's worst-case token retry (7.5 s); raising it past that
// eats most of the SLA margin. A client still backing off goes to reconnecting-once and is kicked only by a second hit
// there; otherwise it recovers when the backend does. 5 s leaves room for DB jitter (normal token round trip < 200 ms),
// not for client retry backoff. Pinned by useCollab.test.tsx.
export const COLLAB_REVERIFY_DEADLINE_MS = 5_000;

export const COLLAB_TOKEN_TTL_SECONDS = 120;
export interface CollabTokenClaims {
  noteId: string;
  userId: string;
  role: Role;
  tv: number;
  /** The collab server rechecks this session row on handshake and reverify, so logging out a device closes its connections. */
  sid: string;
  /** Note schema version sent by the client; absent or non-integer means 0. onAuthenticate rejects with client-outdated
   * when it !== NOTE_SCHEMA_VERSION. */
  sv: number;
}

/** Per-user notification socket; under the `/collab` prefix so reverse-proxy upgrade rules for `/collab` already cover it. */
export const NOTIFICATIONS_SOCKET_PATH = "/collab/notifications";
/** No valid session at connect time, or it was revoked later. */
export const NOTIFICATIONS_CLOSE_UNAUTHORIZED = 4401;
/** Over the per-user socket cap. The client waits for the next window focus instead of retrying. */
export const NOTIFICATIONS_CLOSE_TOO_MANY = 4429;
