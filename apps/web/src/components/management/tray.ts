import { cn } from "@/lib/utils";

/**
 * Management panel tray (#247). Shadow only on this layer; the cards themselves cast none. Shared by `ManagementShell` and
 * `ShortcutsDialog`, so tray changes go here only.
 */
export const managementTray =
  "flex h-full min-h-0 w-full min-w-0 gap-2 rounded-2xl bg-background/45 p-2 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-md md:gap-3 md:p-3 " +
  // Phone (< 640px): the panel is a bottom sheet (`ui/dialog.tsx`) showing one card, so the tray has no padding or shadow
  // and the card sits flush with the sheet's sides and bottom, full width like the menu sheet. The card itself pads the
  // side and bottom safe areas (see the three constants below).
  "max-sm:gap-0 max-sm:p-0 max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:shadow-none max-sm:bg-transparent max-sm:backdrop-blur-none";

/** Phone: the card is the sheet's surface, flush at the sides and bottom, top corners rounded, no side/bottom border (like the menu sheet). */
export const managementCardPhone = "max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:bg-popover";

/** Phone: cards without own padding use the safe-area insets (landscape sides, home indicator) as padding. */
export const managementCardPhoneInset =
  "max-sm:pl-[env(safe-area-inset-left)] max-sm:pr-[env(safe-area-inset-right)] max-sm:pb-[env(safe-area-inset-bottom)]";

/** Phone: cards with their own 16px padding (the nav list) use the larger of that and the safe-area inset. */
export const managementListPaddingPhone =
  "max-sm:pl-[max(1rem,env(safe-area-inset-left))] max-sm:pr-[max(1rem,env(safe-area-inset-right))] max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]";

/**
 * Shared by `ManagementShell`'s `ManagementNavItem` and the shortcuts dialog's category buttons: same visual language, one a
 * NavLink and one a state-driven button. `active` = the current item.
 */
export function managementNavItemClass(active: boolean): string {
  return cn(
    "flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors " +
      "hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
    active && "bg-brand-soft font-medium text-brand-on-soft hover:bg-brand-soft-strong",
    // Phone: a drill-in list, not a selected navigation, so rows look like the menu sheet's rows: at least 48px high, 16px
    // normal weight, no gap, 4px radius, gray press/focus background, no persistent brand color (not even on the current
    // item). -mx-2/px-2 puts the background 8px from the card edge and the text and trailing "›" 16px.
    "max-sm:-mx-2 max-sm:h-auto max-sm:min-h-12 max-sm:rounded-sm max-sm:px-2 max-sm:text-base max-sm:font-normal max-sm:text-foreground " +
      "max-sm:hover:bg-accent max-sm:hover:text-foreground max-sm:active:bg-accent max-sm:focus-visible:bg-accent",
    active && "max-sm:bg-transparent max-sm:font-normal max-sm:text-foreground max-sm:hover:bg-accent",
  );
}

/**
 * Phone rows touch (4px gap on desktop). The list scrolls by itself on phones: the card is `overflow-hidden`, and rows that
 * don't fit a short (landscape) screen must stay reachable; the header row above the rule is outside the list and doesn't
 * scroll. `min-h-0 flex-1` gives the list the card's remaining finite height. `overflow-y-auto` clips horizontally too, so the list extends 8px each side and pads back; the rows' `-mx-2` then
 * stay inside the list bounds and no horizontal scroll appears.
 */
export const managementNavListClass = "flex flex-col gap-1 max-sm:-mx-2 max-sm:min-h-0 max-sm:flex-1 max-sm:gap-0 max-sm:overflow-y-auto max-sm:px-2";

/**
 * Phone: the rule between the top row ("‹" + title) and the list, like the menu sheet's divider, spans the full card width
 * (undoing the card padding, safe area included). The row height centers "‹" and the title vertically; the title's left
 * edge (card padding + 40px for "‹") doesn't move when the row widens.
 */
export const managementListHeaderPhone =
  "max-sm:mb-2 max-sm:h-12 max-sm:border-b max-sm:border-border " +
  "max-sm:-ml-[max(1rem,env(safe-area-inset-left))] max-sm:-mr-[max(1rem,env(safe-area-inset-right))] " +
  "max-sm:pl-[calc(max(1rem,env(safe-area-inset-left))+2.5rem)] max-sm:pr-[max(1rem,env(safe-area-inset-right))]";

/**
 * Phone: centers "‹" on the nav list title (48px high, 16px card padding); the content layer's title has the same height, so
 * "‹" lands in the same place on both layers. The background is the sheet surface (looks transparent) but hides content
 * scrolling under it, so it doesn't overlap the "‹" glyph.
 */
export const managementBackTopPhone = "max-sm:top-[26px] max-sm:bg-popover";

/**
 * Phone: leaves room at the top for "‹" (glyph to 54px, hit area to 62px) so untitled content (loading, error, not found)
 * isn't under it; titled pages (`SettingsPage`'s h1, the shortcuts category title) pull back up with `managementHeadingUpPhone`.
 */
export const managementContentTopPhone = "max-sm:pt-16";

/** Phone: pulls the 48px title up 48px so its midline meets "‹"'s midline (40px). Pairs with `managementContentTopPhone`. */
export const managementHeadingUpPhone = "max-sm:-mt-12 max-sm:flex max-sm:min-h-12 max-sm:items-center max-sm:pl-10";

/** Expands a 28px close button's touch hit area to 44x44. The pseudo-element needs a positioned button; callers add `relative` if it isn't `absolute`. */
export const panelCloseHit = "pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']";
