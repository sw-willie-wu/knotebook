import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupDto, UserDto, VersionSettingsDto } from "@knotebook/shared";
import { api } from "./client";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";
import { GROUPS_QUERY_KEY } from "./groups";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/** 站台版本設定（spec §6.7，requireAdmin）。改總開關後失效公開的 `['auth-config']`（非 admin 的 disabled 顯示讀它，§6.8）。 */
export const VERSION_SETTINGS_QUERY_KEY = ["admin", "version-settings"] as const;

export function useVersionSettings() {
  return useQuery({ queryKey: VERSION_SETTINGS_QUERY_KEY, queryFn: () => api<VersionSettingsDto>("/api/admin/versions/settings") });
}

export function useUpdateVersionSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<VersionSettingsDto>) =>
      api<VersionSettingsDto>("/api/admin/versions/settings", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(VERSION_SETTINGS_QUERY_KEY, updated);
      void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_QUERY_KEY });
    },
  });
}

/** 個人開關（spec §6.8）：**只送 `autoVersions`**——不進改名交易、不扣改名額度。回應是寫入後的 `UserDto`，直接寫進 session 快取。 */
export function useUpdateAutoVersions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (autoVersions: boolean) =>
      api<UserDto>("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ autoVersions }) }),
    onSuccess: (updated) => queryClient.setQueryData(SESSION_QUERY_KEY, updated),
  });
}

/** 群組開關（spec §6.8，manageGroup）：只送 `autoVersions`；成功後失效 `['groups']`（`GroupDto.autoVersions` 從那裡讀）。 */
export function useUpdateGroupAutoVersions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, autoVersions }: { groupId: string; autoVersions: boolean }) =>
      api<GroupDto>(`/api/groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: JSON.stringify({ autoVersions }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY }),
  });
}
