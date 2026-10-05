import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { DeleteGroupBody, GroupDto, GroupMemberDto, GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import { api } from "./client";

/**
 * 群組資料層（#103 PR2；#175 PR1 起成員改掛角色 id、加 `GET …/roles`）。全部端點都是
 * session-only（PAT／MCP 打不到，`routes/groups.ts`）。
 *
 * **invalidate 慣例**：任何群組 mutation 成功後同時 invalidate `['groups']` 與 `['notes']`——
 * 側欄的分段是「這篇筆記的 `group.id` 在不在 `useGroups()` 裡」（spec §8.2）與筆記清單
 * 交叉決定的：改名會改 `note.group.name`、退出群組會讓群組筆記從清單消失。兩把都不失效，
 * 畫面會停在舊分段。`['groups']` 是 `groupMembersKey(id)`＝`['groups', id, 'members']` 與
 * `groupRolesKey(id)`＝`['groups', id, 'roles']` 的**前綴**，一次 invalidate 連成員名單與角色
 * 清單一起涵蓋，不必逐把列。
 *
 * **改名與改角色另外要失效單篇筆記的 key**（`invalidateSingleNoteKeys`）：NotePage 常駐層是
 * `['note', id]`、解析層是 `['note-by-path', …]`（個人）／`['note-by-group-path', …]`（群組），
 * 三者都不以 `['notes']` 開頭，上面那兩把碰不到；而群組異動不動文件，`onRemoteUpdate` 也不會
 * 觸發。不失效的話：改名 → 正開著的那篇群組筆記的 `note.group.name` 停在舊值；改角色 → 改到
 * **自己**的角色時（非最後一位管理員把自己降成一般成員），開著那篇的 `note.permissions`
 * （⋮ 的刪除項、公開連結開關）停在舊角色，多顯示 server 會 403 的項目（Task 11 review r1 M-4）。#175 PR3 的改角色旗標、刪角色同理（`useUpdateRole`／`useDeleteRole`）。
 *
 * **刪群組**（#175 PR4）：必填模式 `DeleteGroupBody`——轉移給一位內建管理員（筆記變他的個人筆記）或全刪。
 * 失效順序：單篇三把 key（開著的群組筆記要重抓成個人形或 404）→ `['public-link']`（轉移清掉公開連結，值會變）
 * → `['groups']`／`['notes']`。不碰 `['shares']`：兩模式都不產生逐人分享（v1 刪群組會把成員物化成逐人分享
 * 才需要先等 shares，v2 已推翻）。全部不 await：開著的查詢可能 404＋預設 retry，回饋不得被拖慢。
 */
export const GROUPS_QUERY_KEY = ["groups"] as const;

export function groupMembersKey(groupId: string) {
  return ["groups", groupId, "members"] as const;
}

export function groupRolesKey(groupId: string) {
  return ["groups", groupId, "roles"] as const;
}

export function useGroups(): UseQueryResult<GroupDto[]> {
  return useQuery({
    queryKey: GROUPS_QUERY_KEY,
    queryFn: () => api<GroupDto[]>("/api/groups"),
  });
}

/**
 * 成員名單（任一成員可讀）。`enabled` 給呼叫端擋「我已不是成員」：那時 server 回 404，
 * 不該發請求去換一個錯誤。
 */
export function useGroupMembers(groupId: string, options: { enabled?: boolean } = {}): UseQueryResult<GroupMemberDto[]> {
  return useQuery({
    queryKey: groupMembersKey(groupId),
    queryFn: () => api<GroupMemberDto[]>(`/api/groups/${encodeURIComponent(groupId)}/members`),
    enabled: (options.enabled ?? true) && groupId.length > 0,
  });
}

/**
 * #175 `GET /api/groups/:id/roles`（Q18：任一成員可讀；排序見 plan Task 7 的 `GET …/roles`）。
 * PR3 起含自訂角色（內建兩個在前、其餘依名稱）——成員表與加人表單的角色下拉要拿**角色 id**（gate r2 M-7：兩位管理員、
 * 沒有一般成員的群組，一般成員角色的 id 只拿得到這裡）。
 */
export function useGroupRoles(groupId: string): UseQueryResult<GroupRoleDto[]> {
  return useQuery({
    queryKey: groupRolesKey(groupId),
    queryFn: () => api<GroupRoleDto[]>(`/api/groups/${encodeURIComponent(groupId)}/roles`),
    enabled: groupId.length > 0,
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

/** 單篇筆記三把 key（常駐 `['note', id]`、解析 `['note-by-path', …]`／`['note-by-group-path', …]`），前綴失效。 */
function invalidateSingleNoteKeys(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["note"] }),
    queryClient.invalidateQueries({ queryKey: ["note-by-path"] }),
    queryClient.invalidateQueries({ queryKey: ["note-by-group-path"] }),
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
 * #175 PR4：刪群組必填模式（`DeleteGroupBody`）。204 無 body；錯誤（409 `not_admin`、409 `server_busy`、404 群組已不在…）由呼叫端 toast。
 * 失效：單篇三把（轉移後開著的群組筆記要重抓成個人形——transferTo 經轉址拿到 `/n/` 形、其他人拿到 404；全刪後拿到 404）
 * → `['public-link']`（轉移清掉公開連結，Willie 2026-10-02）→ `['groups']`／`['notes']`。不碰 `['shares']`：兩模式都不產生逐人分享
 * （v1 先 await shares，是因為 v1 刪群組把成員物化成逐人分享——D8，v2 已推翻）。全部不 await：開著的查詢可能 404＋retry。
 */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DeleteGroupBody }) =>
      api<void>(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify(body) }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["public-link"] });
      invalidate();
    },
  });
}

