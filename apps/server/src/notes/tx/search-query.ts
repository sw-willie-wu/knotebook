// Both statements run in one REPEATABLE READ READ ONLY transaction so the second sees the first's visibility and index snapshot (no unshare or index replacement lands between). The first statement is `tx.setTransaction(...)`: PG requires it before any query in the transaction, and keeping it in the body lets callers pass no second argument. The second statement runs only for a non-empty id list (the first `limit` rows; row `limit+1` only sets truncated).
import { sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { buildNoteSearchQuery, buildSearchMatchesQuery, type NoteSearchRow, type SearchMatchRow, type SearchPageKey } from "../search-sql.js";

export interface NoteSearchInput {
  userId: string;
  query: string;
  limit: number;
  bodyOnly?: boolean;
  tagIds?: readonly string[];
  page?: { after: SearchPageKey | null };
}

export interface NoteSearchResult {
  rows: NoteSearchRow[];
  matches: SearchMatchRow[];
}

export async function runNoteSearchInTx(tx: Tx, input: NoteSearchInput): Promise<NoteSearchResult> {
  await tx.setTransaction({ isolationLevel: "repeatable read", accessMode: "read only" });
  // The body EXISTS is a per-row SubPlan, so the estimated cost is far above jit_above_cost and JIT compile time
  // dominates the run time of the trigram path.
  await tx.execute(sql`set local jit = off`);
  const rows = await buildNoteSearchQuery(tx, input);
  const ids = rows.slice(0, input.limit).filter(r => r.bodyHit).map(r => r.id);
  const matches = ids.length === 0 ? [] : (await tx.execute<SearchMatchRow>(buildSearchMatchesQuery({ query: input.query, ids }))).rows;
  return { rows, matches };
}
