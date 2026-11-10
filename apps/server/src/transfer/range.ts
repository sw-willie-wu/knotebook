/**
 * bulk transfer：範圍解析。**可見性只來自既有查詢**：筆記＝`visibleNoteBranches`、
 * 資料夾＝`listVisibleFolders`、群組＝`listMyGroupsQuery`（JS 濾 `canRead`）、群組範圍的可讀判準＝`loadCreateTarget(...)?.canRead`。
 *
 * 呼叫約定：`buildLayout` 一律吃讀者可見的**完整集合**，命名在完整集合上算、
 * 輸出依範圍篩——範圍縮小時路徑不變。範圍內的篇數＝`layout.files.size`。
 * 範圍物件（群組、資料夾）使用時已看不到 → `gone`，呼叫端回 403；必須在 `buildLayout` 之前判。
 */
import { inArray, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { BulkRange } from "../auth/transfer-token.js";
import type { DbOrTx } from "../db/tx.js";
import { notes } from "../db/schema.js";
import { listVisibleFolders } from "../folders/queries.js";
import { listMyGroupsQuery } from "../groups/queries.js";
import { loadCreateTarget } from "../notes/create-target.js";
import { visibleNoteBranches } from "../notes/list-query.js";
import { buildLayout, type Layout, type LayoutFolder, type LayoutGroup, type LayoutNote } from "./paths.js";

export interface RangeNoteRow {
  id: string;
  title: string;
  role: "owner" | "editor" | "viewer";
  ownerHandle: string | null;
  groupId: string | null;
  slug: string;
  /** personal／group：筆記的資料夾；shared：讀者自己的放置。 */
  viewerFolderId: string | null;
  createdAt: Date;
  space: "personal" | "shared" | "group";
}

/** 讀者可見的完整集合（命名用）。 */
export interface VisibleSet {
  notes: RangeNoteRow[];
  folders: LayoutFolder[];
  groups: LayoutGroup[];
}

/** 讀者看得到的筆記（owned ∪ shared ∪ grouped；垃圾桶已排除）。`ids` → 只查這幾篇（批次重查、單篇）。 */
export async function visibleNotes(db: DbOrTx, userId: string, opts: { ids?: string[] } = {}): Promise<RangeNoteRow[]> {
  if (opts.ids !== undefined && opts.ids.length === 0) return [];
  const extraWhere: SQL | undefined = opts.ids === undefined ? undefined : inArray(notes.id, opts.ids);
  const { owned, shared, grouped } = visibleNoteBranches(db, userId, { extraWhere });
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
    space: r.groupId !== null ? "group" : r.role === "owner" ? "personal" : "shared",
  }));
}

/** 全部可見資料夾、全部可讀群組。 */
export async function visibleTree(db: DbOrTx, userId: string): Promise<{ folders: LayoutFolder[]; groups: LayoutGroup[] }> {
  const folders = (await listVisibleFolders(db, userId)).map(f => ({ id: f.id, name: f.name, parentId: f.parentId, createdAt: new Date(f.createdAt), space: f.space }));
  const groups = (await listMyGroupsQuery(db, userId))
    .filter(g => g.canRead === true)
    .map(g => ({ id: g.id, name: g.name, createdAt: g.createdAt }));
  return { folders, groups };
}

/**
 * 範圍物件此刻還看不看得到。`all`／`personal`／`shared` 恆在。群組與資料夾另外要在 `tree`（經 `consistentTree`
 * 之後）裡——否則 `buildLayout` 會因範圍物件不在輸入而丟錯；兩次查詢之間群組權限變動的那一瞬間一律當「看不到」。
 */
export async function rangeGone(db: DbOrTx, userId: string, range: BulkRange, tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }): Promise<boolean> {
  const t = consistentTree(tree);
  if (range.kind === "group") {
    const target = await loadCreateTarget(db, userId, range.groupId);
    return target === undefined || !target.canRead || !t.groups.some(g => g.id === range.groupId);
  }
  if (range.kind === "folder") return !t.folders.some(f => f.id === range.folderId);
  return false;
}

/**
 * 讓「資料夾、群組、筆記」三支查詢之間的競態不變成 500：`listVisibleFolders`、`listMyGroupsQuery`、
 * `visibleNotes` 各自一句、中間隔著 await，途中被加進（或移出）群組 G 時，可能出現「G 的資料夾或筆記在、G 不在」。
 * 這裡把群組不在清單裡的群組資料夾濾掉（筆記另由 `consistentNotes` 濾）——那一瞬間的變動在下一次下載就會收斂。
 */
export function consistentTree(tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }): { folders: LayoutFolder[]; groups: LayoutGroup[] } {
  const groupIds = new Set(tree.groups.map(g => g.id));
  return { folders: tree.folders.filter(f => f.space.kind !== "group" || groupIds.has(f.space.groupId)), groups: tree.groups };
}

/** 群組筆記的群組不在清單裡 → 濾掉（同 `consistentTree` 的理由）。 */
function consistentNotes(rows: RangeNoteRow[], groups: LayoutGroup[]): RangeNoteRow[] {
  const groupIds = new Set(groups.map(g => g.id));
  return rows.filter(r => r.groupId === null || groupIds.has(r.groupId));
}

/** 範圍所指的群組／資料夾在不在（已一致化的）輸入裡。 */
function rangeObjectPresent(range: BulkRange, tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }): boolean {
  if (range.kind === "group") return tree.groups.some(g => g.id === range.groupId);
  if (range.kind === "folder") return tree.folders.some(f => f.id === range.folderId);
  return true;
}

export function toLayoutNote(r: RangeNoteRow): LayoutNote {
  return { id: r.id, title: r.title, createdAt: r.createdAt, space: r.space, groupId: r.groupId, folderId: r.viewerFolderId };
}

/**
 * 在完整集合上命名、依範圍篩（先一致化：群組不在清單的群組資料夾與筆記濾掉）。
 * **呼叫端必須先以同一份 tree 呼叫 `rangeGone`**（看不到 → 403）：範圍物件不在輸入裡時這裡丟錯（→ 500），刻意不回空版面——
 * 將來有人漏判時寧可 500 被看見，也不要回 200 加一個空包。
 */
export function layoutOf(set: VisibleSet, range: BulkRange): Layout {
  const tree = consistentTree(set);
  if (!rangeObjectPresent(range, tree)) throw new Error("layoutOf: range object is not in the visible tree (call rangeGone first)");
  return buildLayout({ notes: consistentNotes(set.notes, tree.groups).map(toLayoutNote), folders: tree.folders, groups: tree.groups, range });
}

/**
 * 給「這幾篇的現況列」判「此刻還在範圍內嗎」：以開始時的資料夾樹與群組（`tree`）、現況的放置算。看不到的不在 `rows` 裡
 * （呼叫端以 `visibleNotes(…, { ids })` 取得）；移到範圍外的資料夾 → 不在。
 */
export function inRangeIds(rows: RangeNoteRow[], tree: { folders: LayoutFolder[]; groups: LayoutGroup[] }, range: BulkRange): Set<string> {
  // 群組筆記的群組不在開始時的群組集合裡（途中才加入的群組）→ 不在範圍（buildLayout 會丟錯，先濾掉；同 layoutOf）。
  return new Set(layoutOf({ notes: rows, ...tree }, range).files.keys());
}
