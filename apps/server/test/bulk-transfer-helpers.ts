/**
 * bulk transfer（spec 2026-11-02）測試共用：直接簽 bulk 權杖、MCP 呼叫小工具。T9／T10 再補 HTTP 端點的工具。
 */
import http from "node:http";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { hashToken } from "../src/auth/api-token.js";
import { BULK_TRANSFER_TTL_MINUTES, MAX_ACTIVE_BULK_TOKENS, generateTransferToken, type BulkAccess, type BulkRange } from "../src/auth/transfer-token.js";
import { issueBulkTransferTokenInTx } from "../src/auth/tx/issue-bulk-transfer-token.js";
import type { Db } from "../src/db/index.js";
import { transferBases } from "../src/db/schema.js";
import { EditorSession } from "../src/notes/editing/session.js";
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

export function bulkGet(app: FastifyInstance, url: string, token?: string, opts: { cookies?: Record<string, string> } = {}) {
  return app.inject({
    method: "GET",
    url,
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
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
