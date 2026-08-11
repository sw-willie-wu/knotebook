import { NavLink, Outlet, useLocation, useNavigate, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { useSession } from "@/auth/useSession";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SettingsLocationState {
  backgroundLocation?: Location;
}

/**
 * 一條左側導覽項——用 `NavLink` 而非 `Button`／`onClick` 手動 `navigate`，
 * 讓「目前在哪一區」的高亮完全交給 react-router 判斷（不用自己比對 pathname）。
 * `state={backgroundLocation ? { backgroundLocation } : undefined}` 把目前這次
 * 導覽帶進來的 `backgroundLocation` 原封傳給下一個 route entry——沒有這個，
 * 帳號／使用者／AI 三個區塊互切時 `state` 會變 `undefined`，關閉 modal 時
 * 就找不回原本的背景頁，只能落回 `/`（見 `SettingsModal` 的關閉行為）。
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
    <NavLink
      to={to}
      state={backgroundLocation ? { backgroundLocation } : undefined}
      className={({ isActive }) =>
        cn(
          "rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          isActive
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )
      }
    >
      {label}
    </NavLink>
  );
}

/**
 * 設定總 modal 外殼（spec §13.4）——第二棵 Routes 樹的 layout route：Radix Dialog
 * 包 `<Outlet/>`，`/settings/account`｜`/settings/users`｜`/settings/ai` 之間切換
 * 是巢狀 route 切換，`<Dialog>`／`<DialogContent>` 本身不隨切換卸載重掛（layout
 * route 的既有語意——比照 `SetupGate`/`ChangePasswordGate` 那些 `<Outlet/>` 元件）。
 *
 * 導覽項：帳號（所有人）／使用者／AI（`useSession().user?.isAdmin` 才渲染，同
 * `guards.tsx` 的用法——非 admin 深連結後兩者一樣會被巢狀在下面的 `RequireAdmin`
 * 擋下導 `/`，這裡的隱藏純粹是不讓非 admin 看到打不開的入口，不是唯一防線）。
 *
 * 關閉（Esc／✕／backdrop，都會走 Radix 的 `onOpenChange(false)`）：導回開啟前的
 * 背景 location（`location.state.backgroundLocation`）；深連結進來時沒有這個 state
 * （例如直接貼網址），就導回 `/`。
 */
export function SettingsModal() {
  const { t } = useTranslation();
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as SettingsLocationState | null;
  const backgroundLocation = state?.backgroundLocation;

  function handleOpenChange(open: boolean): void {
    if (open) return;
    navigate(backgroundLocation ?? "/");
  }

  const isAdmin = user?.isAdmin ?? false;

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent size="lg" className="flex h-[32rem] max-h-[85vh] w-full overflow-hidden">
        <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-border p-4">
          <DialogTitle className="px-2 pb-2 text-sm font-semibold">{t("settings.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("settings.description")}</DialogDescription>
          <SettingsNavLink to="/settings/account" label={t("settings.nav.account")} backgroundLocation={backgroundLocation} />
          {isAdmin && (
            <>
              <SettingsNavLink to="/settings/users" label={t("settings.nav.users")} backgroundLocation={backgroundLocation} />
              <SettingsNavLink to="/settings/ai" label={t("settings.nav.ai")} backgroundLocation={backgroundLocation} />
            </>
          )}
        </nav>
        <div className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </div>
      </DialogContent>
    </Dialog>
  );
}
