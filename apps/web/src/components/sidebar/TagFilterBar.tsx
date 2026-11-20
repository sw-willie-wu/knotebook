import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { TagDot } from "@/components/tags/TagDot";
import { X } from "@/components/ui/icons";

interface TagFilterBarProps {
  /** Group name on the Groups tab; null for My notes. */
  groupLabel: string | null;
  tags: readonly NoteTagDto[];
  count: number;
  onRemove: (tagId: string) => void;
  onClear: () => void;
}

export function TagFilterBar({ groupLabel, tags, count, onRemove, onClear }: TagFilterBarProps) {
  const { t } = useTranslation();
  return (
    <div data-tag-filter-bar="" className="flex items-center gap-1.5 pl-4 pr-2.75 pb-1.5 text-xs">
      {groupLabel !== null && <span className="max-w-24 shrink-0 truncate font-medium text-muted-foreground">{groupLabel}</span>}
      <ul className="flex min-w-0 flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <li key={tag.id} className="inline-flex h-5 max-w-full items-center gap-1 rounded-full bg-brand-soft pl-2 pr-0.5 text-brand-on-soft">
            <TagDot color={tag.color} />
            <span className="truncate">{tag.name}</span>
            <button
              type="button"
              aria-label={t("tags.filter.removeOne", { name: tag.name })}
              onClick={() => onRemove(tag.id)}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-brand-soft-strong"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onClear} className="shrink-0 text-brand hover:underline">
        {t("tags.filter.clearShort")}
      </button>
      <span className="ms-auto shrink-0 text-muted-foreground" data-tag-filter-count="">
        {t("tags.filter.count", { count })}
      </span>
    </div>
  );
}
