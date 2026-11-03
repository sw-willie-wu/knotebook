/**
 * bulk transfer spec 2026-11-02 §6.4、§6.6-4：單篇匯出器——本文（＝MCP 讀出）＋段表＋每行的比對種類。
 *
 * 流程（plan T6；不變量 3、4）：
 * ① 不持 lease：`topLevelFingerprints` 一次走完頂層取 id 與指紋（未 mount 的結構；mount 會正規化空文件）。零顆 → 空本文、
 *    零段、**不 mount**（同 `readNoteContentFromDoc`）。
 * ② `EditorSession.open` **一次**；mount 後頂層 id 不等於 ① → 降級：本文照出、`segments: null`（不可寫回），不丟錯。
 * ③ 整篇匯出一次（`toNoteMarkdown`，與 MCP 讀出同一支組字點）。mount 之後、整篇匯出之後各無條件讓出一次（這兩段是停頓大宗）。
 * ④ 逐顆匯出；每 `yieldEveryBlocks` 顆、或距上次讓出 ≥ `yieldAfterMs` 就 `await yieldFn()`——仍持 lease、不 acquire、
 *    不做 DB（acquire 不可重入只禁止巢狀取得；讓出期間 live doc 的修改不影響這份 fork）。
 * ⑤ DP 對齊；群組匯出在同一個 mount 內同步做（不讓出、不另開 session）。
 * ⑥ finally close。
 * 持 lease 期間零 DB I/O；`titles` 由呼叫端在 mount 前查好（`linkTitlesFor`）。
 */
import type * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import { topLevelFingerprints } from "../notes/editing/fingerprint.js";
import { toNoteMarkdown } from "../notes/editing/read.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { EditorSession } from "../notes/editing/session.js";
import { alignSegments, lineKindsOf, type AlignStats } from "./align.js";
import { bodyLines, normalizeBody } from "./normalize.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

export interface ExportedNote {
  /** 整篇匯出原文（＝MCP 讀出）。 */
  body: string;
  /** `bodyLines(normalizeBody(body))`。 */
  lines: string[];
  ids: string[];
  fps: string[];
  types: string[];
  /** null＝段表對不上（§6.4-5，不可用檔案寫回）。 */
  segments: TransferSegment[] | null;
  lineKinds: number[];
  stats: AlignStats & { yields: number };
}

export interface ExportNoteOptions {
  /** 逐顆匯出每幾顆讓出一次（預設 50）。 */
  yieldEveryBlocks?: number;
  /** 距上次讓出幾毫秒就讓出（預設 20）。 */
  yieldAfterMs?: number;
  /** 讓出的方式（預設 `yieldToLoop`＝兩次 `setImmediate`，理由見 `yield.ts`）；測試縫。 */
  yieldFn?: () => Promise<void>;
  /** 測試縫：段表強制 null（生產不傳）。 */
  forceUnmergeable?: boolean;
}

const DEFAULT_YIELD_EVERY_BLOCKS = 50;
const DEFAULT_YIELD_AFTER_MS = YIELD_AFTER_MS;

export async function exportNoteForTransfer(
  runtime: EditingRuntime,
  doc: Y.Doc,
  titles: ReadonlyMap<string, string>,
  opts: ExportNoteOptions = {},
): Promise<ExportedNote> {
  const yieldEvery = opts.yieldEveryBlocks ?? DEFAULT_YIELD_EVERY_BLOCKS;
  const yieldAfterMs = opts.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS;
  const yieldFn = opts.yieldFn ?? yieldToLoop;

  const { ids, fps } = topLevelFingerprints(doc.getXmlFragment(YDOC_FRAGMENT));
  if (ids.length === 0) {
    return { body: "", lines: [], ids, fps, types: [], segments: [], lineKinds: [], stats: { groupCalls: 0, capHits: 0, groupUsedWhilePerMatched: 0, yields: 0 } };
  }

  const s = await EditorSession.open(runtime, doc);
  try {
    // 停頓的大宗是 mount 與整篇匯出（T7–T11 審查 m3 實測：mount 約 170 ms、整篇約 230 ms、DP 2–3 ms），各在之後讓出一次。
    let yields = 0;
    await yieldFn();
    yields++;
    const top = s.editor.document;
    const body = toNoteMarkdown(s.editor, top, titles);
    await yieldFn();
    yields++;
    const lines = bodyLines(normalizeBody(body));
    const types = top.map(b => b.type as string);
    // mount 改了頂層 id（例如文件裡有重複的頂層 id，BlockNote mount 時會換掉重複的那個）：段表的 id／指紋對不上現況，
    // 降級成不可寫回——本文照出（讀取不受影響），`segments: null`（manifest 標 `mergeable: false`）。總管裁示（T1–T6 審查 m5）。
    if (top.length !== ids.length || top.some((b, i) => b.id !== ids[i])) {
      return { body, lines, ids, fps, types, segments: null, lineKinds: lineKindsOf(null, types, lines.length), stats: { groupCalls: 0, capHits: 0, groupUsedWhilePerMatched: 0, yields } };
    }

    const per: string[][] = [];
    let last = performance.now();
    for (let i = 0; i < top.length; i++) {
      per.push(bodyLines(normalizeBody(toNoteMarkdown(s.editor, [top[i]!], titles))));
      if ((i + 1) % yieldEvery === 0 || performance.now() - last >= yieldAfterMs) {
        await yieldFn();
        yields++;
        last = performance.now();
      }
    }

    const { segs, stats } = alignSegments(lines, per, types, (i, j) => bodyLines(normalizeBody(toNoteMarkdown(s.editor, top.slice(i, j + 1), titles))));
    const aligned = opts.forceUnmergeable ? null : segs;
    const segments = aligned === null ? null : aligned.map(sg => ({ ids: sg.idx.map(k => ids[k]!), fps: sg.idx.map(k => fps[k]!), start: sg.start, count: sg.count }));
    return { body, lines, ids, fps, types, segments, lineKinds: lineKindsOf(aligned, types, lines.length), stats: { ...stats, yields } };
  } finally {
    s.close();
  }
}
