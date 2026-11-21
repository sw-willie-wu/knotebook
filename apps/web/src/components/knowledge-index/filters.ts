import {
  KNOWLEDGE_INDEX_TAG_FILTER_MAX,
  UUID_RE,
  isKnowledgeIndexEvidenceFilter,
  isKnowledgeIndexStatusFilter,
} from "@knotebook/shared";
import type { IndexFilters } from "@/api/knowledge";

/** Anything the address bar holds that isn't a known value reads as "not set": a shared or stale link never errors. */
export function readIndexFilters(params: URLSearchParams): IndexFilters {
  const tagIds: string[] = [];
  for (const raw of (params.get("tags") ?? "").split(",")) {
    const id = raw.toLowerCase();
    if (UUID_RE.test(id) && !tagIds.includes(id)) tagIds.push(id);
    if (tagIds.length === KNOWLEDGE_INDEX_TAG_FILTER_MAX) break;
  }
  const status = params.get("status");
  const evidence = params.get("evidence");
  return {
    groupBy: params.get("group") === "tag" ? "tag" : "folder",
    tagIds,
    status: isKnowledgeIndexStatusFilter(status) ? status : null,
    evidence: isKnowledgeIndexEvidenceFilter(evidence) ? evidence : null,
  };
}

export function writeIndexFilters(filters: IndexFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.groupBy === "tag") params.set("group", "tag");
  if (filters.tagIds.length > 0) params.set("tags", filters.tagIds.join(","));
  if (filters.status !== null) params.set("status", filters.status);
  if (filters.evidence !== null) params.set("evidence", filters.evidence);
  return params;
}
