import type { FavoriteDto, FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";
import { FOLDER_COLLATOR, folderPath, spaceKeyOf, type FolderIndex, type FolderSpaceKey } from "./folder-index";
import { folderSortOf, type FolderSort } from "./folder-sort";

export type SidebarNode =
  | { kind: "group"; id: string; group: GroupDto; children: SidebarNode[] }
  // depth: root-level folder = 1.
  | { kind: "folder"; id: string; folder: FolderDto; depth: number; children: SidebarNode[] }
  | { kind: "note"; id: string; note: NoteDto };

export type NoteBucket = { kind: "group"; groupId: string } | { kind: "myNotes" } | { kind: "shared" };

/**
 * Bucketing shared by search and every tab: group set and in `groupIds` → that group; group set but not in `groupIds` (just removed, list not refetched) → Shared with me; `role === "owner"` → My notes; otherwise → Shared with me.
 * A group note's `role` is never `owner`, so no extra branch is needed; the rows are exclusive and complete, so `aria-current` matches at most one.
 */
export function noteBucket(note: NoteDto, groupIds: ReadonlySet<string>): NoteBucket {
  if (note.group && groupIds.has(note.group.id)) return { kind: "group", groupId: note.group.id };
  return note.role === "owner" ? { kind: "myNotes" } : { kind: "shared" };
}

export function noteSpaceKey(note: NoteDto, groupIds: ReadonlySet<string>): FolderSpaceKey {
  const bucket = noteBucket(note, groupIds);
  if (bucket.kind === "group") return `group:${bucket.groupId}`;
  return bucket.kind === "myNotes" ? "personal" : "shared";
}

export interface SidebarPartition {
  myNotes: NoteDto[];
  shared: NoteDto[];
  /** Empty buckets included: the group tab renders empty groups. */
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

/** Ties keep input order, unparseable times sort last, the input array isn't mutated. */
export function recentNotes(notes: NoteDto[]): NoteDto[] {
  return [...notes]
    .sort((a, b) => {
      const ka = editedAtMs(a);
      const kb = editedAtMs(b);
      return ka === kb ? 0 : ka > kb ? -1 : 1;
    })
    .slice(0, RECENT_TAB_LIMIT);
}

/** `favorites` ids missing from `notes` just lost access or were trashed: not shown; title and location come from `notes` only. */
export function favoriteNotes(notes: readonly NoteDto[], favorites: readonly FavoriteDto[]): NoteDto[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const out: NoteDto[] = [];
  for (const { noteId } of favorites) {
    const note = byId.get(noteId);
    if (note !== undefined) out.push(note);
  }
  return out;
}

const noteNode = (note: NoteDto): SidebarNode => ({ kind: "note", id: note.id, note });

function stableSort(notes: readonly NoteDto[], compare: (a: NoteDto, b: NoteDto) => number): NoteDto[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => compare(a.note, b.note) || a.index - b.index)
    .map((entry) => entry.note);
}

export function sortFolderNotes(notes: readonly NoteDto[], sort: FolderSort): NoteDto[] {
  if (sort === "name") return stableSort(notes, (a, b) => FOLDER_COLLATOR.compare(a.title, b.title));
  if (sort === "size") return stableSort(notes, (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  return stableSort(notes, (a, b) => {
    const ka = editedAtMs(a);
    const kb = editedAtMs(b);
    return ka === kb ? 0 : ka > kb ? -1 : 1;
  });
}

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

/** Recents and favorites are flat note lists with no folder nodes (favorites follow `favorites`, default []); trash returns []. */
export function buildTabNodes(
  tab: SidebarTab,
  notes: NoteDto[],
  groups: GroupDto[],
  folders: FolderIndex,
  sortOf: (folderId: string) => FolderSort = folderSortOf,
  favorites: readonly FavoriteDto[] = [],
): SidebarNode[] {
  // Trash and favorites aren't grouped by space; intercept first, or they'd fall into the last branch (everything else is a group tab) and list all groups.
  if (tab === "trash") return [];
  if (tab === "recent") return recentNotes(notes).map(noteNode);
  if (tab === "favorites") return favoriteNotes(notes, favorites).map(noteNode);
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

/** Empty groups don't count, empty folders do. */
export function hasSelectableNodes(nodes: readonly SidebarNode[]): boolean {
  return nodes.some((node) => node.kind !== "group" || hasSelectableNodes(node.children));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface LocationContext {
  groupIds: ReadonlySet<string>;
  folders: FolderIndex;
}

export function noteFolderPath(note: NoteDto, ctx: LocationContext): string[] {
  if (note.folderId === null) return [];
  const folder = ctx.folders.byId.get(note.folderId);
  if (folder === undefined || spaceKeyOf(folder.space) !== noteSpaceKey(note, ctx.groupIds)) return [];
  return folderPath(ctx.folders, folder.id) ?? [];
}

export function noteLocationSegments(note: { group: { name: string } | null }, path: readonly string[]): string[] {
  return note.group ? [note.group.name, ...path] : [...path];
}

export interface NoteLocationParts {
  segments: string[];
  suffix: string | null;
  tab: SidebarTab;
  folderId: string | null;
  groupId: string | null;
}

export function noteLocationParts(note: NoteDto, ctx: LocationContext, t: Translate): NoteLocationParts {
  const bucket = noteBucket(note, ctx.groupIds);
  const path = noteFolderPath(note, ctx);
  const folderId = path.length > 0 ? note.folderId : null;
  if (bucket.kind === "group") {
    return { segments: [note.group?.name ?? "", ...path], suffix: null, tab: "workspace", folderId, groupId: bucket.groupId };
  }
  if (bucket.kind === "myNotes") return { segments: [t("sidebar.myNotes"), ...path], suffix: null, tab: "myNotes", folderId, groupId: null };
  return {
    segments: [t("sidebar.shared"), ...path],
    suffix: note.ownerHandle === null ? null : `@${note.ownerHandle}`,
    tab: "shared",
    folderId,
    groupId: null,
  };
}

export function noteLocationLabel(note: NoteDto, ctx: LocationContext, t: Translate): string {
  const bucket = noteBucket(note, ctx.groupIds);
  const path = noteFolderPath(note, ctx);
  if (bucket.kind === "myNotes") return [t("sidebar.myNotes"), ...noteLocationSegments(note, path)].join(" › ");
  if (bucket.kind === "group") return t("sidebar.locationGroup", { group: noteLocationSegments(note, path).join(" › ") });
  const role = t(`roles.${note.role}`);
  if (path.length > 0) return t("sidebar.locationSharedIn", { path: path.join(" › "), role });
  return t("sidebar.locationShared", { role });
}

/** A note stays when it has every tag; a folder stays when something below it does. Group nodes pass through with their children filtered. */
export function filterNodesByTags(nodes: SidebarNode[], tagIds: readonly string[]): SidebarNode[] {
  if (tagIds.length === 0) return nodes;
  const out: SidebarNode[] = [];
  for (const node of nodes) {
    if (node.kind === "note") {
      const have = new Set((node.note.tags ?? []).map((tag) => tag.id));
      if (tagIds.every((id) => have.has(id))) out.push(node);
    } else if (node.kind === "folder") {
      const children = filterNodesByTags(node.children, tagIds);
      if (children.length > 0) out.push({ ...node, children });
    } else {
      out.push({ ...node, children: filterNodesByTags(node.children, tagIds) });
    }
  }
  return out;
}

export function countNoteNodes(nodes: readonly SidebarNode[]): number {
  let total = 0;
  for (const node of nodes) total += node.kind === "note" ? 1 : countNoteNodes(node.children);
  return total;
}
