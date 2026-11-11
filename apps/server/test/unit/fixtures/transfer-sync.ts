/**
 * bulk transfer單元測試共用：「寫回一篇」的記憶體夾具（不碰 DB）。
 * `realBoundaryCheck`（scratch session 內真 parser 的 `CheckBoundary`）、`makeBaseInMemory`（匯出器＋基底雜湊）、
 * `regionsOf`（agent 本文 → 行雜湊 → diff → 區）。另有規劃夾具。
 */
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
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { topLevelSnapshot } from "../../../src/notes/editing/fingerprint.js";
import { applySync } from "../../../src/transfer/sync-apply.js";
import { planSync } from "../../../src/transfer/sync-plan.js";

export const TEST_SITE = "http://localhost";
export const TEST_KEY = deriveTransferKey("transfer-sync-fixture-secret");
export const TEST_SALT = Buffer.alloc(16, 7);

/** block JSON → Y.Doc（server 端 EditorSession，lease 一定還）。 */
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

/** 每次呼叫開一個 scratch session（空 Y.Doc）做 parse；失敗回 null。 */
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

/** `exportNoteForTransfer`＋`baseHashes`（固定測試金鑰與鹽）。 */
export async function makeBaseInMemory(
  rt: EditingRuntime,
  doc: Y.Doc,
  titles: ReadonlyMap<string, string> = new Map(),
  title = "T",
  /** 逐行改寫匯出結果再算基底：模擬舊版匯出器下載的檔（例：#386 之前文字裡的 ``` 不跳脫）。 */
  mapLine?: (line: string) => string,
): Promise<InMemoryBase> {
  const raw = await exportNoteForTransfer(rt, doc, titles, { linkHash: (id, text) => linkTextHash(TEST_KEY, TEST_SALT, id, text) });
  const ex = mapLine === undefined ? raw : { ...raw, lines: raw.lines.map(mapLine), body: raw.body.split("\n").map(mapLine).join("\n") };
  const h = baseHashes(TEST_KEY, TEST_SALT, { body: normalizeBody(ex.body), title, lines: ex.lines, kinds: ex.lineKinds });
  return {
    fileText: writeNoteFile({ id: "00000000-0000-4000-8000-000000000000", title, role: "owner", base: "0123456789abcdef", url: "/n/x" }, ex.body),
    body: ex.body,
    lines: ex.lines,
    ids: ex.ids,
    fps: ex.fps,
    types: ex.types,
    base: { salt: TEST_SALT, keyId: transferKeyId(TEST_KEY), bodySha: h.bodySha, titleSha: h.titleSha, lineHashes: h.lineHashes, lineKinds: h.lineKinds, segments: ex.segments },
  };
}

/** agent 本文 → `bodyLines(normalizeBody(…))` → 行雜湊（基底的鹽）→ diff。 */
export async function diffAgainst(b: InMemoryBase, agentBody: string, opts: { maxD?: number } = {}): Promise<{ agentLines: string[]; diff: LineDiff }> {
  const agentLines = bodyLines(normalizeBody(agentBody));
  const agent = await hashAgentLines(TEST_KEY, b.base.salt, agentLines);
  const dopts: DiffOptions = opts.maxD === undefined ? {} : { maxD: opts.maxD };
  const diff = await diffLines({ hashes: b.base.lineHashes, kinds: b.base.lineKinds }, agent, dopts);
  return { agentLines, diff };
}

/** H6 的 `planInMemory`——基底＋agent 本文＋現況 doc（未 mount 的 fork）→ `planSync`。`maxD` 原樣傳給 `diffLines`。 */
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
    owner: "test-user",
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
 * H6 的 `applyInMemory`——`writeBack` 的模擬：從 `live` fork 一份（不 mount）→ 規劃 → mount fork 一次套用 →
 * `Y.applyUpdate(live, diff)`（記憶體合併）。回規劃、套用結果與合併後的 `live`。
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

/** 合併後的頂層：每顆的 id 與型別＋純文字（比對結果用）。 */
export function topOf(doc: Y.Doc): Array<{ id: string; text: string; type: string }> {
  const snap = topLevelSnapshot(doc.getXmlFragment(YDOC_FRAGMENT));
  return topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map((c, i) => ({ id: snap.ids[i]!, type: snap.types[i]!, text: textOf(c) }));
}
function textOf(n: Y.XmlElement | Y.XmlText): string {
  if (n instanceof Y.XmlText) return n.toString().replace(/<[^>]*>/g, "");
  return n.toArray().map(c => (c instanceof Y.XmlElement || c instanceof Y.XmlText ? textOf(c) : "")).join("");
}

/** fork：同一份 Y 狀態的獨立副本（現況＝基底下載時那份，之後「人」在上面改）。 */
export function forkOf(doc: Y.Doc): Y.Doc {
  const f = new Y.Doc();
  Y.applyUpdate(f, Y.encodeStateAsUpdate(doc));
  return f;
}

/** 在 doc 上開一次 session 做事（人的修改、匯出）。 */
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
