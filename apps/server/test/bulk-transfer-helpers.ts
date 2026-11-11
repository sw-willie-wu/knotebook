/**
 * bulk transfer 測試共用：直接簽 bulk 權杖、MCP 呼叫小工具。HTTP 端點的工具另見各測試檔。
 */
import http from "node:http";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { hashToken } from "../src/auth/api-token.js";
import { BULK_TRANSFER_TTL_MINUTES, MAX_ACTIVE_BULK_TOKENS, generateTransferToken, type BulkAccess, type BulkRange } from "../src/auth/transfer-token.js";
import { issueBulkTransferTokenInTx } from "../src/auth/tx/issue-bulk-transfer-token.js";
import type { Db } from "../src/db/index.js";
import { transferBases } from "../src/db/schema.js";
import { EditorSession, directTarget, withDirectConnection } from "../src/notes/editing/session.js";
import { loadNoteDoc, readNoteContentFromDoc } from "../src/notes/editing/read.js";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import type { CollabServer } from "../src/collab/server.js";
import { seedDoc } from "./copy-helpers.js";
import { testEditingRuntime } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";

/** 直接跑簽發交易（不經 MCP；不經 gate、不驗範圍可見性）。被拒就丟錯。 */
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

/** markdown → Y.Doc（server 端 EditorSession；`testEditingRuntime` 的 lease 一定還）。 */
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

/** 直接寫 note_states（冷筆記）。 */
export async function seedMd(db: Db, noteId: string, markdown: string): Promise<void> {
  await seedDoc(db, noteId, await mdDoc(markdown));
}

/** block JSON 直接寫 note_states（markdown 寫不出的形：toggle、有色清單、帶段落子的 bullet）。 */
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

/** `PUT /api/transfer/notes`（預設 `text/markdown; charset=utf-8`）。 */
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

/** 單篇下載 → `{ text, fm, body }`（`bulkGet`＋`parseNoteFile`）。 */
export async function downloadNote(app: FastifyInstance, token: string, noteId: string): Promise<{ text: string; fm: Record<string, string>; body: string }> {
  const r = await bulkGet(app, `/api/transfer/notes/${noteId}`, token);
  if (r.statusCode !== 200) throw new Error(`downloadNote: ${r.statusCode} ${r.body}`);
  const text = r.body;
  const { fm, body } = parseNoteFile(text);
  return { text, fm, body };
}

/** 只改本文（保留 frontmatter 8 行）。 */
export function editBody(text: string, f: (body: string) => string): string {
  const lines = text.split("\n");
  return [...lines.slice(0, 8), f(lines.slice(8).join("\n"))].join("\n");
}

/** 改 `title` 行（值用 `JSON.stringify`）。 */
export function renameIn(text: string, title: string): string {
  return text.replace(/^title: .*$/m, `title: ${JSON.stringify(title)}`);
}

/**
 * 模擬「人」在下載之後的修改——讀路徑 fork → server 端編輯器改 → 以直連（轉換工作形的 ctx：不落款、不進 AI 修改紀錄）
 * 合併回 live doc（冷筆記會被載入、合併、落盤）。
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

/** 現況頂層 block 的 id 與型別（未 mount；比對 id 是否沿用）。 */
export async function topIdsOf(ctx: { db: Db; collab: CollabServer }, noteId: string): Promise<string[]> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
  return topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id") as string);
}

/** 現況頂層 block 的 id、型別、純文字（行內內容串起來）與子 block 數（fork 上開一次 session 讀；不寫回）。 */
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

/** MCP 讀出的整篇 markdown（比對寫回結果用；不 touch presence）。 */
export async function liveMarkdown(ctx: { db: Db; collab: CollabServer }, noteId: string): Promise<string> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
  const r = await readNoteContentFromDoc(testEditingRuntime, doc);
  if (typeof r === "string" || !("markdown" in r)) throw new Error("liveMarkdown: unexpected shape");
  return r.markdown;
}

/**
 * `node:http` 真 HTTP 的 PUT（S14 用）。`pauseAfterHeaders`：送完 header＋body 後先等 `waitBeforeEnd`；`destroyAfter`：
 * 送完 body 後（或只送一半時）在給定的 promise 解析後 destroy 連線。回應若有就收（被 destroy 時回 null）。
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

/** 一篇下載檔：前 8 行 frontmatter（兩條 `---`＋六鍵）、其後是本文。 */
export function parseNoteFile(text: string): { keys: string[]; fm: Record<string, string>; body: string } {
  const lines = text.split("\n");
  if (lines[0] !== "---" || lines[7] !== "---") throw new Error("not an 8-line front matter");
  const fm: Record<string, string> = {};
  const keys: string[] = [];
  for (const l of lines.slice(1, 7)) {
    const i = l.indexOf(": ");
    keys.push(l.slice(0, i));
    fm[l.slice(0, i)] = l.slice(i + 2);
  }
  return { keys, fm, body: lines.slice(8).join("\n") };
}

export async function basesOf(db: Db, where: { userId?: string; noteId?: string } = {}) {
  const rows = await db.select().from(transferBases);
  return rows.filter(r => (where.userId === undefined || r.userId === where.userId) && (where.noteId === undefined || r.noteId === where.noteId));
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** 收到正常結尾（chunked 的結尾 chunk）＝true；中途被斷＝false。 */
  complete: boolean;
}

/** 以 `node:http` 打整包端點、收完整回應（真 HTTP；hijack 後的中止要靠這個看，不用 inject）。 */
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

/** 一個可以從外面放行的閘（測試縫裡 await 它）。 */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>(r => {
    open = r;
  });
  return { wait, open };
}
