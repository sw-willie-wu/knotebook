export const PANEL_SURFACE = "z-50 min-w-32 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md";

export const PANEL_PLACEMENT = { align: "end", sideOffset: 4, collisionPadding: 0 } as const;

/** Popper sets the anchor width var on both menu and popover content, so a menu and a popover opened from the same row always get the same width. */
export const PANEL_ROW_WIDTH = "w-[var(--radix-popper-anchor-width)]";

/** Marks the sidebar bottom row that panels take their width from (the bell sits inside it, outside the menu trigger). */
export const SIDEBAR_PANEL_ANCHOR_ATTR = "data-sidebar-panel-anchor";
