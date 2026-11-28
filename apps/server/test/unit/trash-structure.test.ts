/**
 * Scans every non-test `.ts` under `src/` line by line; lines whose trimmed text starts with `//`, `*` or `/*` are skipped, and
 * each remaining line is counted with `matchAll`.
 *
 * notes guard: places that query the `notes` table directly (case-insensitive: `.from(notes)`, `(inner|left|right|full)?join(notes`,
 * `.update(notes)`, `.delete(notes)`, SQL literals `from notes` / `join notes` / `update notes`, `${notes}`) are registered as
 * file -> count per disposition. A per-file hit count that differs from the table's sum fails, and so does a new file that isn't
 * registered or a registered file with no hits.
 * deleted_at guard: the literals that write `deleted_at` (`deletedAt:`, `deletedBy:`, `deleted_at\s*=`, `set deleted_at`) may appear only
 * in the schema, the file holding `trashNotesInTx` / `restoreNotesInTx`, the trash list query (including DTO mapping) and MCP
 * `list_trash` (outputSchema and DTO mapping), with registered counts.
 * trash_folder_path guard: the `trashFolderPath:` / `trash_folder_path` literals may appear only in the schema, `notes/tx/trash.ts`,
 * `folders/tx/delete-folder.ts`, `groups/tx/delete-group.ts` and the trash list query, with registered counts (a separate table from the
 * deleted_at guard).
 * folders guard: files that write the `folders` table (`.update|insert|delete(folders)`, SQL literals `update folders` / `delete from
 * folders` / `insert into folders`, also the quoted identifier `"folders"` and the `sql` template `${folders}`) may only be inside
 * `folders/tx/*.ts` and `groups/tx/delete-group.ts`. `notes/tx/trash.ts` is not listed because restore goes through
 * `folders/tx/ensure-path.ts`; add it back if trash.ts ever writes directly.
 * note_placements guard: same form for the `note_placements` table (including `"note_placements"` and `${notePlacements}`); files may
 * only be inside `folders/tx/*.ts`. This and the folders guard compare file sets only and record no counts.
 *
 * Counts instead of inline markers: a marker needs a "marker within N lines of the hit" window rule, and queries span lines and formatters
 * move markers, so it misjudges; a count table has no window or placement rule, and any count change shows up in the diff where code
 * review sees it. Cost: the table records counts, not which hit belongs to which class.
 *
 * Not caught:
 *   - Deleting one hit and adding another in the same file leaves the count unchanged.
 *   - Whether each hit is classified correctly: that depends on review and each route's behaviour tests, not on this guard.
 *   - Reads of child tables by note id that never touch `notes` (`uploads`, `note_states`, `note_versions`, `note_links`, `note_shares`,
 *     `note_search_*` and so on): those are the job of the corresponding tests.
 *   - The notes guard's quoted SQL identifier `"notes"` and import aliases (`import { notes as n }`) are outside the pattern (no hits today).
 *   - Line-by-line matching misses SQL whose keyword and table name sit on different lines (`update⏎ folders`; the notes literal
 *     `from⏎ notes` has the same blind spot, `${notes}` does not) and drizzle calls whose argument is split across lines (`.update(⏎ folders⏎ )`).
 *   - The deleted_at and trash_folder_path guards miss the object shorthand `.set({ deletedAt })` / `.set({ trashFolderPath })` (no colon);
 *     none of the guards parse parentheses.
 *   - Writes caused by FK actions (`ON DELETE CASCADE` / `SET NULL`) are outside the patterns: deleting a folder sets `notes.folder_id` NULL
 *     and cascades to child folders and placements, deleting or unsharing a note cascades to placements, deleting a group cascades to its folders.
 *   - Table names built with `sql.raw`, a table object stored in a local variable and written later (`const t = folders; tx.update(t)`),
 *     aliased imports and schema-qualified names (`${schema.folders}`, `public.folders`) are missed (no hits today).
 *   - The folders and note_placements guards record no counts: extra writes inside an allowed file leave their results unchanged, and
 *     deleting one hit and adding another in the same file leaves the trash_folder_path count table unchanged.
 *   - Writes to `notes.folder_id` are not the folders guard's concern (they are writes to `notes`, registered by the notes guard's
 *     `write` / `trashOnly` entries).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

function hits(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of walk(SRC)) {
    let n = 0;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      n += [...line.matchAll(re)].length;
    }
    if (n > 0) out[rel(p)] = n;
  }
  return out;
}

const NOTES_QUERY = new RegExp(
  [
    String.raw`\.from\(notes\)`,
    String.raw`\b(?:inner|left|right|full)?join\(notes\b`,
    String.raw`\.update\(notes\)`,
    String.raw`\.delete\(notes\)`,
    String.raw`\bfrom\s+notes\b`,
    String.raw`\bjoin\s+notes\b`,
    String.raw`\bupdate\s+notes\b`,
    String.raw`\$\{notes\}`,
  ].join("|"),
  "gi",
);
const DELETED_AT_WRITE = /deletedAt:|deletedBy:|deleted_at\s*=|set\s+deleted_at/gi;

type Disposition = { excludes?: number; trashOnly?: number; includes?: number; write?: number; why?: string };

// `excludes`: carries `deleted_at IS NULL`, or its result always passes the gate that hides trashed notes; `trashOnly`: looks only at the trash; `includes`: deliberately ignores state (with a reason); `write`: `UPDATE` / `DELETE` / write CTE whose statement carries `deleted_at IS NULL` or is protected by an earlier conditioned `FOR UPDATE` in the same transaction.
const REGISTRY: Record<string, Disposition> = {
  "collab/server.ts": { includes: 1, why: "last-edited stamp is written even for a trashed note" },
  "collab/store.ts": { includes: 1, why: "links_clock clamp on load, unrelated to whether the note is live" },
  // excludes: scanRound (scanDue).
  "collab/versions.ts": { excludes: 1, includes: 7, why: "version state is written on persist and when the base is written back after applying a version; readVersionMeta is left unchanged; sweep runs as usual" },
  // Folder delete pre-reads the live notes of the subtree.
  "folders/service.ts": { excludes: 1 },
  // includes: lock-read of the subtree's notes; trashOnly: refreshes the path snapshot of the subtree's trashed notes (folder delete).
  "folders/tx/delete-folder.ts": { includes: 1, trashOnly: 1, why: "locks all of the subtree's notes by id in one statement, regardless of state" },
  // excludes: lock-read of the note being placed (personal/group FOR UPDATE and shared FOR KEY SHARE in one statement, with deleted_at IS NULL); write: UPDATE folder_id (protected by the preceding FOR UPDATE).
  "folders/tx/place-note.ts": { excludes: 1, write: 1 },
  "groups/queries.ts": { includes: 1, why: "all of the group's notes (disconnecting members, deleting the group)" },
  // Transfer lock, quota innerJoin, transfer UPDATE, delete-all lock.
  "groups/tx/delete-group.ts": { includes: 4, why: "transfer and delete-all include trashed notes" },
  "knowledge/fields/queries.ts": { includes: 1, why: "a trashed note still belongs to its space, so it reads that space's settings" },
  // "People you know" for suggestions and member fields: share targets of my live notes (with deleted_at IS NULL).
  "knowledge/members.ts": { excludes: 1 },
  "knowledge/tx/index-write.ts": { includes: 1, why: "the index is written regardless" },
  "mcp/tools/read-note-outline.ts": { excludes: 1 },
  "notes/editing/candidates.ts": { excludes: 3 },
  "notes/editing/read.ts": { excludes: 1 },
  // excludes: file write-back reads the current title (to decide note_changed), with deleted_at IS NULL.
  "notes/editing/write-service.ts": { excludes: 1, includes: 1, why: "a failed create-with-content deletes the row it just created" },
  // excludes: live meta; includes: backfill group branch.
  "notes/link-conversion.ts": { excludes: 1, includes: 1, why: "links are recorded even when the target is trashed" },
  "notes/links.ts": { excludes: 3 },
  "notes/list-query.ts": { excludes: 3 },
  // GET :ref, the by-path re-read, and the reads after move and restore all sit behind the gate; the re-read after POST with content in routes/notes.ts doesn't pass the gate,
  // but it reads the row this request just created, so nothing leaks.
  "notes/note-dto.ts": { excludes: 1 },
  "notes/public-links.ts": { excludes: 1 },
  // excludes: pre-read, and the existence + title lookup after 0 rows (expectTitle and expectTitleFingerprint share this statement; both statements carry deleted_at IS NULL); write: UPDATE.
  "notes/rename-note.ts": { excludes: 2, write: 1 },
  // excludes: accessQuery, noteIsLive; trashOnly: trashedAccessQuery; includes: loadNoteAudience.
  "notes/service.ts": { excludes: 2, trashOnly: 1, includes: 1, why: "loads the audience before moving to trash" },
  "notes/site-link-resolver.ts": { excludes: 2 },
  // excludes: legacy ref (authorization follows); includes: slug probe.
  "notes/slug.ts": { excludes: 1, includes: 1, why: "a trashed note still holds its slug" },
  "notes/tx/copy.ts": { excludes: 1 },
  "notes/tx/delete-notes.ts": { includes: 2, why: "the caller decides the set (permanent delete passes only trashed ids, delete-all passes all)" },
  "notes/tx/move.ts": { excludes: 1, write: 1 },
  "notes/tx/patch-slug.ts": { write: 2 },
  "notes/tx/search-index.ts": { includes: 1, why: "the index is written regardless" },
  "notes/tx/shares.ts": { excludes: 1 },
  // trashOnly: rebuild-by-path write of folder_id (restore), restore UPDATE, expiry query; includes: lockNotes; write: move-to-trash UPDATE.
  "notes/tx/trash.ts": { trashOnly: 3, includes: 1, write: 1, why: "lock first, then decide (state is checked per note after locking)" },
  // excludes: version-cut lock-read; includes: notBaseVersionSql, the two reset statements and the pending-only reset; write: the three UPDATEs inside cutVersionInTx.
  "notes/tx/versions.ts": { excludes: 1, includes: 4, write: 3, why: "version pruning runs as usual; the transfer reset ignores state" },
  "notes/tx/write-links.ts": { includes: 4, why: "links are recorded even when the target is trashed; the CAS adds no condition" },
  // excludes: the access read for a page of notifications (live notes only, with deleted_at IS NULL); a trashed note shows as not openable.
  "notifications/queries.ts": { excludes: 1 },
  "routes/admin-storage.ts": { includes: 2, why: "storage usage still counts trashed notes" },
  // excludes: GET public-link; write: the five public-link routes (token PUT/DELETE, width PUT, alias PUT/DELETE).
  // GET public-link and the pre-read in routes/notes.ts are both "after authorization, statement carries no condition": the former is a pure read, equivalent to "read, then move to trash" under TOCTOU, so it counts as excludes;
  // the latter is registered as includes.
  "routes/note-sharing.ts": { excludes: 1, write: 5 },
  // excludes: withCurrentBase (read after authorization); includes: the base subquery in the version DELETE route.
  "routes/note-versions.ts": { excludes: 1, includes: 1, why: "version delete: single-statement child-table write after authorization, no condition" },
  // excludes: ownershipChanged, selectNotesWhere; includes: the pre-read (after authorization, statement carries no condition; compare GET public-link in routes/note-sharing.ts).
  "routes/notes.ts": { excludes: 2, includes: 1, why: "the pre-read carries no condition; the CTE that follows blocks trashed notes" },
  "routes/public.ts": { excludes: 2 },
  "storage/tx/quota.ts": { includes: 1, why: "storage usage still counts trashed notes" },
  // includes: four attachment reads plus six content-size joins (one per table, in the single-space and the all-spaces statement).
  "storage/usage.ts": { includes: 10, why: "storage and content usage still count trashed notes" },
  // excludes: listSpaceTags counts live notes only; includes: loadNoteTags reads the tags of one note the caller already resolved (a trashed note's tags come back on restore).
  "tags/queries.ts": { excludes: 1, includes: 1, why: "loadNoteTags is keyed by a note id the caller already authorized" },
  // includes: the merge locks and copies tags on every note of the space, trashed ones too.
  "tags/tx/manage.ts": { includes: 2, why: "a merge also moves the tags of trashed notes, which come back with them on restore" },
  // excludes: the space lock-read (FOR KEY SHARE, with deleted_at IS NULL).
  "tags/tx/note-tags.ts": { excludes: 1 },
  // excludes: the source note of a copy (a live note, with deleted_at IS NULL); includes: the notes of a group being handed over, trashed ones too.
  "tags/tx/space-change.ts": { excludes: 1, includes: 1, why: "handing a group over maps the tags of every group note, trashed or not" },
  // trashOnly: the two list queries, loadTrashPreview, loadTrashedMeta (re-read after delete_note moves to trash), loadTrashedPurgeAt (re-read after delete_folder moves to trash).
  "trash/list.ts": { trashOnly: 5 },
  // Pre-read of the space for restore.
  "trash/service.ts": { trashOnly: 1 },
  "uploads/tx/insert-upload.ts": { excludes: 1 },
};

/** deleted_at guard: only these four files; value = count. */
const DELETED_AT_WRITERS: Record<string, number> = {
  "db/schema.ts": 2, // column definitions deleted_at, deleted_by
  "mcp/tools/list-trash.ts": 4, // two outputSchema keys, one DTO-mapping key, one type annotation `let deletedBy:` (all reads, not writes)
  "notes/tx/trash.ts": 5, // lock-read column selection, two columns set on move-to-trash, two set on restore
  "trash/list.ts": 4, // list column selection, row type field, two DTO-mapping columns
};

