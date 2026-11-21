/**
 * Statement order is a contract, the same as the full-text index's. Notes KEY SHARE first: when the state row already exists the upsert doesn't insert (no FK check), so without it this transaction would hold the state row while a permanent delete's cascade locks this note's knowledge rows and then waits for the state row, and this transaction deleting the old rows waits on the delete: a cycle. With notes KEY SHARE the delete waits on the notes row and never reaches the child rows.
 * Then the state-row placeholder `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` (concurrent index transactions for one note queue here). `note_states.version` is read only after holding that lock (READ COMMITTED takes a snapshot per statement): reading first would let a backfill overwrite a newer index with an older one. `source_version > version` only happens if note_states was written backwards outside the app: write anyway and report `regressed`.
 * A missing or different `note_states` version -> `stale`; same hash and extractor version -> only `source_version` advances (`unchanged`); otherwise the rows are replaced in 500-row INSERTs -> `written`. Skips are exceptions so drizzle rolls back the placeholder; `writeKnowledgeIndex` catches them, the copy transaction doesn't (the whole copy fails).
 * Lock order: notes KEY SHARE -> note_knowledge_state row -> note_knowledge rows. Move, trash and permanent delete take FOR UPDATE on the note row and never touch the two knowledge tables (nothing here depends on a note's space), so they only queue ahead of or behind this transaction's first statement, when it holds nothing else.
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteKnowledge, noteKnowledgeState, noteStates, notes } from "../../db/schema.js";
import type { KnowledgeIndexExtract } from "../extract.js";

export interface KnowledgeIndexInput {
  noteId: string;
  sourceVersion: number;
  extract: KnowledgeIndexExtract;
}

export interface KnowledgeIndexHooks {
  beforeStateLockForTest?(): Promise<void>;
  afterVersionReadForTest?(): Promise<void>;
  afterWriteForTest?(): Promise<void>;
}

export class KnowledgeIndexSkip extends Error {
  constructor(readonly reason: "gone" | "stale") {
    super(`knowledge index skipped: ${reason}`);
    this.name = "KnowledgeIndexSkip";
  }
}

export interface KnowledgeIndexTxResult {
  outcome: "written" | "unchanged";
  regressed: { stateSourceVersion: number; noteStateVersion: number } | null;
}

const INSERT_BATCH = 500;

export async function replaceNoteKnowledgeIndexInTx(tx: Tx, input: KnowledgeIndexInput, hooks?: KnowledgeIndexHooks): Promise<KnowledgeIndexTxResult> {
  const { noteId, sourceVersion, extract } = input;
  const [note] = await tx.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId)).for("key share");
  if (!note) throw new KnowledgeIndexSkip("gone");
  await hooks?.beforeStateLockForTest?.();
  await tx
    .insert(noteKnowledgeState)
    .values({ noteId, extractorVersion: 0, sourceVersion: -1, contentHash: "", entries: 0, capped: false })
    .onConflictDoNothing({ target: noteKnowledgeState.noteId });
  const [state] = await tx
    .select({ sourceVersion: noteKnowledgeState.sourceVersion, contentHash: noteKnowledgeState.contentHash, extractorVersion: noteKnowledgeState.extractorVersion })
    .from(noteKnowledgeState)
    .where(eq(noteKnowledgeState.noteId, noteId))
    .for("update");
  const [current] = await tx.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
  await hooks?.afterVersionReadForTest?.();
  if (!current || current.version !== sourceVersion) throw new KnowledgeIndexSkip("stale");
  const regressed = state!.sourceVersion > current.version ? { stateSourceVersion: state!.sourceVersion, noteStateVersion: current.version } : null;

  if (state!.contentHash === extract.contentHash && state!.extractorVersion === extract.extractorVersion) {
    await tx.update(noteKnowledgeState).set({ sourceVersion, indexedAt: sql`now()` }).where(eq(noteKnowledgeState.noteId, noteId));
    return { outcome: "unchanged", regressed };
  }

  await tx.delete(noteKnowledge).where(eq(noteKnowledge.noteId, noteId));
  for (let i = 0; i < extract.rows.length; i += INSERT_BATCH) {
    await tx.insert(noteKnowledge).values(
      extract.rows.slice(i, i + INSERT_BATCH).map((r) => ({
        noteId,
        knowledgeId: r.knowledgeId,
        blockId: r.blockId,
        ord: r.ord,
        level: r.level,
        heading: r.heading,
        readWhen: r.when,
        conclusion: r.conclusion,
        evidence: r.evidence,
        verified: r.verified,
        status: r.status,
        icon: r.icon,
        parentKnowledgeId: r.parentKnowledgeId,
        supersededNoteId: r.supersededNoteId,
        supersededKnowledgeId: r.supersededKnowledgeId,
        descTotal: r.descTotal,
        descVerified: r.descVerified,
        descNoDate: r.descNoDate,
        descNeedsReview: r.descNeedsReview,
        descOutdated: r.descOutdated,
      })),
    );
  }
  await tx
    .update(noteKnowledgeState)
    .set({
      extractorVersion: extract.extractorVersion,
      sourceVersion,
      contentHash: extract.contentHash,
      entries: extract.rows.length,
      capped: extract.capped,
      indexedAt: sql`now()`,
    })
    .where(eq(noteKnowledgeState.noteId, noteId));
  await hooks?.afterWriteForTest?.();
  return { outcome: "written", regressed };
}
