import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation } from "react-router";
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
  // hooks 規則：必須在任何提早 return 之前無條件呼叫。
  const location = useLocation();

  // 順序重要：只有「連一份可用的 session 都沒有」時才是錯誤終態。session query 進
  // error 但快取裡仍有 user（server 重啟／網路抖動造成的失敗 refetch，之後又發生
  // 重新掛載）時必須沿用既有 user 放行——把已登入的樹換掉會卸載 NotePage，
  // `useCollab` 隨之 `provider.destroy(); doc.destroy();`，還沒同步出去的編輯就沒了。
  if (query.isError && user === undefined) {
    return { screen: <SessionError onRetry={() => void query.refetch()} />, user: null };
  }
  if (user === undefined) return { screen: <FullScreenLoading />, user: null };
  if (user === null) {
    // #131：把「我本來要去哪」交給登入頁（`?next=`），登入完才回得去；不帶的話一律
    // 落 `/`。整串 pathname+search 做**一次** encodeURIComponent，內含的 `?`／`&` 才不
    // 會被當成 /login 自己的參數；`LoginPage`（Task 4 起）用 `searchParams.get("next")`
    // 解一次拿回原字串，再過 `safeNextPath`（同一支函式 server 端也用）。
    //
    // ⚠ **開著設定 modal 時**（location.state 帶 backgroundLocation），這裡在 `App.tsx`
    // 的**主樹**拿到的是被 `<Routes location={…}>` 覆寫過的**背景** location，真正生效
    // 的 next 來自第二棵樹（見該檔的兩棵樹說明）。其餘路徑沒有這個覆寫，拿到的就是真實
    // 網址。
    //
    // **hash 不帶**：純粹是 spec 沒要求、且密碼與 SSO 兩條路徑要一致才好推理。注意這
    // **不是**因為 fragment 活不下來——`#` 被 encode 成 `%23` 之後照樣送得到 server、
    // 封得進 state cookie，`safeNextPath` 那頭也**接受**帶 fragment 的路徑（寬進嚴出，
    // 本處只是不產生它）。
    const next = `${location.pathname}${location.search}`;
    return { screen: <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />, user: null };
  }
  return { screen: null, user };
}

/** 未登入 → `/login?next=<目前路徑>`（#131）；`user` 仍是 `undefined`（session query
 * 進行中）時顯示 loading，不可提早當成未登入導向，避免已登入使用者重新整理時被誤導到
 * 登入頁再跳回來。
 *
 * ⚠ **不是每條「未登入」路徑都會帶 next**：session 在筆記頁過期時，
 * `NotePage.handleUnauthorized` 會**同步**先 `navigate("/login")`（裸的，無 next），
 * 本 gate 來不及 render；登出（`UserMenu`）與改密後登出（`ChangePasswordPage`）也
 * 刻意不帶——理由見 `UserMenu.handleLogout` 的註解（那裡一併涵蓋另外兩處）。 */
export function RequireAuth() {
  const { screen } = useSessionGate();

  return screen ?? <Outlet />;
}

/** 非 admin → `/`；未登入時同 RequireAuth 導 `/login?next=<目前路徑>`（三顆 gate 共用
 * `useSessionGate` 的同一個分支，行為必然一致；供獨立掛載時也安全，即使目前唯一用法是
 * 巢狀在 RequireAuth 底下）。 */
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
 * 未登入時同 RequireAuth 導 `/login?next=<目前路徑>`（三顆 gate 共用 `useSessionGate`
 * 的同一個分支；供獨立掛載時也安全，即使目前唯一用法是巢狀在 `<RequireAuth>` 底下，
 * 此時 user 理論上不可能是 null——雙保險而非依賴它獨立生效，同 RequireAdmin 的既有
 * 理由）。
 */
export function ChangePasswordGate() {
  const { screen, user } = useSessionGate();

  if (screen) return screen;
  if (user!.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Outlet />;
}
