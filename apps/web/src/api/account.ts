import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { IdentitiesDto, OidcRedirectDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { api } from "./client";

/** #187 §8.3：`GET /api/auth/identities`（session-only）。 */
export const IDENTITIES_QUERY_KEY = ["identities"] as const;

export function useIdentities(): UseQueryResult<IdentitiesDto> {
  return useQuery({ queryKey: IDENTITIES_QUERY_KEY, queryFn: () => api<IdentitiesDto>("/api/auth/identities") });
}

export function useUnlinkIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/auth/identities/${encodeURIComponent(id)}`, { method: "DELETE" }),
    // 失敗（409／404）也代表 server 狀態已與畫面不同：成敗皆重抓。
    onSettled: () => void queryClient.invalidateQueries({ queryKey: IDENTITIES_QUERY_KEY }),
  });
}

/** §7.6：手動連結起點。B7：一律送 JSON body `{}`（server 拒收無 body 的 POST）。成功後呼叫端 `location.assign(url)`。 */
export function useStartLink() {
  return useMutation({
    mutationFn: (providerId: string) =>
      api<OidcRedirectDto>(`/api/auth/oidc/link/${encodeURIComponent(providerId)}`, { method: "POST", body: "{}" }),
  });
}

/** §8.4：加上密碼。成功後 server 已重簽本人 session（tokenVersion +1）；refetch session（hasPassword）與登入方式（unlinkable 會變）。 */
export function useSetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (newPassword: string) => api<void>("/api/auth/password/set", { method: "POST", body: JSON.stringify({ newPassword }) }),
    // onSettled：409 password_already_set 也代表 server 已有密碼、畫面該切到改密碼形，成敗皆重抓。
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: IDENTITIES_QUERY_KEY });
    },
  });
}
