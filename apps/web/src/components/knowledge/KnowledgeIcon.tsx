import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeEntry, KnowledgeIconKind } from "@knotebook/shared";
import { CircleAlert, CircleCheck, CircleInfo, CircleSlash } from "@/components/ui/icons-extra";
import { cn } from "@/lib/utils";

const COLOR: Record<KnowledgeIconKind, string> = {
  verified: "text-emerald-600 dark:text-emerald-400",
  noVerifiedDate: "text-muted-foreground",
  needsReview: "text-amber-600 dark:text-amber-400",
  outdated: "text-destructive",
};

// Fixed values rather than `color-mix`: the fill is what tells the kinds apart while the icon is faded, and it must not depend on browser support.
const FILL: Partial<Record<KnowledgeIconKind, string>> = {
  needsReview: "bg-[#fff3d6] dark:bg-[#4a3410]",
  outdated: "bg-[#fbdede] dark:bg-[#4a1e1e]",
};

const SYMBOL: Record<KnowledgeIconKind, typeof CircleCheck> = {
  verified: CircleCheck,
  noVerifiedDate: CircleInfo,
  needsReview: CircleAlert,
  outdated: CircleSlash,
};

/** Display-only glyph for rows that are already a link: not focusable, hidden from assistive technology. */
export function KnowledgeGlyph({ kind, className }: { kind: KnowledgeIconKind; className?: string }): ReactNode {
  const Mark = SYMBOL[kind];
  return (
    <span aria-hidden="true" className={cn("inline-flex h-4 w-4 shrink-0", COLOR[kind], className)}>
      <Mark className="h-4 w-4" strokeWidth={2.25} />
    </span>
  );
}

export function KnowledgeIconButton({
  entry,
  top,
  left,
  expanded,
  onClick,
  className,
  style,
  ...rest
}: { entry: KnowledgeEntry; top: number; left: number; expanded: boolean; onClick: (el: HTMLButtonElement) => void } & Omit<ComponentProps<"button">, "onClick">): ReactNode {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      {...rest}
      data-kb-knowledge-icon=""
      data-kind={entry.icon}
      data-block-id={entry.blockId}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={t("knowledge.iconLabel", { status: t(`knowledge.state.${entry.icon}`) })}
      className={cn(
        "absolute z-10 inline-flex h-4 w-4 items-center justify-center rounded-full opacity-50 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']",
        COLOR[entry.icon],
        FILL[entry.icon],
        className,
      )}
      style={{ ...style, top, left }}
      onClick={(e) => onClick(e.currentTarget)}
    >
      <KnowledgeGlyph kind={entry.icon} />
    </button>
  );
}
