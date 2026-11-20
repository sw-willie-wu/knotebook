import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import { X } from "@/components/ui/icons";

// Literal classes: Tailwind scans statically. Touch always shows the ×; with a mouse it appears on pill hover or keyboard focus.
// Touch: an invisible ::after widens the 16px button to a 24px target without changing how it looks.
const REMOVE_HIT = "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-1 pointer-coarse:after:content-['']";
const REMOVE_REVEAL =
  "pointer-fine:opacity-0 pointer-fine:group-hover/tagpill:opacity-100 pointer-fine:focus-visible:opacity-100 pointer-fine:group-has-[:focus-visible]/tagpill:opacity-100";

export function TagPill({ tag, onRemove, removeDisabled }: { tag: NoteTagDto; onRemove?: () => void; removeDisabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      data-tag-color={tag.color}
      className="group/tagpill inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full bg-[var(--tag-bg)] px-2 text-xs text-[var(--tag-fg)]"
    >
      <span className="truncate" title={tag.name}>{tag.name}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          disabled={removeDisabled}
          aria-label={t("tags.remove", { name: tag.name })}
          onClick={onRemove}
          className={`${REMOVE_HIT} -me-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-50 ${REMOVE_REVEAL}`}
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      )}
    </span>
  );
}
