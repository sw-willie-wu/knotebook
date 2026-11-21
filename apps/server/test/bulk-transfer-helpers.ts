import http from "node:http";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { hashToken } from "../src/auth/api-token.js";
import { BULK_TRANSFER_TTL_MINUTES, MAX_ACTIVE_BULK_TOKENS, generateTransferToken, type BulkAccess, type BulkRange } from "../src/auth/transfer-token.js";
import { issueBulkTransferTokenInTx } from "../src/auth/tx/issue-bulk-transfer-token.js";
import type { Db } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import { notes, transferBases } from "../src/db/schema.js";
import { setNoteTagsByNamesInTx } from "../src/tags/tx/note-tags.js";
import { EditorSession, directTarget, withDirectConnection } from "../src/notes/editing/session.js";
import { loadNoteDoc, readNoteContentFromDoc } from "../src/notes/editing/read.js";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import type { CollabServer } from "../src/collab/server.js";
import { seedDoc } from "./copy-helpers.js";
import { testEditingRuntime } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

/** Runs the issuing transaction directly (bypasses MCP and the gate, doesn't check scope visibility); throws if rejected. */
export async function issueBulkDirect(
  db: Db,
  parentTokenId: string,
  opts: { access?: BulkAccess; range?: BulkRange } = {},
): Promise<{ token: string; id: string }> {
  const token = generateTransferToken();
  const r = await db.transaction(tx =>
    issueBulkTransferTokenInTx(tx, {
      tokenHash: hashToken(token),
      parentTokenId,
      access: opts.access ?? "read",
      range: opts.range ?? { kind: "all" },
      maxActive: MAX_ACTIVE_BULK_TOKENS,
      ttlMinutes: BULK_TRANSFER_TTL_MINUTES,
    }),
  );
  if (r.kind !== "issued") throw new Error(`issueBulkDirect 被拒：${r.kind}`);
  return { token, id: r.id };
}

export type ToolCallResult = { isError?: true; structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
export const callTool = (app: FastifyInstance, token: string, name: string, args: Record<string, unknown>): Promise<ToolCallResult> =>
  mcpPost(app, rpc("tools/call", { name, arguments: args }), { token }).then(r => r.json().result as ToolCallResult);

/** markdown -> Y.Doc via a server-side EditorSession (always returns the testEditingRuntime lease). */
export async function mdDoc(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(testEditingRuntime, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, s.editor.tryParseMarkdownToBlocks(markdown));
  } finally {
    s.close();
  }
  return doc;
}

export async function seedMd(db: Db, noteId: string, markdown: string): Promise<void> {
  await seedDoc(db, noteId, await mdDoc(markdown));
}

/** Writes note_states directly from block JSON (shapes markdown can't express: toggle, colored list, bullet with paragraph children). */
export async function seedBlocks(db: Db, noteId: string, blocks: unknown[]): Promise<void> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(testEditingRuntime, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  await seedDoc(db, noteId, doc);
}

export function bulkGet(app: FastifyInstance, url: string, token?: string, opts: { cookies?: Record<string, string> } = {}) {
  return app.inject({
    method: "GET",
    url,
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
  });
}

/** `PUT /api/transfer/notes` (default `text/markdown; charset=utf-8`). */
export function bulkPut(
  app: FastifyInstance,
  token: string | undefined,
  body: string | Buffer,
  opts: { contentType?: string; origin?: string; cookies?: Record<string, string> } = {},
) {
  return app.inject({
    method: "PUT",
    url: "/api/transfer/notes",
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      "content-type": opts.contentType ?? "text/markdown; charset=utf-8",
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    },
    payload: body,
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
  });
}

export async function downloadNote(app: FastifyInstance, token: string, noteId: string): Promise<{ text: string; fm: Record<string, string>; body: string }> {
  const r = await bulkGet(app, `/api/transfer/notes/${noteId}`, token);
  if (r.statusCode !== 200) throw new Error(`downloadNote: ${r.statusCode} ${r.body}`);
  const text = r.body;
  const { fm, body } = parseNoteFile(text);
  return { text, fm, body };
}

/** Changes only the body (keeps the frontmatter lines). */
export function editBody(text: string, f: (body: string) => string): string {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1) + 1;
  return [...lines.slice(0, end), f(lines.slice(end).join("\n"))].join("\n");
}

/** Sets the front matter's `tags` line to the given JSON array text; `undefined` takes the line out. */
export function setTagsLine(text: string, json: string | undefined): string {
  const t = text.replace(/^tags: .*\n/m, "");
  return json === undefined ? t : t.replace(/^(title: .*\n)/m, `$1tags: ${json}\n`);
}

