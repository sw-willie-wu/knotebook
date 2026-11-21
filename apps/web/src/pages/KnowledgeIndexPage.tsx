import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "react-router";
import { KNOWLEDGE_INDEX_MAX, type KnowledgeIndexDto, type KnowledgeIndexScopeRef } from "@knotebook/shared";
import { useKnowledgeIndex, type IndexFilters } from "@/api/knowledge";
import { ApiFail } from "@/api/client";
import { SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";
import { EmptyState } from "@/components/EmptyState";
import { IndexSection } from "@/components/knowledge-index/IndexSection";
import { buildIndexSections } from "@/components/knowledge-index/sections";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import "@/i18n/knowledge-strings";
import "@/i18n/knowledge-index-strings";
import { knowledgeIndexScopeFromParams, knowledgeIndexScopeKey } from "@/lib/knowledge-index-path";
import { cn } from "@/lib/utils";

const DEFAULT_FILTERS: IndexFilters = { groupBy: "folder", tagIds: [], status: null, evidence: null };

export function IndexBody({
  dto,
  filtersActive,
  groupBy,
  scopeTitle,
  filterBar,
}: {
  dto: KnowledgeIndexDto;
  filtersActive: boolean;
  groupBy: IndexFilters["groupBy"];
  scopeTitle: string;
  filterBar?: ReactNode;
}): ReactNode {
  const { t } = useTranslation();
  const untaggedTitle = t("knowledgeIndex.untagged");
  const sections = useMemo(() => buildIndexSections({ dto, groupBy, scopeTitle, untaggedTitle }), [dto, groupBy, scopeTitle, untaggedTitle]);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t("knowledgeIndex.readOnly")} {t("knowledgeIndex.total", { count: dto.entries.length })}
      </p>
      {filterBar}
      {dto.backfillPending && (
        <p role="status" className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("knowledgeIndex.backfillNotice")}
        </p>
      )}
      {dto.truncated && (
        <p role="status" className="mt-3 rounded-lg border border-[#ecd49a] bg-[#fffaf0] px-3 py-2 text-xs text-[#8a5a00] dark:border-[#6b5420] dark:bg-[#2b2210] dark:text-[#f0c36a]">
          {t("knowledgeIndex.truncated", { max: KNOWLEDGE_INDEX_MAX })}
        </p>
      )}
      {dto.entries.length === 0 ? (
        filtersActive ? (
          <EmptyState title={t("knowledgeIndex.noMatch")} />
        ) : (
          <EmptyState title={t("knowledgeIndex.empty.title")} description={t("knowledgeIndex.empty.description")} />
        )
      ) : (
        <div className="mt-4">
          {sections.map((section) => (
            <IndexSection key={section.key} section={section} />
          ))}
        </div>
      )}
    </>
  );
}

function scopeNames(scope: KnowledgeIndexScopeRef, dto: KnowledgeIndexDto | undefined, myNotes: string): { title: string; path: string | null } {
  if (scope.kind === "personal") return { title: myNotes, path: null };
  if (!dto) return { title: "", path: null };
  const space = dto.scope.groupName ?? myNotes;
  if (scope.kind === "group") return { title: space, path: null };
  const title = dto.scope.folderPath[dto.scope.folderPath.length - 1] ?? "";
  return { title, path: [space, ...dto.scope.folderPath].join(" / ") };
}

function IndexView({ scope }: { scope: KnowledgeIndexScopeRef }): ReactNode {
  const { t } = useTranslation();
  const [filters] = useState<IndexFilters>(DEFAULT_FILTERS);
  const query = useKnowledgeIndex(scope, filters);
  const dto = query.data;
  const names = scopeNames(scope, dto, t("sidebar.myNotes"));
  const filtersActive = filters.tagIds.length > 0 || filters.status !== null || filters.evidence !== null;
  const notFound = query.error instanceof ApiFail && query.error.status === 404;

  let body: ReactNode;
  if (dto) {
    body = <IndexBody dto={dto} filtersActive={filtersActive} groupBy={filters.groupBy} scopeTitle={names.title} />;
  } else if (notFound) {
    body = <EmptyState title={t("knowledgeIndex.notFound.title")} description={t("knowledgeIndex.notFound.description")} />;
  } else if (query.isError) {
    const err = query.error;
    body = (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback")}
        </p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>
          {t("app.retry")}
        </Button>
      </div>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  }

  return (
    <div className={cn(cardSurface, "min-w-0 flex-1 overflow-y-auto max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]")}>
      <header className="flex items-center gap-3 border-b border-border px-5 py-3 max-sm:sticky max-sm:top-0 max-sm:z-30 max-sm:gap-2 max-sm:bg-card max-sm:px-3 max-sm:pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <BackToListButton />
        <SidebarDrawerButton />
        <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
          {!notFound && names.title !== "" && (
            <h1 className="truncate text-base font-semibold">{t("knowledgeIndex.title", { name: names.title })}</h1>
          )}
          {names.path !== null && <p className="truncate text-xs text-muted-foreground">{names.path}</p>}
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-6 py-4 max-sm:px-4">{body}</div>
    </div>
  );
}

export default function KnowledgeIndexPage(): ReactNode {
  const location = useLocation();
  const params = useParams();
  const scope = knowledgeIndexScopeFromParams(location.pathname, params);
  if (scope === null) return null;
  return <IndexView key={knowledgeIndexScopeKey(scope)} scope={scope} />;
}
