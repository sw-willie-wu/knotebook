import * as Y from "yjs";
import type { VisibleNoteTarget } from "../../../src/notes/editing/candidates.js";
import { parseMarkdownForNote } from "../../../src/notes/editing/markdown.js";
import type { EditingRuntime } from "../../../src/notes/editing/runtime.js";
import { EditorSession } from "../../../src/notes/editing/session.js";
import { baseHashes, deriveTransferKey, transferKeyId } from "../../../src/transfer/base-hash.js";
import { exportNoteForTransfer } from "../../../src/transfer/export-note.js";
import { writeNoteFile } from "../../../src/transfer/frontmatter.js";
import { diffLines, hashAgentLines, type DiffOptions, type LineDiff } from "../../../src/transfer/line-diff.js";
import { exportedLinkTextOf, linkTextHash } from "../../../src/transfer/link-texts.js";
import { bodyLines, normalizeBody } from "../../../src/transfer/normalize.js";
import { findRegions, makeBoundaryCheck, type CheckBoundary, type RegionsResult } from "../../../src/transfer/regions.js";
import type { TransferSegment } from "../../../src/db/schema.js";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import { topLevelSnapshot } from "../../../src/notes/editing/fingerprint.js";
import { applySync } from "../../../src/transfer/sync-apply.js";
import { planSync } from "../../../src/transfer/sync-plan.js";

export const TEST_SITE = "http://localhost";
export const TEST_KEY = deriveTransferKey("transfer-sync-fixture-secret");
export const TEST_SALT = Buffer.alloc(16, 7);

