import "@/i18n/select-strings";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import { canCreateAndEdit } from "@/lib/group-role";
import { selectionKey } from "@/lib/sidebar-selection";
import type { SidebarSectionKey } from "./collapse";
import { spaceKey, type DestMode, type DestSource, type DestSpace, type DestTarget } from "./destination-level";
import { isInSubtree, liveNotesUnder, type FolderIndex } from "./folder-index";
import { noteBucket, noteSpaceKey, type SidebarNode } from "./tree";

/**
 * 一般 tab 選取模式的純函式（#181 PR-2c，spec §6.11、§9-4、§9-7；資料夾 spec §6.10 的「可見列」）。
 * 只准被 SelectLazy 鏈與測試 import（首包上限）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SelectableTab = "recent" | "myNotes" | "workspace" | "shared";
export type SelectActionId = "move" | "copy" | "delete";

/**
 * spec §6.11 的表（D-M3、D-W6）＋資料夾 spec §6.10：工作坊、與我共享加 "move"（資料夾目的地）；最近不給（F10）。
 * 與我共享的 "delete" 只在選取（去重後）非空且全是資料夾時渲染（移除資料夾；共享筆記本身不能刪，D-M3）。
 */
export const SELECT_ACTIONS: Readonly<Record<SelectableTab, readonly SelectActionId[]>> = {
  recent: ["copy", "delete"],
  myNotes: ["move", "copy", "delete"],
  workspace: ["move", "copy", "delete"],
  shared: ["move", "copy", "delete"],
};

// ── PR-3b-2：資料夾與筆記同列選取（資料夾 spec §6.10） ──

/** 選取的一項：筆記或資料夾（群組列不可勾）。 */
export type SelectionTarget = { kind: "note"; note: NoteDto } | { kind: "folder"; folder: FolderDto };

function targetKey(target: SelectionTarget): string {
  return target.kind === "note" ? selectionKey({ kind: "note", id: target.note.id }) : selectionKey({ kind: "folder", id: target.folder.id });
}

/** 樹序的全部可選項：資料夾在它的子節點之前；收合的子樹也算（群組列本身不算）。 */
export function tabTargets(nodes: readonly SidebarNode[]): SelectionTarget[] {
  return nodes.flatMap((node): SelectionTarget[] => {
    if (node.kind === "note") return [{ kind: "note", note: node.note }];
    if (node.kind === "folder") return [{ kind: "folder", folder: node.folder }, ...tabTargets(node.children)];
    return tabTargets(node.children);
  });
}

/** 畫面上可見的可選列的鍵（樹序）：「全選」與 Shift 範圍用。資料夾列在它的子項前；收合的資料夾自己在、子樹跳過；收合的群組跳過子樹。 */
export function visibleSelectionKeys(nodes: readonly SidebarNode[], isCollapsed: (key: SidebarSectionKey) => boolean): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "note") return [selectionKey({ kind: "note", id: node.id })];
    if (node.kind === "folder") {
      const own = selectionKey({ kind: "folder", id: node.id });
      return isCollapsed(`folder:${node.id}`) ? [own] : [own, ...visibleSelectionKeys(node.children, isCollapsed)];
    }
    return isCollapsed(`group:${node.id}`) ? [] : visibleSelectionKeys(node.children, isCollapsed);
  });
}

/** 已選的項目（樹序；**不看收合**——先勾再收合的仍算）；不在樹裡的鍵不算。 */
export function selectedTargets(nodes: readonly SidebarNode[], keys: ReadonlySet<string>): SelectionTarget[] {
  return tabTargets(nodes).filter((target) => keys.has(targetKey(target)));
}

/**
 * 送出前去重（spec §6.10）：祖先資料夾也被選的項目拿掉（它會跟著祖先一起動），不算略過。
 * 筆記看 `folderId` 落在哪個已選資料夾的子樹；資料夾看自己的祖先鏈（不含自己）。
 */
export function dedupeByAncestor(targets: readonly SelectionTarget[], index: FolderIndex): SelectionTarget[] {
  const selectedFolders = targets.flatMap((target) => (target.kind === "folder" ? [target.folder.id] : []));
  const underSelected = (folderId: string | null): boolean =>
    folderId !== null && selectedFolders.some((ancestorId) => isInSubtree(index, ancestorId, folderId));
  return targets.filter((target) =>
    target.kind === "note" ? !underSelected(target.note.folderId) : !underSelected(index.parentOf(target.folder.id)),
  );
}

export interface Eligibility {
  eligible: SelectionTarget[];
  notesSkipped: number;
  foldersSkipped: number;
  foldersBlocked: number;
}

/** move 的筆記判準依 tab（spec §6.10）：我的筆記＝自己的個人筆記；工作坊＝`edit`（§5.6 放置權）；與我共享＝全部；最近（沒有「移動到」）照 PR-2c。 */
function canMoveNote(tab: SelectableTab, note: NoteDto): boolean {
  if (tab === "workspace") return note.permissions.edit;
  if (tab === "shared") return true;
  return note.permissions.moveToGroup && note.groupId === null;
}

