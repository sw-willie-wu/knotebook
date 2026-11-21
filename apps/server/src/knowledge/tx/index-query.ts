// Every statement runs in one REPEATABLE READ READ ONLY transaction, so the notes, their knowledge rows and the replacement targets all come from one snapshot (a note trashed or unshared midway is either wholly in or wholly out). The first statement is `tx.setTransaction(...)`: PG requires it before any query, and keeping it in the body lets callers pass no second argument.
// Which notes the viewer may see comes only from `visibleNoteBranches` (via `scopedNoteBranch`); the scope was only resolved outside. Reads only: no row locks.
import { and, asc, inArray, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  KNOWLEDGE_INDEX_MAX,
  canonicalNotePath,
  formatKnowledgeRef,
  orderIndexNotes,
  type KnowledgeEvidence,
  type KnowledgeIndexDto,
  type KnowledgeIndexEntryDto,
  type KnowledgeIndexFolderDto,
  type KnowledgeIndexNoteDto,
  type KnowledgeIndexReplacementDto,
  type KnowledgeIndexScopeDto,
  type KnowledgeStatus,
  type NoteTagDto,
} from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { folders, noteKnowledge, notes } from "../../db/schema.js";
import { folderSpaceWhere, subtreeFolderIdsSql } from "../../folders/sql.js";
import { visibleNoteBranches } from "../../notes/list-query.js";
import { noteTagsJsonSql } from "../../tags/queries.js";
import { backfillPendingSql, entryFilterWhere, knowledgeFilterSql, knowledgeMatchCountSql, scopedNoteBranch, type KnowledgeIndexFilters } from "../index-sql.js";
import type { KnowledgeScope } from "../scope.js";

export interface KnowledgeIndexQueryInput {
  userId: string;
  scope: KnowledgeScope;
  filters: KnowledgeIndexFilters;
}

const tagKey = (t: NoteTagDto): string => t.name.toLowerCase();

function scopeDto(scope: KnowledgeScope): KnowledgeIndexScopeDto {
  switch (scope.kind) {
    case "personal":
      return { kind: "personal", groupId: null, groupName: null, folderId: null, folderPath: [] };
    case "group":
      return { kind: "group", groupId: scope.groupId, groupName: scope.groupName, folderId: null, folderPath: [] };
    case "folder":
      return {
        kind: "folder",
        groupId: scope.space.kind === "group" ? scope.space.groupId : null,
        groupName: scope.space.kind === "group" ? scope.space.groupName : null,
        folderId: scope.folderId,
        folderPath: scope.path,
      };
  }
}

