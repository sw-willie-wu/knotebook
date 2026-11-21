import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  KNOWLEDGE_INDEX_EVIDENCE_FILTERS,
  KNOWLEDGE_INDEX_STATUS_FILTERS,
  type KnowledgeIndexEvidenceFilter,
  type KnowledgeIndexStatusFilter,
  type NoteTagDto,
} from "@knotebook/shared";
import type { IndexFilters } from "@/api/knowledge";
import { Select, type SelectOption } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { IndexTagFilter } from "./IndexTagFilter";

const GROUPS = ["folder", "tag"] as const;

function GroupBy({ value, onChange }: { value: IndexFilters["groupBy"]; onChange: (next: IndexFilters["groupBy"]) => void }): ReactNode {
  const { t } = useTranslation();
  const move = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const next = value === "folder" ? "tag" : "folder";
    onChange(next);
    const group = event.currentTarget.parentElement;
    queueMicrotask(() => group?.querySelector<HTMLButtonElement>(`[data-group="${next}"]`)?.focus());
  };
  return (
    <div className="inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden="true" className="text-muted-foreground">
        {t("knowledgeIndex.groupBy.label")}
      </span>
      <span role="radiogroup" aria-label={t("knowledgeIndex.groupBy.label")} className="inline-flex rounded-full border border-input bg-background p-0.5">
        {GROUPS.map((group) => (
          <button
            key={group}
            type="button"
            role="radio"
            aria-checked={value === group}
            data-group={group}
            tabIndex={value === group ? 0 : -1}
            onClick={() => onChange(group)}
            onKeyDown={move}
            className={cn(
              "h-6 rounded-full px-2.5 outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-8",
              value === group ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`knowledgeIndex.groupBy.${group}`)}
          </button>
        ))}
      </span>
    </div>
  );
}

function ValueSelect<V extends string>({
  name,
  value,
  values,
  labelOf,
  onChange,
}: {
  name: string;
  value: V | null;
  values: readonly V[];
  labelOf: (v: V) => string;
  onChange: (next: V | null) => void;
}): ReactNode {
  const { t } = useTranslation();
  const labelled = (text: string): string => t("knowledgeIndex.filter.labelled", { name, value: text });
  const options: SelectOption[] = [
    { value: "", label: labelled(t("knowledgeIndex.filter.all")) },
    ...values.map((v) => ({ value: v, label: labelled(labelOf(v)) })),
  ];
  return (
    <Select
      variant="field"
      aria-label={name}
      value={value ?? ""}
      onValueChange={(next) => onChange(next === "" ? null : (next as V))}
      options={options}
      className={cn("h-7 w-fit rounded-full px-2.5 text-xs pointer-coarse:h-9 pointer-coarse:text-xs", value !== null && "border-brand/60 bg-accent")}
    />
  );
}

export function IndexFilterBar({
  filters,
  tagOptions,
  onChange,
}: {
  filters: IndexFilters;
  tagOptions: readonly NoteTagDto[];
  onChange: (next: IndexFilters) => void;
}): ReactNode {
  const { t } = useTranslation();
  const hasTags = tagOptions.length > 0;
  const active = filters.tagIds.length > 0 || filters.status !== null || filters.evidence !== null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {hasTags && <GroupBy value={filters.groupBy} onChange={(groupBy) => onChange({ ...filters, groupBy })} />}
      <div className="flex flex-wrap items-center gap-1.5">
        {hasTags && <IndexTagFilter tagOptions={tagOptions} selected={filters.tagIds} onChange={(tagIds) => onChange({ ...filters, tagIds })} />}
        <ValueSelect<KnowledgeIndexStatusFilter>
          name={t("knowledgeIndex.filter.status")}
          value={filters.status}
          values={KNOWLEDGE_INDEX_STATUS_FILTERS}
          labelOf={(v) => t(`knowledge.state.${v}`)}
          onChange={(status) => onChange({ ...filters, status })}
        />
        <ValueSelect<KnowledgeIndexEvidenceFilter>
          name={t("knowledgeIndex.filter.evidence")}
          value={filters.evidence}
          values={KNOWLEDGE_INDEX_EVIDENCE_FILTERS}
          labelOf={(v) => t(`knowledge.evidence.${v}`)}
          onChange={(evidence) => onChange({ ...filters, evidence })}
        />
        {active && (
          <button
            type="button"
            onClick={() => onChange({ ...filters, tagIds: [], status: null, evidence: null })}
            className="h-7 rounded-full px-2 text-xs text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-9"
          >
            {t("knowledgeIndex.filter.clear")}
          </button>
        )}
      </div>
    </div>
  );
}