/**
 * 預先排除（spec §6.10）：
 * move：myNotes 筆記＝`moveToGroup && groupId === null`；workspace 筆記＝`permissions.edit`；shared 筆記恆可；資料夾＝`permissions.manage`。
 * copy：只看筆記（有資料夾時呼叫端整顆 disabled，D14）；資料夾不進 eligible、也不計略過。
 * delete：筆記＝`permissions.delete`；資料夾要 `manage`（否則 foldersSkipped），子樹有活筆記（liveNotesUnder）且 `!deleteNotes` → foldersBlocked；
 * shared tab 的筆記一律 notesSkipped（D-M3）。eligible 維持輸入順序。
 */
export function partitionTargets(
  action: SelectActionId,
  targets: readonly SelectionTarget[],
  ctx: { tab: SelectableTab; index: FolderIndex; notes: readonly NoteDto[]; groupIds: ReadonlySet<string> },
): Eligibility {
  const out: Eligibility = { eligible: [], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 };
  for (const target of targets) {
    if (target.kind === "note") {
      const note = target.note;
      let ok: boolean;
      if (action === "move") ok = canMoveNote(ctx.tab, note);
      else if (action === "delete") ok = ctx.tab !== "shared" && note.permissions.delete;
      else ok = true;
      if (ok) out.eligible.push(target);
      else out.notesSkipped += 1;
      continue;
    }
    const folder = target.folder;
    if (action === "copy") continue;
    if (!folder.permissions.manage) {
      out.foldersSkipped += 1;
      continue;
    }
    if (
      action === "delete" &&
      !folder.permissions.deleteNotes &&
      liveNotesUnder(ctx.index, folder.id, ctx.notes, (note) => noteSpaceKey(note, ctx.groupIds)).length > 0
    ) {
      out.foldersBlocked += 1;
      continue;
    }
    out.eligible.push(target);
  }
  return out;
}

const PERSONAL_SPACE: DestSpace = { kind: "personal" };
const SHARED_SPACE: DestSpace = { kind: "shared" };

/** 選取項所在的群組（工作坊）：筆記看 `noteBucket`、資料夾看 `space.groupId`；不在群組的回 null。 */
function targetGroupId(target: SelectionTarget, groupIds: ReadonlySet<string>): string | null {
  if (target.kind === "folder") return target.folder.space.kind === "group" ? target.folder.space.groupId : null;
  const bucket = noteBucket(target.note, groupIds);
  return bucket.kind === "group" ? bucket.groupId : null;
}

/**
 * spec §6.10「批次的目的地」＋D18 ①②：回 DestSource；workspace 的 move 跨兩個以上群組回 "mixedGroups"。不判空（I2）：呼叫端用 T2 的 isEmptyDestination。
 * current：myNotes→個人；shared→共享私人（copy 沒有上半部）；workspace→eligible 全在同一群組 G 時 G（G 要在 groups 裡；copy 另要 G 是 `canCreateAndEdit`）；recent→無。
 * makeCopy：只 copy、且有上半部時。others：move 只有 myNotes 列候選群組；copy＝myNotes→候選群組、workspace 單一群組→個人＋其他候選群組、其餘→個人＋候選群組。
 * locations＝eligible 各自位置（筆記 `folderId`、資料夾 `parentId`）；movingFolders＝eligible 中的資料夾（只 move）。
 */