/** block JSON -> Y.Doc (via the server-side EditorSession; the lease is always released). */
export async function docWith(rt: EditingRuntime, blocks: unknown[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}

/** Opens a scratch session (empty Y.Doc) per call to parse; returns null on failure. */
export function realBoundaryCheck(rt: EditingRuntime, candidates: readonly VisibleNoteTarget[] = []): CheckBoundary {
  return makeBoundaryCheck(async md => {
    const s = await EditorSession.open(rt, new Y.Doc());
    try {
      const p = parseMarkdownForNote(s.editor, md, candidates, TEST_SITE);
      return "error" in p ? null : p.blocks;
    } finally {
      s.close();
    }
  });
}

export interface InMemoryBase {
  fileText: string;
  body: string;
  lines: string[];
  ids: string[];
  fps: string[];
  types: string[];
  base: {
    salt: Buffer;
    keyId: string;
    bodySha: Buffer;
    titleSha: Buffer;
    lineHashes: Buffer;
    lineKinds: Buffer;
    segments: TransferSegment[] | null;
  };
}

/** `exportNoteForTransfer` + `baseHashes` (fixed test key and salt). */
export async function makeBaseInMemory(
  rt: EditingRuntime,
  doc: Y.Doc,
  titles: ReadonlyMap<string, string> = new Map(),
  title = "T",
  /** Rewrites the export line by line before computing the base: simulates a file downloaded by an older exporter (e.g. before #386, ``` inside text wasn't escaped). */
  mapLine?: (line: string) => string,
): Promise<InMemoryBase> {
  const raw = await exportNoteForTransfer(rt, doc, titles, { linkHash: (id, text) => linkTextHash(TEST_KEY, TEST_SALT, id, text) });
  const ex = mapLine === undefined ? raw : { ...raw, lines: raw.lines.map(mapLine), body: raw.body.split("\n").map(mapLine).join("\n") };
  const h = baseHashes(TEST_KEY, TEST_SALT, { body: normalizeBody(ex.body), title, tags: [], lines: ex.lines, kinds: ex.lineKinds });
  return {
    fileText: writeNoteFile({ id: "00000000-0000-4000-8000-000000000000", title, role: "owner", base: "0123456789abcdef", url: "/n/x", tags: [] }, ex.body),
    body: ex.body,
    lines: ex.lines,
    ids: ex.ids,
    fps: ex.fps,
    types: ex.types,
    base: { salt: TEST_SALT, keyId: transferKeyId(TEST_KEY), bodySha: h.bodySha, titleSha: h.titleSha, lineHashes: h.lineHashes, lineKinds: h.lineKinds, segments: ex.segments },
  };
}

/** agent body -> `bodyLines(normalizeBody(...))` -> line hashes (the base's salt) -> diff. */
export async function diffAgainst(b: InMemoryBase, agentBody: string, opts: { maxD?: number } = {}): Promise<{ agentLines: string[]; diff: LineDiff }> {
  const agentLines = bodyLines(normalizeBody(agentBody));
  const agent = await hashAgentLines(TEST_KEY, b.base.salt, agentLines);
  const dopts: DiffOptions = opts.maxD === undefined ? {} : { maxD: opts.maxD };
  const diff = await diffLines({ hashes: b.base.lineHashes, kinds: b.base.lineKinds }, agent, dopts);
  return { agentLines, diff };
}

/** `planInMemory`: base + agent body + current doc (an unmounted fork) -> `planSync`. `maxD` is passed to `diffLines` as-is. */
export async function planInMemory(
  rt: EditingRuntime,
  b: InMemoryBase,
  agentBody: string,
  liveDoc: Y.Doc,
  opts: { maxD?: number; candidates?: readonly VisibleNoteTarget[]; yieldFn?: () => Promise<void>; now?: () => number } = {},
): Promise<Awaited<ReturnType<typeof planSync>> & { cur: { ids: string[]; fps: string[]; types: string[] }; diff: LineDiff }> {
  const { agentLines, diff } = await diffAgainst(b, agentBody, opts);
  const curFragment = liveDoc.getXmlFragment(YDOC_FRAGMENT);
  const cur = topLevelSnapshot(curFragment);
  const exported = exportedLinkTextOf(b.base.segments!, TEST_KEY, b.base.salt);
  const r = await planSync(rt, {
    writerId: "test-user",
    segments: b.base.segments!,
    baseLineCount: b.lines.length,
    agentLines,
    diff,
    cur,
    curFragment,
    candidates: opts.candidates ?? [],
    siteOrigin: TEST_SITE,
    ...(exported ? { exportedLinkText: exported } : {}),
    ...(opts.yieldFn ? { yieldFn: opts.yieldFn } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { ...r, cur, diff };
}

/**
 * `applyInMemory` simulates `writeBack`: fork from `live` (not mounted) -> plan -> mount the fork once and apply ->
 * `Y.applyUpdate(live, diff)` (in-memory merge). Returns the plan, the apply result and the merged `live`.
 */
export async function applyInMemory(
  rt: EditingRuntime,
  b: InMemoryBase,
  agentBody: string,
  live: Y.Doc,
  opts: { maxD?: number; candidates?: readonly VisibleNoteTarget[]; yieldFn?: () => Promise<void>; now?: () => number; applyYieldFn?: () => Promise<void> } = {},
) {
  const fork = forkOf(live);
  const sv = Y.encodeStateVector(fork);
  const { applyYieldFn, ...planOpts } = opts;
  const planned = await planInMemory(rt, b, agentBody, fork, planOpts);
  if (!planned.ok) throw new Error(`plan failed: ${planned.code}`);
  const applied = await applySync(rt, fork, sv, planned.plan, planned.cur, {
    ...(applyYieldFn ? { yieldFn: applyYieldFn } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  Y.applyUpdate(live, applied.diff);
  return { plan: planned.plan, cur: planned.cur, applied, live };
}

/** Merged top level: each block's id, type and plain text (for comparing results). */
export function topOf(doc: Y.Doc): Array<{ id: string; text: string; type: string }> {
  const snap = topLevelSnapshot(doc.getXmlFragment(YDOC_FRAGMENT));
  return topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).map((c, i) => ({ id: snap.ids[i]!, type: snap.types[i]!, text: textOf(c) }));
}
function textOf(n: Y.XmlElement | Y.XmlText): string {
  if (n instanceof Y.XmlText) return n.toString().replace(/<[^>]*>/g, "");
  return n.toArray().map(c => (c instanceof Y.XmlElement || c instanceof Y.XmlText ? textOf(c) : "")).join("");
}

/** fork: an independent copy of the same Y state (current = what was there at base download; a "human" edits it afterwards). */
export function forkOf(doc: Y.Doc): Y.Doc {
  const f = new Y.Doc();
  Y.applyUpdate(f, Y.encodeStateAsUpdate(doc));
  return f;
}

/** Opens a session on doc to do something (human edits, export). */
export async function withEditor<T>(rt: EditingRuntime, doc: Y.Doc, f: (ed: EditorSession["editor"]) => T): Promise<T> {
  const s = await EditorSession.open(rt, doc);
  try {
    return f(s.editor);
  } finally {
    s.close();
  }
}

export async function regionsOf(rt: EditingRuntime, b: InMemoryBase, agentBody: string, opts: { maxD?: number; check?: CheckBoundary } = {}): Promise<RegionsResult & { diff: LineDiff }> {
  const { agentLines, diff } = await diffAgainst(b, agentBody, opts);
  const r = await findRegions(b.base.segments!, b.lines.length, agentLines, diff, opts.check ?? realBoundaryCheck(rt), lines => rt.parser.openFenceLine("test-user", lines));
  return { ...r, diff };
}