export function renameIn(text: string, title: string): string {
  return text.replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`);
}

/**
 * Simulates a "human" edit after the download: read-path fork -> edit in the server-side editor -> merge back into the live doc over a direct connection
 * (conversion-work ctx: no attribution, not in the AI edit log); a cold note gets loaded, merged and persisted.
 */
export async function humanEdit(ctx: { db: Db; collab: CollabServer }, noteId: string, f: (ed: EditorSession["editor"]) => void): Promise<void> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
  const sv = Y.encodeStateVector(doc);
  const s = await EditorSession.open(testEditingRuntime, doc);
  let diff: Uint8Array;
  try {
    f(s.editor);
    diff = s.diffSince(sv);
  } finally {
    s.close();
  }
  await withDirectConnection(directTarget(ctx.collab, ctx.db), noteId, { source: "link-convert", applied: false }, d => {
    Y.applyUpdate(d, diff);
  });
}

/** Current top-level block ids (read from the Y.Doc without opening an editor session; for checking whether ids are reused). */
export async function topIdsOf(ctx: { db: Db; collab: CollabServer }, noteId: string): Promise<string[]> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
  return topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id") as string);
}

/** Current top-level block id, type, plain text (inline content joined) and child block count (read in a session opened on a fork; not written back). */
export async function liveBlocks(ctx: { db: Db; collab: CollabServer }, noteId: string): Promise<Array<{ id: string; type: string; text: string; children: number }>> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
  const s = await EditorSession.open(testEditingRuntime, doc);
  try {
    const textOf = (content: unknown): string =>
      Array.isArray(content) ? content.map(c => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : textOf((c as { content?: unknown }).content))).join("") : "";
    return s.editor.document.map(b => ({ id: b.id, type: b.type, text: textOf(b.content), children: b.children.length }));
  } finally {
    s.close();
  }
}

/** Whole-note markdown as read over MCP (to compare write-back results; doesn't touch presence). */
export async function liveMarkdown(ctx: { db: Db; collab: CollabServer }, noteId: string): Promise<string> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
  const r = await readNoteContentFromDoc(testEditingRuntime, doc);
  if (typeof r === "string" || !("markdown" in r)) throw new Error("liveMarkdown: unexpected shape");
  return r.markdown;
}

/**
 * Real HTTP PUT via `node:http`. `pauseAfterHeaders`: after sending headers + body, wait `waitBeforeEnd` first; `destroyAfter`: after the body is sent (or half of it),
 * destroy the connection once the given promise resolves. The response is collected if present (null when destroyed).
 */
export function putRaw(
  baseUrl: string,
  token: string,
  body: string,
  opts: { destroyAfter?: Promise<void>; half?: boolean } = {},
): Promise<{ status: number; body: string } | null> {
  return new Promise(resolve => {
    const buf = Buffer.from(body, "utf8");
    const req = http.request(`${baseUrl}/api/transfer/notes`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown; charset=utf-8", "content-length": String(opts.half ? buf.length * 2 : buf.length) },
    });
    req.on("error", () => resolve(null));
    req.on("response", res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => resolve(null));
    });
    req.write(buf);
    if (!opts.half) req.end();
    if (opts.destroyAfter) void opts.destroyAfter.then(() => req.destroy());
  });
}

export function bulkDelete(app: FastifyInstance, token?: string) {
  return app.inject({ method: "DELETE", url: "/api/transfer/token", headers: token !== undefined ? { authorization: `Bearer ${token}` } : {} });
}

/** A downloaded file: the frontmatter (seven keys between two `---`), then the body. */
export function parseNoteFile(text: string): { keys: string[]; fm: Record<string, string>; body: string } {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end !== 8) throw new Error("not a 9-line front matter");
  const fm: Record<string, string> = {};
  const keys: string[] = [];
  for (const l of lines.slice(1, end)) {
    const i = l.indexOf(": ");
    keys.push(l.slice(0, i));
    fm[l.slice(0, i)] = l.slice(i + 2);
  }
  return { keys, fm, body: lines.slice(end + 1).join("\n") };
}

export async function basesOf(db: Db, where: { userId?: string; noteId?: string } = {}) {
  const rows = await db.select().from(transferBases);
  return rows.filter(r => (where.userId === undefined || r.userId === where.userId) && (where.noteId === undefined || r.noteId === where.noteId));
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** true = a proper ending was received (chunked terminating chunk); false = cut midway. */
  complete: boolean;
}

/** Hits the bundle endpoint with `node:http` and collects the whole response (real HTTP; an abort after hijack is only visible this way, not with inject). */
export function exportRaw(baseUrl: string, token: string, path = "/api/transfer/export"): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } }, res => {
      const chunks: Buffer[] = [];
      let complete = false;
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        complete = res.complete;
      });
      res.on("aborted", () => {
        complete = false;
      });
      res.on("error", () => {});
      res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: complete && res.complete }));
    });
    req.on("error", reject);
  });
}

/** A gate that can be released from outside (awaited inside the test hook). */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(r => {
    open = r;
  });
  return { wait, open };
}

/** Tags a note through the production transaction, in the given order (creating missing tags in the note's own space). */
export async function seedNoteTags(db: Db, noteId: string, names: readonly string[], createdBy: string): Promise<void> {
  const [n] = await db.select({ ownerId: notes.ownerId, groupId: notes.groupId }).from(notes).where(eq(notes.id, noteId));
  const out = await db.transaction(tx => setNoteTagsByNamesInTx(tx, { noteId, expected: { ownerId: n!.ownerId, groupId: n!.groupId }, names, createdBy }));
  if (out.kind !== "ok") throw new Error(`seedNoteTags: ${out.kind}`);
}
