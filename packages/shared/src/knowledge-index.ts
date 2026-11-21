import type { KnowledgeEvidence, KnowledgeStatus } from "./knowledge.js";
import type { KnowledgeChildSummary, KnowledgeIconKind } from "./knowledge-list.js";
import type { NoteTagDto } from "./tags.js";

export const KNOWLEDGE_INDEX_MAX = 5000;
export const KNOWLEDGE_INDEX_NOTE_MAX = 2000;
export const KNOWLEDGE_INDEX_HEADING_MAX = 200;
export const KNOWLEDGE_INDEX_TAG_FILTER_MAX = 20;
export const KNOWLEDGE_REFS_LIMIT = 20;

export const KNOWLEDGE_ICON_KINDS = ["outdated", "needsReview", "noVerifiedDate", "verified"] as const satisfies readonly KnowledgeIconKind[];

export const KNOWLEDGE_INDEX_STATUS_FILTERS = ["noVerifiedDate", "needsReview", "outdated"] as const;
export type KnowledgeIndexStatusFilter = (typeof KNOWLEDGE_INDEX_STATUS_FILTERS)[number];
export const KNOWLEDGE_INDEX_EVIDENCE_FILTERS = ["tested", "docs", "inferred", "unconfirmed"] as const;
export type KnowledgeIndexEvidenceFilter = (typeof KNOWLEDGE_INDEX_EVIDENCE_FILTERS)[number];

export function isKnowledgeIndexStatusFilter(v: unknown): v is KnowledgeIndexStatusFilter {
  return typeof v === "string" && (KNOWLEDGE_INDEX_STATUS_FILTERS as readonly string[]).includes(v);
}
export function isKnowledgeIndexEvidenceFilter(v: unknown): v is KnowledgeIndexEvidenceFilter {
  return typeof v === "string" && (KNOWLEDGE_INDEX_EVIDENCE_FILTERS as readonly string[]).includes(v);
}

// Must match the sidebar's folder collation so the index lists folders in the order the tree shows them.
export const INDEX_COLLATOR_LOCALE = "zh-Hant";
export const INDEX_COLLATOR_OPTIONS = { numeric: true, sensitivity: "base" } as const;
const COLLATOR = new Intl.Collator(INDEX_COLLATOR_LOCALE, INDEX_COLLATOR_OPTIONS);

export type KnowledgeIndexScopeRef = { kind: "personal" } | { kind: "group"; groupId: string } | { kind: "folder"; folderId: string };

export interface KnowledgeIndexScopeDto {
  kind: "personal" | "group" | "folder";
  groupId: string | null;
  groupName: string | null;
  folderId: string | null;
  /** Space root to this folder; empty for a space. */
  folderPath: string[];
}
export interface KnowledgeIndexFolderDto { id: string; name: string; parentId: string | null }
export interface KnowledgeIndexNoteDto { id: string; title: string; path: string; folderId: string | null; tags: NoteTagDto[]; capped: boolean }
export interface KnowledgeIndexEntryDto {
  noteId: string;
  knowledgeId: string;
  blockId: string;
  ord: number;
  level: number;
  heading: string;
  when: string;
  conclusion: string;
  evidence: KnowledgeEvidence;
  verified: string | null;
  status: KnowledgeStatus;
  icon: KnowledgeIconKind;
  parentKnowledgeId: string | null;
  /** Always `formatKnowledgeRef({ noteId, knowledgeId }, null)`, i.e. "<noteId>#k_…". */
  supersededBy: string | null;
  /** Null when total is 0. */
  summary: KnowledgeChildSummary | null;
}
export interface KnowledgeIndexReplacementDto { noteId: string; knowledgeId: string; blockId: string; heading: string; noteTitle: string; path: string }
export interface KnowledgeIndexDto {
  scope: KnowledgeIndexScopeDto;
  folders: KnowledgeIndexFolderDto[];
  notes: KnowledgeIndexNoteDto[];
  entries: KnowledgeIndexEntryDto[];
  /** Key = the entry's `supersededBy`. */
  replacements: Record<string, KnowledgeIndexReplacementDto>;
  /** Tags on scope notes that have knowledge, ignoring filters; sorted by name case-insensitively. */
  tagOptions: NoteTagDto[];
  truncated: boolean;
  backfillPending: boolean;
}
export interface KnowledgeRefCandidateDto { noteId: string; noteTitle: string; path: string; knowledgeId: string; blockId: string; heading: string; conclusion: string }
export interface KnowledgeRefsDto { candidates: KnowledgeRefCandidateDto[] }

interface OrderNote { id: string; title: string; folderId: string | null }

function byTitleThenId(a: OrderNote, b: OrderNote): number {
  return COLLATOR.compare(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Note ids in the folder-grouping display order: the root section first (rootFolderId's own notes, or for a space the notes
 * with no folder or a folder not in `folders`), then each folder of `folders` depth-first with siblings by name then id,
 * and within a folder by title then id. Notes that no walk reaches (outside the subtree, or inside a parent cycle) come last.
 * Iterative; cycles in `folders` are cut.
 */
export function orderIndexNotes(input: {
  notes: readonly OrderNote[];
  folders: readonly KnowledgeIndexFolderDto[];
  rootFolderId: string | null;
}): string[] {
  const { notes, folders, rootFolderId } = input;
  const known = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, KnowledgeIndexFolderDto[]>();
  for (const f of folders) {
    const parent = f.parentId !== null && known.has(f.parentId) ? f.parentId : null;
    const list = children.get(parent);
    if (list) list.push(f);
    else children.set(parent, [f]);
  }
  const sortFolders = (list: KnowledgeIndexFolderDto[]): KnowledgeIndexFolderDto[] =>
    list.sort((a, b) => COLLATOR.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byFolder = new Map<string | null, OrderNote[]>();
  for (const n of notes) {
    const key = rootFolderId === null && (n.folderId === null || !known.has(n.folderId)) ? null : n.folderId;
    const list = byFolder.get(key);
    if (list) list.push(n);
    else byFolder.set(key, [n]);
  }

  const out: string[] = [];
  const emitted = new Set<string>();
  const emit = (folderKey: string | null): void => {
    const list = byFolder.get(folderKey);
    if (!list) return;
    list.sort(byTitleThenId);
    for (const n of list) {
      if (emitted.has(n.id)) continue;
      emitted.add(n.id);
      out.push(n.id);
    }
  };

  emit(rootFolderId);
  const visited = new Set<string>();
  // Stack of folders; pushed in reverse so the first sibling pops first.
  const stack: KnowledgeIndexFolderDto[] = [];
  const pushChildren = (parent: string | null): void => {
    const kids = sortFolders([...(children.get(parent) ?? [])]);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]!);
  };
  pushChildren(rootFolderId);
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (visited.has(f.id)) continue;
    visited.add(f.id);
    emit(f.id);
    pushChildren(f.id);
  }

  const rest = notes.filter((n) => !emitted.has(n.id)).sort(byTitleThenId);
  for (const n of rest) out.push(n.id);
  return out;
}
