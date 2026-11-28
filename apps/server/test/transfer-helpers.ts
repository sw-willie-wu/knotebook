// The multipart assembly and `rawSocketPost` in `uploads.test.ts` are private to that file; a separate copy is written here.
import { eq, sql } from "drizzle-orm";
import type { TokenScope } from "@knotebook/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { hashToken } from "../src/auth/api-token.js";
import { generateTransferToken, MAX_PENDING_UPLOAD_TOKENS, type TransferPurpose } from "../src/auth/transfer-token.js";
import { issueTransferTokenInTx } from "../src/auth/tx/issue-transfer-token.js";
import { transferTokens } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";

/** A complete 8-byte PNG signature plus arbitrary content (`detectRasterImageMimeType` requires the full signature). */
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const BOUNDARY = "knotebookTransferBoundary";
export const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;

export function fileBody(data: Buffer, opts: { filename?: string; contentType?: string } = {}): Buffer {
  const head =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${opts.filename ?? "a.png"}"\r\n` +
    `Content-Type: ${opts.contentType ?? "image/png"}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "utf-8"), data, Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf-8")]);
}

export function fieldOnlyBody(): Buffer {
  return Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`, "utf-8");
}

export async function ownerWithPat(
  db: Db,
  scope: TokenScope = "notes:read notes:write",
): Promise<{ userId: string; pat: string; patId: string; noteId: string }> {
  const user = await seedUser(db);
  const { token, tokenId } = await seedTokenForUser(db, user.id, scope);
  const note = await seedNote(db, { ownerId: user.id });
  return { userId: user.id, pat: token, patId: tokenId, noteId: note.id };
}

/** Runs the issuing transaction directly (not via MCP; charges no bucket, no gate). Throws if rejected - the test wants a really issued token. */
export async function issueDirect(db: Db, parentTokenId: string, noteId: string, purpose: TransferPurpose): Promise<{ token: string; id: string }> {
  const token = generateTransferToken();
  const r = await db.transaction(tx =>
    issueTransferTokenInTx(tx, { tokenHash: hashToken(token), parentTokenId, noteId, purpose, maxPendingUploads: MAX_PENDING_UPLOAD_TOKENS }),
  );
  if (r.kind !== "issued") throw new Error(`issueDirect 被拒：${r.kind}`);
  return { token, id: r.id };
}

/** Expires a child token. `created_at` is moved back too, otherwise it hits `transfer_tokens_expiry_chk` (expires_at > created_at). */
export async function expireToken(db: Db, id: string): Promise<void> {
  await db
    .update(transferTokens)
    .set({ createdAt: sql`now() - interval '20 minutes'`, expiresAt: sql`now() - interval '1 minute'` })
    .where(eq(transferTokens.id, id));
}

export async function tokenRow(db: Db, id: string) {
  const [row] = await db.select().from(transferTokens).where(eq(transferTokens.id, id));
  return row;
}

export function upload(
  app: FastifyInstance,
  noteId: string,
  body: Buffer,
  opts: { token?: string; cookies?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    payload: body,
    headers: { "content-type": MULTIPART, ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
  });
}

export function download(
  app: FastifyInstance,
  uploadId: string,
  opts: { token?: string; cookies?: Record<string, string>; method?: "GET" | "HEAD" } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: opts.method ?? "GET",
    url: `/api/uploads/${uploadId}`,
    headers: opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {},
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
  });
}
