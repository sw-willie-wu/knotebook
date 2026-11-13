import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/auth/useSession";
import { syncFillerUser } from "./filler-user";

/**
 * 不渲染任何節點。目前頭貼還在待補顯示圖（`pending`）時，在本人的瀏覽器背景補產並送回；補好後別人才讀得到。
 * 掛在登入後的版面（`AppShell`），所以這裡只留一層薄殼：補產本體（佇列、解碼編碼的接線）要到真的有東西可補時才動態載入，
 * 載入之後狀態一直留在記憶體，換頁重掛不會重送同一版。
 */
export function AvatarDisplayFiller() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const avatar = user?.avatar;
  const pending = avatar?.pending === true;
  const avatarId = avatar?.id;
  const avatarVersion = avatar?.v;

  // 換人（同一分頁登出再登入成另一個人）：前一位的佇列與失敗記憶不能留給下一位。必須排在下面那個 effect 之前。
  useEffect(() => {
    syncFillerUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!pending || avatarId === undefined || avatarVersion === undefined) return;
    void import("./filler-runtime").then(runtime => runtime.startFill({ id: avatarId, v: avatarVersion }, queryClient));
  }, [pending, avatarId, avatarVersion, queryClient]);

  return null;
}
