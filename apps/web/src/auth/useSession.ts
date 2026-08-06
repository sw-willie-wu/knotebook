import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";

export const SESSION_QUERY_KEY = ["me"] as const;

export interface UseSessionResult {
  /**
   * `undefined` = session query 尚未完成（載入中，guard 應顯示 loading，
   * 不可當成「未登入」處理）;`null` = 確定未登入（`/api/auth/me` 401）;
   * 其餘為已登入使用者。
   */
  user: UserDto | null | undefined;
  query: UseQueryResult<UserDto | null>;
  logout: () => Promise<void>;
}

/**
 * `GET /api/auth/me` 的 query：401 是「未登入」這個正常狀態，不是 error——
 * 一律轉成 resolve `null`，不讓 TanStack Query 進 error 分支（那樣 guard
 * 還要額外分辨「query 出錯」跟「confirmed 未登入」，且會觸發預設 retry）。
 * 其他非 401 的 ApiFail（例如 500）維持 throw，讓呼叫端可以走一般的錯誤處理。
 */
export function useSession(): UseSessionResult {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<UserDto | null> => {
      try {
        return await api<UserDto>("/api/auth/me");
      } catch (err) {
        if (err instanceof ApiFail && err.status === 401) return null;
        throw err;
      }
    },
  });

  const logout = async (): Promise<void> => {
    await api<void>("/api/auth/logout", { method: "POST" });
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };

  return { user: query.data, query, logout };
}
