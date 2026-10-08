import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { SpaceStorageDto } from "@knotebook/shared";
import { api } from "./client";
import { ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY } from "./storage";

/**
 * `GET /api/admin/users` 回應形狀（鏡射 `apps/server/src/routes/admin-users.ts` 的
 * `AdminUserDto`——那七欄（外加 `storage`）的 select 形狀鎖，見該檔說明）。刻意不放進
 * `@knotebook/shared`：與 `NoteDto`/`ShareDto` 不同，這個形狀只有 admin 頁面讀得到，
 * 沒有跨 owner/editor/viewer 角色共用的理由。與 server 端 adminUserColumns 的七欄
 * select 形狀鎖同步（#122 起含 handle）。
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
  /** 儲存配額 §7.2、§7.4：個人空間的方案與用量（GET／POST／PATCH storage-plan 都帶）。 */
  storage: SpaceStorageDto;
}

export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;

export function useAdminUsers(): UseQueryResult<AdminUserDto[]> {
  return useQuery({
    queryKey: ADMIN_USERS_QUERY_KEY,
    queryFn: () => api<AdminUserDto[]>("/api/admin/users"),
  });
}

export interface CreateAdminUserBody {
  email: string;
  password: string;
  displayName: string;
  isAdmin: boolean;
}

/** `POST /api/admin/users`——成功回 201 `AdminUserDto`（body 未在這裡使用，僅
 * invalidate 名單重新查詢即可）。 */
export function useCreateAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAdminUserBody) =>
      api<AdminUserDto>("/api/admin/users", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    },
  });
}

/** 三支 `:id` 操作端點共用同一套殼：皆為 bodyless POST、皆回 204、皆只需要
 * invalidate 名單。刻意不帶 body（`api()` 只在 `init.body != null` 時才補
 * `Content-Type: application/json`——帶空字串/`{}` 反而可能撞 server 端的
 * `FST_ERR_CTP_EMPTY_JSON_BODY`，見 `client.ts` 的說明與 `useSession.logout`
 * 的既有用法）。 */
function useAdminUserAction(action: "disable" | "enable" | "promote") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    },
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
