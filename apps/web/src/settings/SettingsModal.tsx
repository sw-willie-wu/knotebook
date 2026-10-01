import { Outlet, useLocation, useNavigate, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { NavItemLink } from "./SettingsNavLink";

interface SettingsLocationState {
  backgroundLocation?: Location;
}

/**
 * 一條左側導覽項——樣式與高亮交給共用的 `NavItemLink`，這一層只多做一件事：
 * `state={backgroundLocation ? { backgroundLocation } : undefined}` 把目前這次
 * 導覽帶進來的 `backgroundLocation` 原封傳給下一個 route entry——沒有這個，
 * 帳號／群組兩個區塊互切時 `state` 會變 `undefined`，關閉 modal 時就找不回原本的
 * 背景頁，只能落回 `/`（見 `SettingsModal` 的關閉行為）。
 */
function SettingsNavLink({
  to,
  label,
  backgroundLocation,
}: {
  to: string;
  label: string;
  backgroundLocation: Location | undefined;
}) {
  return (
    <NavItemLink to={to} state={backgroundLocation ? { backgroundLocation } : undefined}>
      {label}
    </NavItemLink>
  );
}

/**
 * 設定總 modal 外殼（spec §13.4）——第二棵 Routes 樹的 layout route：Radix Dialog
 * 包 `<Outlet/>`，`/settings/account`｜`/settings/groups`｜`/settings/groups/:id`｜`/settings/groups/:id/roles`
 * 之間切換是巢狀 route 切換，`<Dialog>`／`<DialogContent>` 本身不隨切換卸載重掛
 * （layout route 的既有語意——比照 `ChangePasswordGate` 那些 `<Outlet/>` 元件）。
 *
 * 導覽項只有帳號、群組兩項，所有登入者一樣。站台管理（使用者、AI）2026-09-30 起是
 * 獨立頁 `/admin/*`（`pages/AdminPage.tsx`，入口在 `UserMenu`），不在這個 modal 裡；
 * 舊網址 `/settings/users`、`/settings/ai` 由 `App.tsx` 第二棵樹轉址過去，而且轉址
 * 路由掛在本元件**外面**——不會先閃一下 modal。
 *
 * 關閉（Esc／✕／backdrop，都會走 Radix 的 `onOpenChange(false)`）：導回開啟前的
 * 背景 location（`location.state.backgroundLocation`）；深連結進來時沒有這個 state
 * （例如直接貼網址），就導回 `/`。背景是 `/admin/users` 時（在管理頁上開設定）照樣
 * 回到管理頁，不需另外處理。
 */
export function SettingsModal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as SettingsLocationState | null;
  const backgroundLocation = state?.backgroundLocation;

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      {/* 設定面板的幾何全部集中在這兩行（`size="lg"` 只有這裡在用）：外框
          896×672（`max-w-4xl`／`h-[42rem]`，蓋掉 variant 的 `max-w-3xl`，由
          tailwind-merge 消解衝突），扣掉 208px 導覽與內容區 32px 內距後，內容
          可用寬約 624px——比改版前的 528px 寬，當初是為了讓 AI／使用者那兩區的
          表格與並排欄位不折行（那兩區 2026-09-30 已搬到 `/admin/*` 獨立頁，尺寸
          未跟著重調），又不會讓說明文字拉得太開（說明本身另有 `max-w-prose` 限寬）。
          高度吃到 `max-h-[88vh]`：這幾頁是往下長的清單（token、群組成員），
          高一點能一次看到更多列，少捲一次。 */}
      <DialogContent size="lg" className="flex h-[42rem] max-h-[88vh] w-full max-w-4xl overflow-hidden">
        {/* 導覽是「機殼」、右邊是「文件」：給左欄一層極淡的底色，兩者才分得開——
            改版前兩側同色、只隔一條 1px 線，整個 modal 讀起來是一整片。
            `settings.title` 在這裡只是定位用的品牌字（13px 靜音），頁標題交給右邊的
            `SettingsPage`；它同時是 Radix 要求的 `DialogTitle`（modal 的可及名稱）。 */}
        <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-muted/40 p-4">
          <DialogTitle className="px-2 pb-3 text-[0.8125rem] font-medium text-muted-foreground">
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("settings.description")}</DialogDescription>
          <SettingsNavLink to="/settings/account" label={t("settings.nav.account")} backgroundLocation={backgroundLocation} />
          <SettingsNavLink to="/settings/groups" label={t("settings.nav.groups")} backgroundLocation={backgroundLocation} />
        </nav>
        <div className="flex-1 overflow-y-auto p-8">
          <Outlet />
        </div>
      </DialogContent>
    </Dialog>
  );
}
