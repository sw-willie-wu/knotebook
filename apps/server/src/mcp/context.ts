/** Tools are standalone `(args, ctx)` functions so tests can call handlers without HTTP; identity and resources come from here, not `FastifyRequest`. `collab`/`editing`/`presence` are optional: without collab the live-doc tools aren't registered. */
import type { FastifyBaseLogger } from "fastify";
import type { TokenScope } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import type { CollabServer } from "../collab/server.js";
import type { NotificationHub } from "../notifications/hub.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import type { PresenceRegistry } from "../notes/editing/presence.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { McpTestHooks } from "./hooks.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { NoteCreateHooks } from "../notes/create.js";
import type { SearchIndexHooks } from "../notes/tx/search-index.js";
import type { KnowledgeIndexHooks } from "../knowledge/tx/index-write.js";
import type { VersionService } from "../collab/versions.js";

export interface McpToolCtx {
  db: Db;
  collab?: CollabServer;
  /** Optional so contexts built without the hub still compile; posting a comment then notifies nobody live. */
  notifications?: NotificationHub;
  editing?: EditingRuntime;
  presence?: PresenceRegistry;
  /** Shared with the REST write paths so writes to one note are serialized. `create_note` deliberately skips presence (nobody can have a just-created note open). */
  writes: NoteWriteService;
  /** `tokenWrite` is charged by `require*Scope` before `resolveRole` (like the REST preHandler); `edit` after the role check, so a `none` 404 doesn't consume it. */
  limiters: {
    contentRead: FixedWindowLimiter;
    edit: FixedWindowLimiter;
    tokenWrite: FixedWindowLimiter;
    search: FixedWindowLimiter;
    /** Charged per copied attachment by `copy_note`; same instance as the upload endpoint and REST copy. */
    upload: FixedWindowLimiter;
    /** Same instance as `foldersRoutes`; separate from `edit` (see `FOLDER_LIMIT`). */
    folder: FixedWindowLimiter;
    /** Same instance as `commentsRoutes`, so MCP and REST comments share one count. */
    comment: FixedWindowLimiter;
  };
  log: FastifyBaseLogger;
  userId: string;
  userHandle: string;
  tokenId: string | null;
  /** Read tools need only `notes:read`, which `authenticateTokenOrSession` guarantees; `write-scope.ts` uses these two to decide write/move/delete. A session skips scope checks and the token limiter. */
  authKind: "token" | "session";
  /** null = session (full rights). */
  tokenScope: TokenScope | null;
  /** scheme://host[:port] with no trailing slash; only this narrow field, deliberately not the whole config. */
  publicOrigin: string;
  hooks?: McpTestHooks;
  groupTestHook?: GroupTestHook;
  /** Same instance as `notesRoutes`. */
  collabHooks: CollabHooks;
  uploadsDir: string;
  /** Milliseconds; same value as `notesRoutes`. */
  storageLockTimeoutMs: number;
  /** Same instance as `notesRoutes`. */
  versions: VersionService;
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  noteCreateHooks?: NoteCreateHooks;
  searchIndexHooks?: SearchIndexHooks;
  knowledgeIndexHooks?: KnowledgeIndexHooks;
}
