import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ApiTokenDto, CreatedApiTokenDto } from "@knotebook/shared";
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
  /** UI 的兩檔；server 落庫前會轉成集合形（`notes:write` ⊇ `notes:read`）。 */
  scope: "notes:read" | "notes:write";
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
