import { lazy, useRef, useState, type MutableRefObject, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ROW_ICON_HIT } from "@/components/ui/hit-area";
import { Filter } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface TagFilterGroup {
  /** Group name; null for the personal space. */
  label: string | null;
  tags: Array<NoteTagDto & { count: number }>;
  /** Compared with `activeGroupId` to tell which section a tag belongs to. */
  id?: string;
}

export interface TagFilterMenuBodyProps {
  groups: TagFilterGroup[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  title: string;
  footnote: string;
  /** The group the current selection belongs to; rows of other groups are dimmed (the caller decides that choosing one replaces the selection). */
  activeGroupId?: string | null;
}

interface TagFilterMenuProps extends TagFilterMenuBodyProps {
  triggerClassName?: string;
  triggerRef?: Ref<HTMLButtonElement>;
}

// Lazy-only entry (initial-bundle cap): the trigger stays in the entry, the list loads when the menu first opens.
const loadBody = () => import("./TagFilterMenuBody").then((m) => ({ default: m.TagFilterMenuBody }));
const TagFilterMenuBody = lazy(loadBody);

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
          // Start the download before the menu opens so the items are usually there when focus lands; a keyboard open would otherwise leave focus on the container.
          onPointerDown={() => void loadBody()}
          onKeyDown={() => void loadBody()}
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
        <SidebarLazyBoundary chunk="tagFilter" fallback={null} errorClassName="p-2 text-xs">
          <TagFilterMenuBody {...body} />
        </SidebarLazyBoundary>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
