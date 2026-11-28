import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";

export const SESSION_QUERY_KEY = ["me"] as const;

export interface UseSessionResult {
  /** `undefined` = still loading (not logged out); `null` = logged out (401). */
  user: UserDto | null | undefined;
  query: UseQueryResult<UserDto | null>;
  logout: () => Promise<void>;
}

/** 401 resolves to null rather than erroring: logged out is a normal state, and an error would trigger retries. */
export async function fetchSessionUser(signal?: AbortSignal): Promise<UserDto | null> {
  try {
    return await api<UserDto>("/api/auth/me", { signal });
  } catch (err) {
    if (err instanceof ApiFail && err.status === 401) return null;
    throw err;
  }
}

export function useSession(): UseSessionResult {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: () => fetchSessionUser(),
  });

  const logout = async (): Promise<void> => {
    await api<void>("/api/auth/logout", { method: "POST" });
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  };

  return { user: query.data, query, logout };
}
