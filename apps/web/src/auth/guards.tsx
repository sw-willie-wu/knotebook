import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation } from "react-router";
import { api } from "@/api/client";
import { useSession } from "./useSession";

interface SetupStatusDto {
  needed: boolean;
}

/** `GET /api/setup/status` 的 query key——匯出給 `SetupPage` 用：setup 成功後
 * 必須把這個 key 的 cache 直接種成 `{needed:false}`（`setQueryData`，不是
 * `invalidateQueries`——後者只是排個 refetch，SetupGate 是 layout route，
 * `/setup → /` 的 navigate 不會讓它重新掛載，沒有任何東西觸發那次 refetch，
 * `needed` 會停留在 `true`，導致使用者剛成功卻被彈回空白的 setup 表單）。 */
export const SETUP_STATUS_QUERY_KEY = ["setup-status"] as const;

/** `GET /api/setup/status` 的 query。error 狀態刻意不當「不需要 setup」處理——
 * 見 `SetupGate` 的 `isPending || isError` 判斷。 */
function useSetupStatus() {
  return useQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: () => api<SetupStatusDto>("/api/setup/status"),
  });
}

function FullScreenLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">{t("app.loading")}</p>
    </div>
  );
}

/**
 * 掛在整棵 route tree 最外層。§11.3 逐字守衛規則：
 * - `needed:true` → 除了 `/setup` 本身，一切導向 `/setup`。
 * - `needed:false` 時訪 `/setup`：未登入導 `/login`、已登入導 `/`。
 * - 其餘情況放行（`<Outlet/>`），細部登入檢查交給 `<RequireAuth>`/`<RequireAdmin>`。
 *
 * setup 狀態與 session 都用 TanStack Query（key 分別是 `SETUP_STATUS_QUERY_KEY`、
 * `['me']`），任一筆還沒回來就顯示 loading，不能提早用 `undefined` 當「未登入」
 * 或「不需要 setup」誤判——那樣重新整理時會閃一下錯的頁面再跳轉。
 *
 * `statusQuery` 出錯（`isError`）時也顯示 loading/重試中的畫面，不能落到
 * `needed ?? false` 那個「fail open」分支——一個全新、還沒 setup 過的實例若這次
 * query 剛好失敗（例如網路抖動），絕不能被當成「不需要 setup」而放行到
 * `/login` 給一個根本不存在帳號的人看登入表單。
 */
export function SetupGate() {
  const location = useLocation();
  const statusQuery = useSetupStatus();
  const { user } = useSession();

  if (statusQuery.isPending || statusQuery.isError) return <FullScreenLoading />;

  const needed = statusQuery.data.needed;

  if (needed) {
    if (location.pathname !== "/setup") {
      return <Navigate to="/setup" replace />;
    }
    return <Outlet />;
  }

  if (location.pathname === "/setup") {
    if (user === undefined) return <FullScreenLoading />;
    return <Navigate to={user ? "/" : "/login"} replace />;
  }

  return <Outlet />;
}

/** 未登入 → `/login`；`user` 仍是 `undefined`（session query 進行中）時顯示 loading，
 * 不可提早當成未登入導向，避免已登入使用者重新整理時被誤導到登入頁再跳回來。 */
export function RequireAuth() {
  const { user } = useSession();

  if (user === undefined) return <FullScreenLoading />;
  if (user === null) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** 非 admin → `/`；未登入時同 RequireAuth 導 `/login`（供獨立掛載時也安全，
 * 即使目前唯一用法是巢狀在 RequireAuth 底下）。 */
export function RequireAdmin() {
  const { user } = useSession();

  if (user === undefined) return <FullScreenLoading />;
  if (user === null) return <Navigate to="/login" replace />;
  if (!user.isAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}
