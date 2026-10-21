import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AdminInviteDto, SpaceStorageDto } from "@knotebook/shared";
import { api } from "./client";
import { ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY } from "./storage";

/**
 * `GET /api/admin/users` 回應形狀（鏡射 `apps/server/src/routes/admin-users.ts` 的
 * `AdminUserDto`——那九欄＋兩個 SQL 表達式（外加 `storage`）的 select 形狀鎖，見該檔說明）。刻意不放進
 * `@knotebook/shared`：與 `NoteDto`/`ShareDto` 不同，這個形狀只有 admin 頁面讀得到，
 * 沒有跨 owner/editor/viewer 角色共用的理由。與 server 端 adminUserColumns 的
 * select 形狀鎖同步（#122 起含 handle、#247 起含 lastLoginAt、#267 起含 lastActiveAt、#286 起含 hasPassword／passwordResetExpiresAt）。
 */
export interface AdminUserDto {
  id: string;
  email: string;
  /** #122：URL 用的使用者名（server 端 adminUserColumns 同步收緊）。 */
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  /** #247 §9.5：最後一次登入（ISO）；null＝升級後尚未登入過。#267 起使用者表不再顯示它。 */
  lastLoginAt: string | null;
  /** #267：最後一次帶 session 的請求、共編連線或編輯、或登入（ISO）；null＝從無紀錄。使用者表「最後活動」欄讀它。 */
  lastActiveAt: string | null;
  /** #286：帳號有密碼（`password_hash` 非空）。SSO-only 帳號為 false，使用者表不顯示重設密碼鈕。 */
  hasPassword: boolean;
  /** #286：未用、未撤銷、未過期那一支重設連結的到期時間（ISO）；null＝沒有。帳密登入關閉期間照樣顯示。 */
  passwordResetExpiresAt: string | null;
  /** 儲存配額 §7.2、§7.4：個人空間的方案與用量（GET／PATCH storage-plan 都帶）。 */
  storage: SpaceStorageDto;
}

export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;

export function useAdminUsers(): UseQueryResult<AdminUserDto[]> {
  return useQuery({
    queryKey: ADMIN_USERS_QUERY_KEY,
    queryFn: () => api<AdminUserDto[]>("/api/admin/users"),
  });
}

/** #285：`GET /api/admin/invites`（管理員邀請列表，不含 token 與雜湊）。 */
export const ADMIN_INVITES_QUERY_KEY = ["admin", "invites"] as const;

export function useAdminInvites(): UseQueryResult<AdminInviteDto[]> {
  return useQuery({
    queryKey: ADMIN_INVITES_QUERY_KEY,
    queryFn: () => api<AdminInviteDto[]>("/api/admin/invites"),
  });
}

/**
 * #285：`POST /api/admin/invites`（201 `{ invite, token }`，明文只此一次）。`label` 只在非空時帶進 body。
 * 不等名單重抓，結果畫面立即出現；`gcTime: 0` 同 `useCreatePasswordReset`。
 */
export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ expiresInDays, label }: { expiresInDays: number; label: string }) =>
      api<{ invite: AdminInviteDto; token: string }>("/api/admin/invites", {
        method: "POST",
        body: JSON.stringify(label === "" ? { expiresInDays } : { expiresInDays, label }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY });
    },
  });
}

/** #285：`DELETE /api/admin/invites/:id`（204；409 `invite_used`）。回傳失效的 promise，讓 pending 涵蓋重抓。 */
export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY }),
  });
}

/**
 * #286：`POST /api/admin/users/:id/password-reset`（201 `{ token, expiresAt }`，明文只此一次）。不等名單重抓，結果畫面立即出現。
 * `gcTime: 0`：201 body 不在 mutation cache 多留 5 分鐘（比照 `useCreateApiToken` 的說明；同一個 JS heap，不是安全邊界）。
 */
export function useCreatePasswordReset() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ userId, expiresInHours }: { userId: string; expiresInHours: number }) =>
      api<{ token: string; expiresAt: string }>(`/api/admin/users/${encodeURIComponent(userId)}/password-reset`, {
        method: "POST",
        body: JSON.stringify({ expiresInHours }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    },
  });
}

/** #286：`DELETE /api/admin/users/:id/password-reset`（204）。回傳失效的 promise，讓 pending 涵蓋重抓。 */
export function useCancelPasswordReset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api<void>(`/api/admin/users/${encodeURIComponent(userId)}/password-reset`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
  });
}

/** 四支 `:id` 操作端點共用同一套殼：皆為 bodyless POST、皆回 204、皆只需要
 * invalidate 名單。刻意不帶 body（`api()` 只在 `init.body != null` 時才補
 * `Content-Type: application/json`——帶空字串/`{}` 反而可能撞 server 端的
 * `FST_ERR_CTP_EMPTY_JSON_BODY`，見 `client.ts` 的說明與 `useSession.logout`
 * 的既有用法）。`onSuccess` 回傳失效的 promise，讓呼叫端的 pending 涵蓋重抓（#247）：
 * `mutateAsync` 等名單重抓完才 resolve，列內剛選的角色／toggle 不會在重抓前彈回舊值。 */
function useAdminUserAction(action: "disable" | "enable" | "promote" | "demote") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
  });
}

export function useDisableAdminUser() {
  return useAdminUserAction("disable");
}

export function useEnableAdminUser() {
  return useAdminUserAction("enable");
}

export function usePromoteAdminUser() {
  return useAdminUserAction("promote");
}

/** #247 §9.4：`POST /api/admin/users/:id/demote`（204；400 `cannot_demote_self`、409 `last_site_admin`）。 */
export function useDemoteAdminUser() {
  return useAdminUserAction("demote");
}

/**
 * `PATCH /api/admin/users/:id/storage-plan`（spec §7.2）：回傳更新後的整列 → 直接換掉清單裡那一列（下拉立刻顯示新方案，
 * 不等重抓）；方案人數與自己的用量（若改的是自己）另行失效。
 */
export function useAssignUserPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, planId }: { userId: string; planId: string }) =>
      api<AdminUserDto>(`/api/admin/users/${encodeURIComponent(userId)}/storage-plan`, { method: "PATCH", body: JSON.stringify({ planId }) }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminUserDto[]>(ADMIN_USERS_QUERY_KEY, (rows) => rows?.map((r) => (r.id === updated.id ? updated : r)));
      void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_QUERY_KEY });
    },
    // onSettled：失敗（404 storage_plan_not_found＝方案剛被刪）時清單也已過時，一樣重抓，下拉才不再列出已刪的方案。
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_STORAGE_PLANS_QUERY_KEY });
    },
  });
}
