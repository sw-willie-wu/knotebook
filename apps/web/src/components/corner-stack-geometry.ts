/** Matches CornerStack `bottom-[18px]` and `h-12` (18 + 48). The outline bottom must stop above it. */
export const CORNER_STACK_FOOTPRINT_PX = 66;
/** Matches CornerStack `right-[calc(18px+gutter)]` and `w-12`. */
export const CORNER_STACK_RIGHT_INSET_PX = 18;
export const CORNER_STACK_SIZE_PX = 48;
/** Matches CornerStack `gap-3`. */
export const CORNER_STACK_GAP_PX = 12;

export function cornerStackFootprint(bubbles: number): number {
  return bubbles <= 0 ? 0 : CORNER_STACK_FOOTPRINT_PX + (bubbles - 1) * (CORNER_STACK_SIZE_PX + CORNER_STACK_GAP_PX);
}
