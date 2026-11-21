import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { X } from "@/components/ui/icons";
import { tagColorStyle } from "./tag-color-style";

// Literal classes: Tailwind scans statically. With a mouse the × appears on pill hover or keyboard focus; with a menu, touch has no × (the menu holds the removal).
// Touch: an invisible ::after widens the 16px badge to a 24px target without changing how it looks.
const REMOVE_HIT = "pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']";
const REMOVE_REVEAL =
  "pointer-fine:opacity-0 pointer-fine:group-hover/tagpill:opacity-100 pointer-fine:focus-visible:opacity-100 pointer-fine:group-has-[:focus-visible]/tagpill:opacity-100";
const LABEL_BUTTON = "min-w-0 cursor-pointer truncate rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface TagPillProps {
  tag: NoteTagDto;
  onRemove?: () => void;
  removeDisabled?: boolean;
  /** Makes the name a button and lets the caller turn it into a menu trigger; the × then stays for mouse users only. */
  wrapLabel?: (label: ReactElement) => ReactElement;
}

export function TagPill({ tag, onRemove, removeDisabled, wrapLabel }: TagPillProps) {
  const { t } = useTranslation();
  const name = (
    <span className="truncate" title={tag.name}>
      {tag.name}
    </span>
  );
  return (
    <span
      data-tag-color={tag.color}
      style={tagColorStyle(tag.color)}
      className="group/tagpill relative inline-flex h-5 min-w-0 max-w-full items-center rounded-full bg-[var(--tag-bg)] px-2 text-xs text-[var(--tag-fg)]"
    >
      {wrapLabel === undefined ? (
        name
      ) : (
        wrapLabel(
          <button type="button" aria-label={t("tagPillMenu.open", { name: tag.name })} className={LABEL_BUTTON}>
            {name}
          </button>,
        )
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          disabled={removeDisabled}
          aria-label={t("tags.remove", { name: tag.name })}
          onClick={onRemove}
          className={`${REMOVE_HIT} absolute -right-2 -top-1.5 z-10 inline-flex size-4 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-popover-foreground shadow-sm transition-opacity hover:bg-accent disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${REMOVE_REVEAL}${wrapLabel === undefined ? "" : " pointer-coarse:hidden"}`}
        >
          <X aria-hidden="true" className="size-2.5" />
        </button>
      )}
    </span>
  );
}
