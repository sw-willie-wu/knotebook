/** Visibility comes only from existing queries. A scope object no longer visible → `gone` (caller returns 403), decided before `buildLayout`. */
import { inArray, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { BulkRange } from "../auth/transfer-token.js";
import type { DbOrTx } from "../db/tx.js";
import { notes } from "../db/schema.js";
import { listVisibleFolders } from "../folders/queries.js";
import { listMyGroupsQuery } from "../groups/queries.js";
import { loadCreateTarget } from "../notes/create-target.js";
import { noteTagsJsonSql } from "../tags/queries.js";
import { visibleNoteBranches } from "../notes/list-query.js";
import { buildLayout, type Layout, type LayoutFolder, type LayoutGroup, type LayoutNote } from "./paths.js";

export interface RangeNoteRow {
  id: string;
  title: string;
  role: "owner" | "editor" | "viewer";
  ownerHandle: string | null;
  groupId: string | null;
  slug: string;
  /** For a shared note: the reader's own placement. */
  viewerFolderId: string | null;
  createdAt: Date;
  /** In the order they were added. */
  tagNames: string[];
  space: "personal" | "shared" | "group";
}

export interface VisibleSet {
  notes: RangeNoteRow[];
  folders: LayoutFolder[];
  groups: LayoutGroup[];
}

export async function visibleNotes(db: DbOrTx, userId: string, opts: { ids?: string[] } = {}): Promise<RangeNoteRow[]> {
  if (opts.ids !== undefined && opts.ids.length === 0) return [];
  const extraWhere: SQL | undefined = opts.ids === undefined ? undefined : inArray(notes.id, opts.ids);
  const { owned, shared, grouped } = visibleNoteBranches(db, userId, { extraWhere, extra: { tags: noteTagsJsonSql() } });
  const rows = await unionAll(owned, shared, grouped);
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    role: r.role as RangeNoteRow["role"],
    ownerHandle: r.ownerHandle,
    groupId: r.groupId,
    slug: r.slug,
    viewerFolderId: r.viewerFolderId,
    createdAt: r.createdAt,
    tagNames: r.tags.map(t => t.name),
    space: r.groupId !== null ? "group" : r.role === "owner" ? "personal" : "shared",
  }));
}

export async function visibleTree(db: DbOrTx, userId: string): Promise<{ folders: LayoutFolder[]; groups: LayoutGroup[] }> {
  const folders = (await listVisibleFolders(db, userId)).map(f => ({ id: f.id, name: f.name, parentId: f.parentId, createdAt: new Date(f.createdAt), space: f.space }));
  const groups = (await listMyGroupsQuery(db, userId))
    .filter(g => g.canRead === true)
    .map(g => ({ id: g.id, name: g.name, createdAt: g.createdAt }));
  return { folders, groups };
}

/** A group or folder must also be in `tree`, else `buildLayout` would throw; a permission change between the two queries counts as not visible. */
export async function rangeGone(db: DbOrTx, userId: string, range: BulkRange, tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }): Promise<boolean> {
  const t = consistentTree(tree);
  if (range.kind === "group") {
    const target = await loadCreateTarget(db, userId, range.groupId);
    return target === undefined || !target.canRead || !t.groups.some(g => g.id === range.groupId);
  }
  if (range.kind === "folder") return !t.folders.some(f => f.id === range.folderId);
  return false;
}

/** The folder, group and note queries are separate statements, so a group joined or left between them can leave G's folders or notes without G; filtering avoids a 500 and settles on the next download. */
export function consistentTree(tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }): { folders: LayoutFolder[]; groups: LayoutGroup[] } {
  const groupIds = new Set(tree.groups.map(g => g.id));
  return { folders: tree.folders.filter(f => f.space.kind !== "group" || groupIds.has(f.space.groupId)), groups: tree.groups };
}

function consistentNotes(rows: RangeNoteRow[], groups: LayoutGroup[]): RangeNoteRow[] {
  const groupIds = new Set(groups.map(g => g.id));
  return rows.filter(r => r.groupId === null || groupIds.has(r.groupId));
}

function rangeObjectPresent(range: BulkRange, tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }): boolean {
  if (range.kind === "group") return tree.groups.some(g => g.id === range.groupId);
  if (range.kind === "folder") return tree.folders.some(f => f.id === range.folderId);
  return true;
}

export function toLayoutNote(r: RangeNoteRow): LayoutNote {
  return { id: r.id, title: r.title, createdAt: r.createdAt, space: r.space, groupId: r.groupId, folderId: r.viewerFolderId };
}

/** The caller must call `rangeGone` with the same tree first: a missing scope object throws (500) rather than returning an empty layout, so a missed check can't pass as a 200 with an empty package. */
export function layoutOf(set: VisibleSet, range: BulkRange): Layout {
  const tree = consistentTree(set);
  if (!rangeObjectPresent(range, tree)) throw new Error("layoutOf: range object is not in the visible tree (call rangeGone first)");
  return buildLayout({ notes: consistentNotes(set.notes, tree.groups).map(toLayoutNote), folders: tree.folders, groups: tree.groups, range });
}

export function inRangeIds(rows: RangeNoteRow[], tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }, range: BulkRange): Set<string> {
  // A group joined midway isn't in the starting group set; buildLayout would throw, so filter first.
  return new Set(layoutOf({ notes: rows, ...tree }, range).files.keys());
}
