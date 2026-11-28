import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, type Location } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, ChevronLeft, ChevronRight, X } from "@/components/ui/icons";
import {
  managementCardPhone,
  managementCardPhoneInset,
  managementBackTopPhone,
  managementContentTopPhone,
  managementListHeaderPhone,
  managementListPaddingPhone,
  managementNavItemClass,
  managementNavListClass,
  managementTray,
  panelCloseHit as PANEL_CLOSE_HIT,
} from "@/components/management/tray";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";
import { forgetPanelReturn, panelReturnFor, type PanelLocationState } from "@/lib/panel-return";
import { cn } from "@/lib/utils";

/** Phone width gets 44x44 regardless of pointer type (a mouse at phone width too). */
const PHONE_BACK_HIT = "max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']";
/** Phone cards sit flush with the sheet's left edge, so the button clears the left safe area itself (the side in landscape), staying at least 8px from the card edge as at other widths. */
const PHONE_BACK_LEFT = "max-sm:left-[max(0.5rem,env(safe-area-inset-left))]";

/**
 * Narrow viewports (< md) show one card at a time (`layer`); from `md` up both cards always show and
 * `layer` has no effect. The cards' base classes omit `flex` and the layer class comes last in `cn`:
 * twMerge would drop a base `flex` in favor of `hidden`, but if anyone switched to string concatenation
 * `flex hidden` would coexist and reveal the hidden card (a test pins "no bare flex on the hidden card").
 *
 * Focus: no `onOpenAutoFocus`, because Radix's auto-focus filters out every `<a>` (the NavLink items),
 * so items would never get focus; initial focus follows DOM order in the right card, landing on the back
 * button (narrow) or close button (wide, where back is display:none); hence its fixed child order:
 * back, close, content.
 * On narrow back/item clicks the target is still display:none until `setLayer` commits, so a synchronous
 * `focus()` silently fails in real browsers (jsdom doesn't show it); a layout effect focuses after commit, and `seq` makes
 * re-clicking the current item fire too. Items use `onClick` rather than watching pathname, because
 * clicking the current item doesn't change pathname but must still switch to the content layer.
 *
 * Phone (< 640px): the panel is a bottom sheet with a back stack and no close button; both layers have a
 * back button in the same spot. The content layer's goes back to the item list; the list's closes the sheet
 * and, if the panel was opened from a menu (`lib/panel-return.ts`), reopens that menu once the sheet is
 * down (labelled back-to-menu; otherwise labelled close). Opened from a menu or shortcut (`panelStart: "list"`)
 * it starts on the item list; deep links (a page URL, the share dialog's manage-members link) land on
 * that page. Tapping the dimmed strip above the sheet or Esc always closes everything. On close the sheet animates
 * out first and `onOpenChange(false)` (navigating back to the background page) runs only once it has
 * finished (`onCloseAutoFocus`); wider viewports close immediately.
 */

export interface ManagementNavItemSpec {
  to: string;
  label: string;
  /** Passed to NavLink: the group modal's members route is `/groups/:id`, which would highlight on child pages without `end`. */
  end?: boolean;
  count?: ReactNode;
}

