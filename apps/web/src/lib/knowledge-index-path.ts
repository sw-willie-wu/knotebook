import { matchPath } from "react-router";
import type { KnowledgeIndexScopeRef } from "@knotebook/shared";

export const KNOWLEDGE_INDEX_ROUTE_PATTERNS = ["/knowledge/me", "/knowledge/g/:groupId", "/knowledge/f/:folderId"] as const;

export function knowledgeIndexPath(scope: KnowledgeIndexScopeRef): string {
  if (scope.kind === "personal") return "/knowledge/me";
  if (scope.kind === "group") return `/knowledge/g/${encodeURIComponent(scope.groupId)}`;
  return `/knowledge/f/${encodeURIComponent(scope.folderId)}`;
}

export function isKnowledgeIndexPath(pathname: string): boolean {
  return KNOWLEDGE_INDEX_ROUTE_PATTERNS.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
}

export function knowledgeIndexScopeKey(scope: KnowledgeIndexScopeRef): string {
  if (scope.kind === "personal") return "me";
  return scope.kind === "group" ? `g:${scope.groupId}` : `f:${scope.folderId}`;
}
