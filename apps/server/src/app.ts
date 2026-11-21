import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyFormbody from "@fastify/formbody";
import { SITE_LIMITS, type ErrorCode, type RequiredScope, type TokenScope } from "@knotebook/shared";
import { publicUrlIssuer, type AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { resolveSessionUser as resolveSessionUserFromCookies, type GateUser, type ResolvedSession, type UserGate } from "./auth/session.js";
import { LastActiveTracker } from "./auth/last-active.js";
import { createAuthenticateTokenOrSession } from "./auth/bearer.js";
import type { LoginThrottle } from "./auth/rate-limit.js";
import type { CollabHooks } from "./collab/hooks.js";
import type { CollabServer } from "./collab/server.js";
import { SCAN_STOP_GRACE_MS, VERSION_AUTO_SCAN_INTERVAL_MS, VERSION_SWEEP_FIRST_DELAY_MS, VERSION_SWEEP_INTERVAL_MS, createVersionService } from "./collab/versions.js";
import { authRoutes } from "./routes/auth.js";
import { notesRoutes } from "./routes/notes.js";
import { noteVersionsRoutes } from "./routes/note-versions.js";
import { trashRoutes } from "./routes/trash.js";
import { foldersRoutes } from "./routes/folders.js";
import { favoritesRoutes } from "./routes/favorites.js";
import { tagsRoutes } from "./routes/tags.js";
import { groupsRoutes } from "./routes/groups.js";
import { searchRoutes } from "./routes/search.js";
import { usersRoutes } from "./routes/users.js";
import type { WriteNoteLinksHooks } from "./notes/links.js";
import type { SlugPatchTestHook } from "./notes/tx/patch-slug.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { adminInvitesRoutes } from "./routes/admin-invites.js";
import { adminPasswordResetRoutes } from "./routes/admin-password-reset.js";
import { adminStorageRoutes } from "./routes/admin-storage.js";
import { storageRoutes } from "./routes/storage.js";
import { adminAiRoutes } from "./routes/admin-ai.js";
import { adminAuthRoutes } from "./routes/admin-auth.js";
import { adminVersionsRoutes } from "./routes/admin-versions.js";
import { adminLimitsRoutes } from "./routes/admin-limits.js";
import { adminTrashRoutes } from "./routes/admin-trash.js";
import { testHookRoutes } from "./routes/test-hooks.js";
import { accountRoutes } from "./routes/account.js";
import { avatarsRoutes } from "./routes/avatars.js";
import { passwordResetRoutes } from "./routes/password-reset.js";
import { aiRoutes } from "./routes/ai.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { transferRoutes, type TransferTestHooks } from "./routes/transfer.js";
import type { BulkAccess, BulkRange } from "./auth/transfer-token.js";
import { publicRoutes, redactPublicTokens } from "./routes/public.js";
import { oidcRoutes } from "./routes/oidc.js";
import { oidcPendingRoutes } from "./routes/oidc-pending.js";
import { oidcLinkRoutes } from "./routes/oidc-link.js";
import { mcpRoutes } from "./routes/mcp.js";
import type { McpTestHooks } from "./mcp/hooks.js";
import { apiTokensRoutes } from "./routes/api-tokens.js";
import { drainWithCap } from "./http/drain.js";
import { BODY_TOO_LARGE_MESSAGE, sendError } from "./http/errors.js";
import { stripDefaultPort } from "./http/origin.js";
import { buildAdjustableLimiters, buildFixedLimiters, mergeLimiters, type Limiters } from "./http/limiters.js";
import { FORM_EXEMPT_ROUTES, isOauthScopedPath, sendOauthError } from "./http/oauth-errors.js";
import { oauthRoutes } from "./routes/oauth.js";
import { oauthMetadataRoutes } from "./routes/oauth-metadata.js";
import { oauthApiRoutes } from "./routes/oauth-api.js";
import { registerSpaFallback } from "./http/spa.js";
import { lowercaseUuidParams } from "./http/uuid-params.js";
import { assertUploadsDirWritable } from "./uploads/service.js";
import type { AiRuntime } from "./ai/runtime.js";
import { createOidcRuntimeRegistry, type OidcRuntimeRegistry } from "./auth/oidc-client.js";
import type { OidcTestHook } from "./auth/oidc-test-hook.js";
import type { AdminTestHook } from "./auth/admin-test-hook.js";
import { createEditingRuntime, type EditingRuntime } from "./notes/editing/runtime.js";
import { PARSE_LIMIT_KEYS } from "./notes/editing/parse-settings.js";
import type { EditingTestHooks } from "./notes/editing/apply.js";
import { PresenceRegistry, type PresenceOptions } from "./notes/editing/presence.js";
import { NoteWriteService } from "./notes/editing/write-service.js";
import type { ShownLinkTexts } from "./notes/editing/shown-link-texts.js";
import { createLinkConversion, errorSummary, NOOP_LINK_CONVERSION, type LinkConversion } from "./notes/link-conversion.js";
import { TRASH_PURGE_FIRST_DELAY_MS, TRASH_PURGE_INTERVAL_MS, createTrashPurger } from "./trash/purge.js";
import type { NoteCreateHooks } from "./notes/create.js";
import type { GroupTestHook } from "./groups/test-hook.js";
import type { AvatarTestHooks } from "./avatars/tx/avatars.js";
import type { AvatarFetchPolicy } from "./avatars/oidc-fetch.js";
import type { OidcAvatarJobHooks } from "./avatars/oidc-job.js";
import type { SearchIndexHooks } from "./notes/tx/search-index.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "./storage/tx/quota.js";
import type { SiteLimits } from "./site-limits/store.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** No-op when there is no collab server. */
    linkConversion: LinkConversion;
    /** Accepts a Bearer token or a cookie session; see `auth/bearer.ts`. */
    authenticateTokenOrSession(
      required: RequiredScope,
      challenge?: string
    ): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: GateUser;
    /** Session JWT `tv`; the collab-token route signs it into the token, and `GateUser` doesn't carry it. */
    sessionTv?: number;
    /** Session JWT `sid`; signed into collab tokens so the collab gate can check the session row still exists. */
    sessionId?: string;
    authKind?: "session" | "token" | "transfer";
    tokenScope?: TokenScope;
    /** `api_tokens.id`, never the plaintext; on the transfer path, the parent token's id. */
    tokenId?: string;
    /** `noteId` is lowercase (DB form). */
    transfer?: { id: string; noteId: string; purpose: "upload" | "download"; parentTokenId: string };
    /** Ids in `range` are lowercase. */
    bulkTransfer?: { id: string; parentTokenId: string; access: BulkAccess; range: BulkRange };
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  /** Must be built on the same `db` and `config.limitEnv` (the only source of env-locked limits). */
  siteLimits: SiteLimits;
  gate: UserGate;
  throttle: LoginThrottle;
  collabHooks: CollabHooks;
  collab?: CollabServer;
  /** Ignored without `collab`; content routes are then not registered, so REST-only apps don't pay for jsdom. */
  editing?: EditingRuntime;
  /** An injected `editing` follows this app's siteLimits only when true (the injector owns it); a self-built one always does. */
  editingFollowsSiteLimits?: boolean;
  /** Overrides individual limiters. Tests must pass fresh instances, never a module singleton, or counts leak between test files. */
  limiters?: Partial<Limiters>;
  editingTestHooks?: EditingTestHooks;
  shownLinks?: ShownLinkTexts;
  mcpTestHooks?: McpTestHooks;
  transferTestHooks?: TransferTestHooks;
  /** Milliseconds; defaults to `NoteWriteQueue`'s 10 s. */
  editingQueueWaitMs?: number;
  presence?: PresenceRegistry;
  presenceOptions?: PresenceOptions;
  linkSyncTestHooks?: WriteNoteLinksHooks;
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  slugPatchTestHook?: SlugPatchTestHook;
  noteCreateHooks?: NoteCreateHooks;
  groupTestHook?: GroupTestHook;
  avatarTestHooks?: AvatarTestHooks;
  /** Test-only, to allow a local image server; defaults to `PRODUCTION_AVATAR_FETCH_POLICY`, and no env var can relax it. */
  avatarFetchPolicy?: AvatarFetchPolicy;
  avatarJobHooks?: OidcAvatarJobHooks;
  searchIndexHooks?: SearchIndexHooks;
  /** Milliseconds; test-only (no env var). */
  storageLockTimeoutMs?: number;
  /** Tests leave it off and call `sweep`/`scanDue` directly. */
  startVersionJobs?: boolean;
  startTrashPurge?: boolean;
  trashPurgeFirstDelayMs?: number;
  trashPurgeIntervalMs?: number;
  /** Delay before re-verifying the older session's collab connections after the same account signs in again. */
  reloginReverifyDelayMs?: number;
  versionAutoScanIntervalMs?: number;
  uploadsDir: string;
  ai: AiRuntime;
  oidcRegistry?: OidcRuntimeRegistry;
  /** Test-only: production never sets it, and no env var or HTTP path can. */
  oidcTestHook?: OidcTestHook;
  /** Test-only: production never sets it, and no env var or HTTP path can. */
  adminTestHook?: AdminTestHook;
}

