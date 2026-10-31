import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";
import { FOLDER_COLLATOR, folderPath, spaceKeyOf, type FolderIndex, type FolderSpaceKey } from "./folder-index";
import { folderSortOf, type FolderSort } from "./folder-sort";

/** 面板節點樹：群組節點（群組 tab）、資料夾節點或筆記節點。 */
export type SidebarNode =
  | { kind: "group"; id: string; group: GroupDto; children: SidebarNode[] }
  /** depth：根層資料夾＝1。 */
  | { kind: "folder"; id: string; folder: FolderDto; depth: number; children: SidebarNode[] }
  | { kind: "note"; id: string; note: NoteDto };

export type NoteBucket = { kind: "group"; groupId: string } | { kind: "myNotes" } | { kind: "shared" };

/**
 * #175 spec §8.2 的分段表（搜尋與各 tab 共用同一份歸類）：
 * - `group` 非 null 且那個群組在 `groupIds`（＝我是成員）→ 該群組（不標角色，#182）；
 * - `group` 非 null 但群組不在 `groupIds`（剛被移出、清單未 refetch）→ 與我共享（兜底）；
 * - `role === "owner"` → 我的筆記；
 * - 其餘（逐人分享給我的個人筆記）→ 與我共享。
 * 群組筆記的 `role` 從不是 `owner`（群組持有、沒有個人 owner），所以第 2 列不必另寫分支——
 * 程式碼只要「在 `groupIds` 裡就進群組，否則看 role」。四列互斥且完整，所以 `aria-current` 至多命中一列。
 */
export function noteBucket(note: NoteDto, groupIds: ReadonlySet<string>): NoteBucket {
  if (note.group && groupIds.has(note.group.id)) return { kind: "group", groupId: note.group.id };
  return note.role === "owner" ? { kind: "myNotes" } : { kind: "shared" };
}

/** 筆記在呼叫者側欄裡所屬的空間（同 noteBucket：myNotes → personal、群組 → group:<id>、其餘 → shared）。 */
export function noteSpaceKey(note: NoteDto, groupIds: ReadonlySet<string>): FolderSpaceKey {
  const bucket = noteBucket(note, groupIds);
  if (bucket.kind === "group") return `group:${bucket.groupId}`;
  return bucket.kind === "myNotes" ? "personal" : "shared";
}

export interface SidebarPartition {
  myNotes: NoteDto[];
  shared: NoteDto[];
  /** 依 `groups` 的順序，每個群組一個桶（空桶也在，群組 tab 要渲染空群組）。 */
  byGroup: Map<string, NoteDto[]>;
}

export function partitionNotes(notes: NoteDto[], groups: GroupDto[]): SidebarPartition {
  const groupIds = new Set(groups.map((group) => group.id));
  const byGroup = new Map<string, NoteDto[]>(groups.map((group) => [group.id, []]));
  const myNotes: NoteDto[] = [];
  const shared: NoteDto[] = [];
  for (const note of notes) {
    const bucket = noteBucket(note, groupIds);
    if (bucket.kind === "group") byGroup.get(bucket.groupId)?.push(note);
    else if (bucket.kind === "myNotes") myNotes.push(note);
    else shared.push(note);
  }
  return { myNotes, shared, byGroup };
}

export const RECENT_TAB_LIMIT = 20;

