import { useRef, useState, type MutableRefObject, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { TagDot } from "@/components/tags/TagDot";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useMenuSheet,
} from "@/components/ui/dropdown-menu";
import { ROW_ICON_HIT } from "@/components/ui/hit-area";
import { Filter, Users } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// The primitive's check indicator is the first span; it is restyled into a visible box that fills when checked.
const CHECKBOX_BOX =
  "gap-2 [&>span:first-child]:rounded-[3px] [&>span:first-child]:border [&>span:first-child]:border-muted-foreground/60 [&>span:first-child_svg]:size-3 " +
  "data-[state=checked]:[&>span:first-child]:border-brand data-[state=checked]:[&>span:first-child]:bg-brand data-[state=checked]:[&>span:first-child]:text-brand-fg";

export interface TagFilterGroup {
  /** Group name; null for the personal space. */
  label: string | null;
  tags: Array<NoteTagDto & { count: number }>;
  /** Compared with `activeGroupId` to tell which section a tag belongs to. */
  id?: string;
}

interface TagFilterMenuProps {
  groups: TagFilterGroup[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  title: string;
  footnote: string;
  /** The group the current selection belongs to; rows of other groups are dimmed (the caller decides that choosing one replaces the selection). */
  activeGroupId?: string | null;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLButtonElement>;
}

function MenuBody({ groups, selected, onChange, title, footnote, activeGroupId }: Omit<TagFilterMenuProps, "triggerClassName" | "triggerRef">) {
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

/** Brings its own trigger button: the sidebar's `HeaderActionButton` doesn't forward a ref, so it can't sit under `DropdownMenuTrigger asChild`. */
export function TagFilterMenu({ triggerClassName, triggerRef, ...body }: TagFilterMenuProps) {
  const { t } = useTranslation();
  // The funnel isn't the rightmost button of its row, so a menu aligned to it would end short of the row's right edge; shift it to line up with the row.
  const [alignOffset, setAlignOffset] = useState(0);
  const measure = (trigger: HTMLElement | null) => {
    const row = trigger?.parentElement;
    if (trigger == null || row == null) return;
    const rowStyle = getComputedStyle(row);
    const rowRight = row.getBoundingClientRect().right - parseFloat(rowStyle.paddingRight || "0");
    setAlignOffset(Math.max(0, Math.round(rowRight - trigger.getBoundingClientRect().right)));
  };
  const innerRef = useRef<HTMLButtonElement | null>(null);
  const setRefs = (node: HTMLButtonElement | null) => {
    innerRef.current = node;
    if (typeof triggerRef === "function") triggerRef(node);
    else if (triggerRef != null) (triggerRef as MutableRefObject<HTMLButtonElement | null>).current = node;
  };
  const active = body.selected.length;
  const label = active > 0 ? t("tags.filter.buttonActive", { count: active }) : t("tags.filter.button");
  return (
    <DropdownMenu phoneSheet onOpenChange={(open) => open && measure(innerRef.current)}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={setRefs}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          data-tag-filter-trigger=""
          className={cn("h-6 shrink-0", ROW_ICON_HIT, active > 0 ? "w-auto min-w-6 gap-0.5 bg-brand-soft px-1 text-brand-on-soft" : "w-6", triggerClassName)}
        >
          <Filter aria-hidden="true" className="h-3.5 w-3.5" />
          {active > 0 && (
            <span aria-hidden="true" className="text-[11px] font-medium tabular-nums">
              {active}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" alignOffset={-alignOffset} collisionPadding={8} sheetTitle={body.title} className="max-h-[min(24rem,70vh)] w-60 overflow-y-auto">
        <MenuBody {...body} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
