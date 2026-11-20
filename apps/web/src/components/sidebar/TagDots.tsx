import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { cn } from "@/lib/utils";
import { TagDot } from "@/components/tags/TagDot";

const MAX_DOTS = 3;

/** Marker only, not a control: it sits left of the star and ⋮ and takes no clicks. */
export function TagDots({ tags, className }: { tags: readonly NoteTagDto[]; className?: string }) {
  const { t } = useTranslation();
  if (tags.length === 0) return null;
  const label = t("tags.dots", { names: tags.map((tag) => tag.name).join(t("tags.separator")) });
  return (
    <span role="img" aria-label={label} title={label} data-tag-dots="" className={cn("flex shrink-0 items-center gap-[3px] pl-1.5", className)}>
      {tags.slice(0, MAX_DOTS).map((tag) => (
        <TagDot key={tag.id} color={tag.color} />
      ))}
    </span>
  );
}
