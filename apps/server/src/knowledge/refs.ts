// Single statements, no transaction. Visibility comes only from `visibleNoteBranches`: the three branches are a CTE and the knowledge rows are joined to it, so a note the caller can't see (or one in the trash) can't contribute a row.
import { eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { KNOWLEDGE_REFS_LIMIT, canonicalNotePath, type KnowledgeRefCandidateDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { visibleNoteBranches } from "../notes/list-query.js";

interface RefRow extends Record<string, unknown> {
  note_id: string;
  title: string;
  slug: string;
  owner_handle: string | null;
  group_id: string | null;
  knowledge_id: string;
  block_id: string;
  heading: string;
  conclusion: string;
}

const toDto = (r: RefRow): KnowledgeRefCandidateDto => ({
  noteId: r.note_id,
  noteTitle: r.title,
  path: canonicalNotePath({ ownerHandle: r.owner_handle, groupId: r.group_id, slug: r.slug }),
  knowledgeId: r.knowledge_id,
  blockId: r.block_id,
  heading: r.heading,
  conclusion: r.conclusion,
});

const SELECTED = sql`vn.id as note_id, vn.title, vn.slug, vn.owner_handle, vn.group_id, nk.knowledge_id, nk.block_id, nk.heading, nk.conclusion`;

/** Plain substring match, case-insensitive, on the heading, when, conclusion or the note's title (`position`, not LIKE: `%` and `_` in the query stay literal). Headings that start with the query come first. */
export async function searchKnowledgeRefs(db: Db, input: { userId: string; query: string; excludeNoteId: string | null }): Promise<KnowledgeRefCandidateDto[]> {
  const { owned, shared, grouped } = visibleNoteBranches(db, input.userId);
  const q = input.query.toLowerCase();
  const exclude = input.excludeNoteId === null ? sql`` : sql` and vn.id <> ${input.excludeNoteId.toLowerCase()}::uuid`;
  const result = await db.execute<RefRow>(sql`
    with vn as (${unionAll(owned, shared, grouped)})
    select ${SELECTED}
    from vn join note_knowledge nk on nk.note_id = vn.id
    where (position(${q} in lower(nk.heading)) > 0 or position(${q} in lower(nk.read_when)) > 0 or position(${q} in lower(nk.conclusion)) > 0 or position(${q} in lower(vn.title)) > 0)${exclude}
    order by (position(${q} in lower(nk.heading)) = 1) desc, vn.updated_at desc, vn.id, nk.ord
    limit ${KNOWLEDGE_REFS_LIMIT}`);
  return result.rows.map(toDto);
}

export async function resolveKnowledgeRef(db: Db, input: { userId: string; noteId: string; knowledgeId: string }): Promise<KnowledgeRefCandidateDto | null> {
  const { owned, shared, grouped } = visibleNoteBranches(db, input.userId, { extraWhere: eq(notes.id, input.noteId.toLowerCase()) });
  const result = await db.execute<RefRow>(sql`
    with vn as (${unionAll(owned, shared, grouped)})
    select ${SELECTED}
    from vn join note_knowledge nk on nk.note_id = vn.id
    where nk.knowledge_id = ${input.knowledgeId}
    limit 1`);
  const row = result.rows[0];
  return row === undefined ? null : toDto(row);
}
