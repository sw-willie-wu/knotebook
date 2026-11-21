/**
 * Hover-reveal for sidebar and avatar-candidate ⋮ buttons (the sidebar ones are button.tsx's 24px exception). Scopes: `tabheader` (the sidebar tab title row), `noterow` (note row ⋮, trash row Restore/⋮; the `<li>` carries `group/noterow`), `folderrow`, `avatarcell` (the block carries `group/avatarcell`; hovering anywhere in it reveals every cell's ⋮).
 * Desktop: `opacity-0` until row hover (`group-hover/<scope>`), keyboard focus inside the row (`group-has-[:focus-visible]/<scope>`, not focus-within, which would stick after a mouse click) or the button itself keyboard-focused.
 * Stays while its menu is open: Radix sets `data-state="open"` on the trigger; with a modal menu the pointer has left the row and ⋮ would fade while the menu is still open. No effect on non-menu "+" buttons.
 * Touch (`hover: none`): always visible, since Tailwind v4's group-hover only applies under `@media (hover: hover)`. `hoverRevealOnly` differs only on touch: the row's hollow favorite star is `display: none` entirely under `hover: none` or `pointer: coarse` (no space, out of tab order and a11y tree), and adding goes through ⋮, which stays visible as the only entry point.
 * Every scope's class must be a complete literal (Tailwind scans statically; template-built classes silently fail while jsdom tests stay green). Tests can only assert class strings: no CSS or hover in jsdom.
 */
export type RevealScope = "grouprow" | "noterow" | "folderrow" | "avatarcell" | "tabheader";

const BASE =
  "opacity-0 transition-opacity focus-visible:opacity-100 [@media(hover:none)]:opacity-100 data-[state=open]:opacity-100";

const SCOPE: Record<RevealScope, string> = {
  grouprow: "group-hover/grouprow:opacity-100 group-has-[:focus-visible]/grouprow:opacity-100",
  noterow: "group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100",
  folderrow: "group-hover/folderrow:opacity-100 group-has-[:focus-visible]/folderrow:opacity-100",
  avatarcell: "group-hover/avatarcell:opacity-100 group-has-[:focus-visible]/avatarcell:opacity-100",
  tabheader: "group-hover/tabheader:opacity-100 group-has-[:focus-visible]/tabheader:opacity-100",
};

export function hoverReveal(scope: RevealScope): string {
  return `${BASE} ${SCOPE[scope]}`;
}

const REVEAL_ONLY = {
  noterow:
    "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/noterow:opacity-100 group-has-[:focus-visible]/noterow:opacity-100 [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden",
} as const;

/** Note row ⋮ (mouse): in the flex flow, order title, ⋮, star (the star keeps the rightmost slot; without a star ⋮ is). Hidden = width 0 (`-ms-1` cancels one extra gap), taking no space, but still tabbable (not `display: none`; `focus-visible` or revealing grows it to 24px, so the title truncates earlier instead of being covered). Touch / `hover: none` (⋮ always visible) uses 24px (`!` overrides width 0). Playwright can't hover or click a zero-width button when the pointer isn't over the row: tests hover the row first. */
export const NOTE_MENU_COLLAPSE =
  "pointer-fine:w-0 pointer-fine:-ms-1 pointer-fine:overflow-hidden pointer-fine:group-hover/noterow:w-6 pointer-fine:group-hover/noterow:ms-0 pointer-fine:group-has-[:focus-visible]/noterow:w-6 pointer-fine:group-has-[:focus-visible]/noterow:ms-0 pointer-fine:focus-visible:w-6 pointer-fine:focus-visible:ms-0 pointer-fine:data-[state=open]:w-6 pointer-fine:data-[state=open]:ms-0 [@media(hover:none)]:w-6! [@media(hover:none)]:ms-0!";

/** The filled star is hidden on touch too: adding and removing favorites both go through ⋮. */
export const NOTE_STAR_TOUCH_HIDDEN = "[@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden";

export function hoverRevealOnly(scope: keyof typeof REVEAL_ONLY): string {
  return REVEAL_ONLY[scope];
}
