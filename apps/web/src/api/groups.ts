import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { GroupDto, GroupMemberDto, GroupMemberRole } from "@knotebook/shared";
import { api } from "./client";

/**
 * 群組資料層（#103 PR2）。八支端點全是 session-only（PAT／MCP 打不到，`routes/groups.ts`）。
 *
 * **invalidate 慣例**：任何群組 mutation 成功後同時 invalidate `['groups']` 與 `['notes']`——
 * 側欄的分段是「這篇筆記的 `group.id` 在不在 `useGroups()` 裡」（spec §3.3）與筆記清單
 * 交叉決定的：改名會改 `note.group.name`、刪群組會讓 `note.group` 變 null、退出群組會讓
 * 別人的群組筆記從清單消失。兩把都不失效，畫面會停在舊分段。`['groups']` 是
 * `groupMembersKey(id)`＝`['groups', id, 'members']` 的**前綴**，一次 invalidate 連成員名單
 * 一起涵蓋，不必逐把列。
 */
export const GROUPS_QUERY_KEY = ["groups"] as const;

export function groupMembersKey(groupId: string) {
  return ["groups", groupId, "members"] as const;
}

export function useGroups(): UseQueryResult<GroupDto[]> {
  return useQuery({
    queryKey: GROUPS_QUERY_KEY,
    queryFn: () => api<GroupDto[]>("/api/groups"),
  });
}

/**
 * 成員名單（任一成員可讀）。`enabled` 給呼叫端擋「我已不是成員」（A1 的 owner，
 * spec §8.3）：那時 server 回 404，不該發請求去換一個錯誤。
 */
export function useGroupMembers(groupId: string, options: { enabled?: boolean } = {}): UseQueryResult<GroupMemberDto[]> {
  return useQuery({
    queryKey: groupMembersKey(groupId),
    queryFn: () => api<GroupMemberDto[]>(`/api/groups/${encodeURIComponent(groupId)}/members`),
    enabled: (options.enabled ?? true) && groupId.length > 0,
  });
}

function useInvalidateGroupsAndNotes() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
  };
}

export function useCreateGroup() {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (body: { name: string }) => api<GroupDto>("/api/groups", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

export function useRenameGroup() {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<GroupDto>(`/api/groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: invalidate,
  });
}

/** 刪群組＝筆記變個人筆記、原成員物化成逐人分享（D8）。204 無 body。 */
export function useDeleteGroup() {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/** 只新增（409 `already_member`，不 upsert——S1 的守法，spec r1 C）。`role` 未給就不送鍵
 * （server body `.strict()`；這裡明確不把 undefined 放進物件）。 */
export function useAddMember(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role?: GroupMemberRole }) =>
      api<GroupMemberDto>(`/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: "PUT",
        body: JSON.stringify(role === undefined ? { email } : { email, role }),
      }),
    onSuccess: invalidate,
  });
}

export function useSetMemberRole(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: GroupMemberRole }) =>
      api<GroupMemberDto>(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: invalidate,
  });
}

/** 移人（admin）與退出（userId＝自己）共用同一支；409 `last_admin` 由呼叫端顯示。 */
export function useRemoveMember(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}
