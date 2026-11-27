import { useId, useRef, useState, type ReactNode } from "react";
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
import { useTour } from "@/lib/tour-context";
import { openSettings } from "@/lib/open-settings";
import { PANEL_PLACEMENT, PANEL_ROW_WIDTH, SIDEBAR_PANEL_ANCHOR_ATTR } from "@/components/ui/panel-shell";
import { panelEntryState } from "@/lib/panel-return";
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
import { tourTarget } from "@/lib/tour-targets";
import { clearUploadQueue } from "@/uploads/upload-queue-store";

const LANGUAGES: { code: "en" | "zh-TW"; labelKey: string }[] = [
  { code: "en", labelKey: "userMenu.languageEn" },
  { code: "zh-TW", labelKey: "userMenu.languageZhTW" },
];

const THEMES: Theme[] = ["light", "dark", "system"];

/** `bell` (row variant only) sits over the trigger's row just left of the gear, as a sibling: a button inside the trigger button is invalid. The trigger sets `aria-label={user.displayName}` and hides avatar/gear so existing e2e name queries keep working. Renders nothing when `user` is missing (guard for use outside `<RequireAuth>`). */
export function UserMenu({ variant = "row", bell }: { variant?: "row" | "avatar"; bell?: ReactNode } = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useSession();
  const { release } = useSidebarQuery();
  const { theme, setTheme, accent, setAccent } = useTheme();
  const accentLabelId = useId();
  // hooks must come before the early return
  const shortcuts = useShortcutsDialog();
  const tour = useTour();
  const mac = isMacPlatform();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!user) return null;

  async function handleLogout(): Promise<void> {
    await logout();
    release(); // search text belongs to the user signing out: clear it (#369)
    clearUploadQueue();
    // Sign-out deliberately omits `?next=` (#131): it means "leaving", not "blocked" (contrast `useSessionGate` in `auth/guards.tsx`). `ChangePasswordPage` and `NotePage` session expiry also go to bare `/login`.
    navigate("/login", { replace: true });
  }

  // i18next already writes the language to localStorage after changeLanguage.
  function handleLanguageChange(code: string): void {
    void i18n.changeLanguage(code);
  }

  const avatar = variant === "avatar";
  const menu = (
    <DropdownMenu phoneSheet open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        {avatar ? (
          <button
            ref={triggerRef}
            type="button"
            aria-label={user.displayName}
            {...tourTarget("userMenu")}
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
            {...tourTarget("userMenu")}
            className={cn(
              // Equal to the backlinks row beside it (see SIDEBAR_ROW_HEIGHT); spelled out so the two stay linked.
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
            <span aria-hidden="true" className={cn("min-w-0 flex-1 truncate", bell !== undefined && "mr-10")}>
              {user.displayName}
            </span>
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      {/* Avatar-form trigger is only 44 wide, so it uses a fixed minimum instead of the row width. */}
      <DropdownMenuContent
        {...PANEL_PLACEMENT}
        side={avatar ? "bottom" : "top"}
        className={avatar ? "min-w-56" : PANEL_ROW_WIDTH}
      >
        <DropdownMenuLabel className="truncate">{user.displayName}</DropdownMenuLabel>
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
        {/* The gap is load-bearing: 16px dot + 8px gap = 24px centres, the WCAG 2.5.8 spacing floor; on touch the dots are 28px with a 44px hit area and gap-4, giving 44px centres so adjacent hit areas just do not overlap (no longer relying on the 24px exception); shrinking the gap fails. */}
        <DropdownMenuRadioGroup
          value={accent}
          onValueChange={(value) => setAccent(value as Accent)}
          aria-labelledby={accentLabelId}
          className="flex flex-wrap gap-2 pointer-coarse:gap-4 px-2 py-1.5"
        >
          {ACCENTS.map((color) => (
            <DropdownMenuRadioItem
              key={color}
              value={color}
              // textValue is needed for typeahead because the dot has no text.
              textValue={t(`accent.${color}`)}
              aria-label={t(`accent.${color}`)}
              title={t(`accent.${color}`)}
              // Keep the menu open so colours can be compared.
              onSelect={(event) => event.preventDefault()}
              className={cn(
                // Check (inside the dot) and focus ring (outside) are orthogonal, so both stay visible; the wrapper outline-none removes the native ring, hence data-highlighted ring.
                "relative flex h-4 w-4 items-center justify-center rounded-full pointer-coarse:h-7 pointer-coarse:w-7 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-[''] ring-offset-2 ring-offset-popover data-[highlighted]:ring-2 data-[highlighted]:ring-foreground",
              )}
              style={{ backgroundColor: `var(--brand-swatch-${color})` }}
            >
              {/* text-popover keeps the check at >= 3:1 in both modes. */}
              <DropdownMenuItemIndicator>
                <Check aria-hidden className="h-3 w-3 text-popover" />
              </DropdownMenuItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        {/* Hint only under AppShell: the listener lives there. aria-hidden keeps it out of the item name (e2e). Opens via `openSettings`, same as AppShell's Ctrl+,. */}
        <DropdownMenuItem
          aria-keyshortcuts={shortcuts ? (mac ? "Meta+," : "Control+,") : undefined}
          onSelect={() => openSettings(navigate, location, () => setMenuOpen(true))}
        >
          {t("settings.entry")}
          {shortcuts && (
            <span aria-hidden="true" className="ml-auto pl-4 text-xs text-muted-foreground">
              {mac ? "⌘," : "Ctrl+,"}
            </span>
          )}
        </DropdownMenuItem>
        {/* Not rendered outside AppShell (no listener). Follow NoteMenu focus-trap rule: preventDefault, close menu manually, open dialog (unit tests cannot catch a missing preventDefault). The trigger is passed as the close focus target; focus return is pinned in AppShell.shortcuts.test and e2e. */}
        {shortcuts && (
          <DropdownMenuItem
            aria-keyshortcuts={mac ? "Meta+/" : "Control+/"}
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              shortcuts.open(triggerRef.current, tour ? "tour" : "global", () => setMenuOpen(true));
            }}
          >
            {t("userMenu.help")}
            {/* hint is aria-hidden (e2e finds items by name) */}
            <span aria-hidden="true" className="ml-auto pl-4 text-xs text-muted-foreground">
              {mac ? "⌘/" : "Ctrl+/"}
            </span>
          </DropdownMenuItem>
        )}
        {/* Modal (#247) with backgroundLocation; `RequireAdmin` on /admin is the real guard. */}
        {user.isAdmin && (
          <DropdownMenuItem onSelect={() => navigate("/admin/users", { state: panelEntryState(location, () => setMenuOpen(true)) })}>{t("userMenu.siteAdmin")}</DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => void handleLogout()}>{t("userMenu.logout")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (avatar || bell === undefined) return menu;
  return (
    <div className="relative" {...{ [SIDEBAR_PANEL_ANCHOR_ATTR]: "" }}>
      {menu}
      {/* right edge = 6 px trigger padding + 16 px gear + 12 px gap = 34 px; the 8 px coarse-pointer hit extension stays 4 px clear of the gear. The name's mr-10 (40 px) + 8 px flex gap + 16 px gear + 6 px padding reserves 70 px = bell's 28 px box + 34 px, plus 8 px before the bell. */}
      <div className="absolute right-[34px] top-1/2 -translate-y-1/2">{bell}</div>
    </div>
  );
}
