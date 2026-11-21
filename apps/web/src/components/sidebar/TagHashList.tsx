import { useTranslation } from "react-i18next";
import { autoUpdate, flip, offset, size, useFloating, type Placement } from "@floating-ui/react";
import "@/i18n/tags-strings";
import { TagDot } from "@/components/tags/TagDot";
import { Users } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { FilterSpaceRef } from "./search-tags";
import type { HashOptionSection } from "./search-tags-logic";

export interface TagHashListProps {
  sections: readonly HashOptionSection[];
  activeIndex: number;
  listId: string;
  optionId: (index: number) => string;
  reference: HTMLElement | null;
  placement: Placement;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}

/**
 * Draws the list; part of the lazy completion chunk (initial-bundle cap).
 * Not portalled and every part swallows mousedown: a portal or a mousedown default would blur the input, which closes the list.
 */
export function TagHashList({ sections, activeIndex, listId, optionId, reference, placement, onPick, onHover }: TagHashListProps) {
  const { t } = useTranslation();
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement,
    strategy: "fixed",
    elements: { reference },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.width = `${rects.reference.width}px`;
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(360, availableHeight))}px`;
        },
      }),
    ],
  });
  let index = -1;
  const anyDimmed = sections.some((section) => section.tags.some((tag) => tag.dimmed));
  const swallow = (event: { preventDefault: () => void }) => event.preventDefault();
  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      onMouseDown={swallow}
      className="z-50 flex flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      <div id={listId} role="listbox" aria-label={t("tagSearch.listLabel")} className="min-h-0 flex-1 overflow-y-auto p-1">
        {sections.map((section) => {
          const headingId = `${listId}-space-${sectionKey(section.space)}`;
          return (
            <div key={sectionKey(section.space)} role="group" aria-labelledby={headingId}>
              <p id={headingId} role="presentation" className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">
                {section.space.kind === "group" && <Users aria-hidden="true" className="size-3 shrink-0" />}
                <span className="truncate">{section.space.kind === "group" ? section.space.groupName : t("sidebar.myNotes")}</span>
              </p>
              {section.tags.map((tag) => {
                index += 1;
                const here = index;
                return (
                  <div
                    key={tag.id}
                    id={optionId(here)}
                    role="option"
                    aria-label={`${tag.name} ${t("tagSearch.noteCount", { count: tag.count })}`}
                    aria-selected={here === activeIndex}
                    onClick={() => onPick(here)}
                    onMouseMove={() => onHover(here)}
                    className={cn(
                      "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm pointer-coarse:py-2.5",
                      tag.dimmed && "opacity-50",
                      here === activeIndex && "bg-accent text-accent-foreground",
                    )}
                  >
                    <TagDot color={tag.color} />
                    <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                    <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {tag.count}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground pointer-coarse:hidden">{t("tagSearch.keysHint")}</p>
      {anyDimmed && <p className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{t("tagSearch.replacesHint")}</p>}
    </div>
  );
}

function sectionKey(space: FilterSpaceRef): string {
  return space.kind === "personal" ? "personal" : space.groupId;
}
