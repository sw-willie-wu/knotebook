import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ApiTokenDto, CreatedApiTokenDto, TokenScope } from "@knotebook/shared";
import { api } from "./client";

export const API_TOKENS_QUERY_KEY = ["api-tokens"] as const;

/** `GET /api/auth/tokens`（#107）：PAT 與 OAuth grant 共用一份清單。 */
export function useApiTokens(): UseQueryResult<ApiTokenDto[]> {
  return useQuery({
    queryKey: API_TOKENS_QUERY_KEY,
    queryFn: () => api<{ tokens: ApiTokenDto[] }>("/api/auth/tokens").then(body => body.tokens),
  });
}

export interface CreateApiTokenInput {
  name: string;
  /** #239：三種落庫形之一，由建立對話框的兩個 toggle（`ScopeTogglesField`）經 `scopeFromChecks` 算出（#247）。 */
  scope: TokenScope;
  expiresInDays: 30 | 90 | 365 | null;
}

/**
 * `POST /api/auth/tokens`。回應含明文 `token`，**只有這一次**（I2）——呼叫端要自己
 * 把它顯示出來，這裡不寫進 query cache（列表永遠是重抓的）。注意 `useMutation` 仍會把
 * 201 body 留在 mutation cache（預設 gcTime 5 分鐘）——同一個 JS heap，不是安全邊界。
 */
export function useCreateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiTokenInput) =>
      api<CreatedApiTokenDto>("/api/auth/tokens", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });
}

/**
 * PATCH 的可改欄位（#239 server；#247 行內編輯只送改過的鍵）。`agentLabel: null`＝**把欄位清成 NULL**、
 * 回到派生值——回應仍是 server 端 `deriveAgentLabel(name)` 的派生值（不是空字串）。`name` 不可改。
 */
export interface UpdateApiTokenPatch {
  agentLabel?: string | null;
  scope?: TokenScope;
}

/** `PATCH /api/auth/tokens/:id`：改 label 與／或權限（下一個請求生效）。 */
export function useUpdateApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateApiTokenPatch }) =>
      api<ApiTokenDto>(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    // 先用回應換掉快取裡那一列、再失效重抓：回顯示態時不會在重抓完成前閃一下舊值。
    onSuccess: updated => {
      queryClient.setQueryData<ApiTokenDto[]>(API_TOKENS_QUERY_KEY, rows => rows?.map(r => (r.id === updated.id ? updated : r)));
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });
}

/** `DELETE /api/auth/tokens/:id`（D9：撤銷＝硬刪，立即失效）。 */
export function useRevokeApiToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });
}
