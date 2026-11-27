import { and, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { COMMENT_MENTIONS_MAX, MENTION_CANDIDATES_MAX, parseMentionSpans, type MentionCandidateDto, type MentionSpan } from "@knotebook/shared";
import { liveGrantSql } from "../auth/grant-quota.js";
import { readAvatarRefs } from "../avatars/read.js";
import type { Db } from "../db/index.js";
import type { DbOrTx, Tx } from "../db/tx.js";
import { apiTokens } from "../db/schema.js";
import { escapeLike } from "../db/like.js";
import { resolveNoteAccess } from "../notes/service.js";
import { hasUnstorableChar } from "../oauth/storable.js";
import { tagSpaceOf, type TagSpace } from "../tags/space.js";

export interface MentionTarget {
  userId: string;
  agentLabel: string | null;
}

export interface StoredMention extends MentionTarget {
  /** Code points, as in `parseMentionSpans`. */
  start: number;
  length: number;
}

export const targetKey = (t: MentionTarget): string => JSON.stringify([t.userId, t.agentLabel]);

/**
 * The same people `noteAccessFromRow` gives read access to, for a note whose space is already locked: the owner and sharees of a
 * personal note, members whose role reads for a group note (share rows left on a group note grant nothing). Disabled accounts excluded.
 */
export function noteReadersSql(space: TagSpace, noteId: string): SQL {
  const ids =
    space.kind === "personal"
      ? sql`select ${space.ownerId}::uuid as id union select ns.user_id from note_shares ns where ns.note_id = ${noteId}`
      : sql`select gm.user_id from group_members gm join group_roles gr on gr.id = gm.role_id where gm.group_id = ${space.groupId} and gr.can_read`;
  return sql`select u.id, u.handle, u.display_name from users u where u.disabled_at is null and u.id in (${ids})`;
}

export async function readableUserIds(tx: DbOrTx, space: TagSpace, noteId: string, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const res = await tx.execute<{ id: string }>(
    sql`select r.id from (${noteReadersSql(space, noteId)}) r where r.id = any(${sql.param([...new Set(userIds)])}::uuid[])`,
  );
  return new Set(res.rows.map(r => r.id));
}

/** Labels set explicitly on a token usable now; a label derived from a token name never names an agent here. */
async function explicitLabels(tx: DbOrTx, userIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .selectDistinct({ userId: apiTokens.userId, label: apiTokens.agentLabel })
    .from(apiTokens)
    .where(and(inArray(apiTokens.userId, [...new Set(userIds)]), isNotNull(apiTokens.agentLabel), liveGrantSql));
  for (const r of rows) {
    const set = out.get(r.userId) ?? new Set<string>();
    set.add(r.label!);
    out.set(r.userId, set);
  }
  return out;
}

const codePoints = (s: string): string[] => [...s];
const spanText = (cps: readonly string[], start: number, length: number): string => cps.slice(start, start + length).join("").toLowerCase();
const handlePart = (text: string): string => text.split("/", 1)[0]!;

/**
 * The label as written, then without trailing dots: at the end of a sentence `@alice/claude.` means `claude`. Null when neither is one of
 * the user's labels, and the mention falls back to the bare handle.
 */
function matchLabel(span: MentionSpan, labels: ReadonlySet<string> | undefined): { label: string; length: number } | null {
  if (span.label === null || labels === undefined) return null;
  const base = 1 + span.handle.length + 1;
  if (labels.has(span.label)) return { label: span.label, length: base + span.label.length };
  const trimmed = span.label.replace(/\.+$/, "");
  if (trimmed !== "" && trimmed !== span.label && labels.has(trimmed)) return { label: trimmed, length: base + trimmed.length };
  return null;
}

/**
 * Mentions of `body` for a note whose space is locked. On edit, a span takes over an unused earlier mention of the comment, in order of
 * appearance: every span first takes one whose text is the same, case-insensitively and also without trailing dots (user and label
 * kept, even if that label was renamed since); spans left over then take one with the same `@handle` (a mention that fell back to the
 * bare handle, or whose label was added or removed: user kept, label matched against that user's labels). Only the rest are resolved
 * by handle, so a handle released and
 * re-registered by someone else can't redirect an old mention. At most `COMMENT_MENTIONS_MAX` distinct targets; the rest stay text.
 */
export async function resolveMentions(
  tx: Tx,
  input: { body: string; space: TagSpace; noteId: string; previous?: { body: string; mentions: readonly StoredMention[] } },
): Promise<StoredMention[]> {
  const spans = parseMentionSpans(input.body);
  if (spans.length === 0) return [];
  const cps = codePoints(input.body);

  const prevCps = codePoints(input.previous?.body ?? "");
  const prev = [...(input.previous?.mentions ?? [])]
    .sort((a, b) => a.start - b.start)
    .map(m => ({ m, text: spanText(prevCps, m.start, m.length), used: false }));
  // Two passes, or a span matching only by handle could take the mention of a later, unchanged span.
  const carried: Array<{ m: StoredMention; exactLength: number | null } | null> = spans.map(span => {
    const full = spanText(cps, span.start, span.length);
    const trimmed = full.replace(/\.+$/, "");
    const forms = span.label !== null && trimmed !== full && !trimmed.endsWith("/") ? [full, trimmed] : [full];
    for (const form of forms) {
      const same = prev.find(p => !p.used && p.text === form);
      if (same === undefined) continue;
      same.used = true;
      return { m: same.m, exactLength: form.length };
    }
    return null;
  });
  spans.forEach((span, i) => {
    if (carried[i] !== null) return;
    const sameHandle = prev.find(p => !p.used && handlePart(p.text) === `@${span.handle}`);
    if (sameHandle === undefined) return;
    sameHandle.used = true;
    carried[i] = { m: sameHandle.m, exactLength: null };
  });

  const freshHandles = [...new Set(spans.filter((_, i) => carried[i] === null).map(s => s.handle))];
  const byHandle = new Map<string, string>();
  if (freshHandles.length > 0) {
    const res = await tx.execute<{ id: string; handle: string }>(
      sql`select r.id, r.handle from (${noteReadersSql(input.space, input.noteId)}) r where r.handle = any(${sql.param(freshHandles)}::text[])`,
    );
    for (const r of res.rows) byHandle.set(r.handle, r.id);
  }
  const labelUsers = spans.flatMap((span, i) => {
    if (span.label === null) return [];
    const c = carried[i];
    if (c && c.exactLength !== null) return [];
    const userId = c ? c.m.userId : byHandle.get(span.handle);
    return userId === undefined ? [] : [userId];
  });
  const labels = await explicitLabels(tx, labelUsers);

  const out: StoredMention[] = [];
  const targets = new Set<string>();
  spans.forEach((span, i) => {
    const c = carried[i];
    let mention: StoredMention;
    if (c && c.exactLength !== null) {
      mention = { userId: c.m.userId, agentLabel: c.m.agentLabel, start: span.start, length: c.exactLength };
    } else {
      const userId = c ? c.m.userId : byHandle.get(span.handle);
      if (userId === undefined) return;
      const label = matchLabel(span, labels.get(userId));
      mention = { userId, agentLabel: label?.label ?? null, start: span.start, length: label?.length ?? 1 + span.handle.length };
    }
    const key = targetKey(mention);
    if (!targets.has(key)) {
      if (targets.size >= COMMENT_MENTIONS_MAX) return;
      targets.add(key);
    }
    out.push(mention);
  });
  return out;
}

/**
 * Up to `MENTION_CANDIDATES_MAX` people who can read the note, the caller included, matched on handle or display name (never email).
 * Null when the caller can't read the note.
 */
export async function resolveMentionCandidates(db: Db, input: { noteId: string; viewerId: string; q: string }): Promise<MentionCandidateDto[] | null> {
  const access = await resolveNoteAccess(db, input.viewerId, input.noteId);
  if (access.role === "none") return null;
  if (hasUnstorableChar(input.q)) return [];
  const space = tagSpaceOf(access);
  const escaped = escapeLike(input.q.trim().replace(/^@/, ""));
  const contains = `%${escaped}%`;
  const prefix = `${escaped}%`;
  // lower() on both sides so JS and PG case rules can't disagree.
  const res = await db.execute<{ id: string; handle: string; display_name: string }>(sql`
    select r.id, r.handle, r.display_name
      from (${noteReadersSql(space, input.noteId)}) r
     where r.handle like lower(${contains}) escape '\\' or lower(r.display_name) like lower(${contains}) escape '\\'
     order by case when r.handle like lower(${prefix}) escape '\\' or lower(r.display_name) like lower(${prefix}) escape '\\' then 0 else 1 end,
              r.handle, r.id
     limit ${MENTION_CANDIDATES_MAX}
  `);
  const ids = res.rows.map(r => r.id);
  const [avatars, labels] = await Promise.all([readAvatarRefs(db, ids), explicitLabels(db, ids)]);
  return res.rows.map(r => ({
    userId: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatar: avatars.get(r.id) ?? null,
    agentLabels: [...(labels.get(r.id) ?? [])].sort(),
  }));
}
