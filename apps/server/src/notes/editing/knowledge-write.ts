import * as Y from "yjs";
import {
  KNOWLEDGE_PENDING_ID_PREFIX,
  YDOC_FRAGMENT,
  knowledgeIdRenewals,
  listKnowledgeInFragment,
  readKnowledgeInfo,
  topLevelBlocks,
  type KnowledgeHeadingRef,
  type KnowledgeInfo,
  type KnowledgeProblem,
} from "@knotebook/shared";

export interface KnowledgeRenewal extends KnowledgeHeadingRef {
  from: string;
}

export interface KnowledgeWriteReport {
  kept: KnowledgeHeadingRef[];
  created: KnowledgeHeadingRef[];
  removed: KnowledgeHeadingRef[];
  renewed: KnowledgeRenewal[];
  ignoredComments: number;
}

/** What a write worked out itself; `ignoredComments` is counted when the markdown is parsed. */
export type KnowledgeEditReport = Omit<KnowledgeWriteReport, "ignoredComments">;

/** Thrown inside `withForkEditor`'s callback so that nothing is written. */
export class KnowledgeWriteError extends Error {
  override name = "KnowledgeWriteError";
  constructor(readonly problem: KnowledgeProblem) {
    super(`knowledge write rejected: ${problem.problem}`);
  }
}

export const emptyKnowledgeReport = (): KnowledgeWriteReport => ({ kept: [], created: [], removed: [], renewed: [], ignoredComments: 0 });

export function isEmptyKnowledgeReport(r: KnowledgeWriteReport): boolean {
  return r.kept.length === 0 && r.created.length === 0 && r.removed.length === 0 && r.renewed.length === 0 && r.ignoredComments === 0;
}

export function mergeKnowledgeReports(rs: readonly KnowledgeWriteReport[]): KnowledgeWriteReport {
  const out = emptyKnowledgeReport();
  for (const r of rs) {
    out.kept.push(...r.kept);
    out.created.push(...r.created);
    out.removed.push(...r.removed);
    out.renewed.push(...r.renewed);
    out.ignoredComments += r.ignoredComments;
  }
  return out;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

interface TopHeading {
  blockId: string;
  heading: Y.XmlElement;
}

// Collab state is untrusted, so a container without a string id is skipped like in `listKnowledgeInFragment`.
function topLevelHeadings(fragment: Y.XmlFragment): TopHeading[] {
  const out: TopHeading[] = [];
  for (const container of topLevelBlocks(fragment)) {
    const blockId = container.getAttribute("id");
    if (typeof blockId !== "string" || container.nodeName !== "blockContainer") continue;
    const first = container.get(0);
    if (first instanceof Y.XmlElement && first.nodeName === "heading") out.push({ blockId, heading: first });
  }
  return out;
}

export function knowledgeIdsByBlock(fragment: Y.XmlFragment): Map<string, string> {
  const m = new Map<string, string>();
  for (const { blockId, heading } of topLevelHeadings(fragment)) {
    const id = str(heading.getAttribute("knowledgeId"));
    if (id !== "" && !m.has(blockId)) m.set(blockId, id);
  }
  return m;
}

/** Top-level only; where an id repeats, the first heading in document order is the one a comment of that id is compared with. */
export function knowledgeInfoById(fragment: Y.XmlFragment): Map<string, KnowledgeInfo> {
  const m = new Map<string, KnowledgeInfo>();
  for (const { heading } of topLevelHeadings(fragment)) {
    const info = readKnowledgeInfo(heading.getAttributes());
    if (info !== null && !m.has(info.id)) m.set(info.id, info);
  }
  return m;
}

/** Only headings whose (block id, knowledge id) differ from `before` are checked: a pending-looking id already stored in collab state must not block unrelated writes. */
export function assertNoPendingKnowledgeIds(fragment: Y.XmlFragment, before: ReadonlyMap<string, string>): void {
  for (const { blockId, heading } of topLevelHeadings(fragment)) {
    const id = str(heading.getAttribute("knowledgeId"));
    if (id.startsWith(KNOWLEDGE_PENDING_ID_PREFIX) && before.get(blockId) !== id) throw new Error("a pending knowledge id reached the document");
  }
}

/**
 * `before`: top-level block id -> knowledge id as it was before the write. A heading is settled only while the same block id still carries the same
 * knowledge id: a rewritten heading can get its old block id back and a different knowledge id. Only inserted headings are renewed,
 * so duplicates this write did not touch stay as they were. No editor may be mounted on `fork`: one Yjs transaction, no per-attribute editor steps.
 */
export function renewDuplicateKnowledgeIds(fork: Y.Doc, before: ReadonlyMap<string, string>): KnowledgeRenewal[] {
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const items: Array<TopHeading & { knowledgeId: string; inserted: boolean }> = [];
  for (const h of topLevelHeadings(fragment)) {
    const knowledgeId = str(h.heading.getAttribute("knowledgeId"));
    if (knowledgeId !== "") items.push({ ...h, knowledgeId, inserted: before.get(h.blockId) !== knowledgeId });
  }
  if (items.length < 2) return [];
  if (!items.some(i => i.inserted)) return [];
  // Duplicates the note already had are left as they are; only a heading this write added or changed gets a new id.
  const renewals = knowledgeIdRenewals(items).filter(r => items[r.index]!.inserted);
  if (renewals.length === 0) return [];
  fork.transact(() => {
    for (const r of renewals) items[r.index]!.heading.setAttribute("knowledgeId", r.knowledgeId);
  });
  const headings = new Map(listKnowledgeInFragment(fragment).map(e => [e.blockId, e.heading]));
  return renewals.map(r => ({ id: r.knowledgeId, heading: headings.get(r.blockId) ?? "", from: items[r.index]!.knowledgeId }));
}

/** Ids new to the whole note after a write, whether generated or written out in full; a renewed id is reported under `renewed` only. */
export function createdKnowledge(fragment: Y.XmlFragment, before: ReadonlyMap<string, string>, renewed: readonly KnowledgeRenewal[]): KnowledgeHeadingRef[] {
  const had = new Set(before.values());
  const renewedIds = new Set(renewed.map(x => x.id));
  const headings = new Map(listKnowledgeInFragment(fragment).map(e => [e.blockId, e.heading]));
  const out: KnowledgeHeadingRef[] = [];
  for (const [blockId, id] of knowledgeIdsByBlock(fragment)) if (!had.has(id) && !renewedIds.has(id)) out.push({ id, heading: headings.get(blockId) ?? "" });
  return out;
}
