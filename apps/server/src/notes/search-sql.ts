/**
 * #93: builds the full-text search queries (builds only, never runs them). Moved here from `mcp/queries.ts` and
 * extended; MCP and REST both use it through `searchNotesForUser` in `notes/search-query.ts`.
 * The two drizzle pitfalls in the `mcp/queries.ts` header apply here too: branch selects are single-use, so the three
 * are built fresh for every query, and a set operation's ORDER BY only takes output column names, so rank is
 * `.as("rank")` first.
 * The query string is never used as a raw LIKE pattern: the body trigram path escapes it with `escapeLike`.
 *
 * Matching: title `position(lower(q) in lower(title)) > 0`; body `EXISTS (… note_search_sections … <bodyMatch>)`, where
 * `bodyMatch` is the trigram-friendly LIKE or `position(lower(q) in lower(body)) > 0` depending on `usesTrigramPath(q)`
 * (the two forms are equivalent). Title and body are ORed into one `extraWhere` for `visibleNoteBranches`, so each of the
 * three branches carries the same correlated subquery. Index rows carry no permissions: **visibility comes only from
 * the three-branch union**. `body_hit` and WHERE each evaluate the same EXISTS (a branch's WHERE can't reference its own
 * output aliases).
 * rank: title equals the query 0, title starts with it 1, title contains it 2, body only 3.
 *
 * The second (matches) statement takes only the ids on the first statement's page whose `body_hit` is true (a list the
 * server built itself) and passes them with `inArray`. **Do not** write `` sql`= ANY(${ids})` ``: drizzle expands a JS
 * array in an sql template into `($1, $2, …)`, and `ANY(($1,$2))` is an error.
 * Up to `SEARCH_MATCHES_PER_NOTE` matches per note, in `ord` order; the window is 40 code points before the hit, the hit
 * and 160 after (a PG character is a code point); the snippet is picked in JS (`notes/search-snippet.ts`).
 */
