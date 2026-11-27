import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { generateAccessToken, hashToken } from "../src/auth/api-token.js";
import { deleteCommentInTx, editCommentInTx, postCommentInTx, type CommentActor, type CommentWriteResult } from "../src/comments/tx/write.js";
import type { Db } from "../src/db/index.js";
import { apiTokens, commentNotified, noteCommentMentions, notifications, oauthClients, users } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { TxAbort } from "../src/http/tx-abort.js";

export interface NamedUser {
  id: string;
  handle: string;
}

export async function seedNamedUser(db: Db, handle: string, over: { isAdmin?: boolean; disabled?: boolean; displayName?: string } = {}): Promise<NamedUser> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${handle}-${randomUUID().slice(0, 8)}@example.com`,
      handle,
      displayName: over.displayName ?? handle[0]!.toUpperCase() + handle.slice(1),
      isAdmin: over.isAdmin ?? false,
      ...(over.disabled ? { disabledAt: new Date() } : {}),
    })
    .returning();
  return { id: u!.id, handle: u!.handle };
}

export function actorOf(user: { id: string }, over: Partial<Omit<CommentActor, "userId">> = {}): CommentActor {
  return { userId: user.id, tokenId: null, agentLabel: null, isSiteAdmin: false, ...over };
}

/**
 * A token of `userId`; `label` is the explicit `agent_label` column (undefined leaves it NULL, so only a label derived from `name`).
 * An OAuth grant gets a client of its own.
 */
export async function seedAgentToken(
  db: Db,
  userId: string,
  opts: { label?: string; name?: string; kind?: "pat" | "oauth"; expired?: boolean } = {},
): Promise<string> {
  const kind = opts.kind ?? "pat";
  const expiresAt = opts.expired ? sql`now() - interval '1 hour'` : kind === "oauth" ? sql`now() + interval '1 hour'` : null;
  let clientId: string | null = null;
  if (kind === "oauth") {
    clientId = `c-${randomUUID()}`;
    await db.insert(oauthClients).values({ clientId, clientName: "Client", redirectUris: ["https://client.example/cb"] });
  }
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      kind,
      name: opts.name ?? "agent",
      scope: "notes:read notes:write",
      accessTokenHash: hashToken(generateAccessToken()),
      refreshTokenHash: kind === "oauth" ? hashToken(generateAccessToken()) : null,
      clientId,
      accessExpiresAt: expiresAt,
      agentLabel: opts.label ?? null,
    })
    .returning({ id: apiTokens.id });
  return row!.id;
}

type PostInput = Parameters<typeof postCommentInTx>[1];

export const post = (db: Db, input: PostInput, hook?: GroupTestHook): Promise<CommentWriteResult> =>
  db.transaction(tx => postCommentInTx(tx, input, hook));
export const edit = (db: Db, input: Parameters<typeof editCommentInTx>[1], hook?: GroupTestHook): Promise<CommentWriteResult> =>
  db.transaction(tx => editCommentInTx(tx, input, hook));
export const remove = (db: Db, input: Parameters<typeof deleteCommentInTx>[1], hook?: GroupTestHook): Promise<CommentWriteResult> =>
  db.transaction(tx => deleteCommentInTx(tx, input, hook));

export async function expectAbort(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected TxAbort ${status} ${code}`).toBeInstanceOf(TxAbort);
  expect({ status: (err as TxAbort).status, code: (err as TxAbort).errCode }).toEqual({ status, code });
}

export async function mentionsOf(db: Db, commentId: string): Promise<Array<{ userId: string; agentLabel: string | null; start: number; length: number }>> {
  return db
    .select({ userId: noteCommentMentions.userId, agentLabel: noteCommentMentions.agentLabel, start: noteCommentMentions.start, length: noteCommentMentions.length })
    .from(noteCommentMentions)
    .where(eq(noteCommentMentions.commentId, commentId))
    .orderBy(asc(noteCommentMentions.start));
}

export interface NotificationRow {
  userId: string;
  agentLabel: string | null;
  kind: string;
  commentId: string;
  actorId: string;
  actorAgentLabel: string | null;
}

export async function notificationsOf(db: Db): Promise<NotificationRow[]> {
  return db
    .select({
      userId: notifications.userId,
      agentLabel: notifications.agentLabel,
      kind: notifications.kind,
      commentId: notifications.commentId,
      actorId: notifications.actorId,
      actorAgentLabel: notifications.actorAgentLabel,
    })
    .from(notifications)
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
}

export async function notifiedOf(db: Db, commentId: string): Promise<Array<{ userId: string; agentLabel: string | null }>> {
  return db
    .select({ userId: commentNotified.userId, agentLabel: commentNotified.agentLabel })
    .from(commentNotified)
    .where(eq(commentNotified.commentId, commentId));
}

/** The code-point slice a mention row covers. */
export const spanOf = (body: string, m: { start: number; length: number }): string => [...body].slice(m.start, m.start + m.length).join("");