export interface BuildAppOptions {
  /** Takes full logger options so tests can hook pino's `logMethod`. */
  logger?: FastifyServerOptions["logger"];
  webDist?: string;
  /** Milliseconds; test-only, because fake timers with real SSE I/O are unreliable in CI. */
  aiIdleTimeoutMs?: number;
}

const CHANGE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Matched against the route pattern (`routeOptions.url`), so one `:id` entry covers every id.
const MULTIPART_EXEMPT_ROUTES = new Set(["POST /api/notes/:id/uploads", "PUT /api/admin/auth/providers/:id/icon", "POST /api/auth/avatars", "PUT /api/auth/avatars/:id/display"]);

/** `is404` first: a 404 request has no route pattern. */
function isMultipartExemptRoute(request: FastifyRequest): boolean {
  if (request.is404) return false;
  const url = request.routeOptions.url;
  if (url === undefined) return false;
  return MULTIPART_EXEMPT_ROUTES.has(`${request.method} ${url}`);
}

// The text/markdown parser is registered app-wide, so this list is what keeps other routes at 415.
const TEXT_BODY_EXEMPT_ROUTES = new Set(["PUT /api/transfer/notes"]);

function isTextBodyExemptRoute(request: FastifyRequest): boolean {
  if (request.is404) return false;
  const url = request.routeOptions.url;
  if (url === undefined) return false;
  return TEXT_BODY_EXEMPT_ROUTES.has(`${request.method} ${url}`);
}

