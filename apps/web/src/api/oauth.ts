import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { OauthRequestDto, TokenScope } from "@knotebook/shared";
import { api } from "./client";

export const OAUTH_REQUEST_QUERY_KEY = ["oauth-request"] as const;

/** `GET /api/oauth/request`：同意頁的四要素。`req` 為 null 時不發請求。 */
export function useOauthRequest(req: string | null): UseQueryResult<OauthRequestDto> {
  return useQuery({
    queryKey: [...OAUTH_REQUEST_QUERY_KEY, req],
    enabled: req !== null,
    // 這一支不消費 pending request，重新整理安全；但 410/404 重試沒有意義。
    retry: false,
    // #239：同意頁的勾選初值只在第一次拿到資料時算（`ConsentBody` 的 useState），之後重抓
    // 只會更新「Currently granted」與 replacesWithLess 這些衍生顯示，兩邊就對不上了。
    // 這份資料當載入當下的快照用（spec §5.4），所以切回視窗或重新連線都不重抓。
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => api<OauthRequestDto>(`/api/oauth/request?req=${encodeURIComponent(req!)}`),
  });
}

/**
 * `POST /api/oauth/decision`：allow／deny 都會消費 pending request（I6）。
 * #239：allow 必帶 `scope`（使用者勾選的結果，server 再以 `narrowerScope` 夾回 pending）；
 * deny 只帶 `{req, decision}`。
 */
export type OauthDecisionBody =
  | { req: string; decision: "deny" }
  | { req: string; decision: "allow"; scope: TokenScope };

export function useOauthDecision() {
  return useMutation({
    mutationFn: (body: OauthDecisionBody) =>
      api<{ redirectTo: string }>("/api/oauth/decision", { method: "POST", body: JSON.stringify(body) }),
  });
}
