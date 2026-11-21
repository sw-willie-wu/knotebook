// An FK violation counts as "gone" defensively: the transaction already holds notes KEY SHARE, so current paths can't reach it. `bumpKnowledgeIndexVersion` locks only the state row (a deleter holds notes then waits on the state row: no cycle) and advances only when hash and extractor version match, returning the row count (0 -> the caller clears its cache). Other errors are rethrown (the store swallows, backfill warns).
import { and, asc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "../db/index.js";
import { noteKnowledgeState, noteStates } from "../db/schema.js";
import { isForeignKeyViolation, pgErrorSummary } from "../db/pg-errors.js";
import type { BackfillLogger, BackfillOptions, BackfillResult } from "../notes/search-index.js";
import {
  EMPTY_KNOWLEDGE_EXTRACT,
  KNOWLEDGE_EXTRACTOR_VERSION,
  bytesMayHoldKnowledgeEntries,
  extractKnowledgeForIndex,
  type KnowledgeIndexExtract,
} from "./extract.js";
import { KnowledgeIndexSkip, replaceNoteKnowledgeIndexInTx, type KnowledgeIndexHooks, type KnowledgeIndexTxResult } from "./tx/index-write.js";

export { extractKnowledgeForIndex };

export type KnowledgeIndexOutcome = "written" | "unchanged" | "gone" | "stale";

/** Only these three fields reach a log: a DrizzleQueryError's message and params hold the INSERT values, i.e. the text of the knowledge. */
export function knowledgeErrorFields(err: unknown): { code: string | null; constraint: string | null; name: string } {
  return { ...pgErrorSummary(err), name: err instanceof Error ? err.name : typeof err };
}

export async function writeKnowledgeIndex(
  db: Db,
  noteId: string,
  sourceVersion: number,
  extract: KnowledgeIndexExtract,
  opts: { log?: { warn(obj: object, msg: string): void }; hooks?: KnowledgeIndexHooks } = {},
): Promise<KnowledgeIndexOutcome> {
  const input = { noteId, sourceVersion, extract };
  const hooks = opts.hooks;
  let result: KnowledgeIndexTxResult;
  try {
    result = await db.transaction((tx) => replaceNoteKnowledgeIndexInTx(tx, input, hooks));
  } catch (err) {
    if (err instanceof KnowledgeIndexSkip) return err.reason;
    if (isForeignKeyViolation(err)) return "gone";
    throw err;
  }
  if (result.regressed) {
    opts.log?.warn({ noteId, ...result.regressed }, "note_states.version is below the knowledge index source_version; writing the persisted content anyway");
  }
  return result.outcome;
}

export async function bumpKnowledgeIndexVersion(db: Db, noteId: string, sourceVersion: number, contentHash: string): Promise<number> {
  const updated = await db
    .update(noteKnowledgeState)
    .set({ sourceVersion })
    .where(
      and(
        eq(noteKnowledgeState.noteId, noteId),
        eq(noteKnowledgeState.contentHash, contentHash),
        eq(noteKnowledgeState.extractorVersion, KNOWLEDGE_EXTRACTOR_VERSION),
        lt(noteKnowledgeState.sourceVersion, sourceVersion),
      ),
    )
    .returning({ noteId: noteKnowledgeState.noteId });
  return updated.length;
}

const BACKFILL_BATCH = 20;
const BACKFILL_PROGRESS_EVERY = 500;

function backfillCandidate() {
  return or(
    isNull(noteKnowledgeState.noteId),
    ne(noteKnowledgeState.extractorVersion, KNOWLEDGE_EXTRACTOR_VERSION),
    ne(noteKnowledgeState.sourceVersion, noteStates.version),
  );
}

/** Converges to the latest persisted version under any interleaving with live persists (lock first, then read the version). A run with no candidates logs nothing. */
export async function backfillKnowledgeIndex(db: Db, log: BackfillLogger, opts: BackfillOptions = {}): Promise<BackfillResult> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? BACKFILL_BATCH;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(noteStates)
    .leftJoin(noteKnowledgeState, eq(noteKnowledgeState.noteId, noteStates.noteId))
    .where(backfillCandidate());
  const candidates = count?.n ?? 0;
  if (candidates === 0) return { candidates: 0, done: 0, skipped: 0, failed: 0, aborted: false, ms: Date.now() - started };
  log.info({ candidates }, "knowledge index backfill started");
  let after: string | null = null;
  let processed = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;
  outer: for (;;) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    const page = await db
      .select({ noteId: noteStates.noteId })
      .from(noteStates)
      .leftJoin(noteKnowledgeState, eq(noteKnowledgeState.noteId, noteStates.noteId))
      .where(and(after === null ? undefined : gt(noteStates.noteId, after), backfillCandidate()))
      .orderBy(asc(noteStates.noteId))
      .limit(batchSize);
    if (page.length === 0) break;
    for (const { noteId } of page) {
      if (opts.signal?.aborted) {
        aborted = true;
        break outer;
      }
      after = noteId;
      processed += 1;
      try {
        const [row] = await db.select({ ydoc: noteStates.ydoc, version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId));
        if (!row) {
          skipped += 1;
        } else {
          let extract = EMPTY_KNOWLEDGE_EXTRACT;
          if (bytesMayHoldKnowledgeEntries(row.ydoc)) {
            const doc = new Y.Doc();
            try {
              Y.applyUpdate(doc, row.ydoc);
              extract = extractKnowledgeForIndex(doc);
            } finally {
              doc.destroy();
            }
          }
          // Shutdown may arrive during the awaits above; check again so we don't write while the pool is closing and log a misleading failure.
          if (opts.signal?.aborted) {
            aborted = true;
            break outer;
          }
          const outcome = await writeKnowledgeIndex(db, noteId, row.version, extract, { log });
          if (outcome === "written" || outcome === "unchanged") done += 1;
          else skipped += 1;
        }
      } catch (err) {
        failed += 1;
        log.warn({ ...knowledgeErrorFields(err), noteId }, "knowledge index backfill: one note failed (skipped, continuing)");
      }
      await opts.afterEachForTest?.(noteId);
      if (processed % BACKFILL_PROGRESS_EVERY === 0) log.info({ processed, done, skipped, failed }, "knowledge index backfill progress");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result: BackfillResult = { candidates, done, skipped, failed, aborted, ms: Date.now() - started };
  log.info(result, aborted ? "knowledge index backfill aborted (resumes on next start)" : "knowledge index backfill finished");
  return result;
}

export const KNOWLEDGE_SWEEP_INTERVAL_MS = 600_000;

/** First run now, then every intervalMs; a run still going when the next is due is skipped. stop() aborts the current run and clears the timer. */
export function startKnowledgeIndexSweep(
  db: Db,
  log: BackfillLogger,
  opts: { intervalMs?: number; afterRunForTest?: (r: BackfillResult) => void } = {},
): { stop(): void } {
  const abort = new AbortController();
  let running = false;
  const run = async (): Promise<void> => {
    if (running || abort.signal.aborted) return;
    running = true;
    try {
      const result = await backfillKnowledgeIndex(db, log, { signal: abort.signal });
      opts.afterRunForTest?.(result);
    } catch (err) {
      try {
        log.warn(knowledgeErrorFields(err), "knowledge index backfill aborted");
      } catch {
        /* logger threw: nowhere to log */
      }
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), opts.intervalMs ?? KNOWLEDGE_SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    stop(): void {
      abort.abort();
      clearInterval(timer);
    },
  };
}