function editedAtMs(note: NoteDto): number {
  const ms = Date.parse(note.lastEdited?.at ?? note.updatedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** 依最後編輯時間（`lastEdited.at ?? updatedAt`）新到舊取前 `RECENT_TAB_LIMIT` 篇；
 * 同時間保持輸入順序、無法解析的排最後、不改動輸入陣列。 */
export function recentNotes(notes: NoteDto[]): NoteDto[] {
  return [...notes]
    .sort((a, b) => {
      const ka = editedAtMs(a);
      const kb = editedAtMs(b);
      return ka === kb ? 0 : ka > kb ? -1 : 1;
    })
    .slice(0, RECENT_TAB_LIMIT);
}

const noteNode = (note: NoteDto): SidebarNode => ({ kind: "note", id: note.id, note });

/** 穩定排序：比較相等時依輸入順序。 */
function stableSort(notes: readonly NoteDto[], compare: (a: NoteDto, b: NoteDto) => number): NoteDto[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => compare(a.note, b.note) || a.index - b.index)
    .map((entry) => entry.note);
}

/** 穩定排序：name＝FOLDER_COLLATOR 升冪；recent＝editedAtMs 新到舊（不可解析的最後）；size＝sizeBytes 大到小（缺＝0）；同值依輸入順序。 */
export function sortFolderNotes(notes: readonly NoteDto[], sort: FolderSort): NoteDto[] {
  if (sort === "name") return stableSort(notes, (a, b) => FOLDER_COLLATOR.compare(a.title, b.title));
  if (sort === "size") return stableSort(notes, (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  return stableSort(notes, (a, b) => {
    const ka = editedAtMs(a);
    const kb = editedAtMs(b);
    return ka === kb ? 0 : ka > kb ? -1 : 1;
  });
}

/**
 * 一個空間（我的筆記、與我共享、某群組）的根：資料夾在前（索引已依名稱排好）、根層筆記在後（維持輸入＝server 順序，前 §9-10）。
 * 筆記的 `folderId` 不在索引、或資料夾空間與筆記所在空間不符 → 落根層（兜底，讀碼發現 4）。
 */
function spaceNodes(space: FolderSpaceKey, notes: readonly NoteDto[], folders: FolderIndex, sortOf: (folderId: string) => FolderSort): SidebarNode[] {
  const byFolder = new Map<string, NoteDto[]>();
  const rootNotes: NoteDto[] = [];
  for (const note of notes) {
    const folder = note.folderId === null ? undefined : folders.byId.get(note.folderId);
    if (folder === undefined || spaceKeyOf(folder.space) !== space) {
      rootNotes.push(note);
      continue;
    }
    const list = byFolder.get(folder.id);
    if (list === undefined) byFolder.set(folder.id, [note]);
    else list.push(note);
  }
  const folderNodes = (parentId: string | null, depth: number): SidebarNode[] =>
    folders.children(space, parentId).map((folder) => ({
      kind: "folder",
      id: folder.id,
      folder,
      depth,
      children: [...folderNodes(folder.id, depth + 1), ...sortFolderNotes(byFolder.get(folder.id) ?? [], sortOf(folder.id)).map(noteNode)],
    }));
  return [...folderNodes(null, 1), ...rootNotes.map(noteNode)];
}

/**
 * folders 必填（讀碼發現 6）。同層資料夾在前（索引已依名稱排好）、筆記在後；資料夾內筆記依 sortOf(id)；根層筆記維持 server 順序（前 §9-10）。
 * 最近 tab 不建資料夾節點；垃圾桶照舊回 []。
 */
export function buildTabNodes(
  tab: SidebarTab,
  notes: NoteDto[],
  groups: GroupDto[],
  folders: FolderIndex,
  sortOf: (folderId: string) => FolderSort = folderSortOf,
): SidebarNode[] {
  // 垃圾桶不從 ["notes"] 組樹；先攔，否則會落進最後一支（其餘一律當群組 tab）列出全部群組。
  if (tab === "trash") return [];
  if (tab === "recent") return recentNotes(notes).map(noteNode);
  const parts = partitionNotes(notes, groups);
  if (tab === "myNotes") return spaceNodes("personal", parts.myNotes, folders, sortOf);
  if (tab === "shared") return spaceNodes("shared", parts.shared, folders, sortOf);
  return groups.map((group) => ({
    kind: "group",
    id: group.id,
    group,
    children: spaceNodes(`group:${group.id}`, parts.byGroup.get(group.id) ?? [], folders, sortOf),
  }));
}

/**
 * 樹裡有沒有可勾的節點（資料夾或筆記，含群組下的；群組節點本身不算，所以空群組不算、空資料夾算）：
 * 一般 tab 標題列「選取」鈕可不可按（PR-2c；資料夾 spec §6.10 起資料夾也可勾）。
 */
export function hasSelectableNodes(nodes: readonly SidebarNode[]): boolean {
  return nodes.some((node) => node.kind !== "group" || hasSelectableNodes(node.children));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface LocationContext {
  groupIds: ReadonlySet<string>;
  folders: FolderIndex;
}

/** 呼叫者視角的資料夾路徑：folderId 不在索引、或空間與筆記所在空間不符 → []。 */
export function noteFolderPath(note: NoteDto, ctx: LocationContext): string[] {
  if (note.folderId === null) return [];
  const folder = ctx.folders.byId.get(note.folderId);
  if (folder === undefined || spaceKeyOf(folder.space) !== noteSpaceKey(note, ctx.groupIds)) return [];
  return folderPath(ctx.folders, folder.id) ?? [];
}

/** spec §9-2 單一函式：[群組名?, ...資料夾路徑]。垃圾桶第二行（`lib/trash-display.ts`）也經它。 */
export function noteLocationSegments(note: { group: { name: string } | null }, path: readonly string[]): string[] {
  return note.group ? [note.group.name, ...path] : [...path];
}

/**
 * 筆記的位置標籤（資料夾 spec §6.9）：搜尋結果與最近 tab 的第二行都只經這一支。
 * 個人「My notes › A › B」；群組「Groups › G › A」；共享無放置「Shared with me · Viewer」、有放置「Shared with me › X · Viewer」。
 */
export function noteLocationLabel(note: NoteDto, ctx: LocationContext, t: Translate): string {
  const bucket = noteBucket(note, ctx.groupIds);
  const path = noteFolderPath(note, ctx);
  if (bucket.kind === "myNotes") return [t("sidebar.myNotes"), ...noteLocationSegments(note, path)].join(" › ");
  if (bucket.kind === "group") return t("sidebar.locationGroup", { group: noteLocationSegments(note, path).join(" › ") });
  const role = t(`roles.${note.role}`);
  if (path.length > 0) return t("sidebar.locationSharedIn", { path: path.join(" › "), role });
  return t("sidebar.locationShared", { role });
}
