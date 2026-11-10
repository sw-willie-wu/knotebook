import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import type { SiteLimitsDto, SiteLimitsPatchBody } from "@knotebook/shared";
import { api } from "./client";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";

export const SITE_LIMITS_QUERY_KEY = ["admin", "site-limits"] as const;

export function useSiteLimits(): UseQueryResult<SiteLimitsDto> {
  return useQuery({ queryKey: SITE_LIMITS_QUERY_KEY, queryFn: () => api<SiteLimitsDto>("/api/admin/limits") });
}

/** PATCH 站台限制（requireAdmin）；公開設定（例如上傳大小上限）跟著變，所以失效 `["auth-config"]`。 */
export function useUpdateSiteLimits(): UseMutationResult<SiteLimitsDto, unknown, SiteLimitsPatchBody> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SiteLimitsPatchBody) => api<SiteLimitsDto>("/api/admin/limits", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(SITE_LIMITS_QUERY_KEY, updated);
      // 兩次儲存的回應可能亂序到達，舊的快照會蓋掉新的：寫入後再重抓一次，以伺服器現況為準。
      void queryClient.invalidateQueries({ queryKey: SITE_LIMITS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_QUERY_KEY });
    },
  });
}
