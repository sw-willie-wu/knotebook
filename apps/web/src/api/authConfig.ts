import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AuthConfigDto } from "@knotebook/shared";
import { api } from "./client";

/** `GET /api/auth/config`（免認證）。key 與既有的 `['auth-config']` 相同——管理頁的 mutation 以它 invalidate（api/adminAuth.ts）。 */
export const AUTH_CONFIG_QUERY_KEY = ["auth-config"] as const;

export function useAuthConfig(): UseQueryResult<AuthConfigDto> {
  return useQuery({ queryKey: AUTH_CONFIG_QUERY_KEY, queryFn: () => api<AuthConfigDto>("/api/auth/config") });
}
