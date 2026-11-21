import { matchPath } from "react-router";
import type { KnowledgeIndexScopeRef } from "@knotebook/shared";

// Kept apart from lib/knowledge-index-path: only the lazy index page needs it, and a shared module would pull it into the entry chunk.
/** `params` come from the matched route (already decoded); `pathname` tells which of the three patterns matched. */
export function knowledgeIndexScopeFromParams(
  pathname: string,
  params: Readonly<Record<string, string | undefined>>,
): KnowledgeIndexScopeRef | null {
  if (matchPath({ path: "/knowledge/me", end: true }, pathname) !== null) return { kind: "personal" };
  if (matchPath({ path: "/knowledge/g/:groupId", end: true }, pathname) !== null) {
    return params.groupId ? { kind: "group", groupId: params.groupId } : null;
  }
  if (matchPath({ path: "/knowledge/f/:folderId", end: true }, pathname) !== null) {
    return params.folderId ? { kind: "folder", folderId: params.folderId } : null;
  }
  return null;
}
