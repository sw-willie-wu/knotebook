import { FOLDER_DEPTH_MAX, type NoteDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";
import type { Translate } from "./destination-level";
import type { FolderSpaceKey } from "./folder-index";
import type { SidebarNode } from "./tree";

/**
 * 側欄拖曳的純函式（資料夾 spec §6.13）：區域落點、可拖判準、疊資料夾取名。
 * 首包模組：不 import 字串包（字串在主檔 `folders.stackName*`）、不 import 畫面模組。
 * 位置一律取樹上的（`tree.ts` 兜底後），不用 `note.folderId` 原值（讀碼發現 10）。
 */

export const DRAG_NOTE_MIME = "application/x-knotebook-note";
/** spec §6.13：彈簧資料夾與疊資料夾預覽共用的 0.5 秒。 */
export const DRAG_HOVER_DELAY_MS = 500;
export const DRAG_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export type DragTab = "myNotes" | "workspace" | "shared";

export interface DragSource {
  noteId: string;
  space: FolderSpaceKey;
  folderId: string | null;
  title: string;
}

export interface DropLookup {
  /** 樹上的位置（兜底後）；folderDepth＝所在資料夾的深度，根層 0；placeable＝canDragNote。 */
  notes: ReadonlyMap<string, { space: FolderSpaceKey; folderId: string | null; folderDepth: number; placeable: boolean; title: string }>;
  folders: ReadonlyMap<string, { space: FolderSpaceKey; depth: number }>;
}

type NoteEntry = DropLookup["notes"] extends ReadonlyMap<string, infer V> ? V : never;
type FolderEntry = DropLookup["folders"] extends ReadonlyMap<string, infer V> ? V : never;

/** spec §6.13「可拖」：personal 空間＝true（我的筆記 tab 只有自己的筆記）；group:<id>＝permissions.edit；shared＝note.groupId === null。 */
export function canDragNote(note: NoteDto, space: FolderSpaceKey): boolean {
  if (space === "personal") return true;
  if (space === "shared") return note.groupId === null;
  return note.permissions.edit;
}

/** 從 `buildTabNodes` 的結果建 lookup。工作坊只收 `groupIds` 裡（我是成員）的群組。 */
export function buildDropLookup(nodes: readonly SidebarNode[], tab: DragTab, groupIds: ReadonlySet<string>): DropLookup {
  const notes = new Map<string, NoteEntry>();
  const folders = new Map<string, FolderEntry>();
  const walk = (children: readonly SidebarNode[], space: FolderSpaceKey, parentFolderId: string | null, parentDepth: number) => {
    for (const node of children) {
      if (node.kind === "folder") {
        folders.set(node.id, { space, depth: node.depth });
        walk(node.children, space, node.id, node.depth);
      } else if (node.kind === "note") {
        notes.set(node.id, { space, folderId: parentFolderId, folderDepth: parentDepth, placeable: canDragNote(node.note, space), title: node.note.title });
      }
    }
  };
  if (tab === "workspace") {
    for (const node of nodes) {
      if (node.kind === "group" && groupIds.has(node.id)) walk(node.children, `group:${node.id}`, null, 0);
    }
  } else {
    walk(nodes, tab === "myNotes" ? "personal" : "shared", null, 0);
  }
  return { notes, folders };
}

export type DragTarget =
  | { kind: "preview" }
  | { kind: "note"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "group"; id: string }
  | { kind: "blank" }
  | { kind: "outside" };

/**
 * target 不在 container 內（或 null）→ outside；closest("[data-node-kind]") 為 preview／note／folder／group；在 container 內但沒有節點 → blank；
 * 節點的 kind 認不得或缺 data-node-id → outside（不是落點）。
 */
export function readDragTarget(target: EventTarget | null, container: Element): DragTarget {
  if (!(target instanceof Node)) return { kind: "outside" };
  const el = target instanceof Element ? target : target.parentElement;
  if (el === null || !container.contains(el)) return { kind: "outside" };
  // 預覽塊裡的列（B 列等）不得當成一般筆記列（spec §6.13 區域表第一列）：先找預覽。
  const preview = el.closest('[data-node-kind="preview"]');
  if (preview !== null && container.contains(preview)) return { kind: "preview" };
  const node = el.closest("[data-node-kind]");
  if (node === null || !container.contains(node)) return { kind: "blank" };
  const kind = node.getAttribute("data-node-kind");
  const id = node.getAttribute("data-node-id");
  if (id !== null && (kind === "note" || kind === "folder" || kind === "group")) return { kind, id };
  return { kind: "outside" };
}

export type DropScope = { kind: "list" } | { kind: "group"; groupId: string } | { kind: "folder"; folderId: string } | { kind: "preview" };
export type DropZone = { kind: "place"; folderId: string | null; scope: DropScope } | { kind: "stack"; scope: { kind: "preview" } };
export type HoldAction = { kind: "spring"; folderId: string } | { kind: "stack"; anchorNoteId: string; parentFolderId: string | null };

/** row：計時用的列鍵（"note:<id>"／"folder:<id>"／"preview"；空白處與群組列＝null）。zone null＝不是落點。 */
export interface DragOverResult {
  zone: DropZone | null;
  row: string | null;
  hold: HoldAction | null;
}

/** 「data-drop-scope」與標示比對用的鍵："list"｜"group:<id>"｜"folder:<id>"｜"preview"。 */
export function dropScopeKey(scope: DropScope): string {
  if (scope.kind === "group") return `group:${scope.groupId}`;
  if (scope.kind === "folder") return `folder:${scope.folderId}`;
  return scope.kind;
}

const NONE: DragOverResult = { zone: null, row: null, hold: null };

function groupIdOf(space: FolderSpaceKey): string | null {
  return space.startsWith("group:") ? space.slice("group:".length) : null;
}

/** 落點＝被拖筆記目前所在處 → 不是落點（spec §6.13）。 */
function placeAt(source: DragSource, folderId: string | null, scope: DropScope): DropZone | null {
  return folderId === source.folderId ? null : { kind: "place", folderId, scope };
}

/** 空間的根目錄：我的筆記／與我共享＝整份清單；工作坊＝該群組。 */
function rootScope(tab: DragTab, space: FolderSpaceKey): DropScope | null {
  if (tab !== "workspace") return { kind: "list" };
  const groupId = groupIdOf(space);
  return groupId === null ? null : { kind: "group", groupId };
}

function zoneIn(source: DragSource, tab: DragTab, folderId: string | null): DropZone | null {
  if (folderId !== null) return placeAt(source, folderId, { kind: "folder", folderId });
  const scope = rootScope(tab, source.space);
  return scope === null ? null : placeAt(source, null, scope);
}

export function evaluateDragOver(input: {
  source: DragSource;
  target: DragTarget;
  lookup: DropLookup;
  tab: DragTab;
  isCollapsed: (folderId: string) => boolean;
  previewAnchor: string | null;
}): DragOverResult {
  const { source, lookup, tab, isCollapsed, previewAnchor } = input;
  let { target } = input;
  // 預覽剛出現、同一輪 dragover 還指到舊列（B 列）。
  if (previewAnchor !== null && target.kind === "note" && target.id === previewAnchor) target = { kind: "preview" };
  if (target.kind === "preview") return { zone: { kind: "stack", scope: { kind: "preview" } }, row: "preview", hold: null };
  if (target.kind === "folder") {
    const folder = lookup.folders.get(target.id);
    if (folder === undefined) return NONE;
    const hold: HoldAction | null = isCollapsed(target.id) ? { kind: "spring", folderId: target.id } : null;
    if (folder.space !== source.space) return NONE;
    return { zone: placeAt(source, target.id, { kind: "folder", folderId: target.id }), row: `folder:${target.id}`, hold };
  }
  if (target.kind === "note") {
    const row = `note:${target.id}`;
    const note = lookup.notes.get(target.id);
    if (note === undefined) return NONE;
    if (note.space !== source.space) return { zone: null, row, hold: null };
    const canStack = target.id !== source.noteId && note.placeable && note.folderDepth < FOLDER_DEPTH_MAX;
    return {
      zone: zoneIn(source, tab, note.folderId),
      row,
      hold: canStack ? { kind: "stack", anchorNoteId: target.id, parentFolderId: note.folderId } : null,
    };
  }
  if (target.kind === "group") {
    if (tab !== "workspace" || `group:${target.id}` !== source.space) return NONE;
    return { zone: placeAt(source, null, { kind: "group", groupId: target.id }), row: null, hold: null };
  }
  if (target.kind === "blank") return { zone: zoneIn(source, tab, null), row: null, hold: null };
  return NONE;
}

/**
 * spec §6.13 第 4 步：existing（同層既有資料夾名）與 skip 都不分大小寫（toLowerCase）比對；回第一個沒被用的「新資料夾」「新資料夾 2」…。
 * 鴿籠上限：最多試 taken.size + 1 個；字串壞掉（每次同字）時回最後一個候選，交給 server 的 409 重送路徑。
 */
export function stackFolderName(existing: readonly string[], t: Translate, skip: ReadonlySet<string> = new Set()): string {
  const taken = new Set([...existing, ...skip].map((name) => name.toLowerCase()));
  let name = "";
  for (let n = 1; n <= taken.size + 1; n += 1) {
    name = n === 1 ? t("folders.stackName") : t("folders.stackNameN", { n });
    if (!taken.has(name.toLowerCase())) return name;
  }
  return name;
}

const DRAG_TABS: readonly SidebarTab[] = ["myNotes", "workspace", "shared"];

/** 側欄接不接手拖曳（讀碼發現 8；gate r1 m10）：finePointer ∧ tab ∈ {myNotes, workspace, shared} ∧ !selectionActive ∧ !creating ∧ nodesReady。 */
export function isDragEnabled(input: { finePointer: boolean; tab: SidebarTab; selectionActive: boolean; creating: boolean; nodesReady: boolean }): boolean {
  return input.finePointer && DRAG_TABS.includes(input.tab) && !input.selectionActive && !input.creating && input.nodesReady;
}