import { and, asc, desc, inArray, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { DbOrTx } from "../db/tx.js";
import { escapeLike } from "../db/like.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { noteSearchSections, notes } from "../db/schema.js";
import { notesHavingAllTagsSql } from "../tags/queries.js";
import { visibleNoteBranches } from "./list-query.js";

/**
 * Whether the database's pg_trgm extracts trigrams from CJK text. pg_trgm decides what is a word character from the
 * database's `LC_CTYPE`: under a UTF-8 locale CJK characters yield trigrams, under `C` only ASCII letters and digits do.
 * Set once at startup by `initCjkTrigramMode`. Until then (or if the probe fails) it is false: queries without 3 ASCII letters or
 * digits in a row keep the `position()` form, which is never slower than before, and ASCII queries still use the index on any locale.
 */
let cjkYieldsTrigrams = false;

export function setCjkYieldsTrigrams(value: boolean): void {
  cjkYieldsTrigrams = value;
}

/** Three CJK characters (built from code points: the source tree keeps CJK string literals out of src/). */
const CJK_SAMPLE = String.fromCodePoint(0x8cc7, 0x6599, 0x5eab);

/** Asks the database itself whether `show_trgm` returns trigrams for CJK text. */
export async function probeCjkTrigrams(db: DbOrTx): Promise<boolean> {
  const res = await db.execute<{ ok: boolean }>(sql`select coalesce(array_length(show_trgm(${CJK_SAMPLE}::text), 1), 0) > 0 as ok`);
  return res.rows[0]?.ok === true;
}

/** The logger shape `initCjkTrigramMode` needs (pino and Fastify loggers fit). */
export type SearchModeLog = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

/**
 * Startup step: probes the database and sets the routing mode. A failed probe keeps the fallback mode and never stops the
 * server; only the SQLSTATE and constraint name are logged, never the error body.
 */
export async function initCjkTrigramMode(db: DbOrTx, log: SearchModeLog): Promise<void> {
  try {
    const yields = await probeCjkTrigrams(db);
    setCjkYieldsTrigrams(yields);
    log.info({ cjkYieldsTrigrams: yields }, yields ? "search: queries with 3 letters or digits in a row use the trigram index" : "search: queries without 3 ASCII letters or digits in a row keep the position() form");
  } catch (err) {
    setCjkYieldsTrigrams(false);
    log.warn({ ...pgErrorSummary(err) }, "search: could not check pg_trgm CJK support, continuing with the fallback (queries without 3 ASCII letters or digits in a row keep the position() form)");
  }
}

/**
 * Picks the body match form. A query with a run of 3+ characters that yield trigrams uses
 * `lower(body) LIKE lower('%' || escapeLike(q) || '%')`, which can use `nss_body_trgm_idx`; anything else uses
 * `position(...)`. Both forms return the same rows (deterministic collation, UTF8), so a wrong guess only costs speed:
 * a query with no trigrams makes the index useless, so LIKE seq-scans and is slower than position().
 * Which characters yield trigrams depends on the database's `LC_CTYPE` (see `cjkYieldsTrigrams`): alphabetic characters and decimal digits
 * under a UTF-8 locale, only ASCII letters and digits under `C`.
 */
export function usesTrigramPath(q: string): boolean {
  return (cjkYieldsTrigrams ? /[\p{Alphabetic}\p{Nd}]{3}/u : /[A-Za-z0-9]{3}/).test(q);
}

export const SEARCH_MATCHES_PER_NOTE = 3;
export const SNIPPET_LEAD_CP = 40;
export const SNIPPET_TAIL_CP = 160;

/** `updatedAtKey` is pg's own microsecond text: JS `Date` has milliseconds, so truncating would skip rows (`list_notes` in `mcp/queries.ts` uses a reduced-precision sort key, which can't be copied here: it would change the shared ORDER BY). */
export interface SearchPageKey {
  rank: number;
  updatedAtKey: string;
  id: string;
}

export interface NoteSearchQueryOpts {
  userId: string;
  query: string;
  limit: number;
  bodyOnly?: boolean;
  /** Only notes carrying every one of these tags; the caller has already checked the ids belong to a space they are in. */
  tagIds?: readonly string[];
  page?: { after: SearchPageKey | null };
}

export function buildNoteSearchQuery(db: DbOrTx, opts: NoteSearchQueryOpts) {
  const q = opts.query;
  const titleHit = sql`position(lower(${q}) in lower(${notes.title})) > 0`;
  // The pattern is escaped in JS and lower()ed in PG. lower() never creates or changes `\`, `%` or `_`, so this equals
  // escaping after lower(), and the SQL carries no backslash literal (unaffected by standard_conforming_strings).
  // The title match stays on position(): it is ORed with the EXISTS, so it can only be a Filter and no index would help
  // (hence no title trigram index).
  const bodyMatch = usesTrigramPath(q)
    ? sql`lower(${noteSearchSections.body}) like lower(${"%" + escapeLike(q) + "%"})`
    : sql`position(lower(${q}) in lower(${noteSearchSections.body})) > 0`;
  const bodyHit = sql`exists (select 1 from ${noteSearchSections} where ${noteSearchSections.noteId} = ${notes.id} and ${noteSearchSections.sourceKind} = 'note' and ${bodyMatch})`;
  // WHERE can't reference output aliases, so rank is re-embedded unaliased.
  const rankExpr = sql<number>`case
    when lower(${notes.title}) = lower(${q}) then 0
    when position(lower(${q}) in lower(${notes.title})) = 1 then 1
    when ${titleHit} then 2
    else 3 end`;
  const rank = sql<number>`${rankExpr}`.as("rank");
  const titleHitCol = sql<boolean>`${titleHit}`.as("title_hit");
  const bodyHitCol = sql<boolean>`${bodyHit}`.as("body_hit");
  const page = opts.page;
  const after = page?.after ?? null;
  // Directions differ (rank asc, updated_at desc, id desc), so no row-value comparison. Build with drizzle's or(…, and(…)): a bare sql with `or (…)` inside and() renders `match and rank > r or (…)` and AND would bind first.
  const keysetCond =
    after === null
      ? undefined
      : or(
          sql`${rankExpr} > ${after.rank}`,
          and(sql`${rankExpr} = ${after.rank}`, sql`(${notes.updatedAt}, ${notes.id}) < (${after.updatedAtKey}::timestamptz, ${after.id}::uuid)`),
        );
  const updatedAtKey = sql<string>`to_char(${notes.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("updated_at_key");
  const { owned, shared, grouped } = visibleNoteBranches(db, opts.userId, {
    extraWhere: and(opts.bodyOnly === true ? bodyHit : or(titleHit, bodyHit), keysetCond, notesHavingAllTagsSql(opts.tagIds ?? [])),
    extra: { rank, titleHit: titleHitCol, bodyHit: bodyHitCol, ...(page !== undefined ? { updatedAtKey } : {}) },
  });
  return unionAll(owned, shared, grouped)
    .orderBy(asc(rank), desc(notes.updatedAt), desc(notes.id))
    .limit(opts.limit + 1);
}

export type NoteSearchRow = Awaited<ReturnType<typeof buildNoteSearchQuery>>[number];

export type SearchMatchRow = {
  note_id: string;
  section_id: string;
  ord: number;
  heading: string;
  p: number;
  win_start: number;
  win: string;
  body_len: number;
} & Record<string, unknown>;

export function buildSearchMatchesQuery(opts: { query: string; ids: string[] }): SQL {
  const q = opts.query;
  return sql`with hits as (
    select ${noteSearchSections.noteId} as note_id, ${noteSearchSections.sectionId} as section_id, ${noteSearchSections.ord} as ord,
           ${noteSearchSections.heading} as heading, ${noteSearchSections.body} as body,
           position(lower(${q}) in lower(${noteSearchSections.body})) as p
    from ${noteSearchSections}
    where ${inArray(noteSearchSections.noteId, opts.ids)} and ${noteSearchSections.sourceKind} = 'note'
  ), ranked as (
    select *, row_number() over (partition by note_id order by ord) as rn from hits where p > 0
  )
  select note_id, section_id, ord, heading, p,
         greatest(p - ${SNIPPET_LEAD_CP}, 1) as win_start,
         substr(body, greatest(p - ${SNIPPET_LEAD_CP}, 1), ${SNIPPET_LEAD_CP} + char_length(${q}) + ${SNIPPET_TAIL_CP}) as win,
         char_length(body) as body_len
  from ranked where rn <= ${SEARCH_MATCHES_PER_NOTE}
  order by note_id, ord`;
}
