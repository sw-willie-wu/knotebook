import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { KnowledgeIconKind } from "@knotebook/shared";
import { KnowledgeGlyph } from "@/components/knowledge/KnowledgeIcon";
import { cn } from "@/lib/utils";
import type { IndexReplacement, IndexRowModel } from "./sections";

// Literal classes (Tailwind scans statically) and fixed colours instead of colour-mix, so the tints hold in every browser.
const FLAG: Partial<Record<KnowledgeIconKind, string>> = {
  needsReview: "border-[#ecd49a] bg-[#fffaf0] dark:border-[#6b5420] dark:bg-[#2b2210]",
  outdated: "border-[#ddd] bg-[#f6f6f6] opacity-60 dark:border-[#444] dark:bg-[#262626]",
};
const CHIP: Partial<Record<KnowledgeIconKind, string>> = {
  needsReview: "border-[#e8c36a] bg-[#fff3d6] text-[#8a5a00] dark:border-[#8a6a1c] dark:bg-[#4a3410] dark:text-[#f0c36a]",
  outdated: "border-[#ccc] bg-[#eee] text-[#666] line-through dark:border-[#555] dark:bg-[#333] dark:text-[#aaa]",
};

export const blockHref = (path: string, blockId: string): string => `${path}#b-${blockId}`;

function Summary({ row }: { row: IndexRowModel }): ReactNode {
  const { t } = useTranslation();
  const summary = row.entry.summary;
  if (summary === null) return null;
  return (
    <span className="mt-0.5 block text-xs text-muted-foreground">
      {t("knowledge.card.summary", { total: summary.total, verified: summary.verified, noDate: summary.noVerifiedDate, review: summary.needsReview })}
      {summary.outdated > 0 && t("knowledge.card.summaryOutdated", { outdated: summary.outdated })}
    </span>
  );
}

function ReplacedBy({ replacement }: { replacement: IndexReplacement }): ReactNode {
  const { t } = useTranslation();
  if (replacement.state === "found") {
    const { target } = replacement;
    const title = target.heading || target.noteTitle || t("knowledge.card.untitled");
    return (
      <Link
        to={blockHref(target.path, target.blockId)}
        className="relative z-10 mt-0.5 inline-block rounded-sm text-xs text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("knowledgeIndex.row.replacedBy", { title })}
      </Link>
    );
  }
  const title = t(replacement.state === "otherNote" ? "knowledge.card.refOtherNote" : "knowledge.card.refMissing");
  return <span className="relative mt-0.5 block text-xs text-muted-foreground">{t("knowledgeIndex.row.replacedBy", { title })}</span>;
}

export function IndexRow({ row }: { row: IndexRowModel }): ReactNode {
  const { t } = useTranslation();
  const { entry, note } = row;
  const hasWhen = entry.when !== "";
  const hasConclusion = entry.conclusion !== "";
  const heading = entry.heading || t("knowledge.card.untitled");
  const state = t(`knowledge.state.${entry.icon}`);
  return (
    <li>
      <div
        data-kb-index-row=""
        data-kind={entry.icon}
        className={cn("relative rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px] leading-[1.45]", FLAG[entry.icon])}
      >
        <Link
          to={blockHref(note.path, entry.blockId)}
          className="block rounded-lg after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="flex items-start gap-2">
            <span role="img" aria-label={t("knowledge.iconLabel", { status: state })} className="mt-[3px] inline-flex shrink-0">
              <KnowledgeGlyph kind={entry.icon} />
            </span>
            <span className="min-w-0 flex-1">
              {CHIP[entry.icon] !== undefined && (
                <span
                  aria-hidden="true"
                  className={cn("mr-1.5 inline-block rounded-full border px-1.5 align-[1px] text-[11px] leading-4", CHIP[entry.icon])}
                >
                  {state}
                </span>
              )}
              {hasWhen && <span className="text-muted-foreground">{entry.when}</span>}
              {hasWhen && hasConclusion && <span className="mx-1 text-muted-foreground/70">→</span>}
              {hasConclusion && <span>{entry.conclusion}</span>}
              {!hasWhen && !hasConclusion && <span>{heading}</span>}
              <span className="mt-0.5 block text-xs text-brand underline underline-offset-2">
                {t("knowledgeIndex.row.location", { note: note.title || t("note.titlePlaceholder"), heading })}
              </span>
              <Summary row={row} />
            </span>
          </span>
        </Link>
        {row.replacement !== null && (
          <div className="pl-6">
            <ReplacedBy replacement={row.replacement} />
          </div>
        )}
      </div>
      {row.nested.length > 0 && (
        <ul className="ml-6 mt-[5px] space-y-[5px] border-l border-border pl-2">
          {row.nested.map((child) => (
            <IndexRow key={child.entry.knowledgeId} row={child} />
          ))}
        </ul>
      )}
    </li>
  );
}
