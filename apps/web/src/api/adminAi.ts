import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AdminAiActionDto, AdminAiModelDto, AdminAiProviderDto } from "@knotebook/shared";
import { api } from "./client";

/**
 * Admin AI 三層 CRUD 的 query key（spec §13.4，**key 定死**）：`["admin-ai","providers"]`／
 * `["admin-ai","models"]`／`["admin-ai","actions"]`，共用 `["admin-ai"]` 前綴——
 * `invalidateAdminAi` 靠這個前綴一次打中三個。
 */
export const ADMIN_AI_PROVIDERS_QUERY_KEY = ["admin-ai", "providers"] as const;
export const ADMIN_AI_MODELS_QUERY_KEY = ["admin-ai", "models"] as const;
export const ADMIN_AI_ACTIONS_QUERY_KEY = ["admin-ai", "actions"] as const;

export function useAdminAiProviders(): UseQueryResult<AdminAiProviderDto[]> {
  return useQuery({
    queryKey: ADMIN_AI_PROVIDERS_QUERY_KEY,
    queryFn: () => api<{ providers: AdminAiProviderDto[] }>("/api/admin/ai/providers").then((body) => body.providers),
  });
}

export function useAdminAiModels(): UseQueryResult<AdminAiModelDto[]> {
  return useQuery({
    queryKey: ADMIN_AI_MODELS_QUERY_KEY,
    queryFn: () => api<{ models: AdminAiModelDto[] }>("/api/admin/ai/models").then((body) => body.models),
  });
}

export function useAdminAiActions(): UseQueryResult<AdminAiActionDto[]> {
  return useQuery({
    queryKey: ADMIN_AI_ACTIONS_QUERY_KEY,
    queryFn: () => api<{ actions: AdminAiActionDto[] }>("/api/admin/ai/actions").then((body) => body.actions),
  });
}

/**
 * 任一 admin-ai mutation 成功 → invalidate 三層 admin-ai query（`["admin-ai"]` 前綴一次
 * 命中 providers/models/actions）＋ `["ai-actions"]`（`AiSession` 讀的可執行動作清單，
 * spec §13.4「同分頁立即生效」——admin 改了 action/model/provider 設定後，不必整頁重整，
 * 筆記側欄的 AI 面板馬上跟著換手）。
 */
function invalidateAdminAi(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["admin-ai"] });
  void queryClient.invalidateQueries({ queryKey: ["ai-actions"] });
}

// ───────────────────────────── providers ─────────────────────────────

export interface CreateAiProviderBody {
  name: string;
  type: "openai_compatible" | "anthropic";
  baseUrl: string;
  apiKey?: string;
}

export interface PatchAiProviderBody {
  name?: string;
  type?: "openai_compatible" | "anthropic";
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
}

export function useCreateAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiProviderBody) =>
      api<AdminAiProviderDto>("/api/admin/ai/providers", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function usePatchAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAiProviderBody }) =>
      api<AdminAiProviderDto>(`/api/admin/ai/providers/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function useDeleteAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/ai/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

/** `POST /api/admin/ai/providers/:id/test`——不帶 body。成功回 `{ok:true}`，只用來判斷
 * mutateAsync 是否 resolve。
 *
 * **`onSettled`（fix round 1，m-1），不是 `onSuccess`**：`routes/admin-ai.ts` 只在
 * decrypt 失敗那條路徑對 `runtime.degraded` 做 `add`（成功路徑不可能清掉
 * degraded——已 degraded 的 provider 一律先被 503 擋掉，根本進不到這支 fetch）。
 * degraded 徽章因此**只會在測試失敗時才需要刷新**；若沿用 `onSuccess`，剛被測出
 * degraded 的卡片直到下一次無關的操作前都不會亮警示，徽章過期。
 *
 * 成功路徑仍然一併 invalidate（`onSettled` 無條件跑）：不是因為成功會改變 degraded
 * （不會），純粹遵守 brief 對所有 admin-ai mutation「成功也 invalidate」的統一規則，
 * 對這支端點來說是無害的多一次 refetch，不是「藉此反映 degraded 變化」。 */
export function useTestAiProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/admin/ai/providers/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSettled: () => invalidateAdminAi(queryClient),
  });
}

// ───────────────────────────── models ─────────────────────────────

export interface CreateAiModelBody {
  providerId: string;
  modelId: string;
  displayName: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface PatchAiModelBody {
  modelId?: string;
  displayName?: string;
  isDefault?: boolean;
  enabled?: boolean;
}

export function useCreateAiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiModelBody) =>
      api<AdminAiModelDto>("/api/admin/ai/models", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function usePatchAiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAiModelBody }) =>
      api<AdminAiModelDto>(`/api/admin/ai/models/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function useDeleteAiModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/ai/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

// ───────────────────────────── actions ─────────────────────────────

export interface CreateAiActionBody {
  name: string;
  systemPrompt: string;
  userTemplate: string;
  modelId?: string | null;
  applyMode: "direct" | "preview";
  sortOrder?: number;
  enabled?: boolean;
}

export interface PatchAiActionBody {
  name?: string;
  systemPrompt?: string;
  userTemplate?: string;
  modelId?: string | null;
  applyMode?: "direct" | "preview";
  sortOrder?: number;
  enabled?: boolean;
}

export function useCreateAiAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiActionBody) =>
      api<AdminAiActionDto>("/api/admin/ai/actions", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function usePatchAiAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchAiActionBody }) =>
      api<AdminAiActionDto>(`/api/admin/ai/actions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}

export function useDeleteAiAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/admin/ai/actions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateAdminAi(queryClient),
  });
}
