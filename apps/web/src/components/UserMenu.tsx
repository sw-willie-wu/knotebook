import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useSession } from "@/auth/useSession";
import { Avatar } from "@/components/Avatar";
import { useTheme, ACCENTS, type Accent, type Theme } from "@/theme";
import { Check, Settings } from "@/components/ui/icons";
import { SIDEBAR_ROW_HEIGHT } from "@/components/ui/rows";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";
import { useSidebarQuery } from "@/lib/sidebar-query";
import { useShortcutsDialog } from "@/lib/shortcuts-dialog";
import { openSettings } from "@/lib/open-settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
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
 * `backgroundLocation`——設定總 modal）、站台管理入口（admin only，
 * 導站台管理 modal `/admin/users`，帶 `backgroundLocation`（#247））、登出。
 * 未登入（`user` 為 `null`/`undefined`）時不渲染任何東西——這個元件只掛在
 * `<RequireAuth>` 底下的頁面，理論上此時一定已登入，但保留這道防呆，
 * 避免元件被單獨挪用到未受保護的頁面時炸掉。
 *
 * 觸發鈕是整列（圓形首字 avatar＋displayName＋齒輪），
 * 而不是只有文字的 `Button`。**e2e 名稱保護**：觸發鈕本身設
 * `aria-label={user.displayName}`，覆蓋掉子樹（avatar／文字／齒輪）自然算出的
 * accessible name；avatar 與齒輪都標 `aria-hidden="true"`，確保
 * `getByRole("button",{name:user.displayName,exact:true})` 這類既有查詢在改版
 * 前後行為不變。
 */
