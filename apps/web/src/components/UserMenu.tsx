import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useSession } from "@/auth/useSession";
import { useTheme, ACCENTS, type Accent, type Theme } from "@/theme";
import { Check, Settings } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
 * 設定入口（所有人皆可見，開 `/settings/account`，帶目前 location 當
 * `backgroundLocation`——設定總 modal，spec §13.4）、登出。既有「管理使用者」入口
 * 已移除（原本 admin only、導 `/admin/users`，Task 15；該路由現已改為
 * `<Navigate to="/settings/users" replace/>`，功能併入設定 modal 的使用者區）。
 * 未登入（`user` 為 `null`/`undefined`）時不渲染任何東西——這個元件只掛在
 * `<RequireAuth>` 底下的頁面，理論上此時一定已登入，但保留這道防呆，
 * 避免元件被單獨挪用到未受保護的頁面時炸掉。
 *
 * PR2（側欄卡 D.5）：觸發鈕改成整列（圓形首字 avatar＋displayName＋齒輪），
 * 而不是只有文字的 `Button`。**e2e 名稱保護**：觸發鈕本身設
 * `aria-label={user.displayName}`，覆蓋掉子樹（avatar／文字／齒輪）自然算出的
 * accessible name；avatar 與齒輪都標 `aria-hidden="true"`，確保
 * `getByRole("button",{name:user.displayName,exact:true})` 這類既有查詢在改版
 * 前後行為不變。
 */
export function UserMenu() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useSession();
  const { theme, setTheme, accent, setAccent } = useTheme();

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
        <button
          type="button"
          aria-label={user.displayName}
          className="flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-accent/60"
        >
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
          >
            {user.displayName.charAt(0).toUpperCase()}
          </span>
          <span aria-hidden="true" className="min-w-0 flex-1 truncate">
            {user.displayName}
          </span>
          <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
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

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("userMenu.accent")}
        </DropdownMenuLabel>
        {/* gap-2 是承重值：16px 圓點（h-4 w-4）＋8px 間距＝圓心距 24px，恰合
            WCAG 2.5.8 Target Size (Minimum) 的間距例外下限——縮小 gap 即不合格，
            不得因為「看起來擠一點沒差」隨手調整。 */}
        <DropdownMenuRadioGroup
          value={accent}
          onValueChange={(value) => setAccent(value as Accent)}
          className="flex gap-2 px-2 py-1.5"
        >
          {ACCENTS.map((color) => (
            <DropdownMenuRadioItem
              key={color}
              value={color}
              // 純色點沒有 textContent，Radix roving focus 的 typeahead
              // （按字母跳到對應項）需要靠 textValue 才找得到這一項。
              textValue={t(`accent.${color}`)}
              aria-label={t(`accent.${color}`)}
              title={t(`accent.${color}`)}
              // 選色不應該關掉選單——使用者可能想連續比較幾個顏色。
              onSelect={(event) => event.preventDefault()}
              className={cn(
                // wrapper 的 outline-none 清掉了瀏覽器原生 focus ring，鍵盤在六點
                // 間移動因此需要自己補一個可見指示：Radix 在 roving focus 目前
                // 停留的項目上放 data-highlighted，用 ring-foreground 跟選中態的
                // ring-ring 做視覺區分（顏色不同、不是同一個 CSS 變數）；兩者同時
                // 成立時 data-[highlighted]:ring-foreground 特異度較高，蓋掉
                // ring-ring——不是同一個 twMerge 群組互斥掉對方，是 CSS 層級決勝負。
                "h-4 w-4 rounded-full ring-offset-2 ring-offset-popover data-[highlighted]:ring-2 data-[highlighted]:ring-foreground",
                accent === color && "ring-2 ring-ring",
              )}
              style={{ backgroundColor: `var(--brand-swatch-${color})` }}
            />
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => navigate("/settings/account", { state: { backgroundLocation: location } })}
        >
          {t("settings.entry")}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => void handleLogout()}>{t("userMenu.logout")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
