import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
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
 *
 * **改名／刪群組另外要失效單篇筆記的 key**：NotePage 常駐層是 `['note', id]`、解析層是
 * `['note-by-path', …]`，兩者都不以 `['notes']` 開頭，上面那兩把碰不到；而群組異動不動文件，
 * `onRemoteUpdate` 也不會觸發。不失效的話，正開著的那篇筆記的 `note.group` 停在舊值——
 * 改名：觸發鈕與「群組成員」說明留舊名；刪群組：ShareDialog 還當群組筆記、成員區誤報
 * 「你已不是這個群組的成員」（其實筆記已回個人）。
 * 刪群組還有**順序**：先 `await` 失效 `['shares']`／`['public-link']`（active 的會重抓，server 端
 * D8 物化的逐人分享此時已定），**之後**才失效 note——note 一翻成個人，`AccessSection` 以
 * `note.group?.id` 為 key 重掛，而個人筆記是「快取有就 latch」（`freshEnough`）；若 shares 還是
 * 當群組筆記時抓的 `[]`，會 sticky 地 latch 成「私人」。與 spec §8.3 對 PR3 搬家的快取寫入順序同理。
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

/** 單篇筆記兩層 key（常駐 `['note', id]`、解析 `['note-by-path', …]`），前綴失效。 */
function invalidateSingleNoteKeys(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["note"] }),
    queryClient.invalidateQueries({ queryKey: ["note-by-path"] }),
  ]);
}

/** 改名會改 `note.group.name`——開著的那篇也要重抓（見檔頭）；key 不變，無順序要求。 */
export function useRenameGroup() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<GroupDto>(`/api/groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}

/**
 * 刪群組＝筆記變個人筆記、原成員物化成逐人分享（D8）。204 無 body。
 * 失效順序是契約（見檔頭）：shares／public-link 先落定 → 單篇 note → groups／notes。
 * onSuccess 回 promise，所以 `mutateAsync` 會等 shares／public-link 重抓完才 resolve。
 */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["shares"] }),
        queryClient.invalidateQueries({ queryKey: ["public-link"] }),
      ]);
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
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