/** Values are hit counts. */
const TRASH_FOLDER_PATH_WRITE = /trashFolderPath:|trash_folder_path/gi;
const TRASH_FOLDER_PATH_WRITERS: Record<string, number> = {
  "db/schema.ts": 3, // column definition (key, column name), CHECK name notes_trash_folder_path_chk
  "folders/tx/delete-folder.ts": 1, // folder delete refreshes the snapshot of the subtree's trashed notes
  "groups/tx/delete-group.ts": 1, // transfer: prepends the new top-level name to the snapshot
  "notes/tx/trash.ts": 3, // lockNotes column selection, set on move-to-trash, cleared on restore
  "trash/list.ts": 1, // list folderPath reads the snapshot
};

const FOLDERS_WRITE = /\.(?:update|insert|delete)\(folders\)|\b(?:update|delete\s+from|insert\s+into)\s+(?:"?folders"?(?!\w)|\$\{folders\})/gi;
const PLACEMENTS_WRITE =
  /\.(?:update|insert|delete)\(notePlacements\)|\b(?:update|delete\s+from|insert\s+into)\s+(?:"?note_placements"?(?!\w)|\$\{notePlacements\})/gi;
const inFoldersTx = (f: string) => /^folders\/tx\/[^/]+\.ts$/.test(f);
// groups/tx/delete-group.ts: transfer rewrites the whole tree. Restore rebuilds by path through folders/tx/ensure-path.ts, so notes/tx/trash.ts isn't listed.
const FOLDERS_WRITE_OTHERS = new Set(["groups/tx/delete-group.ts"]);

