import { Navigate, useLocation, useParams } from "react-router";

/**
 * 群組 modal（#247 §6）。⚠ 本檔目前**只有** `LegacyGroupRedirect`——`GroupModal` 本體由 #247 Part 3 加入，
 * App.tsx 的接線（`/settings/groups/:id(/roles)` 改用它）也在 Part 3（`/groups/:id` 出現之前接上會導到空白頁）。
 *
 * `LegacyGroupRedirect`：舊網址 `/settings/groups/:id`、`/settings/groups/:id/roles` 轉到群組 modal。
 * `<Navigate to="/groups/:id">` 不會代入參數，所以讀 `useParams`。**必須轉傳 `location.state`**：舊網址可能
 * 帶著 `backgroundLocation`（出貨前開著的分頁、尚未改到的呼叫點），不帶 state 的 `<Navigate>` 會把背景丟掉，
 * 關閉群組 modal 就落到 `/` 而不是原本那頁。首包、很小。
 */
export function LegacyGroupRedirect({ suffix }: { suffix: "" | "/roles" }) {
  const { id = "" } = useParams();
  const location = useLocation();
  return <Navigate to={`/groups/${encodeURIComponent(id)}${suffix}`} replace state={location.state} />;
}
