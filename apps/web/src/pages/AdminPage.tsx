import { Navigate, Route, Routes } from "react-router";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/AppShell";
import { NarrowTopBar } from "@/components/NarrowTopBar";
import { cardSurface } from "@/components/ui/card";
import { ArrowLeft } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { NavItemLink } from "@/settings/SettingsNavLink";
import { SettingsUsersSection } from "@/settings/SettingsUsersSection";
import { SettingsAdminGroupsSection } from "@/settings/SettingsAdminGroupsSection";
import { SettingsStorageSection } from "@/settings/SettingsStorageSection";
import { SettingsVersionsSection } from "@/settings/SettingsVersionsSection";
import { SettingsAiSection } from "@/settings/SettingsAiSection";
import { SettingsAuthSection } from "@/settings/SettingsAuthSection";

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
      <NavItemLink to="/admin/groups">{t("admin.nav.groups")}</NavItemLink>
      <NavItemLink to="/admin/storage">{t("admin.nav.storage")}</NavItemLink>
      <NavItemLink to="/admin/versions">{t("admin.nav.versions")}</NavItemLink>
      <NavItemLink to="/admin/ai">{t("admin.nav.ai")}</NavItemLink>
      <NavItemLink to="/admin/auth">{t("admin.nav.auth")}</NavItemLink>
    </nav>
  );
}

/**
 * 站台管理頁（`/admin/*`，admin only）：`/admin/users`、`/admin/groups`、`/admin/storage`、`/admin/versions`、`/admin/ai`、
 * `/admin/auth`（#187 PR2）各自是 `SettingsUsersSection`、`SettingsAdminGroupsSection`、`SettingsStorageSection`、`SettingsVersionsSection`、`SettingsAiSection`、
 * `SettingsAuthSection`（使用者與 AI 原本掛在設定 modal 裡，元件本體未改，只換了掛載點）。殼用既有的 `AppShell`，側欄中段換成 `AdminNav`；
 * 主區的內容卡與 `HomePage` 同款（`cardSurface`＋卡自己捲動＋窄視窗頂列）。
 *
 * 守衛不在這裡：`App.tsx` 把本路由掛在 `RequireAuth` → `ChangePasswordGate` →
 * `RequireAdmin` 底下。
 *
 * **lazy chunk（#201）**：`App.tsx` 以 `lazy(() => import("./pages/AdminPage"))` 載入。各個子
 * 區塊的路由因此寫在這裡（descendant `<Routes>`）而不是 `App.tsx`——子區塊元件只被本模組
 * 靜態 import，Rollup 才會把它們跟本頁收進同一個 `AdminPage-<hash>.js`；若留在 `App.tsx`
 * 當 route element，它們會被拉回首包，或得各自再 lazy 一層、變成「頁面成功掛載後才 throw
 * 的巢狀 chunk」（ErrorBoundary.tsx 旗標註解警告過的自動 reload 迴圈形）。
 * `scripts/check-bundle-size.mjs` 釘住這個 chunk 存在。
 *
 * descendant `<Routes>` 吃的是主樹覆寫後的 location（在管理頁上開設定 modal 時背景仍是
 * 本頁、照常渲染）。`/admin` 與不存在的子路徑都轉 `/admin/users`。
 */
export default function AdminPage() {
  return (
    <AppShell sidebar={<AdminNav />}>
      <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto")}>
        <NarrowTopBar />
        <div className="p-8">
          <Routes>
            <Route path="users" element={<SettingsUsersSection />} />
            <Route path="groups" element={<SettingsAdminGroupsSection />} />
            <Route path="storage" element={<SettingsStorageSection />} />
            <Route path="versions" element={<SettingsVersionsSection />} />
            <Route path="ai" element={<SettingsAiSection />} />
            <Route path="auth" element={<SettingsAuthSection />} />
            <Route path="*" element={<Navigate to="/admin/users" replace />} />
          </Routes>
        </div>
      </div>
    </AppShell>
  );
}
