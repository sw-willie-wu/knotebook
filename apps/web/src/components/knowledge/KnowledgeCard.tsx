import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { KnowledgeChildSummary, KnowledgeEntry } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT_BORDERED } from "@/components/ui/hit-area";
import { Pencil } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export interface KnowledgeReplacementView {
  state: "found" | "otherNote" | "missing";
  title: string | null;
  open: (() => void) | null;
}

export interface KnowledgeCardProps {
  entry: KnowledgeEntry;
  parent: KnowledgeEntry | null;
  outdatedAncestor: KnowledgeEntry | null;
  summary: KnowledgeChildSummary | null;
  replacement: KnowledgeReplacementView | null;
  variant: "hover" | "sheet";
  canEdit: boolean;
  onEdit: () => void;
  onJump: (blockId: string) => void;
  footer?: ReactNode;
}

const LINK_CLASS = "rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Banner({ tone, children }: { tone: "amber" | "red"; children: ReactNode }) {
  return (
    <div
      data-kb-knowledge-banner={tone}
      className={cn(
        "mt-2 rounded-md px-2 py-1 text-xs",
        tone === "amber" ? "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200" : "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-200",
      )}
    >
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function Banners({ entry, outdatedAncestor, replacement, onJump }: Pick<KnowledgeCardProps, "entry" | "outdatedAncestor" | "replacement" | "onJump">) {
  const { t } = useTranslation();
  const untitled = t("knowledge.card.untitled");
  // The title never goes through the translation string: Trans would parse any markup a heading contains.
  // `<link>` would be parsed as a void HTML element, so the placeholder is `<ref/>`.
  const link = (title: string, action: (() => void) | null) => {
    const text = t("knowledge.card.quotedTitle", { title });
    return action ? (
      <button type="button" className={LINK_CLASS} onClick={action}>
        {text}
      </button>
    ) : (
      <span className="font-medium">{text}</span>
    );
  };

  if (entry.info.status === "outdated") {
    if (!replacement) return <Banner tone="red">{t("knowledge.state.outdated")}</Banner>;
    const title =
      replacement.state === "missing" ? t("knowledge.card.refMissing")
      : replacement.state === "otherNote" && !replacement.title ? t("knowledge.card.refOtherNote")
      : (replacement.title ?? untitled);
    const action = replacement.state === "missing" ? null : replacement.open;
    return (
      <Banner tone="red">
        <Trans i18nKey="knowledge.card.bannerOutdated" components={{ ref: link(title, action) }} />
      </Banner>
    );
  }
  if (outdatedAncestor) {
    return (
      <Banner tone="red">
        <Trans
          i18nKey="knowledge.card.bannerInheritedOutdated"
          components={{ ref: link(outdatedAncestor.heading || untitled, () => onJump(outdatedAncestor.blockId)) }}
        />
      </Banner>
    );
  }
  if (entry.info.status === "unverified") {
    return (
      <Banner tone="amber">
        {entry.info.verified !== ""
          ? t("knowledge.card.bannerNeedsReview", { date: entry.info.verified })
          : t("knowledge.card.bannerNeedsReviewNoDate")}
      </Banner>
    );
  }
  return null;
}

export function KnowledgeCard({ entry, parent, outdatedAncestor, summary, replacement, variant, canEdit, onEdit, onJump, footer }: KnowledgeCardProps): ReactNode {
  const { t } = useTranslation();
  const sheet = variant === "sheet";
  const empty = t("knowledge.card.empty");
  const { info } = entry;
  const divider = sheet ? null : <div role="presentation" className="col-span-2 my-1 border-t border-dashed border-border" />;
  const topRow = !sheet && (parent || canEdit);
  return (
    <div data-kb-knowledge-card={variant} className={cn("text-left text-popover-foreground", sheet ? "text-sm" : "text-[13px] leading-snug")}>
      {topRow && (
        <div className="mb-1.5 flex items-center gap-2">
          {parent && (
            <button type="button" className={cn(LINK_CLASS, "min-w-0 truncate text-left text-xs font-normal text-muted-foreground")} onClick={() => onJump(parent.blockId)}>
              {t("knowledge.card.belongsTo", { title: parent.heading || t("knowledge.card.untitled") })}
            </button>
          )}
          <span className="flex-1" />
          {canEdit && (
            <Button type="button" variant="outline" size="sm" className={cn("h-6 gap-1 px-2", ROW_ICON_HIT_BORDERED)} onClick={onEdit}>
              <Pencil className="h-3 w-3" />
              {t("knowledge.card.edit")}
            </Button>
          )}
        </div>
      )}
      {sheet && parent && (
        <button type="button" className={cn(LINK_CLASS, "mb-1 block max-w-full truncate text-left text-xs font-normal text-muted-foreground")} onClick={() => onJump(parent.blockId)}>
          {t("knowledge.card.belongsTo", { title: parent.heading || t("knowledge.card.untitled") })}
        </button>
      )}
      <Banners entry={entry} outdatedAncestor={outdatedAncestor} replacement={replacement} onJump={onJump} />
      <dl className={cn("m-0 mt-2 grid gap-x-2 gap-y-0.5", sheet ? "grid-cols-[5.25rem_1fr]" : "grid-cols-[4.875rem_1fr]")}>
        <Field label={t("knowledge.field.when")}>{info.when || empty}</Field>
        <Field label={t("knowledge.field.conclusion")}>{info.conclusion || empty}</Field>
        {divider}
        <Field label={t("knowledge.field.evidence")}>{info.evidence === "" ? t("knowledge.evidence.unconfirmed") : t(`knowledge.evidence.${info.evidence}`)}</Field>
        {divider}
        <Field label={t("knowledge.field.verified")}>{info.verified === "" ? t("knowledge.card.notVerified") : info.verified}</Field>
      </dl>
      {summary && (
        <p className="m-0 mt-2 border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
          {t("knowledge.card.summary", { total: summary.total, verified: summary.verified, noDate: summary.noVerifiedDate, review: summary.needsReview })}
          {summary.outdated > 0 ? t("knowledge.card.summaryOutdated", { outdated: summary.outdated }) : ""}
        </p>
      )}
      {sheet && (canEdit || footer) && (
        <div className="mt-3 flex gap-2.5">
          {footer}
          {canEdit && (
            <Button type="button" variant="brandDeep" className="h-11 flex-1 text-[15px]" onClick={onEdit}>
              <Pencil className="h-4 w-4" />
              {t("knowledge.card.edit")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