export function UserMenu({ variant = "row" }: { variant?: "row" | "avatar" } = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useSession();
  const { release } = useSidebarQuery();
  const { theme, setTheme, accent, setAccent } = useTheme();
  const accentLabelId = useId();
  // 快捷鍵介紹項：這幾個 hook 必須在 `if (!user) return null` 之前。
  const shortcuts = useShortcutsDialog();
  const mac = isMacPlatform();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!user) return null;

  async function handleLogout(): Promise<void> {
    await logout();
    release(); // 搜尋字屬於登出的這個人：清掉（#369）
    // #131：登出**刻意不帶** `?next=`——登出的語意是「我要離開」，不是「我暫時被擋下
    // 來」。同理 `ChangePasswordPage` 改密後登出、`NotePage` 的 session 過期也都導裸的
    // `/login`（對照 `auth/guards.tsx` 的 `useSessionGate`，那條才是「被擋下來」）。
    navigate("/login", { replace: true });
  }

  // i18next 核心在 changeLanguage 後會自己呼叫 languageDetector.cacheUserLanguage
  // 寫回 localStorage（見 i18next.js changeLanguage 尾聲），這裡不需要重複寫。
  function handleLanguageChange(code: string): void {
    void i18n.changeLanguage(code);
  }

  const avatar = variant === "avatar";
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        {avatar ? (
          // 頭像形（手機清單頂列）：只有共用頭像（圖或首字）；視覺 32、點擊範圍 44。
          <button
            ref={triggerRef}
            type="button"
            aria-label={user.displayName}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          >
            <Avatar
              name={user.displayName}
              avatar={user.avatar ? { id: user.avatar.id, v: user.avatar.v } : null}
              size={32}
              className="bg-primary text-primary-foreground"
            />
          </button>
        ) : (
          <button
            ref={triggerRef}
            type="button"
            aria-label={user.displayName}
            className={cn(
              // 列高吃 SIDEBAR_ROW_HEIGHT：與內文卡底部的 backlinks 列等高
              // （兩者左右相鄰，見該常數註解）。p-1.5＋24px avatar 的自然高度
              // 本來就等於它，這裡明寫出來是為了讓兩邊有機械連結、不會各改各的。
              "flex w-full items-center gap-2 rounded-md p-1.5 text-left text-sm hover:bg-accent/60",
              SIDEBAR_ROW_HEIGHT,
            )}
          >
            <Avatar
              name={user.displayName}
              avatar={user.avatar ? { id: user.avatar.id, v: user.avatar.v } : null}
              size={24}
              className="bg-primary text-primary-foreground"
            />
            <span aria-hidden="true" className="min-w-0 flex-1 truncate">
              {user.displayName}
            </span>
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      {/* 寬度跟著觸發它的帳號列走（Radix 在 Content 上曝露 trigger 量到的寬度），
          選單左右緣就跟側欄對齊；預設的 `min-w-32`（128px）比那一列窄一半。頭像形的觸發鈕只有 44 寬，改用固定下限、靠左對齊。 */}
      <DropdownMenuContent
        align={avatar ? "start" : "end"}
        className={avatar ? "min-w-56" : "min-w-[var(--radix-dropdown-menu-trigger-width)]"}
      >
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

        <DropdownMenuLabel id={accentLabelId} className="text-xs font-normal text-muted-foreground">
          {t("userMenu.accent")}
        </DropdownMenuLabel>
        {/* gap-2 是承重值：16px 圓點（h-4 w-4）＋8px 間距＝圓心距 24px，恰合
            WCAG 2.5.8 Target Size (Minimum) 的間距例外下限——縮小 gap 即不合格，
            不得因為「看起來擠一點沒差」隨手調整。 */}
        <DropdownMenuRadioGroup
          value={accent}
          onValueChange={(value) => setAccent(value as Accent)}
          aria-labelledby={accentLabelId}
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
                // 選中＝點內打勾（下方 ItemIndicator，checked 時才渲染），
                // 焦點＝這圈 ring；兩者是正交的視覺維度（一個在點內、一個在點
                // 外），互不覆蓋，因此鍵盤移到選中的點上時勾與 ring 同時完整
                // 可見。wrapper 的 outline-none 清掉了瀏覽器原生 focus ring，
                // 鍵盤在六點間移動需要自己補：Radix 在 roving focus 目前停留
                // 的項目上放 data-highlighted，用 ring-foreground 顯示。
                "flex h-4 w-4 items-center justify-center rounded-full ring-offset-2 ring-offset-popover data-[highlighted]:ring-2 data-[highlighted]:ring-foreground",
              )}
              style={{ backgroundColor: `var(--brand-swatch-${color})` }}
            >
              {/* text-popover：淺色 popover（白）用白勾約 4.7–5.0:1、深色
                  popover 用深勾約 5.0–6.8:1，六色兩模式皆 ≥3:1，不需依模式
                  切換顏色。勾純視覺，色點本身已有 aria-label。 */}
              <DropdownMenuItemIndicator>
                <Check aria-hidden className="h-3 w-3 text-popover" />
              </DropdownMenuItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        {/* Ctrl+, 的提示只在 AppShell 底下才標（context 非 null）：那支監聽器在 AppShell，單獨渲染本元件時按了不會有反應。
            提示字 aria-hidden：不進選單項的可及名稱（e2e 以名稱找項）。開法與 AppShell 的 Ctrl+, 同一條路（`openSettings`）。 */}
        <DropdownMenuItem
          aria-keyshortcuts={shortcuts ? (mac ? "Meta+," : "Control+,") : undefined}
          onSelect={() => openSettings(navigate, location)}
        >
          {t("settings.entry")}
          {shortcuts && (
            <span aria-hidden="true" className="ml-auto pl-4 text-xs text-muted-foreground">
              {mac ? "⌘," : "Ctrl+,"}
            </span>
          )}
        </DropdownMenuItem>
        {/* 快捷鍵介紹（Ctrl+/）：不在 AppShell 底下（context 為 null，例如單獨渲染本元件的測試）就不渲染，免得出現點了沒反應的死項。
            三步形照 NoteMenu 的 focus trap 規矩：preventDefault → 手動關選單 → 開對話框，並把觸發鈕交給對話框當關閉時的還焦點目標。
            ⚠ 少了 preventDefault 選單一樣會關，單元測試守不到這一步（跟 NoteMenu 同理）；焦點回歸由 AppShell.shortcuts.test 的「Esc 關 → 焦點回 UserMenu 觸發鈕」案與 e2e 守。 */}
        {shortcuts && (
          <DropdownMenuItem
            aria-keyshortcuts={mac ? "Meta+/" : "Control+/"}
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              shortcuts.open(triggerRef.current);
            }}
          >
            {t("userMenu.shortcuts")}
            {/* 提示字 aria-hidden：不進選單項的可及名稱（e2e 以名稱找項）。 */}
            <span aria-hidden="true" className="ml-auto pl-4 text-xs text-muted-foreground">
              {mac ? "⌘/" : "Ctrl+/"}
            </span>
          </DropdownMenuItem>
        )}
        {/* 站台管理是 modal（#247）：帶 backgroundLocation，關閉時回到原頁。非 admin 不渲染；/admin 的 RequireAdmin 才是防線。 */}
        {user.isAdmin && (
          <DropdownMenuItem onSelect={() => navigate("/admin/users", { state: { backgroundLocation: location } })}>{t("userMenu.siteAdmin")}</DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => void handleLogout()}>{t("userMenu.logout")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
