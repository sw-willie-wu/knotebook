import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import { api } from "./client";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

/**
 * `PATCH /api/auth/profile`（#122 改名）。onSuccess 兩件事（spec §2a：「全清＋session
 * 快取更新」，兩者都要）：
 * 1. **先 `setQueryData` 把 PATCH 回應寫進 session 快取**——比照 ChangePasswordForm
 *    的「呼叫端當下就要讀得到新值」慣例；只 invalidate 的話 mutateAsync resolve 時
 *    refetch 還沒落地，畫面會先閃回舊名一個 RTT（讀碼審查 M1）。
 * 2. `invalidateQueries()` 全清、**fire-and-forget 不 return**：畫面正確性已由
 *    setQueryData 保證，成功 toast／呼叫端流程不該被「全站每個 active query 都
 *    refetch 完」拖住（慢查詢或暫時打不通時 toast 會晚到甚至不到——M1 釘測用
 *    懸掛的 /me 實測過 return 版的這個病）。handle 會被反正規化進 NoteDto/
 *    BacklinkDto（PR2 起），改名罕見、全清最保險。
 */
export function useUpdateHandle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { handle: string }) =>
      api<UserDto>("/api/auth/profile", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, updated);
      void queryClient.invalidateQueries();
    },
  });
}
