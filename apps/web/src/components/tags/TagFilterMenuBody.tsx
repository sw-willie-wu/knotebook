import { useTranslation } from "react-i18next";
import { TagDot } from "@/components/tags/TagDot";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, useMenuSheet } from "@/components/ui/dropdown-menu";
import { Users } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { TagFilterMenuBodyProps } from "./TagFilterMenu";

// The primitive's check indicator is the first span; it is restyled into a visible box that fills when checked.
const CHECKBOX_BOX =
  "gap-2 [&>span:first-child]:rounded-[3px] [&>span:first-child]:border [&>span:first-child]:border-muted-foreground/60 [&>span:first-child_svg]:size-3 " +
  "data-[state=checked]:[&>span:first-child]:border-brand data-[state=checked]:[&>span:first-child]:bg-brand data-[state=checked]:[&>span:first-child]:text-brand-fg";

export function TagFilterMenuBody({ groups, selected, onChange, title, footnote, activeGroupId }: TagFilterMenuBodyProps) {
  const { t } = useTranslation();
  const sheet = useMenuSheet();
  const choose = (tagId: string) => onChange(selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId]);
  return (
    <>
      {!sheet && <DropdownMenuLabel className="truncate text-xs font-medium text-muted-foreground">{title}</DropdownMenuLabel>}
      {groups.map((group) => {
        const dimmed = activeGroupId != null && group.id !== activeGroupId;
        return (
          <div key={group.id ?? "personal"} role="group" aria-label={group.label ?? undefined} className={cn(dimmed && "opacity-50")}>
            {group.label !== null && (
              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Users aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{group.label}</span>
              </DropdownMenuLabel>
            )}
            {group.tags.map((tag) => (
              <DropdownMenuCheckboxItem
                key={tag.id}
                checked={selected.includes(tag.id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => choose(tag.id)}
                className={CHECKBOX_BOX}
              >
                <TagDot color={tag.color} />
                <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tag.count}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        );
      })}
      <DropdownMenuSeparator />
      <div className="px-2 pb-1 pt-1 text-xs text-muted-foreground">{footnote}</div>
      {sheet && (
        <div className="sticky bottom-0 -mb-2 mt-1 flex justify-end gap-2 border-t border-border bg-popover pb-2 pt-2">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onChange([]);
            }}
            className="justify-center border border-input px-5"
          >
            {t("tags.filter.clearShort")}
          </DropdownMenuItem>
          <DropdownMenuItem className="justify-center bg-brand px-5 text-brand-fg focus:bg-brand/90 focus:text-brand-fg">
            {t("tags.filter.done")}
          </DropdownMenuItem>
        </div>
      )}
    </>
  );
}
