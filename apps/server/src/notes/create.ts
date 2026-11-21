// The only place that inserts `notes` rows (a source guard in `test/notes-slug.test.ts` enforces it): slug de-dup is an async DB probe, so scattered inserts would drift.
// Without a title no probe is issued and `slug` is left to the DB default (`untitled-<uuid8>`).
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import type { DbOrTx, Tx } from "../db/tx.js";
import { MAX_AUTO_SLUG_RETRIES, deriveUniqueAutoSlug, fallbackAutoSlug, isSlugUniqueViolation, type SlugScope } from "./slug.js";
import { writeSlugInTx } from "./tx/write-slug.js";

export interface NewNoteLocation {
  scope: SlugScope;
  /** Caller has checked visibility, space and permission; null = root. */
  folderId: string | null;
}

export interface NoteCreateHooks {
  beforeInsert?: (candidate: string) => void | Promise<void>;
}

/**
 * A slug-index collision is a race → re-probe; after `MAX_AUTO_SLUG_RETRIES` use `fallbackAutoSlug()`; a further collision surfaces. Never returns 409 `slug_taken` (reserved for explicit custom slugs). Retry only on the two slug constraints, never on any 23505.
 * `slugIsCustom`/`prevSlug`/`legacySlug` stay at their defaults so a later title PATCH still recomputes the slug.
 */
export async function insertNoteWithAutoSlug(db: Db, where: NewNoteLocation, title: string | undefined, hooks?: NoteCreateHooks): Promise<typeof notes.$inferSelect>;
/** Each INSERT runs in a `writeSlugInTx` savepoint: a plain 23505 would leave the transaction in 25P02. */
export async function insertNoteWithAutoSlug(tx: Tx, where: NewNoteLocation, title: string | undefined, hooks: NoteCreateHooks | undefined, mode: { inTx: true }): Promise<typeof notes.$inferSelect>;
export async function insertNoteWithAutoSlug(
  db: DbOrTx,
  where: NewNoteLocation,
  title: string | undefined,
  hooks?: NoteCreateHooks,
  mode?: { inTx: true },
): Promise<typeof notes.$inferSelect> {
  const { scope } = where;
  // FK/KF001 failures (group or folder deleted or moved after the caller checked) are rethrown for the caller to map to 404; the retry loop only handles the slug 23505.
  const owner = "groupId" in scope
    ? { groupId: scope.groupId, folderId: where.folderId }
    : { ownerId: scope.ownerId, folderId: where.folderId };
  if (mode?.inTx && title !== undefined) {
    let created: typeof notes.$inferSelect | undefined;
    await writeSlugInTx(
      db as Tx,
      scope,
      { title },
      async slug => {
        [created] = await db.insert(notes).values({ ...owner, title, slug }).returning();
      },
      { beforeWrite: hooks?.beforeInsert },
    );
    return created!;
  }
  if (title === undefined) {
    const [created] = await db.insert(notes).values(owner).returning();
    return created!;
  }

  for (let attempt = 1; ; attempt++) {
    const slug = attempt > MAX_AUTO_SLUG_RETRIES ? fallbackAutoSlug() : await deriveUniqueAutoSlug(db, scope, null, title);
    await hooks?.beforeInsert?.(slug);
    try {
      // No 404 branch: unlike PATCH's UPDATE, an INSERT can't match 0 rows.
      const [created] = await db.insert(notes).values({ ...owner, title, slug }).returning();
      return created!;
    } catch (err) {
      if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
}
