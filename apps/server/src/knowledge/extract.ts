/**
 * Turns a note's document into the rows of the knowledge index. The document is client-controlled: Yjs attributes can be arrays, numbers or objects
 * (`RegExp.test` would stringify an array like `["k_0123abcd"]` and let it through), so every value is type-checked before it can reach a CHECK constraint.
 * A value the database refuses would keep the whole note out of the index for good, so nothing here may produce one, and extraction never throws.
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import {
  BLOCK_ANCHOR_RE,
  KNOWLEDGE_CONCLUSION_MAX,
  KNOWLEDGE_ICON_KINDS,
  KNOWLEDGE_ID_RE,
  KNOWLEDGE_INDEX_HEADING_MAX,
  KNOWLEDGE_INDEX_NOTE_MAX,
  KNOWLEDGE_WHEN_MAX,
  YDOC_FRAGMENT,
  isKnowledgeDate,
  listKnowledgeInFragment,
  parseKnowledgeRef,
  summarizeAllKnowledgeDescendants,
  type KnowledgeEntry,
  type KnowledgeEvidence,
  type KnowledgeIconKind,
  type KnowledgeStatus,
} from "@knotebook/shared";

export const KNOWLEDGE_EXTRACTOR_VERSION = 1;

export interface KnowledgeIndexRow {
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
  supersededNoteId: string | null;
  supersededKnowledgeId: string | null;
  descTotal: number;
  descVerified: number;
  descNoDate: number;
  descNeedsReview: number;
  descOutdated: number;
}

export interface KnowledgeIndexExtract {
  rows: KnowledgeIndexRow[];
  contentHash: string;
  capped: boolean;
  extractorVersion: number;
}

/** `capped` is hashed: identical rows with different `capped` are reachable (2000 -> 2001 headings), and a hash-only compare would leave it stale. */
export function knowledgeContentHash(version: number, rows: readonly KnowledgeIndexRow[], capped: boolean): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        version,
        capped,
        rows.map((r) => [
          r.knowledgeId, r.blockId, r.ord, r.level, r.heading, r.when, r.conclusion, r.evidence, r.verified, r.status, r.icon,
          r.parentKnowledgeId, r.supersededNoteId, r.supersededKnowledgeId, r.descTotal, r.descVerified, r.descNoDate, r.descNeedsReview, r.descOutdated,
        ]),
      ]),
    )
    .digest("hex");
}

function finish(rows: KnowledgeIndexRow[], capped: boolean): KnowledgeIndexExtract {
  return { rows, capped, contentHash: knowledgeContentHash(KNOWLEDGE_EXTRACTOR_VERSION, rows, capped), extractorVersion: KNOWLEDGE_EXTRACTOR_VERSION };
}

export const EMPTY_KNOWLEDGE_EXTRACT: KnowledgeIndexExtract = Object.freeze(finish([], false)) as KnowledgeIndexExtract;

