import { asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "../src/db/index.js";
import { noteKnowledge, noteKnowledgeState, notes } from "../src/db/schema.js";
import { extractKnowledgeForIndex, writeKnowledgeIndex } from "../src/knowledge/index-write.js";
import { seedNote } from "./group-helpers.js";
import { searchDoc, type Blk } from "./search-doc.js";
import { seedNoteState } from "./search-helpers.js";

/** Values are `unknown` on purpose: hostile cases pass arrays, numbers and objects as Yjs attributes. */
export type KBlk = Blk & { knowledge?: Record<string, unknown> };

export function knowledgeDoc(blocks: KBlk[]): Y.Doc {
  return searchDoc(blocks.map(({ knowledge, ...b }) => ({ ...b, attrs: { ...b.attrs, ...knowledge } })));
}

interface KhExtra {
  level?: number;
  when?: string;
  conclusion?: string;
  verified?: string;
  status?: string;
  evidence?: string;
  supersededBy?: string;
}

/** A heading carrying knowledge info; `id` is the knowledge id. */
export const kh = (blockId: string, id: string, text: string, extra: KhExtra = {}): KBlk => ({
  id: blockId,
  type: "heading",
  level: extra.level ?? 2,
  text,
  knowledge: {
    knowledgeId: id,
    knowledgeWhen: extra.when ?? "",
    knowledgeConclusion: extra.conclusion ?? "",
    knowledgeVerified: extra.verified ?? "",
    knowledgeStatus: extra.status ?? "",
    knowledgeEvidence: extra.evidence ?? "",
    knowledgeSupersededBy: extra.supersededBy ?? "",
  },
});

export const kid = (n: number): string => `k_${n.toString(16).padStart(8, "0")}`;

export async function knowledgeRows(db: Db, noteId: string) {
  return db.select().from(noteKnowledge).where(eq(noteKnowledge.noteId, noteId)).orderBy(asc(noteKnowledge.ord));
}

export async function knowledgeState(db: Db, noteId: string) {
  const [row] = await db.select().from(noteKnowledgeState).where(eq(noteKnowledgeState.noteId, noteId));
  return row;
}

export async function seedKnowledgeNote(
  db: Db,
  owner: { ownerId: string } | { groupId: string },
  title: string,
  blocks: KBlk[],
  opts: { folderId?: string } = {},
): Promise<{ id: string; slug: string }> {
  const note = await seedNote(db, owner, { title });
  if (opts.folderId !== undefined) await db.update(notes).set({ folderId: opts.folderId }).where(eq(notes.id, note.id));
  const doc = knowledgeDoc(blocks);
  await seedNoteState(db, note.id, doc, 1);
  const outcome = await writeKnowledgeIndex(db, note.id, 1, extractKnowledgeForIndex(doc));
  if (outcome !== "written") throw new Error(`seedKnowledgeNote: expected written, got ${outcome}`);
  return note;
}
