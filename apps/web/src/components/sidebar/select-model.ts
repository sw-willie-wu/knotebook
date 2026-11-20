import "@/i18n/select-strings";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import { canCreateAndEdit } from "@/lib/group-role";
import { selectionKey } from "@/lib/sidebar-selection";
import type { SidebarSectionKey } from "./collapse";
import { spaceKey, type DestMode, type DestSource, type DestSpace, type DestTarget } from "./destination-level";
import { isInSubtree, liveNotesUnder, type FolderIndex } from "./folder-index";
import { noteBucket, noteSpaceKey, type SidebarNode } from "./tree";


// Import only through the SelectLazy chain and tests (first-bundle limit).

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type SelectableTab = "recent" | "favorites" | "myNotes" | "workspace" | "shared";
export type SelectActionId = "unfavorite" | "move" | "copy" | "delete";

/** Shared's "delete" renders only when the (deduped) selection is non-empty and all folders (removing folders; shared notes themselves can't be deleted). */
export const SELECT_ACTIONS: Readonly<Record<SelectableTab, readonly SelectActionId[]>> = {
  recent: ["copy", "delete"],
  favorites: ["unfavorite", "copy", "delete"],
  myNotes: ["move", "copy", "delete"],
  workspace: ["move", "copy", "delete"],
  shared: ["move", "copy", "delete"],
};


export type SelectionTarget = { kind: "note"; note: NoteDto } | { kind: "folder"; folder: FolderDto };

function targetKey(target: SelectionTarget): string {
  return target.kind === "note" ? selectionKey({ kind: "note", id: target.note.id }) : selectionKey({ kind: "folder", id: target.folder.id });
}

export function tabTargets(nodes: readonly SidebarNode[]): SelectionTarget[] {
  return nodes.flatMap((node): SelectionTarget[] => {
    if (node.kind === "note") return [{ kind: "note", note: node.note }];
    if (node.kind === "folder") return [{ kind: "folder", folder: node.folder }, ...tabTargets(node.children)];
    return tabTargets(node.children);
  });
}

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

/** Under a tag filter the selectable rows are the matching notes that are on screen: never a folder (its batch action would also reach notes the filter hides), and nothing under a folder or group closed during this filter. */
export function filteredSelectionKeys(nodes: readonly SidebarNode[], isClosed: (key: SidebarSectionKey) => boolean): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === "note") return [selectionKey({ kind: "note", id: node.id })];
    const key: SidebarSectionKey = node.kind === "folder" ? `folder:${node.id}` : `group:${node.id}`;
    return isClosed(key) ? [] : filteredSelectionKeys(node.children, isClosed);
  });
}

export function selectedTargets(nodes: readonly SidebarNode[], keys: ReadonlySet<string>): SelectionTarget[] {
  return tabTargets(nodes).filter((target) => keys.has(targetKey(target)));
}

/** Drops items whose ancestor folder is also selected (they move with it; not counted as skipped). */
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

function canMoveNote(tab: SelectableTab, note: NoteDto): boolean {
  if (tab === "workspace") return note.permissions.edit;
  if (tab === "shared") return true;
  return note.permissions.moveToGroup && note.groupId === null;
}

/**
 * `eligible` keeps input order. For copy and unfavorite, folders are neither eligible nor counted as skipped.
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
      if (action === "unfavorite") ok = true;
      else if (action === "move") ok = canMoveNote(ctx.tab, note);
      else if (action === "delete") ok = ctx.tab !== "shared" && note.permissions.delete;
      else ok = true;
      if (ok) out.eligible.push(target);
      else out.notesSkipped += 1;
      continue;
    }
    const folder = target.folder;
    if (action === "copy" || action === "unfavorite") continue;
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

function targetGroupId(target: SelectionTarget, groupIds: ReadonlySet<string>): string | null {
  if (target.kind === "folder") return target.folder.space.kind === "group" ? target.folder.space.groupId : null;
  const bucket = noteBucket(target.note, groupIds);
  return bucket.kind === "group" ? bucket.groupId : null;
}

/** Doesn't check emptiness (callers use `isEmptyDestination`). Workspace move across two or more groups → "mixedGroups". Workspace `current` is the single group G when all eligible items are in it (G must be in `groups`; copy also needs `canCreateAndEdit`). */
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
    // G not in `groups` (list not loaded or just removed) → no top half: don't show an empty group name (same stance as requireName).
    if (group === undefined) return mode === "move" ? { ...noUpper, others: [] } : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
    const space: DestSpace = { kind: "group", groupId, name: group.name };
    if (mode === "move") return { ...base, current: space, makeCopy: false, others: [] };
    if (canCreateAndEdit(group)) {
      return { ...base, current: space, makeCopy: true, others: [PERSONAL_SPACE, ...candidates.filter((other) => spaceKey(other) !== spaceKey(space))] };
    }
    return { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
  }
  // recent and favorites have no "move to"; "copy to" never has a top half (the selection may span spaces).
  return mode === "move" ? { ...noUpper, others: [] } : { ...noUpper, others: [PERSONAL_SPACE, ...candidates] };
}

export interface ResultTally {
  action: SelectActionId;
  tab: SelectableTab;
  notesDone: number;
  foldersDone: number;
  trashedViaFolders: number;
  notesSkipped: number;
  foldersSkipped: number;
  foldersBlocked: number;
  foldersGone: number;
  destinationName: string | null;
  sameSpace: boolean;
  destination: DestTarget | null;
  copySource: DestSpace | null;
}

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

/** Throws if move/copy lacks `destination` or makeCopy lacks `copySource` (contract error: never render an empty name). */
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