const total = (d: Disposition) => (d.excludes ?? 0) + (d.trashOnly ?? 0) + (d.includes ?? 0) + (d.write ?? 0);

describe("trash structure guard (#181)", () => {
  const actual = hits(NOTES_QUERY);

  it("notes queries: the file set equals the registry keys", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it("notes queries: each file's count equals the sum of its four registry fields", () => {
    for (const [f, d] of Object.entries(REGISTRY)) expect.soft(actual[f] ?? 0, f).toBe(total(d));
  });

  it("notes queries: every entry with includes carries a reason", () => {
    const missing = Object.entries(REGISTRY).filter(([, d]) => (d.includes ?? 0) > 0 && !d.why?.trim()).map(([f]) => f);
    expect(missing).toEqual([]);
  });

  it("deleted_at write literals appear only in four files, counts frozen", () => {
    expect(hits(DELETED_AT_WRITE)).toEqual(DELETED_AT_WRITERS);
  });

  it("trash_folder_path literals appear only in five files, counts frozen", () => {
    expect(hits(TRASH_FOLDER_PATH_WRITE)).toEqual(TRASH_FOLDER_PATH_WRITERS);
  });

  it("folders writes appear only in folders/tx/* and groups/tx/delete-group.ts", () => {
    const outside = Object.keys(hits(FOLDERS_WRITE)).filter(f => !inFoldersTx(f) && !FOLDERS_WRITE_OTHERS.has(f));
    expect(outside).toEqual([]);
  });

  it("note_placements writes appear only in folders/tx/*", () => {
    expect(Object.keys(hits(PLACEMENTS_WRITE)).filter(f => !inFoldersTx(f))).toEqual([]);
  });
});
