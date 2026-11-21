// Fragments only: nothing here is executed. Outer note columns are written as literals because a single-table select renders `${notes.id}` as a bare "id", which inside these subqueries would resolve to their own table.
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { KnowledgeIndexEvidenceFilter, KnowledgeIndexStatusFilter } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { noteKnowledge, noteKnowledgeState, noteStates, notes } from "../db/schema.js";
import { NOTES_FOLDER_ID, subtreeFolderIdsSql } from "../folders/sql.js";
import { visibleNoteBranches } from "../notes/list-query.js";
import { notesHavingAllTagsSql } from "../tags/queries.js";
import { KNOWLEDGE_EXTRACTOR_VERSION } from "./extract.js";
import type { KnowledgeScope } from "./scope.js";

const OUTER_NOTE_ID = (): SQL => sql.raw('"notes"."id"');

/** `GET /api/notes` extra column. The primary-key prefix is enough: the state row's `entries` can be stale for a note that has none. */
export function noteHasKnowledgeSql(): SQL.Aliased<boolean> {
  return sql<boolean>`exists (select 1 from ${noteKnowledge} nk where nk.note_id = ${OUTER_NOTE_ID()})`.as("has_knowledge");
}

export interface KnowledgeIndexFilters {
  tagIds: readonly string[];
  status: KnowledgeIndexStatusFilter | null;
  evidence: KnowledgeIndexEvidenceFilter | null;
}

function entryConditions(filters: Pick<KnowledgeIndexFilters, "status" | "evidence">): SQL[] {
  const out: SQL[] = [];
  if (filters.status !== null) out.push(sql`nk.icon = ${filters.status}`);
  if (filters.evidence !== null) out.push(sql`nk.evidence = ${filters.evidence === "unconfirmed" ? "" : filters.evidence}`);
  return out;
}

/** The same icon/evidence conditions as `entryConditions`, for the `note_knowledge` select that loads the rows. */
export function entryFilterWhere(filters: Pick<KnowledgeIndexFilters, "status" | "evidence">): SQL | undefined {
  return and(
    filters.status === null ? undefined : eq(noteKnowledge.icon, filters.status),
    filters.evidence === null ? undefined : eq(noteKnowledge.evidence, filters.evidence === "unconfirmed" ? "" : filters.evidence),
  );
}

/** `extraWhere`: notes carrying every given tag and having at least one knowledge row that passes the status and evidence filters. */
export function knowledgeFilterSql(filters: KnowledgeIndexFilters): SQL {
  const conditions = entryConditions(filters);
  const rows = sql`exists (select 1 from ${noteKnowledge} nk where nk.note_id = ${OUTER_NOTE_ID()}${conditions.length === 0 ? sql`` : sql` and ${sql.join(conditions, sql` and `)}`})`;
  return and(notesHavingAllTagsSql(filters.tagIds), rows)!;
}

/** `extra` column: how many rows pass the filters, which is what the size limit adds up. */
export function knowledgeMatchCountSql(filters: Pick<KnowledgeIndexFilters, "status" | "evidence">): SQL.Aliased<number> {
  const conditions = entryConditions(filters);
  return sql<number>`(select count(*)::int from ${noteKnowledge} nk where nk.note_id = ${OUTER_NOTE_ID()}${conditions.length === 0 ? sql`` : sql` and ${sql.join(conditions, sql` and `)}`})`
    .mapWith(Number)
    .as("match_count");
}

/** `extra` column: the note had more than `KNOWLEDGE_INDEX_NOTE_MAX` entries and only the first ones were indexed. A missing state row reads as not capped. */
export function knowledgeCappedSql(): SQL.Aliased<boolean> {
  return sql<boolean>`coalesce((select ks.capped from ${noteKnowledgeState} ks where ks.note_id = ${OUTER_NOTE_ID()}), false)`.as("knowledge_capped");
}

/** A note somebody has opened (it has a stored document) whose index state is missing or from another extractor version. A lagging `source_version` doesn't count: a note without knowledge lags all the time. */
export function backfillPendingSql(): SQL {
  const outerId = OUTER_NOTE_ID();
  return sql`exists (select 1 from ${noteStates} ns where ns.note_id = ${outerId}) and not exists (select 1 from ${noteKnowledgeState} ks where ks.note_id = ${outerId} and ks.extractor_version = ${KNOWLEDGE_EXTRACTOR_VERSION})`;
}

/**
 * The scope's notes, from the one visibility branch that can hold them: a personal scope only has your own notes, a group scope only group notes,
 * and a folder scope belongs to one of the two. The other two branches are empty for these scopes (notes shared with you are never in a space you own or
 * in a group), so they are not built. Builders are single-use: every call builds a fresh one.
 */
export function scopedNoteBranch<E extends Record<string, SQL.Aliased> = Record<never, never>>(
  db: DbOrTx,
  userId: string,
  scope: KnowledgeScope,
  opts: { extraWhere?: SQL; extra?: E } = {},
) {
  const groupId = scope.kind === "group" ? scope.groupId : scope.kind === "folder" && scope.space.kind === "group" ? scope.space.groupId : null;
  const inFolder = scope.kind === "folder" ? sql`${NOTES_FOLDER_ID()} in (${subtreeFolderIdsSql(scope.folderId)})` : undefined;
  const branches = visibleNoteBranches(db, userId, {
    ...(opts.extra === undefined ? {} : { extra: opts.extra }),
    extraWhere: and(groupId === null ? undefined : eq(notes.groupId, groupId), inFolder, opts.extraWhere),
  });
  return (groupId === null ? branches.owned : branches.grouped) as typeof branches.owned;
}
