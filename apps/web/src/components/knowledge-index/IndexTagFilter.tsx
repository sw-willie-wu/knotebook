import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { TagDot } from "@/components/tags/TagDot";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown } from "@/components/ui/icons";
import { chipClass } from "./chip-class";

export function IndexTagFilter({
  tagOptions,
  selected,
  onChange,
}: {
  tagOptions: readonly NoteTagDto[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}): ReactNode {
  const { t } = useTranslation();
  const label = selected.length > 0 ? t("knowledgeIndex.filter.tagsActive", { count: selected.length }) : t("knowledgeIndex.filter.tags");
  return (
    <DropdownMenu phoneSheet>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass(selected.length > 0)}>
          <span>{label}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-48 overflow-y-auto">
        {tagOptions.map((tag) => (
          <DropdownMenuCheckboxItem
            key={tag.id}
            checked={selected.includes(tag.id)}
            // Keeps the menu open so several tags can be ticked in one visit.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onChange(selected.includes(tag.id) ? selected.filter((id) => id !== tag.id) : [...selected, tag.id])}
            className="gap-2"
          >
            <TagDot color={tag.color} />
            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
