import { useTranslation } from "react-i18next";
import { Navigate, Outlet } from "react-router";
import { useSession } from "./useSession";

function FullScreenLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">{t("app.loading")}</p>
    </div>
  );
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
  const { user } = useSession();

  if (user === undefined) return <FullScreenLoading />;
  if (user === null) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Outlet />;
}
