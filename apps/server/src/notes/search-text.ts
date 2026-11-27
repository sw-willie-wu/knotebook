/**
 * Sections map to `sectionize` by position, not id lookup (ids can repeat or be non-strings). A non-string/empty container id disqualifies the whole note (`outlineOf` throws on it, so the read tools can't read it and search must not hand out unreadable sectionIds). A section is indexed only if its id matches `SECTION_ID_RE` and is the first occurrence (as `outline.find` in `read.ts`; an id counts as seen whether or not it got indexed) and its body is non-empty. The walk is iterative: depth is client-controlled. Wikilinks contribute label, else `snapshotTitle`; mermaid its `code`; math its `tex`; media caption/name/url nothing. Separators are emitted lazily so the body has no leading/trailing/repeated separators; whitespace in the text isn't collapsed. NUL and lone surrogates become U+FFFD (a NUL fails the transaction with 22021; replacing makes stored = hashed = returned text agree). Caps: body truncated at `SEARCH_INDEX_NOTE_MAX` (the section crossing it is cut to the remaining quota, later ones aren't indexed), sections beyond `SEARCH_INDEX_SECTIONS_MAX` dropped (not merged), headings keep `SEARCH_HEADING_MAX`; dropping a non-empty section sets `capped`. Any rule or limit change must bump `SEARCH_EXTRACTOR_VERSION` (backfill redoes old versions).
 */
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { SECTION_ID_RE, sectionize, topLevelBlocks } from "@knotebook/shared";
import { truncateCodeUnits } from "../mcp/limits.js";

export const SEARCH_EXTRACTOR_VERSION = 3;
export const SEARCH_INDEX_NOTE_MAX = 1_048_576;
export const SEARCH_INDEX_SECTIONS_MAX = 2000;
export const SEARCH_HEADING_MAX = 1000;

export interface SearchSectionRow {
  sectionId: string;
  ord: number;
  heading: string;
  body: string;
}

export interface SearchExtract {
  rows: SearchSectionRow[];
  contentHash: string;
  indexedUnits: number;
  capped: boolean;
  extractorVersion: number;
}

const UNSTORABLE_RE = /\0|\p{Surrogate}/gu;

/** With the `u` flag a paired surrogate is one code point and isn't matched by `\p{Surrogate}`. */
export function sanitizeForIndex(s: string): string {
  return s.replace(UNSTORABLE_RE, "�");
}

function deltaText(t: Y.XmlText): string {
  return (t.toDelta() as Array<{ insert: unknown }>).map(d => (typeof d.insert === "string" ? d.insert : "")).join("");
}

function containerSearchText(container: Y.XmlElement): string {
  let out = "";
  let pendingSep = false;
  const emit = (s: string): void => {
    if (s.length === 0) return;
    if (pendingSep && out.length > 0) out += "\n";
    pendingSep = false;
    out += s;
  };
  const stack: unknown[] = [container];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node instanceof Y.XmlText) {
      emit(deltaText(node));
      continue;
    }
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === "wikilink") {
      const label: unknown = node.getAttribute("label");
      const title: unknown = node.getAttribute("snapshotTitle");
      emit(typeof label === "string" && label !== "" ? label : typeof title === "string" ? title : "");
      continue;
    }
    pendingSep = true;
    if (node.nodeName === "mermaid" || node.nodeName === "math") {
      const source: unknown = node.getAttribute(node.nodeName === "math" ? "tex" : "code");
      if (typeof source === "string") emit(source);
      continue;
    }
    const kids = node.toArray();
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return out;
}

/** `capped` is hashed: identical rows with different `capped` are reachable (2000 → 2001 sections; empty note → empty-id container), and a hash-only compare would return `unchanged` and leave `capped` stale. */
export function searchContentHash(version: number, rows: SearchSectionRow[], capped: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify([version, capped, rows.map(r => [r.sectionId, r.ord, r.heading, r.body])]))
    .digest("hex");
}

function finish(rows: SearchSectionRow[], indexedUnits: number, capped: boolean): SearchExtract {
  return { rows, indexedUnits, capped, contentHash: searchContentHash(SEARCH_EXTRACTOR_VERSION, rows, capped), extractorVersion: SEARCH_EXTRACTOR_VERSION };
}

export function extractSearchSections(fragment: Y.XmlFragment): SearchExtract {
  const containers = topLevelBlocks(fragment);
  for (const c of containers) {
    const id: unknown = c.getAttribute("id");
    if (typeof id !== "string" || id === "") return finish([], 0, true);
  }
  const sections = sectionize(fragment);
  const rows: SearchSectionRow[] = [];
  const seen = new Set<unknown>();
  let units = 0;
  let capped = false;
  let bodyFull = false;
  let pos = 0;
  for (let k = 0; k < sections.length; k += 1) {
    const s = sections[k]!;
    const mine = containers.slice(pos, pos + s.blockIds.length);
    pos += s.blockIds.length;
    const rawId: unknown = s.sectionId;
    const first = !seen.has(rawId);
    seen.add(rawId);
    if (typeof rawId !== "string" || !SECTION_ID_RE.test(rawId) || !first) continue;
    let body = sanitizeForIndex(mine.map(containerSearchText).filter(t => t.length > 0).join("\n"));
    if (body.length === 0) continue;
    if (rows.length >= SEARCH_INDEX_SECTIONS_MAX || bodyFull) {
      capped = true;
      continue;
    }
    if (units + body.length > SEARCH_INDEX_NOTE_MAX) {
      body = truncateCodeUnits(body, SEARCH_INDEX_NOTE_MAX - units).text;
      capped = true;
      // Truncation can stop units at MAX−1 (surrogate back-off), so units can't tell.
      bodyFull = true;
      if (body.length === 0) continue;
    }
    units += body.length;
    rows.push({ sectionId: rawId, ord: k, heading: truncateCodeUnits(sanitizeForIndex(s.heading), SEARCH_HEADING_MAX).text, body });
  }
  return finish(rows, units, capped);
}
