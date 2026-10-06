import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  AdminAuthProbeResultDto,
  AdminAuthProviderDto,
  AdminAuthProviderImpactDto,
  AdminAuthSettingsDto,
  AuthProviderTemplate,
} from "@knotebook/shared";
import { AUTH_CONFIG_QUERY_KEY } from "./authConfig";
import { api } from "./client";

/** #187 PR2：`/api/admin/auth/*` 的 query key 一律掛在 `["admin-auth"]` 前綴下——任一 mutation 一次 invalidate 全部。 */
export const ADMIN_AUTH_PROVIDERS_QUERY_KEY = ["admin-auth", "providers"] as const;

export function useAdminAuthProviders(): UseQueryResult<AdminAuthProviderDto[]> {
  return useQuery({
    queryKey: ADMIN_AUTH_PROVIDERS_QUERY_KEY,
    queryFn: () => api<{ providers: AdminAuthProviderDto[] }>("/api/admin/auth/providers").then(body => body.providers),
  });
}

/** 停用 dialog 開著時才抓（`enabled`）；每次開都重抓——人數是當下快照（§9.3）。 */
export function useAuthProviderImpact(id: string, enabled: boolean): UseQueryResult<AdminAuthProviderImpactDto> {
  return useQuery({
    queryKey: ["admin-auth", "impact", id],
    queryFn: () => api<AdminAuthProviderImpactDto>(`/api/admin/auth/providers/${id}/impact`),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

/** 任一變更 → admin-auth 全部重抓＋登入頁的 `['auth-config']`（同一分頁登出後看到的按鈕要是新的）。 */
function invalidateAdminAuth(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["admin-auth"] });
  void queryClient.invalidateQueries({ queryKey: AUTH_CONFIG_QUERY_KEY });
}

export interface CreateAuthProviderBody {
  template: AuthProviderTemplate;
  displayName: string;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
}

export interface PatchAuthProviderBody {
  displayName?: string;
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export function useCreateAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAuthProviderBody) =>
      api<AdminAuthProviderDto>("/api/admin/auth/providers", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

export function usePatchAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAuthProviderBody }) =>
      api<AdminAuthProviderDto>(`/api/admin/auth/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

export function useDeleteAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/auth/providers/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

/** 測試連線成功會寫 `resolved_issuer`（卡片的「未連線」提醒要消失）→ 也 invalidate。 */
export function useTestAuthProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<AdminAuthProbeResultDto>(`/api/admin/auth/providers/${id}/test`, { method: "POST" }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}

/** 儲存前試探：不寫任何東西，不 invalidate。 */
export function useDiscoverAuthProvider() {
  return useMutation({
    mutationFn: (issuerUrl: string) =>
      api<AdminAuthProbeResultDto>("/api/admin/auth/discover", { method: "POST", body: JSON.stringify({ issuerUrl }) }),
  });
}

/** #187 §9.5：站台設定（「允許註冊」「允許帳密登入」）。`passwordLoginEnabled` 是 DB 值、`passwordLoginForced` 是 env。 */
export const ADMIN_AUTH_SETTINGS_QUERY_KEY = ["admin-auth", "settings"] as const;

export function useAdminAuthSettings(): UseQueryResult<AdminAuthSettingsDto> {
  return useQuery({ queryKey: ADMIN_AUTH_SETTINGS_QUERY_KEY, queryFn: () => api<AdminAuthSettingsDto>("/api/admin/auth/settings") });
}

export interface PatchAdminAuthSettingsBody {
  registrationEnabled?: boolean;
  passwordLoginEnabled?: boolean;
}

/** 成功 → admin-auth 全部（含 settings 與 provider 卡片）＋登入頁的 auth-config 重抓。409 不 invalidate：Switch 受控於 server 值，自然維持原狀。 */
export function usePatchAdminAuthSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchAdminAuthSettingsBody) =>
      api<AdminAuthSettingsDto>("/api/admin/auth/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAuth(queryClient),
  });
}
