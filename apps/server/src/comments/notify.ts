import type { Tx } from "../db/tx.js";
import { commentNotified, notifications } from "../db/schema.js";
import type { TagSpace } from "../tags/space.js";
import { readableUserIds, targetKey, type MentionTarget } from "./mentions.js";

/** A reply target already named by a mention of the same comment gets only the mention. */
export async function writeCommentNotifications(
  tx: Tx,
  input: {
    commentId: string;
    noteId: string;
    space: TagSpace;
    actor: MentionTarget;
    mentionTargets: readonly MentionTarget[];
    replyTarget: MentionTarget | null;
  },
): Promise<string[]> {
  const wanted = new Map<string, MentionTarget & { kind: "mention" | "reply" }>();
  for (const t of input.mentionTargets) if (!wanted.has(targetKey(t))) wanted.set(targetKey(t), { ...t, kind: "mention" });
  if (input.replyTarget !== null && !wanted.has(targetKey(input.replyTarget))) {
    wanted.set(targetKey(input.replyTarget), { ...input.replyTarget, kind: "reply" });
  }
  wanted.delete(targetKey(input.actor));
  if (wanted.size === 0) return [];

  const readable = await readableUserIds(tx, input.space, input.noteId, [...wanted.values()].map(t => t.userId));
  const targets = [...wanted.values()].filter(t => readable.has(t.userId));
  if (targets.length === 0) return [];

  const fresh = await tx
    .insert(commentNotified)
    .values(targets.map(t => ({ commentId: input.commentId, userId: t.userId, agentLabel: t.agentLabel })))
    .onConflictDoNothing()
    .returning({ userId: commentNotified.userId, agentLabel: commentNotified.agentLabel });
  const freshKeys = new Set(fresh.map(targetKey));
  const rows = targets.filter(t => freshKeys.has(targetKey(t)));
  if (rows.length === 0) return [];

  await tx.insert(notifications).values(
    rows.map(t => ({
      userId: t.userId,
      agentLabel: t.agentLabel,
      kind: t.kind,
      noteId: input.noteId,
      commentId: input.commentId,
      actorId: input.actor.userId,
      actorAgentLabel: input.actor.agentLabel,
    })),
  );
  return [...new Set(rows.map(t => t.userId))];
}