// `knowledgeId` is the attribute without which no heading counts as knowledge, so a document whose bytes lack it cannot hold any. Plain substring: Yjs writes attribute keys as UTF-8.
const KNOWLEDGE_ID_KEY = Buffer.from("knowledgeId", "utf8");
export function bytesMayHoldKnowledgeEntries(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(KNOWLEDGE_ID_KEY);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Cut before cleaning so a 260,000-character heading is not scanned in full. 2 UTF-16 units per code point is the worst case.
function cut(text: string, maxCodePoints: number): string {
  const head = text.length > maxCodePoints * 2 ? text.slice(0, maxCodePoints * 2) : text;
  let count = 0;
  let end = 0;
  while (end < head.length && count < maxCodePoints) {
    const c = head.charCodeAt(end);
    end += c >= 0xd800 && c <= 0xdbff && end + 1 < head.length && head.charCodeAt(end + 1) >= 0xdc00 && head.charCodeAt(end + 1) <= 0xdfff ? 2 : 1;
    count += 1;
  }
  return head.slice(0, end);
}

// NUL cannot be stored in text, and a lone surrogate cannot be encoded as UTF-8.
const UNSTORABLE = /\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const clean = (text: string, max: number): string => cut(text, max).replace(UNSTORABLE, "�");

function extractEntries(entries: readonly KnowledgeEntry[]): KnowledgeIndexExtract {
  const kept: KnowledgeEntry[] = [];
  const seen = new Set<string>();
  let capped = false;
  for (const e of entries) {
    const id: unknown = e.info.id;
    const blockId: unknown = e.blockId;
    const level = Number(e.level);
    if (typeof id !== "string" || !KNOWLEDGE_ID_RE.test(id)) continue;
    if (typeof blockId !== "string" || !BLOCK_ANCHOR_RE.test(blockId)) continue;
    if (!Number.isInteger(level) || level < 1 || level > 6) continue;
    if (!(KNOWLEDGE_ICON_KINDS as readonly unknown[]).includes(e.icon) || seen.has(id)) continue;
    if (kept.length === KNOWLEDGE_INDEX_NOTE_MAX) {
      capped = true;
      break;
    }
    seen.add(id);
    kept.push(e);
  }
  const summaries = summarizeAllKnowledgeDescendants(kept);
  const idOfBlock = new Map<string, string>();
  const rows: KnowledgeIndexRow[] = [];
  for (const e of kept) {
    let parentKnowledgeId: string | null = null;
    for (let i = e.ancestorBlockIds.length - 1; i >= 0; i -= 1) {
      const found = idOfBlock.get(e.ancestorBlockIds[i]!);
      if (found !== undefined) {
        parentKnowledgeId = found;
        break;
      }
    }
    idOfBlock.set(e.blockId, e.info.id);
    const verified = str(e.info.verified);
    const ref = parseKnowledgeRef(str(e.info.supersededBy));
    const s = summaries.get(e.blockId);
    rows.push({
      knowledgeId: e.info.id,
      blockId: e.blockId,
      ord: rows.length,
      level: Number(e.level),
      heading: clean(str(e.heading), KNOWLEDGE_INDEX_HEADING_MAX),
      when: clean(str(e.info.when), KNOWLEDGE_WHEN_MAX),
      conclusion: clean(str(e.info.conclusion), KNOWLEDGE_CONCLUSION_MAX),
      evidence: e.info.evidence,
      verified: isKnowledgeDate(verified) ? verified : null,
      status: e.info.status,
      icon: e.icon,
      parentKnowledgeId,
      // A note id equal to this note's own is stored as is: the index doesn't know the note's id, and queries treat NULL and the note itself as the same note.
      supersededNoteId: ref?.noteId ?? null,
      supersededKnowledgeId: ref?.knowledgeId ?? null,
      descTotal: s?.total ?? 0,
      descVerified: s?.verified ?? 0,
      descNoDate: s?.noVerifiedDate ?? 0,
      descNeedsReview: s?.needsReview ?? 0,
      descOutdated: s?.outdated ?? 0,
    });
  }
  return finish(rows, capped);
}

/** Never throws: any failure returns no rows and `capped`, the same shape the search extractor gives a document it cannot read. */
export function extractKnowledgeIndex(fragment: Y.XmlFragment): KnowledgeIndexExtract {
  try {
    return extractEntries(listKnowledgeInFragment(fragment));
  } catch {
    return finish([], true);
  }
}

/** `bytes`, when the caller already has the encoded document, lets a note without any knowledge attribute skip the document walk. */
export function extractKnowledgeForIndex(doc: Y.Doc, bytes?: Uint8Array): KnowledgeIndexExtract {
  try {
    if (bytes !== undefined && !bytesMayHoldKnowledgeEntries(bytes)) return EMPTY_KNOWLEDGE_EXTRACT;
    return extractKnowledgeIndex(doc.getXmlFragment(YDOC_FRAGMENT));
  } catch {
    return finish([], true);
  }
}
