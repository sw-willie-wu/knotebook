import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AdminGroupDto, StoragePlanDefaultsDto, StoragePlanDto, StoragePlansResponse } from "@knotebook/shared";
import { api } from "./client";
import { ADMIN_USERS_QUERY_KEY } from "./admin";
import { ADMIN_GROUPS_QUERY_KEY, ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY, groupStorageKey } from "./storage";

/**
 * 站台管理的儲存方案（spec §7.1）。方案的名稱／上限會出現在使用者表、群組表與自己的用量上，所以方案的任何 mutation 成功後
 * 四把 key 一起失效（`useInvalidateStorageAdmin`）。
 */
export function useAdminStoragePlans(): UseQueryResult<StoragePlansResponse> {
  return useQuery({ queryKey: ADMIN_STORAGE_PLANS_QUERY_KEY, queryFn: () => api<StoragePlansResponse>("/api/admin/storage-plans") });
}

export function useInvalidateStorageAdmin(): () => void {
  const queryClient = useQueryClient();
  return () => {
    for (const queryKey of [ADMIN_STORAGE_PLANS_QUERY_KEY, ADMIN_USERS_QUERY_KEY, ADMIN_GROUPS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
}

export interface StoragePlanBody {
  name: string;
  quotaBytes: number | null;
}

export function useCreateStoragePlan() {
  const invalidate = useInvalidateStorageAdmin();
  return useMutation({
    mutationFn: (body: StoragePlanBody) => api<StoragePlanDto>("/api/admin/storage-plans", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateStoragePlan() {
  const invalidate = useInvalidateStorageAdmin();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<StoragePlanBody> }) =>
      api<StoragePlanDto>(`/api/admin/storage-plans/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
    // onSettled：失敗（404 方案已被別人刪、409）時清單也已過時，一樣重抓。
    onSettled: () => invalidate(),
  });
}

export function useDeleteStoragePlan() {
  const invalidate = useInvalidateStorageAdmin();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/storage-plans/${encodeURIComponent(id)}`, { method: "DELETE" }),
    // onSettled：409 in_use／404 代表畫面上的清單已過時，失敗也重抓。
    onSettled: () => invalidate(),
  });
}

export function useUpdateStorageDefaults() {
  const invalidate = useInvalidateStorageAdmin();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<StoragePlanDefaultsDto>) =>
      api<StoragePlanDefaultsDto>("/api/admin/storage-plans/defaults", { method: "PATCH", body: JSON.stringify(body) }),
    // 先用回應換掉快取的 defaults，再失效重抓：下拉不會在重抓完成前跳回舊值。
    onSuccess: (defaults) => {
      queryClient.setQueryData<StoragePlansResponse>(ADMIN_STORAGE_PLANS_QUERY_KEY, (old) => (old ? { ...old, defaults } : old));
      invalidate();
    },
  });
}

/** `GET /api/admin/groups`（spec §7.2）：站上所有群組（不論我是不是成員），含成員數與儲存欄。 */
export function useAdminGroups(): UseQueryResult<AdminGroupDto[]> {
  return useQuery({ queryKey: ADMIN_GROUPS_QUERY_KEY, queryFn: () => api<AdminGroupDto[]>("/api/admin/groups") });
}

/**
 * `PATCH /api/admin/groups/:id/storage-plan`：同 `useAssignUserPlan`——回傳更新後的整列 → 直接換掉清單裡那一列，
 * 方案人數（成功與失敗都重抓：404 `storage_plan_not_found`＝方案剛被刪、清單已過時）與該群組的用量 key 另行失效。
 * 群組不影響個人用量，所以**不**失效 `["storage"]`。
 */
export function useAssignGroupPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, planId }: { groupId: string; planId: string }) =>
      api<AdminGroupDto>(`/api/admin/groups/${encodeURIComponent(groupId)}/storage-plan`, { method: "PATCH", body: JSON.stringify({ planId }) }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminGroupDto[]>(ADMIN_GROUPS_QUERY_KEY, (rows) => rows?.map((r) => (r.id === updated.id ? updated : r)));
      void queryClient.invalidateQueries({ queryKey: groupStorageKey(updated.id) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_STORAGE_PLANS_QUERY_KEY });
    },
  });
}
