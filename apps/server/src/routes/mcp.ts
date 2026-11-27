import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CollabServer } from "../collab/server.js";
import type { NotificationHub } from "../notifications/hub.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import type { PresenceRegistry } from "../notes/editing/presence.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError } from "../http/errors.js";
import { mcpOriginAllowed } from "../http/origin.js";
import type { McpTestHooks } from "../mcp/hooks.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { VersionService } from "../collab/versions.js";
import type { NoteCreateHooks } from "../notes/create.js";
import type { SearchIndexHooks } from "../notes/tx/search-index.js";
import type { KnowledgeIndexHooks } from "../knowledge/tx/index-write.js";
import { hasOpenNotesAsFiles, registerMcpTools } from "../mcp/register.js";
import { mcpInstructions, MCP_SERVER_NAME, MCP_SERVER_VERSION, versionReadFailed } from "../mcp/server-info.js";
import { canWriteNotes } from "../mcp/write-scope.js";
import { sendWebResponse, toWebRequest } from "../mcp/transport.js";

/**
 * Order is a contract: JSON guard → authentication → Origin guard → build server / register tools / registerCapabilities / connect → handleRequest → materialize the Response
 * → copy to reply; finally closes the server. The route stays on the global onSend chain (nosniff). Stateless, one instance per request (the SDK throws if a transport is reused);
 * registerCapabilities must come after registering tools and before connect() (declaring in the constructor options has no effect; after connect() it throws).
 * GET/DELETE give 405 + Allow: POST only after authentication, so unauthenticated requests still get the 401 challenge (#130).
 * ⚠ Differs from the spec: a bad JSON body is this site's 400 bad_request (Fastify's parser rejects it before the SDK), not -32700; with no Content-Type and no body the SDK
 * answers 415 -32000; -32700 has no reachable path here. With no tool registered, tools/list and tools/call return 200 + -32601 (handlers are installed by the first
 * registerTool; registerCapabilities installs none, so initialize still says listChanged: false), not an empty list, so -32601 doesn't mean the order is wrong.
 * Unreachable today because list_notes/search_notes always register; kept for a future scope filter that removes every tool.
 * tools/list depends on credential scope and on whether the app has collab/editing.
 */

// Must match the SDK's handleUnsupportedRequest.
const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32000, message: "Method Not Allowed: this MCP endpoint only accepts POST." },
} as const;

export interface McpRouteDeps {
  db: Db;
  config: AppConfig;
  collab?: CollabServer;
  notifications?: NotificationHub;
  editing?: EditingRuntime;
  // Picked one by one so MCP sees only the ones it uses; folder is the same instance as foldersRoutes (charged in folders/service.ts). tokenWrite is charged at the scope
  // check and edit after the role check, as in REST.
  limiters: {
    contentRead: FixedWindowLimiter;
    edit: FixedWindowLimiter;
    tokenWrite: FixedWindowLimiter;
    search: FixedWindowLimiter;
    upload: FixedWindowLimiter;
    folder: FixedWindowLimiter;
    comment: FixedWindowLimiter;
  };
  presence?: PresenceRegistry;
  /** Same write service instance as notesRoutes, so MCP and REST writes serialize per note. */
  writes: NoteWriteService;
  testHooks?: McpTestHooks;
  groupTestHook?: GroupTestHook;
  collabHooks: CollabHooks;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  versions: VersionService;
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  noteCreateHooks?: NoteCreateHooks;
  searchIndexHooks?: SearchIndexHooks;
  knowledgeIndexHooks?: KnowledgeIndexHooks;
}

export function mcpRoutes(deps: McpRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    if (versionReadFailed) {
      app.log.warn("讀不到 apps/server/package.json 的 version，MCP serverInfo 退成 0.0.0");
    }

    const publicOrigin = publicUrlIssuer(deps.config.publicUrl);
    const endpointUrl = `${publicOrigin}/api/mcp`;
    const publicHost = deps.config.publicUrl.host;

    const authenticate = app.authenticateTokenOrSession("notes:read", "notes:read notes:write notes:move notes:delete");

    // After authentication so unauthenticated requests get 401 first; attached to all three routes, else GET with a bad Origin would be 405 instead of 403.
    const originGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const origin = request.headers.origin;
      // No Origin: non-browser clients pass deliberately.
      if (origin === undefined) return;
      if (!mcpOriginAllowed(origin, request.host, publicHost)) {
        sendError(reply, 403, "forbidden", "Origin check failed: the request's Origin and Host must both match this site's address (PUBLIC_URL).");
        return;
      }
    };

    const preHandler = [authenticate, originGuard];

    const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      reply.header("allow", "POST");
      return reply.code(405).send(METHOD_NOT_ALLOWED_BODY);
    };

    app.get("/api/mcp", { preHandler }, methodNotAllowed);
    app.delete("/api/mcp", { preHandler }, methodNotAllowed);

    app.post("/api/mcp", { preHandler, bodyLimit: WRITE_BODY_LIMIT }, async (request, reply) => {
      // instructions is either-or per request, decided by canWriteNotes (same as scope filtering at registration) so the list and the instructions can't disagree.
      // canMoveNotes/canDeleteNotes only affect registration. #417: whether open_notes_as_files is registered decides whether instructions mention it.
      // The read-only variant names no write tools and explains how to get write access instead.
      const authKind = request.authKind === "session" ? "session" : "token";
      const canWrite = canWriteNotes({ authKind, tokenScope: request.tokenScope ?? null });
      const filesTool = hasOpenNotesAsFiles({ authKind, collab: deps.collab, editing: deps.editing });
      const server = new McpServer(
        { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        { instructions: mcpInstructions(canWrite, filesTool) }
      );
      // Identity is bound into the tool closures (tools never read request); registerCapabilities must come after tool registration.
      registerMcpTools(server, {
        db: deps.db,
        collab: deps.collab,
        notifications: deps.notifications,
        editing: deps.editing,
        presence: deps.presence,
        writes: deps.writes,
        limiters: deps.limiters,
        log: request.log,
        userId: request.user!.id,
        userHandle: request.user!.handle,
        tokenId: request.tokenId ?? null,
        authKind: request.authKind === "session" ? "session" : "token",
        tokenScope: request.tokenScope ?? null,
        publicOrigin,
        hooks: deps.testHooks,
        groupTestHook: deps.groupTestHook,
        collabHooks: deps.collabHooks,
        uploadsDir: deps.uploadsDir,
        storageLockTimeoutMs: deps.storageLockTimeoutMs,
        versions: deps.versions,
        slugUpdateTestHook: deps.slugUpdateTestHook,
        noteCreateHooks: deps.noteCreateHooks,
        searchIndexHooks: deps.searchIndexHooks,
        knowledgeIndexHooks: deps.knowledgeIndexHooks,
      });
      server.server.registerCapabilities({ tools: { listChanged: false } });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        const res = await transport.handleRequest(toWebRequest(request, endpointUrl), {
          parsedBody: request.body,
        });
        // Materialize status/headers/body into values before closing the server.
        const status = res.status;
        const headers = [...res.headers] as [string, string][];
        const text = await res.text();
        deps.testHooks?.beforeReply?.();
        return sendWebResponse(reply, { status, headers, text });
      } finally {
        await server.close();
        deps.testHooks?.afterClose?.();
      }
    });
  };
}