/** 只新增（409 `already_member`，不 upsert——S1 的守法，spec r1 C）。`roleId` 未給就不送鍵
 * （server body `.strict()`，未給＝內建一般成員；這裡明確不把 undefined 放進物件）。 */
export function useAddMember(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ email, roleId }: { email: string; roleId?: string }) =>
      api<GroupMemberDto>(`/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: "PUT",
        body: JSON.stringify(roleId === undefined ? { email } : { email, roleId }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * 改成員的角色（`{roleId}`）。另外失效單篇筆記的 key：改到自己的角色時，開著那篇群組筆記的
 * `permissions` 要跟著變（見檔頭）。這裡不判斷 `userId` 是不是自己——改別人的角色時多一發
 * active 查詢的重抓，換掉「資料層要知道目前使用者」的耦合。
 */
export function useSetMemberRole(groupId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      api<GroupMemberDto>(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ roleId }),
      }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}

/** 移人（管理成員者）與退出（userId＝自己）共用同一支；409 `last_admin` 由呼叫端顯示。 */
export function useRemoveMember(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/**
 * #175 PR3：角色 CRUD（`manageGroup`；spec §6.7）。建立不影響任何人的存取（沒有人掛新角色），只失效兩把 key；
 * 改與刪會改到「掛這個角色的人」的 `permissions`——可能就是自己——所以比照 `useSetMemberRole` 另外失效單篇筆記
 * 三把 key（見檔頭）。`['groups']` 前綴同時涵蓋 `groupRolesKey(id)`，角色頁跟著重抓。
 */
export function useCreateRole(groupId: string) {
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (body: { name: string; permissions: GroupRoleFlags }) =>
      api<GroupRoleDto>(`/api/groups/${encodeURIComponent(groupId)}/roles`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
}

/** body 只帶有給的鍵（`JSON.stringify` 丟掉 undefined）；server `.strict()`，`permissions` 給就要六鍵全給、不得帶 `read`。 */
export function useUpdateRole(groupId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: ({ roleId, name, permissions }: { roleId: string; name?: string; permissions?: GroupRoleFlags }) =>
      api<GroupRoleDto>(`/api/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, permissions }),
      }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}

/** 刪自訂角色：持有者改掛內建一般成員（Q8）——他們的 `permissions` 會變，失效同 `useUpdateRole`。 */
export function useDeleteRole(groupId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateGroupsAndNotes();
  return useMutation({
    mutationFn: (roleId: string) =>
      api<void>(`/api/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void invalidateSingleNoteKeys(queryClient);
      invalidate();
    },
  });
}
