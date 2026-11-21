import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { cn } from "@/lib/utils";
import { TagDot } from "@/components/tags/TagDot";

const MAX_DOTS = 3;

// Each dot is cut by a 1px ring around the dot drawn over it, so the gap shows whatever the row's background is.
const CUT = "[mask-image:radial-gradient(circle_at_calc(100%+2.5px)_50%,transparent_4.5px,#000_5px)]";

/** Marker only, not a control: a row puts it last, in a fixed-width slot, so its right edge is the same on every tagged row; it takes no clicks. */
export function TagDots({ tags, className }: { tags: readonly NoteTagDto[]; className?: string }) {
  const { t } = useTranslation();
  if (tags.length === 0) return null;
  const label = t("tags.dots", { names: tags.map((tag) => tag.name).join(t("tags.separator")) });
  const shown = tags.slice(0, MAX_DOTS);
  return (
    <span role="img" aria-label={label} title={label} data-tag-dots="" className={cn("flex shrink-0 items-center pl-1.5", className)}>
      {shown.map((tag, index) => (
        <TagDot key={tag.id} color={tag.color} className={cn(index > 0 && "-ml-[1px]", index < shown.length - 1 && CUT)} />
      ))}
    </span>
  );
}
