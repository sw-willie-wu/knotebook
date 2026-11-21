import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KNOWLEDGE_INDEX_NOTE_MAX } from "@knotebook/shared";
import { TagPill } from "@/components/tags/TagPill";
import { IndexRow } from "./IndexRow";
import type { IndexSectionModel } from "./sections";

export function IndexSection({ section }: { section: IndexSectionModel }): ReactNode {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-5 first:mt-0">
      <h2 id={headingId} className="mb-2 flex items-baseline justify-between gap-3 border-b border-border pb-1 text-sm font-semibold">
        <span className="min-w-0 truncate">{section.tag ? <TagPill tag={section.tag} /> : section.title}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">{t("knowledgeIndex.sectionCount", { count: section.count })}</span>
      </h2>
      <ul className="space-y-[5px]">
        {section.rows.map((row) => (
          <IndexRow key={`${row.note.id}:${row.entry.knowledgeId}`} row={row} />
        ))}
      </ul>
      {section.cappedNotes.map((note) => (
        <p key={note.id} className="mt-1.5 text-xs text-muted-foreground">
          {t("knowledgeIndex.capped", { note: note.title || t("note.titlePlaceholder"), max: KNOWLEDGE_INDEX_NOTE_MAX })}
        </p>
      ))}
    </section>
  );
}
