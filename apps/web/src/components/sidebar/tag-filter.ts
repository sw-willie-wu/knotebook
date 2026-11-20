import { useSyncExternalStore } from "react";
import type { GroupDto, NoteTagDto } from "@knotebook/shared";
import { countedTagOptionsForNotes } from "@/components/tags/note-tag-options";
import type { TagFilterGroup } from "@/components/tags/TagFilterMenu";
import type { SidebarTab } from "@/lib/sidebar-tab";
import { useCollapsed, type SidebarSectionKey } from "./collapse";
import { filterNodesByTags, type SidebarNode, type SidebarPartition } from "./tree";

export type TagFilterState = { myNotes: string[]; workspace: { groupId: string; tagIds: string[] } | null };

const EMPTY: TagFilterState = { myNotes: [], workspace: null };

// Memory only: a reload starts unfiltered, and the static card and the drawer share one selection.
let state: TagFilterState = EMPTY;
const listeners = new Set<() => void>();

// Folders and groups the user closed while filtering; dropped whenever the filter changes, never written to the saved collapse state.
let filterCollapsed: ReadonlySet<SidebarSectionKey> = new Set();

function emit(next: TagFilterState): void {
  state = next;
  filterCollapsed = new Set();
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTagFilter(): TagFilterState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Re-renders on every filter change and every temporary open/close; read the set at event time with `isFilterCollapsed`. */
export function useFilterCollapsedSet(): ReadonlySet<SidebarSectionKey> {
  return useSyncExternalStore(subscribe, () => filterCollapsed);
}

export function isFilterCollapsed(key: SidebarSectionKey): boolean {
  return filterCollapsed.has(key);
}

function toggleFilterCollapsed(key: SidebarSectionKey): void {
  const next = new Set(filterCollapsed);
  if (!next.delete(key)) next.add(key);
  filterCollapsed = next;
  for (const listener of [...listeners]) listener();
}

/** Open state of a folder or group row. While filtering, rows with something to show start open whatever the saved state says, and toggling only lasts until the filter changes. */
export function useSectionOpen(key: SidebarSectionKey, filtering: boolean, hasChildren: boolean): [open: boolean, toggle: () => void] {
  const [stored, storedToggle] = useCollapsed(key);
  const closed = useSyncExternalStore(subscribe, () => filterCollapsed.has(key));
  if (!filtering) return [stored, storedToggle];
  return [hasChildren && !closed, () => toggleFilterCollapsed(key)];
}

/** What the list shows under the current filter: on Groups only the chosen group, then only notes that have every selected tag. */
export function applyTagFilter(tab: SidebarTab, nodes: SidebarNode[], view: TagFilterView | null): SidebarNode[] {
  if (view === null || view.selected.length === 0) return nodes;
  const scoped = tab === "workspace" ? nodes.filter((node) => node.id === view.activeGroupId) : nodes;
  return filterNodesByTags(scoped, view.selected);
}

export function toggleTagFilter(tab: "myNotes", tagId: string): void;
export function toggleTagFilter(tab: "workspace", tagId: string, groupId: string): void;
export function toggleTagFilter(tab: "myNotes" | "workspace", tagId: string, groupId?: string): void {
  if (tab === "myNotes") {
    const has = state.myNotes.includes(tagId);
    emit({ ...state, myNotes: has ? state.myNotes.filter((id) => id !== tagId) : [...state.myNotes, tagId] });
    return;
  }
  const current = state.workspace;
  // A tag belongs to one group, so picking one from another group replaces the whole selection.
  if (current === null || current.groupId !== groupId) {
    emit({ ...state, workspace: { groupId: groupId as string, tagIds: [tagId] } });
    return;
  }
  const tagIds = current.tagIds.includes(tagId) ? current.tagIds.filter((id) => id !== tagId) : [...current.tagIds, tagId];
  emit({ ...state, workspace: tagIds.length === 0 ? null : { groupId: current.groupId, tagIds } });
}

export function clearTagFilter(tab: "myNotes" | "workspace"): void {
  emit(tab === "myNotes" ? { ...state, myNotes: [] } : { ...state, workspace: null });
}

/** @internal tests only. */
export function __resetTagFilterForTests(): void {
  state = EMPTY;
  filterCollapsed = new Set();
}

export interface TagFilterView {
  /** Menu sections: one with a null label on My notes, one per group that has tagged notes on Groups. */
  groups: TagFilterGroup[];
  /** Selected ids that still exist on a visible note: a tag renamed away, merged or deleted drops out here, so it can't leave the list stuck on "no match". */
  selected: string[];
  selectedTags: NoteTagDto[];
  activeGroupId: string | null;
  activeGroupName: string | null;
}

/** Chips follow the order the tags were ticked, not the menu's alphabetical order. */
function pickInOrder(tags: readonly NoteTagDto[], ids: readonly string[]): NoteTagDto[] {
  return ids.flatMap((id) => tags.filter((tag) => tag.id === id));
}

/** null = nothing to filter by on this tab (the funnel button is not drawn). */
export function tagFilterView(tab: SidebarTab, state: TagFilterState, partition: SidebarPartition | null, groups: readonly GroupDto[]): TagFilterView | null {
  if (partition === null) return null;
  if (tab === "myNotes") {
    const tags = countedTagOptionsForNotes(partition.myNotes);
    if (tags.length === 0) return null;
    const selected = state.myNotes.filter((id) => tags.some((tag) => tag.id === id));
    return {
      groups: [{ label: null, tags }],
      selected,
      selectedTags: pickInOrder(tags, selected),
      activeGroupId: null,
      activeGroupName: null,
    };
  }
  if (tab !== "workspace") return null;
  const sections: TagFilterGroup[] = [];
  for (const group of groups) {
    const tags = countedTagOptionsForNotes(partition.byGroup.get(group.id) ?? []);
    if (tags.length > 0) sections.push({ id: group.id, label: group.name, tags });
  }
  if (sections.length === 0) return null;
  const active = state.workspace === null ? undefined : sections.find((section) => section.id === state.workspace?.groupId);
  const selected = active === undefined ? [] : (state.workspace?.tagIds ?? []).filter((id) => active.tags.some((tag) => tag.id === id));
  const hit = selected.length > 0 ? active : undefined;
  return {
    groups: sections,
    selected,
    selectedTags: hit === undefined ? [] : pickInOrder(hit.tags, selected),
    activeGroupId: hit?.id ?? null,
    activeGroupName: hit?.label ?? null,
  };
}
