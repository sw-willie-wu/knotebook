/**
 * Touch (`pointer: coarse`) hit areas: the visual size is unchanged and `::after` extends an invisible hit area; mouse is unaffected.
 * `ROW_ICON_HIT`: 24px sidebar row icon buttons, 10px each side = 44×44; carries a `row-icon` marker class that `ROW_ICON_ROW` recognises.
 * `ROW_ICON_ROW`: goes on the row container holding them. On touch the row gap is 4px and a button directly followed by another `row-icon` gets 16px more on its right (24+4+16 = 44 centre distance), so hit areas don't overlap (except next to a bordered `ROW_ICON_HIT_BORDERED`).
 * The spacing sits on the earlier button, so a `display: none` one (e.g. the favorite star hidden on touch) doesn't push the next one apart.
 * `HEADER_ICON_HIT`: 32px note-header icon buttons, 4px left/right and 6px top/bottom = 40×44; the 8px header gap gives 40 centre distance, just no overlap.
 *
 * Every class must be a complete literal (Tailwind scans source statically); `relative` anchors the absolutely positioned `::after`.
 * Tests can only assert class strings; the real 44px must be measured in a browser. An ancestor with `overflow` clipping makes the overshoot unclickable.
 */
export const ROW_ICON_HIT =
  "row-icon relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']";

/** Bordered variant (24px `variant="outline"` buttons): `::after` positions from inside the border, so 11px per side compensates the 1px border for a total of 44. Next to "Select all" the two hit areas overlap by 1px. */
export const ROW_ICON_HIT_BORDERED =
  "row-icon relative pointer-coarse:after:absolute pointer-coarse:after:-inset-[11px] pointer-coarse:after:content-['']";

export const ROW_ICON_ROW = "pointer-coarse:gap-1 pointer-coarse:[&>.row-icon:has(+.row-icon)]:me-4";

/** 28px icon buttons (the sidebar bell): 8px each side = 44×44. The bell sits 12px from the gear, so the 8px extension never reaches it. */
export const ICON_28_HIT = "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']";

export const HEADER_ICON_HIT =
  "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:content-['']";

/** For a 24px icon button inside an input (search clear ✕). The button is already `absolute` (the anchor), so no `relative`, or the two position classes override each other. With the button 4px from the right and 24px wide, plus 10px on each side (44×44), the hit area's left edge is 38px from the input's right edge, so on touch the input needs right padding ≥ 41px (`pointer-coarse:pr-10` = 40px + 1px border) to keep text out of it. */
export const FIELD_ICON_HIT = "pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 pointer-coarse:after:content-['']";
