import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { OauthRequestDto } from "@knotebook/shared";
import { api } from "./client";

export const OAUTH_REQUEST_QUERY_KEY = ["oauth-request"] as const;

/** `GET /api/oauth/request`：同意頁的四要素。`req` 為 null 時不發請求。 */
export function useOauthRequest(req: string | null): UseQueryResult<OauthRequestDto> {
  return useQuery({
    queryKey: [...OAUTH_REQUEST_QUERY_KEY, req],
    enabled: req !== null,
    // 這一支不消費 pending request，重新整理安全；但 410/404 重試沒有意義。
    retry: false,
    queryFn: () => api<OauthRequestDto>(`/api/oauth/request?req=${encodeURIComponent(req!)}`),
  });
}

/** `POST /api/oauth/decision`：allow／deny 都會消費 pending request（I6）。 */
export function useOauthDecision() {
  return useMutation({
    mutationFn: (body: { req: string; decision: "allow" | "deny" }) =>
      api<{ redirectTo: string }>("/api/oauth/decision", { method: "POST", body: JSON.stringify(body) }),
  });
}
