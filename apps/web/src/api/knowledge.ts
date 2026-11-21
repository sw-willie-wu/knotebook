import { useMemo } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  KnowledgeIndexDto,
  KnowledgeIndexEvidenceFilter,
  KnowledgeIndexScopeRef,
  KnowledgeIndexStatusFilter,
} from "@knotebook/shared";
import { knowledgeIndexScopeKey } from "@/lib/knowledge-index-path";
import { ApiFail, api } from "./client";

export interface IndexFilters {
  groupBy: "folder" | "tag";
  tagIds: string[];
  status: KnowledgeIndexStatusFilter | null;
  evidence: KnowledgeIndexEvidenceFilter | null;
}

export interface IndexQueryFilters {
  readonly tagIds: readonly string[];
  readonly status: IndexFilters["status"];
  readonly evidence: IndexFilters["evidence"];
}

export const KNOWLEDGE_INDEX_QUERY_ROOT = "knowledge-index";
const BACKFILL_POLL_MS = 10_000;

/** Grouping is not part of the key: it only reorders what one response already holds. */
export function knowledgeIndexKey(scope: KnowledgeIndexScopeRef, filters: IndexQueryFilters): readonly unknown[] {
  return [KNOWLEDGE_INDEX_QUERY_ROOT, knowledgeIndexScopeKey(scope), { tags: filters.tagIds, status: filters.status, evidence: filters.evidence }];
}

export function knowledgeIndexApiPath(scope: KnowledgeIndexScopeRef, filters: IndexQueryFilters): string {
  const base =
    scope.kind === "personal"
      ? "/api/knowledge/index/me"
      : scope.kind === "group"
        ? `/api/knowledge/index/groups/${encodeURIComponent(scope.groupId)}`
        : `/api/knowledge/index/folders/${encodeURIComponent(scope.folderId)}`;
  const query = new URLSearchParams();
  if (filters.tagIds.length > 0) query.set("tags", filters.tagIds.join(","));
  if (filters.status !== null) query.set("status", filters.status);
  if (filters.evidence !== null) query.set("evidence", filters.evidence);
  const qs = query.toString();
  return qs === "" ? base : `${base}?${qs}`;
}

export function useKnowledgeIndex(scope: KnowledgeIndexScopeRef, filters: IndexQueryFilters): UseQueryResult<KnowledgeIndexDto> {
  const scopeKey = knowledgeIndexScopeKey(scope);
  const queryClient = useQueryClient();
  // A 4xx (not found, no access) will not change on its own, so it is not retried; everything else follows the client default.
  const retry = useMemo(() => {
    const base = queryClient.getDefaultOptions().queries?.retry ?? 3;
    return (failureCount: number, error: Error) => {
      if (error instanceof ApiFail && error.status >= 400 && error.status < 500) return false;
      if (typeof base === "function") return base(failureCount, error);
      return typeof base === "number" ? failureCount < base : base;
    };
  }, [queryClient]);
  return useQuery({
    retry,
    queryKey: knowledgeIndexKey(scope, filters),
    queryFn: ({ signal }) => api<KnowledgeIndexDto>(knowledgeIndexApiPath(scope, filters), { signal }),
    // Only a change of filters keeps the old list on screen; another space's data must never stand in for this one.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === scopeKey ? previous : undefined),
    refetchInterval: (query) => (query.state.data?.backfillPending === true ? BACKFILL_POLL_MS : false),
  });
}