export interface ManagementShellProps {
  title: string;
  subtitle?: string;
  description?: string;
  items: ManagementNavItemSpec[];
  /** Esc, the close button and the phone list's back button all go through here; on phones only after the sheet has finished closing. */
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

type Layer = "items" | "content";
interface FocusRequest {
  target: Layer;
  seq: number;
}

const WIDE_QUERY = "(min-width: 768px)";
function isNarrowViewport(): boolean {
  return !window.matchMedia(WIDE_QUERY).matches;
}

/**
 * Always forward `backgroundLocation`: without it, after one item switch `location.state` is
 * undefined, closing can't find the background page and falls back to `/`, silently tearing down
 * the background note's collab provider.
 */
export function ManagementNavItem({
  to,
  label,
  end,
  count,
  backgroundLocation,
  onSelect,
}: ManagementNavItemSpec & { backgroundLocation: Location | undefined; onSelect: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      state={backgroundLocation ? { backgroundLocation } : undefined}
      onClick={onSelect}
      className={({ isActive }) => managementNavItemClass(isActive)}
    >
      <span className="min-w-0 truncate">{label}</span>
      {/* aria-hidden: the count is visual only; the link's name stays the item label (e2e finds items by name) */}
      {count !== undefined && (
        <span aria-hidden="true" className="ml-auto text-xs text-muted-foreground">
          {count}
        </span>
      )}
      {/* phone: trailing chevron marks drill-in (as in the menu sheet's submenu rows); hidden from 640px up */}
      <ChevronRight aria-hidden="true" className={cn("h-4 w-4 shrink-0 sm:hidden", count === undefined && "ml-auto")} />
    </NavLink>
  );
}

export function ManagementShell({ title, subtitle, description, items, onOpenChange, children }: ManagementShellProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  const phone = useIsPhone();
  // Read once at mount: after item switches the state keeps only backgroundLocation.
  const [entry] = useState(() => {
    const state = location.state as PanelLocationState | null;
    return { startList: state?.panelStart === "list" && isPhone(), returnToken: state?.panelReturn };
  });
  // Initially "content": index routes redirect to the first item outside the modal (the group's `/groups/:id`
  // is itself the members item), so the URL always names an item, and deep links on phones show that page.
  // Opened from a menu or shortcut on a phone, start on the item list.
  const [layer, setLayer] = useState<Layer>(entry.startList ? "items" : "content");
  const [open, setOpen] = useState(true);
  // null: this close was not started here, so there is nothing to do after the sheet closes.
  const afterCloseRef = useRef<{ reopen: (() => void) | null } | null>(null);
  // Back-to-menu only when opened from a menu on a phone and that menu can still reopen; opened at a
  // wider width and then shrunk to phone width, the list's back button only closes.
  const canReturnToMenu = entry.startList && phone && panelReturnFor(entry.returnToken) !== null;
  const navigate = useNavigate();
  // Strip panelStart/panelReturn from this history entry once read, so reload and back/forward treat
  // it as a deep link (stay on the URL's page, the list's back button only closes) instead of showing the
  // list again or reopening a menu that is gone.
  useEffect(() => {
    const state = location.state as PanelLocationState | null;
    if (state?.panelStart === undefined && state?.panelReturn === undefined) return;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: state.backgroundLocation ? { backgroundLocation: state.backgroundLocation } : null },
    );
  }, [location, navigate]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const seqRef = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  function switchTo(target: Layer): void {
    setLayer(target);
    if (!isNarrowViewport()) return; // wide viewports keep NavLink's native focus behavior
    seqRef.current += 1;
    setFocusRequest({ target, seq: seqRef.current });
  }

  function close(backToMenu: boolean): void {
    const reopen = backToMenu && entry.startList ? panelReturnFor(entry.returnToken) : null;
    forgetPanelReturn(entry.returnToken);
    if (!isPhone()) {
      onOpenChange(false);
      return;
    }
    afterCloseRef.current = { reopen };
    setOpen(false);
  }

