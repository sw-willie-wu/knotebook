import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GroupDto, NoteDto } from "@knotebook/shared";
import { GROUPS_QUERY_KEY } from "@/api/groups";

/** Who may rename, recolor, merge or delete the space's tags: the personal owner, or a group manager. An edit share on a personal note only attaches and detaches. */
export function canManageSpaceTags(note: Pick<NoteDto, "groupId" | "role">, groups: readonly Pick<GroupDto, "id" | "canManageGroup">[] | undefined): boolean {
  if (note.groupId === null) return note.role === "owner";
  return groups?.find((group) => group.id === note.groupId)?.canManageGroup === true;
}

/** Reads the groups list the sidebar has loaded without observing the query: an extra observer would add refetches to every group invalidation. Until it is loaded a group note shows the menu of a member who can't manage. */
export function useCanManageSpaceTags(note: Pick<NoteDto, "groupId" | "role">): boolean {
  const queryClient = useQueryClient();
  const groups = useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () => queryClient.getQueryData<GroupDto[]>(GROUPS_QUERY_KEY),
  );
  return canManageSpaceTags(note, groups);
}