export function batchDestSource(input: {
  tab: SelectableTab;
  mode: DestMode;
  eligible: readonly SelectionTarget[];
  groups: readonly GroupDto[];
  groupIds: ReadonlySet<string>;
}): DestSource | "mixedGroups" {
  const { tab, mode, eligible, groups, groupIds } = input;
  const candidates: DestSpace[] = groups.filter(canCreateAndEdit).map((group) => ({ kind: "group", groupId: group.id, name: group.name }));
  const base = {
    mode,
    locations: eligible.map((target) => (target.kind === "note" ? target.note.folderId : target.folder.parentId)),
    movingFolders: mode === "move" ? eligible.flatMap((target) => (target.kind === "folder" ? [target.folder] : [])) : [],
  };
  const noUpper = { ...base, current: null, makeCopy: false };
  if (tab === "myNotes") return { ...base, current: PERSONAL_SPACE, makeCopy: mode === "copy", others: candidates };
  if (tab === "shared") {
    return mode === "move" ? { ...base, current: SHARED_SPACE, makeCopy: false, others: [] } : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
  }
  if (tab === "workspace") {
    const ids = new Set(eligible.flatMap((target) => targetGroupId(target, groupIds) ?? []));
    if (ids.size > 1) return mode === "move" ? "mixedGroups" : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
    const [groupId] = [...ids];
    if (groupId === undefined) return mode === "move" ? { ...noUpper, others: [] } : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
    const group = groups.find((candidate) => candidate.id === groupId);
    // G 不在 groups（清單未到或剛被移出）→ 沒有上半部：不出空群組名（同 requireName 的立場，T5 審查 m2）。
    if (group === undefined) return mode === "move" ? { ...noUpper, others: [] } : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
    const space: DestSpace = { kind: "group", groupId, name: group.name };
    if (mode === "move") return { ...base, current: space, makeCopy: false, others: [] };
    if (canCreateAndEdit(group)) {
      return { ...base, current: space, makeCopy: true, others: [PERSONAL_SPACE, ...candidates.filter((other) => spaceKey(other) !== spaceKey(space))] };
    }
    return { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
  }
  // recent：沒有「移動到」；「複製到」一律沒有上半部（選取可能跨空間）。
  return mode === "move" ? { ...noUpper, others: [] } : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
}

/** 同空間＝target 是某空間的位置、且與 batch 的 current 同一空間（筆記 PUT、資料夾 PATCH，不確認）；否則跨空間（只會是 myNotes → 群組）。 */
export function isSameSpace(target: DestTarget, source: DestSource): boolean {
  return target.kind === "place" && source.current !== null && spaceKey(target.space) === spaceKey(source.current);
}

export interface ResultTally {
  action: SelectActionId;
  tab: SelectableTab;
  notesDone: number;
  foldersDone: number;
  /** 刪資料夾連帶移到垃圾桶的筆記數。 */
  trashedViaFolders: number;
  notesSkipped: number;
  foldersSkipped: number;
  foldersBlocked: number;
  foldersGone: number;
  /** 同空間＝destinationShortLabel；跨空間／複製＝destinationPathLabel。 */
  destinationName: string | null;
  sameSpace: boolean;
  /** I-B：move／copy 的目的地（delete 為 null）；copySource＝批次的 current 空間（建立副本的結果句用）。 */
  destination: DestTarget | null;
  copySource: DestSpace | null;
}

/** 資料夾的後綴，依序：略過、擋下、已不存在（各自 > 0 才接）。 */
function folderSuffixes(tally: ResultTally, t: Translate): string {
  let out = "";
  if (tally.foldersSkipped > 0) out += t("select.foldersSkippedSuffix", { count: tally.foldersSkipped });
  if (tally.foldersBlocked > 0) out += t("select.foldersBlockedSuffix", { count: tally.foldersBlocked });
  if (tally.foldersGone > 0) out += t("select.foldersGoneSuffix", { count: tally.foldersGone });
  return out;
}

function requireName(tally: ResultTally): string {
  if (tally.destinationName === null) throw new Error(`selectionResultTitle: ${tally.action} needs a destination name`);
  return tally.destinationName;
}

function copyTitle(tally: ResultTally, destination: DestTarget, done: number, t: Translate): string {
  if (destination.kind === "makeCopy") {
    const source = tally.copySource;
    if (source === null) throw new Error("selectionResultTitle: makeCopy needs a copySource");
    if (source.kind === "personal") return t("select.copiedToPersonal", { count: done });
    if (source.kind === "group") return t("select.copiedToGroup", { count: done, group: source.name });
    throw new Error("selectionResultTitle: makeCopy has no shared source");
  }
  if (destination.space.kind === "personal" && destination.folder === null) return t("select.copiedToPersonal", { count: done });
  return t("select.copiedToGroup", { count: done, group: requireName(tally) });
}

/**
 * 結果 toast 標題（spec §6.10、§6.16）。全部完成數 0 → `noneDone`（notesSkipped > 0）或 `noneDoneItems`，再接資料夾後綴。
 * 否則動作句＋依序 `skippedSuffix`、`foldersSkippedSuffix`、`foldersBlockedSuffix`、`foldersGoneSuffix`（各自 > 0 才接）。
 * move／copy 沒有 destination、或 makeCopy 沒有 copySource → throw（契約錯誤，不出空名稱）。
 */
export function selectionResultTitle(tally: ResultTally, t: Translate): string {
  const { action, destination } = tally;
  const done = tally.notesDone + tally.foldersDone;
  if (done === 0) {
    const head = tally.notesSkipped > 0 ? t("select.noneDone", { count: tally.notesSkipped }) : t("select.noneDoneItems");
    return head + folderSuffixes(tally, t);
  }
  let title: string;
  if (action === "delete") {
    if (tally.foldersDone > 0 && tally.tab === "shared") title = t("select.foldersRemoved", { count: tally.foldersDone });
    else if (tally.foldersDone > 0) {
      const trashed = tally.trashedViaFolders + tally.notesDone;
      title = t("select.foldersDeleted", { count: tally.foldersDone }) + (trashed > 0 ? t("select.notesTrashedSuffix", { count: trashed }) : "");
    } else title = t("select.trashed", { count: tally.notesDone });
  } else if (destination === null) {
    throw new Error(`selectionResultTitle: ${action} needs a destination`);
  } else if (action === "copy") {
    title = copyTitle(tally, destination, done, t);
  } else if (tally.sameSpace) {
    title = t("select.movedItems", { count: done, name: requireName(tally) });
  } else {
    title = t("select.moved", { count: done, group: requireName(tally) });
  }
  if (tally.notesSkipped > 0) title += t("select.skippedSuffix", { count: tally.notesSkipped });
  return title + folderSuffixes(tally, t);
}
