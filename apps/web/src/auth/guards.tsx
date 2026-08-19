import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet } from "react-router";
import { Button } from "@/components/ui/button";
import { useSession } from "./useSession";

function FullScreenLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">{t("app.loading")}</p>
    </div>
  );
}

/**
 * session query 失敗（非 401——401 是「未登入」這個正常狀態，見 `useSession`）時的終態。
 *
 * 沒有這個分支的話 `user` 會永遠停在 `undefined`，三個 gate 都把它當成「載入中」，
 * 整個 app 就卡在轉圈畫面，既沒有訊息也沒有出口。
 */
function SessionError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <p className="text-muted-foreground" role="alert">
        {t("app.sessionError")}
      </p>
      <Button type="button" onClick={onRetry}>
        {t("app.retry")}
      </Button>
    </div>
  );
}

/** 三個 gate 共用的前置判斷：載入中 / 出錯 / 未登入各自的終態，都決定不了才回 `null`
 * 讓呼叫端接手自己的規則。 */
function useSessionGate(): { screen: ReactElement | null; user: NonNullable<ReturnType<typeof useSession>["user"]> | null } {
  const { user, query } = useSession();

  if (query.isError) return { screen: <SessionError onRetry={() => void query.refetch()} />, user: null };
  if (user === undefined) return { screen: <FullScreenLoading />, user: null };
  if (user === null) return { screen: <Navigate to="/login" replace />, user: null };
  return { screen: null, user };
}

/** 未登入 → `/login`；`user` 仍是 `undefined`（session query 進行中）時顯示 loading，
 * 不可提早當成未登入導向，避免已登入使用者重新整理時被誤導到登入頁再跳回來。 */
export function RequireAuth() {
  const { screen } = useSessionGate();

  return screen ?? <Outlet />;
}

/** 非 admin → `/`；未登入時同 RequireAuth 導 `/login`（供獨立掛載時也安全，
 * 即使目前唯一用法是巢狀在 RequireAuth 底下）。 */
export function RequireAdmin() {
  const { screen, user } = useSessionGate();

  if (screen) return screen;
  if (!user!.isAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}

/**
 * 首登強制改密碼閘門（spec rev 5.7）：`user.mustChangePassword === true` → 除
 * `/change-password` 本身以外的受保護路由一律導向 `/change-password`——比照
 * `RequireAdmin` 的模式，這裡不用另外判斷「目前路徑是不是
 * `/change-password`」，因為 `App.tsx` 把 `/change-password` 這條路由掛在本 gate
 * 之外（與本 gate 平行，同樣巢狀在 `<RequireAuth>` 底下）——本 gate 底下的 `<Outlet/>`
 * 涵蓋的路由集合本來就不含 `/change-password`，不會有「導向自己」的迴圈疑慮。
 *
 * 未登入時同 RequireAuth 導 `/login`（供獨立掛載時也安全，即使目前唯一用法是巢狀在
 * `<RequireAuth>` 底下，此時 user 理論上不可能是 null——雙保險而非依賴它獨立生效，
 * 同 RequireAdmin 的既有理由）。
 */
export function ChangePasswordGate() {
  const { screen, user } = useSessionGate();

  if (screen) return screen;
  if (user!.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Outlet />;
}