/**
 * Compares `host`, not `hostname`: hostname drops the port, so LAN and dev origins (e.g. localhost:5173) would be rejected.
 * With TRUST_PROXY, `request.host` may come from X-Forwarded-Host; browsers can't send that cross-site
 * without a CORS preflight, which this server never grants. Adding CORS breaks this assumption.
 */
function isOriginAllowed(origin: string, requestHost: string): boolean {
  if (origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return stripDefaultPort(originHost) === stripDefaultPort(requestHost);
}

function clientErrorCode(statusCode: number): ErrorCode {
  if (statusCode === 415) return "unsupported_media_type";
  if (statusCode === 413) return "content_too_large";
  return "bad_request";
}


/**
 * Always overrides `serializers.req`, even a caller's: redacting share tokens from URLs is a security invariant.
 * Fields mirror fastify's default req serializer; only `url` differs.
 */
function withTokenRedaction(logger: FastifyServerOptions["logger"]): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const base = logger === true ? {} : (logger ?? {});
  return {
    ...base,
    serializers: {
      ...(typeof base === "object" && "serializers" in base ? base.serializers : {}),
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactPublicTokens(request.url),
          version: typeof request.headers["accept-version"] === "string" ? request.headers["accept-version"] : undefined,
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  };
}
export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  assertUploadsDirWritable(deps.uploadsDir);

  // find-my-way counts decoded UTF-16 units, so old `<vanity>-<uuid>` links with astral characters exceed
  // the default 100 and get 414. Set via routerOptions: top-level maxParamLength is deprecated (FSTDEP022)
  // and would silently fall back to 100 once removed.
  const app = Fastify({
    // Wrapped after the default so an injected test logger still gets redaction.
    logger: withTokenRedaction(options.logger ?? true),
    trustProxy: deps.config.trustProxy,
    routerOptions: { maxParamLength: 512 },
  });

  // Forwarded headers without TRUST_PROXY mean an undeclared proxy: every client gets the proxy's IP, so a few
  // failed logins lock everyone out. Warn once; it's a deployment problem, not a per-request event.
  if (!deps.config.trustProxy) {
    let warned = false;
    app.addHook("onRequest", async request => {
      // Not just X-Forwarded-For: proxies that send only X-Real-IP or Forwarded cause the same shared-IP problem.
      const forwardedHeaders = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"];
      if (warned || !forwardedHeaders.some(name => request.headers[name] !== undefined)) return;
      warned = true;
      request.log.warn(
        { hint: "TRUST_PROXY" },
        "收到帶轉發 header 的請求，但 TRUST_PROXY 未設定：所有 per-IP 節流會以代理的位址為準（全站共用一份額度）。反代拓撲請設定 TRUST_PROXY，見 docs/self-hosting.md"
      );
    });
  }

  // No secret: the session cookie is already a signed JWT.
  void app.register(fastifyCookie);

  // Top-level on purpose: inside uploadsRoutes' encapsulated context the parser wouldn't reach other routes,
  // and the CSRF test (multipart to /api/auth/login must 415) would pass without proving the allowlist works.
  // fileSize is the registry maximum; routes/uploads.ts enforces the live limit. No `limits.files`: the route
  // keeps the first file part and drains the rest. throwFileSizeLimit:false lets the route map `.truncated`
  // to 413 file_too_large instead of the plugin error aborting the parts() loop.
  void app.register(fastifyMultipart, {
    limits: { fileSize: SITE_LIMITS.uploadMaxBytes.max, parts: 32, fields: 16, fieldSize: 1024 },
    throwFileSizeLimit: false,
  });

  // /oauth/token takes form bodies (OAuth spec); top-level for the same reason as multipart.
  void app.register(fastifyFormbody);

  // Top-level for the same reason as multipart. Returns the raw Buffer; the route decodes it as strict UTF-8.
  app.addContentTypeParser("text/markdown", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  // On every response, not only HTML (CSP is in http/spa.ts), so JSON and assets can't be MIME-sniffed.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
  });

  // onRequest also runs for unmatched routes once setNotFoundHandler is used (fastify#3120).
  app.addHook("onRequest", async (request, reply) => {
    if (!CHANGE_METHODS.has(request.method)) return;

    // Chunked requests have a body but no content-length; body-less mutations (e.g. logout) pass.
    const transferEncoding = request.headers["transfer-encoding"];
    const contentLength = request.headers["content-length"];
    const hasBody = transferEncoding !== undefined || (contentLength !== undefined && contentLength !== "0");
    if (!hasBody) return;

    // Exact essence, not includes(): `text/plain;charset=application/json` is CORS-safelisted.
    const contentType = request.headers["content-type"];
    const essence = contentType?.split(";")[0]?.trim().toLowerCase();

    // OAuth prefixes get RFC-shaped 415s, matched by URL prefix because `routeOptions.url` is undefined on 404.
    const pathname = request.url.split("?")[0]!;
    if (isOauthScopedPath(pathname)) {
      const wantsForm = !request.is404 && FORM_EXEMPT_ROUTES.has(`${request.method} ${request.routeOptions.url}`);
      const expected = wantsForm ? "application/x-www-form-urlencoded" : "application/json";
      if (essence !== expected) {
        return sendOauthError(reply, 415, "invalid_request", `This request needs Content-Type ${expected}.`);
      }
      return;
    }

    // Exempt routes still require their own essence (otherwise the parser throws non-contract errors) plus the
    // Origin check. Their 415 and 403 early returns drain, with a cap, so a rejected upload gets an error body instead
    // of a network error mid-transfer. The JSON 415 below doesn't drain: normal clients never hit it.
    if (isMultipartExemptRoute(request)) {
      if (essence !== "multipart/form-data") {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", "This request needs Content-Type multipart/form-data.");
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !isOriginAllowed(origin, request.host)) {
        drainWithCap(request);
        return sendError(reply, 403, "forbidden", "Origin check failed: the request's Origin doesn't match its Host.");
      }
      return;
    }

    if (isTextBodyExemptRoute(request)) {
      if (essence !== "text/markdown") {
        drainWithCap(request);
        return sendError(reply, 415, "unsupported_media_type", "This request needs Content-Type text/markdown.");
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !isOriginAllowed(origin, request.host)) {
        drainWithCap(request);
        return sendError(reply, 403, "forbidden", "Origin check failed: the request's Origin doesn't match its Host.");
      }
      return;
    }

    if (essence !== "application/json") {
      return sendError(reply, 415, "unsupported_media_type", "This request needs Content-Type application/json.");
    }
  });

  /**
   * Returns null instead of replying. The Bearer path can't fall back by calling `authenticate`: after
   * sendError, a `WWW-Authenticate` header is silently lost (fastify 5). Records last activity here because
   * both session paths come through; token requests don't count as activity.
   */
  const lastActive = deps.collab?.lastActive ?? new LastActiveTracker(deps.db, app.log);
  async function resolveSessionUser(request: FastifyRequest): Promise<ResolvedSession | null> {
    const resolved = await resolveSessionUserFromCookies(request.cookies, deps.config.appSecret, deps.gate);
    if (resolved) await lastActive.touch(resolved.user.id);
    return resolved;
  }

  app.decorate("authenticate", async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const resolved = await resolveSessionUser(request);
    if (!resolved) {
      sendError(reply, 401, "unauthorized", "Not signed in.");
      return;
    }
    // The collab-token route signs both `sessionTv` and `sessionId` into the token.
    request.user = resolved.user;
    request.sessionTv = resolved.tv;
    request.sessionId = resolved.sid;
  });

  app.decorate("requireAdmin", async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.user?.isAdmin) {
      sendError(reply, 403, "forbidden", "Only site admins can do this.");
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  const limiters = mergeLimiters(
    { ...buildFixedLimiters(), ...buildAdjustableLimiters(deps.siteLimits) } satisfies Limiters,
    deps.limiters
  );
  const storageLockTimeoutMs = deps.storageLockTimeoutMs ?? DEFAULT_STORAGE_LOCK_TIMEOUT_MS;
  // Without collab, an unbound service: REST reads note_states as the live state.
  const versions = deps.collab?.versions ?? createVersionService({ db: deps.db, log: app.log });
  if (deps.startVersionJobs) {
    const runSweep = (): void => {
      void versions.sweep(new Date()).catch(err => app.log.warn({ err }, "版本清除背景掃描失敗"));
    };
    const first = setTimeout(runSweep, VERSION_SWEEP_FIRST_DELAY_MS);
    first.unref();
    const every = setInterval(runSweep, VERSION_SWEEP_INTERVAL_MS);
    every.unref();
    // No first-run timeout; scanDue itself prevents overlapping runs.
    const runScan = (): void => {
      void versions.scanDue().catch(err => app.log.warn({ err }, "自動切版背景掃描失敗"));
    };
    const scanEvery = setInterval(runScan, deps.versionAutoScanIntervalMs ?? VERSION_AUTO_SCAN_INTERVAL_MS);
    scanEvery.unref();
    app.addHook("onClose", async () => {
      clearTimeout(first);
      clearInterval(every);
      clearInterval(scanEvery);
      // Bounded so a stuck note can't stall close; same grace as the index.ts shutdown.
      await Promise.race([versions.stopScan(), new Promise<void>(resolve => setTimeout(resolve, SCAN_STOP_GRACE_MS).unref())]);
    });
  }

  if (deps.startTrashPurge) {
    const purger = createTrashPurger({ db: deps.db, log: app.log, uploadsDir: deps.uploadsDir, groupTestHook: deps.groupTestHook });
    const run = (): void => {
      void purger.runOnce().catch(err => app.log.warn({ err: errorSummary(err) }, "垃圾桶清理背景工作失敗"));
    };
    const first = setTimeout(run, deps.trashPurgeFirstDelayMs ?? TRASH_PURGE_FIRST_DELAY_MS);
    first.unref();
    const every = setInterval(run, deps.trashPurgeIntervalMs ?? TRASH_PURGE_INTERVAL_MS);
    every.unref();
    app.addHook("onClose", async () => {
      clearTimeout(first);
      clearInterval(every);
      await Promise.race([purger.stop(), new Promise<void>(resolve => setTimeout(resolve, SCAN_STOP_GRACE_MS).unref())]);
    });
  }

  // Before any route registration: route plugins call app.authenticateTokenOrSession.
  app.decorate(
    "authenticateTokenOrSession",
    createAuthenticateTokenOrSession({
      db: deps.db,
      gate: deps.gate,
      // Origin, not href: href's trailing slash yields `…3000//.well-known/…`.
      issuer: publicUrlIssuer(deps.config.publicUrl),
      resolveSessionUser,
      limiters: { bearerMiss: limiters.bearerMiss, tokenRead: limiters.tokenRead, tokenWrite: limiters.tokenWrite },
    })
  );

  // Before any route registration: app-level preValidation reaches every route plugin and runs before their
  // preHandlers, so auth and handlers see lowercase ids.
  app.addHook("preValidation", lowercaseUuidParams);

  void app.register(
    authRoutes({ db: deps.db, config: deps.config, siteLimits: deps.siteLimits, gate: deps.gate, throttle: deps.throttle, collabHooks: deps.collabHooks, reloginReverifyDelayMs: deps.reloginReverifyDelayMs })
  );
  void app.register(
    apiTokensRoutes({ db: deps.db, siteLimits: deps.siteLimits, limiters: { patCreate: limiters.patCreate, tokenRename: limiters.tokenRename } })
  );
  void app.register(oauthApiRoutes({ db: deps.db, config: deps.config, siteLimits: deps.siteLimits }));

  // Per app, never a module singleton (same as limiters).
  const oidcRegistry = deps.oidcRegistry ?? createOidcRuntimeRegistry();
  void app.register(
    oidcRoutes({ config: deps.config, db: deps.db, siteLimits: deps.siteLimits, gate: deps.gate, collabHooks: deps.collabHooks, reloginReverifyDelayMs: deps.reloginReverifyDelayMs, registry: oidcRegistry, limiters: { oidcLogin: limiters.oidcLogin, oidcCallback: limiters.oidcCallback }, oidcTestHook: deps.oidcTestHook, uploadsDir: deps.uploadsDir, storageLockTimeoutMs, avatarFetchPolicy: deps.avatarFetchPolicy, avatarJobHooks: deps.avatarJobHooks }),
  );
  void app.register(
    oidcPendingRoutes({ config: deps.config, db: deps.db, siteLimits: deps.siteLimits, gate: deps.gate, collabHooks: deps.collabHooks, reloginReverifyDelayMs: deps.reloginReverifyDelayMs, throttle: deps.throttle, registry: oidcRegistry, limiters: { oidcLogin: limiters.oidcLogin }, oidcTestHook: deps.oidcTestHook }),
  );
  void app.register(oidcLinkRoutes({ db: deps.db, config: deps.config, registry: oidcRegistry, limiters: { oidcLogin: limiters.oidcLogin } }));

  // Only with collab: createEditingRuntime installs jsdom globals at once, which REST-only apps shouldn't pay
  // for or expose to browser sniffing.
  const ownEditing = deps.collab !== undefined && deps.editing === undefined;
  const editing = deps.collab ? (deps.editing ?? createEditingRuntime(deps.config, deps.siteLimits.parseLimits(), app.log)) : undefined;
  if (editing) {
    // Injected runtimes can be shared across test apps, so they follow siteLimits only when asked.
    const offSiteLimits =
      ownEditing || deps.editingFollowsSiteLimits === true
        ? deps.siteLimits.onChange(keys => {
            if (PARSE_LIMIT_KEYS.some(k => keys.has(k))) editing.parser.configure?.(deps.siteLimits.parseLimits());
          })
        : null;
    if (offSiteLimits !== null || ownEditing) {
      app.addHook("onClose", async () => {
        offSiteLimits?.();
        if (ownEditing) await editing.close();
      });
    }
  }

  // stopAll() is required: each entry holds a setInterval that would keep handles open after app.close().
  const presence = deps.presence ?? new PresenceRegistry(deps.collab?.hocuspocus, deps.presenceOptions);
  app.addHook("onClose", async () => {
    presence.stopAll();
  });

  // Built once and shared with mcpRoutes: it owns the single NoteWriteQueue, so MCP and REST writes to a note serialize.
  const writes = new NoteWriteService({
    db: deps.db,
    collab: deps.collab,
    editing,
    presence,
    queueWaitMs: deps.editingQueueWaitMs,
    testHooks: deps.editingTestHooks,
    versions,
    renameHook: deps.slugUpdateTestHook,
    shownLinks: deps.shownLinks,
    noteMaxBytes: () => deps.siteLimits.get("noteMaxBytes"),
  });

  // Same `writes`, so conversion queues behind other writes. index.ts starts it after listen; tests call runLinkConversion directly.
  const linkConversion = writes.available
    ? createLinkConversion({ db: deps.db, writes, versions, log: app.log, siteOrigin: deps.config.publicUrl.origin })
    : NOOP_LINK_CONVERSION;
  app.decorate("linkConversion", linkConversion);
  app.addHook("onClose", async () => {
    // Bounded so an in-flight note can't push app.close()/pool.end() past SIGKILL.
    await Promise.race([linkConversion.stop(), new Promise<void>(resolve => setTimeout(resolve, SCAN_STOP_GRACE_MS).unref())]);
  });

  void app.register(
    notesRoutes({
      db: deps.db,
      collabHooks: deps.collabHooks,
      config: deps.config,
      siteLimits: deps.siteLimits,
      collab: deps.collab,
      editing,
      limiters,
      writes,
      versions,
      presence,
      linkSyncTestHooks: deps.linkSyncTestHooks,
      slugUpdateTestHook: deps.slugUpdateTestHook,
      slugPatchTestHook: deps.slugPatchTestHook,
      noteCreateHooks: deps.noteCreateHooks,
      groupTestHook: deps.groupTestHook,
      searchIndexHooks: deps.searchIndexHooks,
      uploadsDir: deps.uploadsDir,
      storageLockTimeoutMs,
    })
  );
  void app.register(noteVersionsRoutes({ db: deps.db, versions, writes, limiters: { edit: limiters.edit } }));
  void app.register(trashRoutes({ db: deps.db, collabHooks: deps.collabHooks, uploadsDir: deps.uploadsDir, storageLockTimeoutMs, groupTestHook: deps.groupTestHook }));
  void app.register(foldersRoutes({ db: deps.db, collabHooks: deps.collabHooks, storageLockTimeoutMs, groupTestHook: deps.groupTestHook, limiters: { folder: limiters.folder } }));
  void app.register(favoritesRoutes({ db: deps.db, limiters: { favorite: limiters.favorite }, groupTestHook: deps.groupTestHook }));
  void app.register(tagsRoutes({ db: deps.db, limiters: { tag: limiters.tag }, groupTestHook: deps.groupTestHook }));
  void app.register(groupsRoutes({ db: deps.db, collabHooks: deps.collabHooks, groupTestHook: deps.groupTestHook, uploadsDir: deps.uploadsDir, storageLockTimeoutMs, versions }));
  void app.register(usersRoutes({ db: deps.db, limiters: { userSuggest: limiters.userSuggest } }));
  void app.register(searchRoutes({ db: deps.db, limiters: { search: limiters.search } }));
  void app.register(adminUsersRoutes({ db: deps.db, gate: deps.gate, collabHooks: deps.collabHooks, adminTestHook: deps.adminTestHook }));
  void app.register(adminPasswordResetRoutes({ db: deps.db, config: deps.config }));
  void app.register(adminInvitesRoutes({ db: deps.db, config: deps.config }));
  void app.register(adminStorageRoutes({ db: deps.db }));
  void app.register(storageRoutes({ db: deps.db }));
  void app.register(adminAiRoutes({ db: deps.db, config: deps.config, runtime: deps.ai }));
  // Same registry as the login routes, so provider edits invalidate cached runtimes.
  void app.register(adminAuthRoutes({ db: deps.db, config: deps.config, registry: oidcRegistry }));
  void app.register(adminVersionsRoutes({ db: deps.db }));
  void app.register(adminTrashRoutes({ db: deps.db }));
  void app.register(adminLimitsRoutes({ db: deps.db, siteLimits: deps.siteLimits }));
  // Only with KNOTEBOOK_E2E_TEST_HOOKS=1 and a loopback PUBLIC_URL (config.ts).
  if (deps.config.testHooks) void app.register(testHookRoutes({ versions }));
  // Same oneTimeLink* instances as passwordResetRoutes, so invite and reset attempts share one budget.
  void app.register(
    accountRoutes({
      db: deps.db,
      config: deps.config,
      siteLimits: deps.siteLimits,
      gate: deps.gate,
      collabHooks: deps.collabHooks,
      reloginReverifyDelayMs: deps.reloginReverifyDelayMs,
      limiters: { register: limiters.register, oneTimeLinkMiss: limiters.oneTimeLinkMiss, oneTimeLinkAttempt: limiters.oneTimeLinkAttempt },
    }),
  );
  void app.register(
    avatarsRoutes({
      db: deps.db,
      gate: deps.gate,
      limiters: { upload: limiters.upload, avatarRefresh: limiters.avatarRefresh },
      uploadsDir: deps.uploadsDir,
      siteLimits: deps.siteLimits,
      storageLockTimeoutMs,
      avatarFetchPolicy: deps.avatarFetchPolicy,
      avatarTestHooks: deps.avatarTestHooks,
    }),
  );
  void app.register(
    passwordResetRoutes({
      db: deps.db,
      config: deps.config,
      siteLimits: deps.siteLimits,
      gate: deps.gate,
      collabHooks: deps.collabHooks,
      limiters: { oneTimeLinkMiss: limiters.oneTimeLinkMiss, oneTimeLinkAttempt: limiters.oneTimeLinkAttempt },
    }),
  );
  void app.register(
    aiRoutes({ db: deps.db, config: deps.config, runtime: deps.ai, limiters: { ai: limiters.ai }, idleTimeoutMs: options.aiIdleTimeoutMs })
  );
  void app.register(
    uploadsRoutes({
      db: deps.db,
      config: deps.config,
      siteLimits: deps.siteLimits,
      gate: deps.gate,
      // Same instances as authenticateTokenOrSession's, so misses count against one budget.
      limiters: { upload: limiters.upload, bearerMiss: limiters.bearerMiss, tokenRead: limiters.tokenRead },
      uploadsDir: deps.uploadsDir,
      groupTestHook: deps.groupTestHook,
      storageLockTimeoutMs,
    })
  );
  void app.register(publicRoutes({ db: deps.db, uploadsDir: deps.uploadsDir, limiters: { publicMiss: limiters.publicMiss, publicNote: limiters.publicNote, publicUpload: limiters.publicUpload } }));
  void app.register(
    mcpRoutes({
      db: deps.db,
      config: deps.config,
      collab: deps.collab,
      editing,
      // Only MCP's own limiters; upload and folder are the same instances as the REST routes'.
      limiters: { contentRead: limiters.contentRead, edit: limiters.edit, tokenWrite: limiters.tokenWrite, search: limiters.search, upload: limiters.upload, folder: limiters.folder },
      presence,
      writes,
      testHooks: deps.mcpTestHooks,
      groupTestHook: deps.groupTestHook,
      collabHooks: deps.collabHooks,
      uploadsDir: deps.uploadsDir,
      storageLockTimeoutMs,
      versions,
      slugUpdateTestHook: deps.slugUpdateTestHook,
      noteCreateHooks: deps.noteCreateHooks,
      searchIndexHooks: deps.searchIndexHooks,
    })
  );

  // Export needs live docs and mounts, so only with collab and editing.
  if (deps.collab && editing) {
    void app.register(
      transferRoutes({
        db: deps.db,
        config: deps.config,
        gate: deps.gate,
        collab: deps.collab,
        editing,
        limiters: { bearerMiss: limiters.bearerMiss, contentRead: limiters.contentRead, transferExport: limiters.transferExport, transferWrite: limiters.transferWrite, tokenRead: limiters.tokenRead },
        writes,
        testHooks: deps.transferTestHooks,
      })
    );
  }

  // Prefixed: the root notFound handler belongs to spa.ts.
  void app.register(
    oauthRoutes({
      db: deps.db,
      config: deps.config,
      siteLimits: deps.siteLimits,
      gate: deps.gate,
      limiters: { dcr: limiters.dcr, authorize: limiters.authorize, tokenEndpoint: limiters.tokenEndpoint },
    }),
    { prefix: "/oauth" }
  );
  void app.register(oauthMetadataRoutes({ config: deps.config }), { prefix: "/.well-known" });

  // WebSocket upgrades bypass Fastify routing, so neither route order nor the SPA fallback affects them.
  deps.collab?.attach(app);

  registerSpaFallback(app, options.webDist);

  // Keep fastify's own 4xx status (e.g. invalid JSON → 400) rather than turning it into 500; only ≥500 is logged.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // Identity in logs is authKind and tokenId only, never the token or Authorization header.
      request.log.error({ err: error, authKind: request.authKind, tokenId: request.tokenId }, "unhandled error");
      return sendError(reply, 500, "internal", "Internal server error.");
    }
    // Fixed sentence instead of fastify's native 413 message, matching the other errors.
    const message = status === 413 ? BODY_TOO_LARGE_MESSAGE : error.message || "Bad request.";
    return sendError(reply, status, clientErrorCode(status), message);
  });

  return app;
}
