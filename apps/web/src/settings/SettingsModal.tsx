import { Suspense } from "react";
import { Outlet, useLocation, useNavigate, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { useGroups } from "@/api/groups";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { ManagementShell, type ManagementNavItemSpec } from "@/components/management/ManagementShell";

interface SettingsLocationState {
  backgroundLocation?: Location;
}

/**
 * 個人設定 modal（#247 §5）——第二棵 Routes 樹的 layout route。外殼（托盤、兩卡、✕、窄視窗雙層、
 * 項次轉傳 `backgroundLocation`）全在 `components/management/ManagementShell`；這一層只做兩件事：
 * 1. 關閉（Esc／✕）時導回開啟前的背景 location（`location.state.backgroundLocation`）；深連結沒有這個
 *    state 時導回 `/`。點外面不關（外殼的 `dismissOnOutside={false}`）。
 * 2. 六個項次（帳戶資訊／登入／授權／儲存空間／群組／關於，Willie W8）。站台管理不在這裡（入口在 `UserMenu`）。
 *
 * 項次之間切換是巢狀 route 切換，`<Dialog>` 不隨切換卸載重掛（layout route 的既有語意）。
 * 各頁是 lazy chunk（#201）：外殼留在首包，開 modal 時外框與導覽立刻出現，只有內容區在 chunk 到手前顯示
 * 「載入中」。chunk 載入失敗走 `LazyRouteErrorBoundary`（自動 reload 一次、之後內容區顯示錯誤＋重試）；
 * `resetKey` 取真實 pathname——錯誤畫面上點另一個項次＝換目的地。`ChunkLoadBeacon` 必須在 Suspense 內、
 * 與 `<Outlet/>` 並列（擺放不變量見 ErrorBoundary.tsx）。`chunk="settings"` 只是錯誤邊界的額度別名，不代表一個 chunk。
 */
export function SettingsModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const backgroundLocation = (location.state as SettingsLocationState | null)?.backgroundLocation;
  // 「群組」項右側灰字計數（原型 v30、#247 Q7 裁定）：與側欄同一份 ['groups'] 快取；載入中（data undefined）不顯示。
  const groups = useGroups();

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  // 群組項不帶 `end`：過渡期（#247 Part 2 → Part 3 之間）`/settings/groups/:id(/roles)` 仍在本 modal 裡，
  // 停在那裡時「群組」要維持高亮。Part 3 把那兩條改成轉址後，有無 `end` 結果相同。
  const items: ManagementNavItemSpec[] = [
    { to: "/settings/account", label: t("settings.nav.account") },
    { to: "/settings/login", label: t("settings.nav.login") },
    { to: "/settings/authorization", label: t("settings.nav.authorization") },
    { to: "/settings/storage", label: t("settings.nav.storage") },
    { to: "/settings/groups", label: t("settings.nav.groups"), count: groups.data?.length },
    { to: "/settings/about", label: t("settings.nav.about") },
  ];

  return (
    <ManagementShell title={t("settings.title")} description={t("settings.description")} items={items} onOpenChange={handleOpenChange}>
      <LazyRouteErrorBoundary resetKey={location.pathname} chunk="settings" frame="inline">
        <Suspense fallback={<LazyRouteLoading frame="inline" />}>
          <Outlet />
          <ChunkLoadBeacon chunk="settings" />
        </Suspense>
      </LazyRouteErrorBoundary>
    </ManagementShell>
  );
}
