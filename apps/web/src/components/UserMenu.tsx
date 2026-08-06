import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useSession } from "@/auth/useSession";
import { useTheme, type Theme } from "@/theme";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const LANGUAGES: { code: "en" | "zh-TW"; labelKey: string }[] = [
  { code: "en", labelKey: "userMenu.languageEn" },
  { code: "zh-TW", labelKey: "userMenu.languageZhTW" },
];

const THEMES: Theme[] = ["light", "dark", "system"];

/**
 * 顯示 displayName、語言切換（en/zh-TW）、主題切換（light/dark/system）、
 * 管理使用者入口（僅 `user.isAdmin` 時出現，導向 `/admin/users`，Task 15）、登出。
 * 未登入（`user` 為 `null`/`undefined`）時不渲染任何東西——這個元件只掛在
 * `<RequireAuth>` 底下的頁面，理論上此時一定已登入，但保留這道防呆，
 * 避免元件被單獨挪用到未受保護的頁面時炸掉。
 */
export function UserMenu() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useSession();
  const { theme, setTheme } = useTheme();

  if (!user) return null;

  async function handleLogout(): Promise<void> {
    await logout();
    navigate("/login", { replace: true });
  }

  // i18next 核心在 changeLanguage 後會自己呼叫 languageDetector.cacheUserLanguage
  // 寫回 localStorage（見 i18next.js changeLanguage 尾聲），這裡不需要重複寫。
  function handleLanguageChange(code: string): void {
    void i18n.changeLanguage(code);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost">{user.displayName}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{user.displayName}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("userMenu.language")}
        </DropdownMenuLabel>
        {LANGUAGES.map(({ code, labelKey }) => (
          <DropdownMenuItem key={code} onSelect={() => handleLanguageChange(code)}>
            <span className="flex w-4 justify-center">{i18n.language === code && <Check className="h-3.5 w-3.5" />}</span>
            {t(labelKey)}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("userMenu.theme")}
        </DropdownMenuLabel>
        {THEMES.map((value) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
            <span className="flex w-4 justify-center">{theme === value && <Check className="h-3.5 w-3.5" />}</span>
            {t(`theme.${value}`)}
          </DropdownMenuItem>
        ))}

        {user.isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate("/admin/users")}>{t("admin.entry")}</DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => void handleLogout()}>{t("userMenu.logout")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
