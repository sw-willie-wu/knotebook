import * as Y from "yjs";
import { readKnowledgeInfo, type KnowledgeInfo } from "./knowledge.js";
import { topLevelBlocks } from "./note-sections.js";

export type KnowledgeIconKind = "outdated" | "needsReview" | "noVerifiedDate" | "verified";

export interface KnowledgeTopLevelItem {
  blockId: string;
  heading: { level: number; text: string; props: Readonly<Record<string, unknown>> } | null;
}

export interface KnowledgeEntry {
  blockId: string;
  level: number;
  heading: string;
  info: KnowledgeInfo;
  parentBlockId: string | null;
  /** Knowledge ancestors, outermost first. */
  ancestorBlockIds: readonly string[];
  /** Top-level ids from this heading up to (not including) the next heading with level <= this one. */
  rangeBlockIds: readonly string[];
  /** Self or any ancestor has status "outdated". */
  outdated: boolean;
  icon: KnowledgeIconKind;
}

export interface KnowledgeChildSummary {
  total: number;
  verified: number;
  noVerifiedDate: number;
  needsReview: number;
  outdated: number;
}

function iconOf(info: KnowledgeInfo, outdated: boolean): KnowledgeIconKind {
  if (outdated) return "outdated";
  if (info.status === "unverified") return "needsReview";
  if (info.verified === "") return "noVerifiedDate";
  return "verified";
}

export function listKnowledge(items: readonly KnowledgeTopLevelItem[]): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  // Open ranges, levels strictly increasing; `start` indexes into `items`.
  const open: Array<{ entry: KnowledgeEntry & { rangeBlockIds: string[] }; start: number }> = [];
  const close = (end: number): void => {
    const top = open.pop()!;
    top.entry.rangeBlockIds = items.slice(top.start, end).map((i) => i.blockId);
  };
  items.forEach((item, index) => {
    const h = item.heading;
    if (h) {
      // Any heading, knowledge or not, ends the ranges of the same or lower level.
      while (open.length > 0 && open[open.length - 1]!.entry.level >= h.level) close(index);
      const info = readKnowledgeInfo(h.props);
      if (info) {
        const parent = open.length > 0 ? open[open.length - 1]!.entry : null;
        const outdated = info.status === "outdated" || (parent?.outdated ?? false);
        const entry: KnowledgeEntry & { rangeBlockIds: string[] } = {
          blockId: item.blockId,
          level: h.level,
          heading: h.text,
          info,
          parentBlockId: parent ? parent.blockId : null,
          ancestorBlockIds: open.map((o) => o.entry.blockId),
          rangeBlockIds: [],
          outdated,
          icon: iconOf(info, outdated),
        };
        entries.push(entry);
        open.push({ entry, start: index });
      }
    }
  });
  while (open.length > 0) close(items.length);
  return entries;
}

// Only the levels the editor can produce: an unbounded level would let a crafted note nest ranges as deep as it has headings.
function levelOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 1;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wikilinkText(props: unknown): string {
  if (typeof props !== "object" || props === null) return "";
  const p = props as Record<string, unknown>;
  const label = typeof p.label === "string" ? p.label : "";
  if (label !== "") return label;
  return typeof p.snapshotTitle === "string" ? p.snapshotTitle : "";
}

// Iterative: inline content nesting is client-controlled. Children are pushed in reverse so pops come out in document order.
export function knowledgeHeadingText(content: unknown): string {
  if (typeof content === "string") return collapse(content);
  let out = "";
  const stack: unknown[] = [content];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const n = node as { type?: unknown; text?: unknown; props?: unknown; content?: unknown };
    if (n.type === "text") {
      if (typeof n.text === "string") out += n.text;
    } else if (n.type === "wikilink") {
      out += wikilinkText(n.props);
    } else if (n.content !== undefined) {
      stack.push(n.content);
    }
  }
  return collapse(out);
}

export interface KnowledgeBlockLike {
  id: string;
  type: string;
  props?: Readonly<Record<string, unknown>>;
  content?: unknown;
}

export function listKnowledgeInBlocks(topLevel: readonly KnowledgeBlockLike[]): KnowledgeEntry[] {
  return listKnowledge(
    topLevel.filter((b) => typeof b.id === "string").map((b) => ({
      blockId: b.id,
      heading: b.type === "heading"
        ? { level: levelOf(b.props?.level), text: knowledgeHeadingText(b.content), props: b.props ?? {} }
        : null,
    })),
  );
}

function yjsHeadingText(heading: Y.XmlElement): string {
  let out = "";
  const stack: Array<Y.XmlElement | Y.XmlText> = [];
  const pushChildren = (el: Y.XmlElement): void => {
    const kids = el.toArray();
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const c = kids[i];
      if (c instanceof Y.XmlText || c instanceof Y.XmlElement) stack.push(c);
    }
  };
  pushChildren(heading);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n instanceof Y.XmlText) {
      out += (n.toDelta() as Array<{ insert: unknown }>).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
    } else if (n.nodeName === "wikilink") {
      out += wikilinkText(n.getAttributes());
    } else if (n.nodeName.toLowerCase() === "hardbreak") {
      out += "\n";
    } else {
      pushChildren(n);
    }
  }
  return collapse(out);
}

export function listKnowledgeInFragment(fragment: Y.XmlFragment): KnowledgeEntry[] {
  return listKnowledge(
    topLevelBlocks(fragment).flatMap((container): KnowledgeTopLevelItem[] => {
      const blockId = container.getAttribute("id");
      // A block without a string id cannot be addressed, and sharing one key would merge unrelated blocks in id-keyed maps.
      if (typeof blockId !== "string") return [];
      const first = container.nodeName === "blockContainer" ? container.get(0) : null;
      if (!(first instanceof Y.XmlElement) || first.nodeName !== "heading") return [{ blockId, heading: null }];
      const props = first.getAttributes() as Record<string, unknown>;
      return [{ blockId, heading: { level: levelOf(props.level), text: yjsHeadingText(first), props } }];
    }),
  );
}

function emptySummary(): KnowledgeChildSummary {
  return { total: 0, verified: 0, noVerifiedDate: 0, needsReview: 0, outdated: 0 };
}

function addToSummary(summary: KnowledgeChildSummary, icon: KnowledgeIconKind): void {
  summary.total += 1;
  if (icon === "verified") summary.verified += 1;
  else if (icon === "noVerifiedDate") summary.noVerifiedDate += 1;
  else if (icon === "needsReview") summary.needsReview += 1;
  else summary.outdated += 1;
}

export function summarizeKnowledgeDescendants(entries: readonly KnowledgeEntry[], blockId: string): KnowledgeChildSummary | null {
  const summary = emptySummary();
  for (const entry of entries) {
    if (entry.ancestorBlockIds.includes(blockId)) addToSummary(summary, entry.icon);
  }
  return summary.total === 0 ? null : summary;
}

export function summarizeAllKnowledgeDescendants(entries: readonly KnowledgeEntry[]): ReadonlyMap<string, KnowledgeChildSummary> {
  const out = new Map<string, KnowledgeChildSummary>();
  for (const entry of entries) {
    for (const ancestor of entry.ancestorBlockIds) {
      let summary = out.get(ancestor);
      if (!summary) {
        summary = emptySummary();
        out.set(ancestor, summary);
      }
      addToSummary(summary, entry.icon);
    }
  }
  return out;
}