  useLayoutEffect(() => {
    if (focusRequest === null) return;
    if (focusRequest.target === "content") {
      contentRef.current?.focus();
    } else {
      const nav = navRef.current;
      const current = nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>("a");
      current?.focus();
    }
    setFocusRequest(null);
  }, [focusRequest]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close(false);
      }}
    >
      {/* desktop: outside click doesn't close (inline forms may hold unsaved input); on the phone sheet, tapping the dimmed strip closes like Esc */}
      <DialogContent
        size="panel"
        dismissOnOutside={phone}
        onCloseAutoFocus={(event) => {
          const after = afterCloseRef.current;
          if (after === null) return;
          afterCloseRef.current = null;
          // When reopening the menu, focus goes there, not to the opener (unmounted along with the menu).
          if (after.reopen) event.preventDefault();
          onOpenChange(false);
          after.reopen?.();
        }}
      >
        {/* tray: shadow only here, cards don't cast */}
        <div className={managementTray}>
          <div
            data-management-card="items"
            className={cn(
              cardSurface,
              "relative w-full shrink-0 flex-col overflow-hidden p-4 md:w-64",
              managementCardPhone,
              managementListPaddingPhone,
              layer === "items" ? "flex" : "hidden",
              "md:flex",
            )}
          >
            <div className={cn("mb-3 flex h-10 items-center gap-2 px-3 max-md:pr-10 max-sm:pl-10 max-sm:pr-3", managementListHeaderPhone)}>
              {/* phone: list-layer back button, in the same spot as the content layer's (card's top-left, 8px); before the title in DOM for initial focus */}
              {phone && layer === "items" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("absolute left-2 top-2 z-10 h-7 w-7 bg-card", PHONE_BACK_LEFT, managementBackTopPhone, PANEL_CLOSE_HIT, PHONE_BACK_HIT)}
                  aria-label={canReturnToMenu ? t("management.backToMenu") : t("management.close")}
                  onClick={() => close(true)}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
              )}
              <div className="min-w-0">
                <DialogTitle className="truncate text-[15px] font-semibold leading-tight tracking-normal max-sm:text-lg">{title}</DialogTitle>
                {subtitle !== undefined && <p className="truncate text-xs font-normal text-muted-foreground">{subtitle}</p>}
              </div>
              {/* narrow list layer: right card is hidden, so a close button here, in the same spot as the right card's (top-right, 8px) so it doesn't jump between layers; only in this layer to avoid two Close buttons */}
              {layer === "items" && !phone && (
                <DialogClose asChild>
                  <Button type="button" variant="ghost" size="icon" className={cn("absolute right-2 top-2 z-10 h-7 w-7 bg-card md:hidden", PANEL_CLOSE_HIT)} aria-label={t("management.close")}>
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </DialogClose>
              )}
            </div>
            <DialogDescription className="sr-only">{description ?? title}</DialogDescription>
            <nav ref={navRef} aria-label={title} className={managementNavListClass}>
              {items.map((item) => (
                <ManagementNavItem
                  key={item.to}
                  {...item}
                  backgroundLocation={backgroundLocation}
                  onSelect={() => switchTo("content")}
                />
              ))}
            </nav>
          </div>
          <div
            data-management-card="content"
            className={cn(
              cardSurface,
              "relative min-w-0 flex-1 flex-col overflow-hidden",
              managementCardPhone,
              managementCardPhoneInset,
              layer === "content" ? "flex" : "hidden",
              "md:flex",
            )}
          >
            {/* child order is load-bearing: back, close, content (initial focus) */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("absolute left-2 top-2 z-10 h-7 w-7 bg-card md:hidden", PHONE_BACK_LEFT, managementBackTopPhone, PANEL_CLOSE_HIT, PHONE_BACK_HIT)}
              aria-label={t("management.back")}
              onClick={() => switchTo("items")}
            >
              {phone ? <ChevronLeft className="h-4 w-4" aria-hidden="true" /> : <ArrowLeft className="h-4 w-4" aria-hidden="true" />}
            </Button>
            {/* phone has no close button: back goes to the item list, and back again closes */}
            {!phone && (
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn("absolute right-2 top-2 z-10 h-7 w-7 bg-card", PANEL_CLOSE_HIT)}
                  aria-label={t("management.close")}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DialogClose>
            )}
            <div
              ref={contentRef}
              data-management-content=""
              tabIndex={-1}
              className={cn("flex-1 overflow-y-auto p-4 pt-12 focus:outline-none md:p-8", managementContentTopPhone)}
            >
              {children}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
