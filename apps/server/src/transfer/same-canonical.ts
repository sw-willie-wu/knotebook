/**
 * Not `fingerprintOf`/`canonicalizeNode` (the contract of `if_match` and version
 * fingerprints, must not change). Plus four minimal normalizations: drop `undefined`
 * attributes (parse → `insertBlocks` writes them, old browser blocks lack them), drop numbered
 * `start`, for wikilinks only drop `snapshotTitle` and empty `label`/`anchorBlockId`
 * (parse rebinds to the current title), and drop heading knowledge attributes equal to their
 * default (a heading written before those props existed must equal one that stores them empty).
 * Other empty-string attributes compare normally.
 */
import * as Y from "yjs";
import { isIgnorableKnowledgeDefault, topLevelBlocks } from "@knotebook/shared";

function stable(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function keep(nodeName: string, k: string, v: unknown): boolean {
  if (k === "id" || v === undefined) return false;
  if (isIgnorableKnowledgeDefault(nodeName, k, v)) return false;
  if (nodeName === "numberedListItem" && k === "start") return false;
  if (nodeName === "wikilink" && (k === "snapshotTitle" || ((k === "label" || k === "anchorBlockId") && v === ""))) return false;
  return true;
}

function canon(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
    return `T${stable(delta.map(d => ({ insert: d.insert, attributes: d.attributes ?? {} })))}`;
  }
  const attrs = node.getAttributes() as Record<string, unknown>;
  const kept = Object.keys(attrs)
    .filter(k => keep(node.nodeName, k, attrs[k]))
    .sort()
    .map(k => `${k}=${stable(attrs[k])}`);
  const children: string[] = [];
  // `get(i)` on a Y type is O(i), so an index loop is quadratic; walk once with `toArray()`.
  for (const c of node.toArray()) {
    if (c instanceof Y.XmlElement || c instanceof Y.XmlText) children.push(canon(c));
  }
  return `E${node.nodeName}(${kept.join(";")})[${children.join("|")}]`;
}

export function sameCanonicalOf(container: Y.XmlElement): string {
  return canon(container);
}

/** For tests: number of blocks actually canonicalized (cache misses). */
export const sameCanonicalStats = { canonicalized: 0 };

export interface SameIndex {
  byId: Map<string, Y.XmlElement>;
  cache: Map<string, string>;
}
/** Index and per-block cache built once per fragment: rebuilding per region is O(regions × blocks). Only valid on fragments that no longer change. */
export function indexTopLevel(fragment: Y.XmlFragment): SameIndex {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelBlocks(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id === "string") byId.set(id, c);
  }
  return { byId, cache: new Map() };
}
export function sameCanonicalSeqIn(index: SameIndex, ids: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const id of ids) {
    let s = index.cache.get(id);
    if (s === undefined) {
      const c = index.byId.get(id);
      if (c === undefined) return null;
      s = canon(c);
      sameCanonicalStats.canonicalized++;
      index.cache.set(id, s);
    }
    out.push(s);
  }
  return out;
}

export function sameCanonicalSeq(fragment: Y.XmlFragment, ids: readonly string[]): string[] | null {
  if (ids.length === 0) return [];
  return sameCanonicalSeqIn(indexTopLevel(fragment), ids);
}
