import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { StorageUsageDto } from "@knotebook/shared";
import { api } from "./client";

/**
 * 儲存配額的 query key 一律定義在這裡（spec §7.3、§7.1；`api/admin.ts` 與 `api/adminStorage.ts` 都 import 這裡，避免互相 import）。
 * - `["storage"]`：自己的個人空間（`GET /api/storage`）。
 * - `["groups", id, "storage"]`：群組空間（`GET /api/groups/:id/storage`，manageGroup 才看得到）——落在 `["groups"]` 前綴下，
 *   群組 mutation 的既有 invalidate（`api/groups.ts`）一併涵蓋。
 * - `["admin", "storage-plans"]`、`["admin", "groups"]`：站台管理。
 */
export const STORAGE_USAGE_QUERY_KEY = ["storage"] as const;
export const ADMIN_STORAGE_PLANS_QUERY_KEY = ["admin", "storage-plans"] as const;
export const ADMIN_GROUPS_QUERY_KEY = ["admin", "groups"] as const;

export function groupStorageKey(groupId: string) {
  return ["groups", groupId, "storage"] as const;
}

export function useStorageUsage(): UseQueryResult<StorageUsageDto> {
  return useQuery({ queryKey: STORAGE_USAGE_QUERY_KEY, queryFn: () => api<StorageUsageDto>("/api/storage") });
}

/** 只該在 `canManageGroup` 時掛載呼叫它的元件（否則 server 回 403）。 */
export function useGroupStorageUsage(groupId: string): UseQueryResult<StorageUsageDto> {
  return useQuery({
    queryKey: groupStorageKey(groupId),
    queryFn: () => api<StorageUsageDto>(`/api/groups/${encodeURIComponent(groupId)}/storage`),
  });
}
