import { Outlet } from "react-router";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/AppShell";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { cardSurface } from "@/components/ui/card";
import { ArrowLeft } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { NavItemLink } from "@/settings/SettingsNavLink";

/** 站台管理頁的側欄導覽（放進 `AppShell` 的 `sidebar` 插槽，取代搜尋框＋筆記清單）。 */
function AdminNav() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("admin.nav.label")} className="flex flex-col gap-1">
      <NavItemLink to="/">
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("admin.nav.backToNotes")}
      </NavItemLink>
      <div className="my-1 border-t border-border" />
      <NavItemLink to="/admin/users">{t("admin.nav.users")}</NavItemLink>
      <NavItemLink to="/admin/ai">{t("admin.nav.ai")}</NavItemLink>
      <NavItemLink to="/admin/auth">{t("admin.nav.auth")}</NavItemLink>
    </nav>
  );
}

/**
 * 站台管理頁（`/admin/*`，admin only）——layout route：`/admin/users`、`/admin/ai`、
 * `/admin/auth`（#187 PR2）三個子路由各自是 `SettingsUsersSection`、`SettingsAiSection`、
 * `SettingsAuthSection`（前兩者原本掛在設定 modal 裡，元件本體未改，只換了掛載點）。殼用既有的 `AppShell`，側欄中段換成 `AdminNav`；
 * 主區的內容卡與 `HomePage` 同款（`cardSurface`＋卡自己捲動＋窄視窗頂列）。
 *
 * 守衛不在這裡：`App.tsx` 把本路由掛在 `RequireAuth` → `ChangePasswordGate` →
 * `RequireAdmin` 底下。同步 import（比照 `HomePage`；只有 `NotePage`／公開頁因為
 * BlockNote 那條相依鏈才走 lazy）。
 */
export default function AdminPage() {
  return (
    <AppShell sidebar={<AdminNav />}>
      <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto")}>
        <NarrowTopBar />
        <div className="p-8">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
