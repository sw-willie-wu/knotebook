import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api } from "./client";

/**
 * `GET /api/admin/users` 回應形狀（鏡射 `apps/server/src/routes/admin-users.ts` 的
 * `AdminUserDto`——那七欄的 select 形狀鎖，見該檔說明）。刻意不放進
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