export async function runKnowledgeIndexQueryInTx(tx: Tx, input: KnowledgeIndexQueryInput): Promise<KnowledgeIndexDto> {
  await tx.setTransaction({ isolationLevel: "repeatable read", accessMode: "read only" });
  // Correlated subqueries per note: their estimated cost passes jit_above_cost, and compiling costs more than the run.
  await tx.execute(sql`set local jit = off`);
  const { userId, scope, filters } = input;
  const noFilters = filters.tagIds.length === 0 && filters.status === null && filters.evidence === null;

  const matched = await scopedNoteBranch(tx, userId, scope, {
    extraWhere: knowledgeFilterSql(filters),
    extra: { tags: noteTagsJsonSql(), matchCount: knowledgeMatchCountSql(filters) },
  });

  const folderRows: KnowledgeIndexFolderDto[] = await tx
    .select({ id: folders.id, name: folders.name, parentId: folders.parentId })
    .from(folders)
    .where(
      scope.kind === "folder"
        ? sql`${folders.id} in (${subtreeFolderIdsSql(scope.folderId)})`
        : folderSpaceWhere(scope.kind === "group" ? { kind: "group", groupId: scope.groupId } : { kind: "personal", ownerId: scope.ownerId }),
    );

  // Cut on a whole-note boundary in the order the page shows the folders, so what is left is the top of the page and not a random set of notes.
  const order = orderIndexNotes({
    notes: matched.map((n) => ({ id: n.id, title: n.title, folderId: n.viewerFolderId })),
    folders: folderRows,
    rootFolderId: scope.kind === "folder" ? scope.folderId : null,
  });
  const byId = new Map(matched.map((n) => [n.id, n]));
  const keptIds: string[] = [];
  let total = 0;
  let truncated = false;
  for (const id of order) {
    const count = byId.get(id)!.matchCount;
    if (total + count > KNOWLEDGE_INDEX_MAX) {
      truncated = true;
      break;
    }
    total += count;
    keptIds.push(id);
  }

  const notesOut: KnowledgeIndexNoteDto[] = keptIds.map((id) => {
    const n = byId.get(id)!;
    return { id: n.id, title: n.title, path: canonicalNotePath(n), folderId: n.viewerFolderId, tags: n.tags };
  });

  const rows =
    keptIds.length === 0
      ? []
      : await tx
          .select()
          .from(noteKnowledge)
          .where(and(inArray(noteKnowledge.noteId, keptIds), entryFilterWhere(filters)))
          .orderBy(asc(noteKnowledge.noteId), asc(noteKnowledge.ord));

  const refs = new Map<string, { noteId: string; knowledgeId: string }>();
  const entries: KnowledgeIndexEntryDto[] = rows.map((r) => {
    // Only a row that is itself outdated has a replacement; a NULL or own note id both mean the same note.
    let supersededBy: string | null = null;
    if (r.status === "outdated" && r.supersededKnowledgeId !== null) {
      const ref = { noteId: r.supersededNoteId ?? r.noteId, knowledgeId: r.supersededKnowledgeId };
      supersededBy = formatKnowledgeRef(ref, null);
      refs.set(supersededBy, ref);
    }
    return {
      noteId: r.noteId,
      knowledgeId: r.knowledgeId,
      blockId: r.blockId,
      ord: r.ord,
      level: r.level,
      heading: r.heading,
      when: r.readWhen,
      conclusion: r.conclusion,
      evidence: r.evidence as KnowledgeEvidence,
      verified: r.verified,
      status: r.status as KnowledgeStatus,
      icon: r.icon as KnowledgeIndexEntryDto["icon"],
      parentKnowledgeId: r.parentKnowledgeId,
      supersededBy,
      summary:
        r.descTotal === 0
          ? null
          : { total: r.descTotal, verified: r.descVerified, noVerifiedDate: r.descNoDate, needsReview: r.descNeedsReview, outdated: r.descOutdated },
    };
  });

  const replacements: Record<string, KnowledgeIndexReplacementDto> = {};
  if (refs.size > 0) {
    // Whatever the viewer can't see, or that isn't there, simply has no entry: the two cases are indistinguishable in the response.
    const targetNoteIds = [...new Set([...refs.values()].map((r) => r.noteId))];
    const { owned, shared, grouped } = visibleNoteBranches(tx, userId, { extraWhere: inArray(notes.id, targetNoteIds) });
    const visible = new Map((await unionAll(owned, shared, grouped)).map((n) => [n.id, n]));
    const wanted = [...refs.values()].filter((r) => visible.has(r.noteId));
    if (wanted.length > 0) {
      const tuples = sql.join(wanted.map((r) => sql`(${r.noteId}::uuid, ${r.knowledgeId})`), sql`, `);
      const found = await tx
        .select({ noteId: noteKnowledge.noteId, knowledgeId: noteKnowledge.knowledgeId, blockId: noteKnowledge.blockId, heading: noteKnowledge.heading })
        .from(noteKnowledge)
        .where(sql`(${noteKnowledge.noteId}, ${noteKnowledge.knowledgeId}) in (${tuples})`);
      for (const f of found) {
        const note = visible.get(f.noteId)!;
        replacements[formatKnowledgeRef(f, null)] = {
          noteId: f.noteId,
          knowledgeId: f.knowledgeId,
          blockId: f.blockId,
          heading: f.heading,
          noteTitle: note.title,
          path: canonicalNotePath(note),
        };
      }
    }
  }

  // Tags of notes that have knowledge, whatever the filters say, so the filter menu never offers an empty result.
  const tagSource = noFilters
    ? matched
    : await scopedNoteBranch(tx, userId, scope, { extraWhere: knowledgeFilterSql({ tagIds: [], status: null, evidence: null }), extra: { tags: noteTagsJsonSql() } });
  const tagById = new Map<string, NoteTagDto>();
  for (const n of tagSource) for (const t of n.tags) tagById.set(t.id, t);
  const tagOptions = [...tagById.values()].sort((a, b) => (tagKey(a) < tagKey(b) ? -1 : tagKey(a) > tagKey(b) ? 1 : a.id < b.id ? -1 : 1));

  const pending = await scopedNoteBranch(tx, userId, scope, { extraWhere: backfillPendingSql() }).limit(1);

  return {
    scope: scopeDto(scope),
    folders: folderRows,
    notes: notesOut,
    entries,
    replacements,
    tagOptions,
    truncated,
    backfillPending: pending.length > 0,
  };
}
