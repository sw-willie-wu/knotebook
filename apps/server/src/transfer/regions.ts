/**
 * bulk transfer spec 2026-11-02 §9.3-2～-8：找出 agent 改到的區（plan PR-2 T4；§0.1-2、-3）。純函式＋注入的邊界回呼——
 * 不碰編輯器、不碰 DB；邊界 parse 由呼叫端在 scratch session 內做（`makeBoundaryCheck` 是判準本體，生產與單元測試共用）。
 *
 * 規則（照順序）：① 本文整份空白、或拿掉閉合 HTML 註解後空白 → `empty_content` ② 段「行配對到」＝每行都配到且配對連續
 * （0 行段恆成立）③ 空段落段（`count === 0`，或配到的 agent 行全是空行——匯出成空行的 block 只有空段落，不靠型別）不驗邊界
 * ④ 邊界觸發：段在 agent 檔中緊鄰的上（下）一行存在、非空、且不是基底緊鄰那一行的配對 → 取相接文字（往外到空行為止）呼叫
 * `checkBoundary`；false → 段併入區。上下各驗一次，**只跑一輪、不迭代**（段併入不改變相鄰段的緊鄰行）⑤ 相鄰「改了」段＋夾著
 * 或貼著的插入行合成區；區文字＝前一個沒改的段之後到後一個沒改的段之前的 agent 行，去頭尾空行 ⑥ 三種區；沒有基底段且文字空
 * → 不算區 ⑦ 區文字拿掉閉合註解後只剩空白：插入區丟掉、改寫區當刪除區 ⑧ 文件順序；`prevSeg`／`nextSeg`＝前後最近一個沒改的段。
 * 「區文字 parse 成 `empty_content`、但 strip 後還有字」（§9.3-6，整篇 400）不在這裡判——要 parse 才知道，`sync-plan.ts` 判。
 */
import { markdownToHTML, type PartialBlock } from "@blocknote/core";
import type { TransferSegment } from "../db/schema.js";
import type { LineDiff } from "./line-diff.js";
import { lineKey } from "./normalize.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

export type BoundarySide = "before" | "after";
/** 生產＝scratch session 內 parse；回 true＝邊界成立（k 不併）。parse 失敗必須回 false（§9.3-3，gate r5 I-1）。 */
export type CheckBoundary = (kText: string, adjText: string, side: BoundarySide) => Promise<boolean>;

export interface Region {
  kind: "rewrite" | "delete" | "insert";
  /** 區內的基底段（`segments` 的索引）。 */
  segIdx: number[];
  baseIds: string[];
  baseFps: string[];
  /** 區文字（去頭尾空行；刪除區＝""）。 */
  text: string;
  /** 前（後）最近一個沒改的段的索引；無則 -1。 */
  prevSeg: number;
  nextSeg: number;
}
/** `fence`：未閉合的那一行用的 fence 記號（``` 或 ~~~，原樣幾個字元），給訊息用（8000 探索測試 E）。 */
export type RegionsResult = { ok: true; regions: Region[]; boundaryChecks: number } | { ok: false; code: "empty_content" } | { ok: false; code: "unclosed_fence"; fence: string };

/**
 * 總管裁示（審查 m3，複審改裁）：agent **新增或改過**的一行開了 code fence、而且一路延伸到檔尾沒有收尾 → 整篇 400、什麼都不寫
 * （比照未閉合 `<!--`，§9.3-6）。整檔 parse 時它會吞掉到檔尾的內容，但區偵測是逐區、一輪、按文字觸發的，寫回的結果會與 agent 檔
 * 「整份讀起來」的樣子不一致。**開頭那一行落在沒改的段裡就放行**：PR-1 的匯出器不跳脫，段落文字本身是 ``` 的筆記會照字匯出成
 * 一行（E6），原檔重送或只改別段都不能因此被拒。判斷以 repo 實際的 parser 為準（`markdownToHTML`，即 `parseMarkdownForNote`
 * 的第一步），不手寫 fence 規則：見 `trailingOpenFenceLine`。路由映 400 `invalid_body` 並帶這句（HTTP 層，#372 起英文，T8 接）。
 */
/** 8000 探索測試 E：訊息照實際用的 fence 記號寫（``` 或 ~~~），不一律寫 ```。 */
export const unclosedFenceMessage = (fence: string): string =>
  `A line you added or changed opens a code block with ${fence} that is never closed, so everything from that line to the end of the file counts as code. Add a closing ${fence} (or use inline \`code\`) and send the file again.`;
export const UNCLOSED_FENCE_MESSAGE = unclosedFenceMessage("```");

const FENCE_SENTINEL = "kn-fence-sentinel-3f9c2a7e";
/** `trailingOpenFenceLine` 認得的開頭行形（它回的那一行必定符合；預篩用同一條，所以預篩是精確的）。 */
const FENCE_LIKE = /^\s*(`{3,}|~{3,})/;
/** 測試用計數：整檔 fence 判斷實際丟給 parser 幾次（複審 F3）。 */
export const fenceParseStats = { calls: 0 };
const NL = "\n";
const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/**
 * parser 當準：在檔尾隔一個空行接一行哨兵，丟給 `markdownToHTML`。若 HTML 以 `<pre><code>…哨兵</code></pre>` 收尾＝有一個 code
 * 區塊一路延伸到檔尾、沒有收尾 fence（收尾的 code 不會吞到哨兵；容器內的 fence 由 parser 自己決定，結果與它一致）。code 的內容是
 * 開頭那一行之後到檔尾的每一行＋空行＋哨兵，所以開頭那一行＝`lines.length − 1 −（內容行數 − 2）`。回那一行的索引；沒有 → null。
 * 算出來的那一行看起來不像 fence（行首 ``` 或 ~~~）→ 不確定位置，回 null（放行；後果是那段之後的內容被當成 code，known-limitations）。
 */
export function trailingOpenFenceLine(lines: readonly string[]): number | null {
  fenceParseStats.calls++;
  const html = markdownToHTML(lines.join(NL) + NL + NL + FENCE_SENTINEL);
  const at = html.lastIndexOf("<pre><code");
  if (at === -1) return null;
  const m = /^<pre><code[^>]*>([\s\S]*)<\/code><\/pre>\s*$/.exec(html.slice(at));
  if (m === null) return null;
  const parts = unescapeHtml(m[1]!).split(NL);
  if (parts[parts.length - 1] !== FENCE_SENTINEL) return null;
  const line = lines.length - 1 - (parts.length - 2);
  if (line < 0 || !FENCE_LIKE.test(lines[line]!)) return null;
  return line;
}

/** 拿掉所有**閉合**的 `<!--…-->`（純文字處理，不懂 markdown）；未閉合的 `<!--` 原樣留著。 */
export function stripClosedComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyPartialBlock = PartialBlock<any, any, any>;

/** 比較用：去掉 `id`（遞迴）、忽略 `numberedListItem` 的 `props.start`（E13）。 */
function comparable(b: unknown): unknown {
  if (Array.isArray(b)) return b.map(comparable);
  if (b === null || typeof b !== "object") return b;
  const o = b as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    if (k === "id") continue;
    if (k === "props" && o.type === "numberedListItem" && o.props !== null && typeof o.props === "object") {
      const { start: _s, ...rest } = o.props as Record<string, unknown>;
      out.props = comparable(rest);
      continue;
    }
    out[k] = comparable(o[k]);
  }
  return out;
}

/**
 * §9.3-3 的判準：parse(k＋相接文字)，取對應 k 的那幾顆——**取 parse(k) 的顆數**（spike S2：攤平子 block 的 1 id 段逐顆匯出
 * parse 成 2 顆）；相接在後從頭取、在前從尾取——與 parse(k) 比（去 `id`、忽略 numbered 的 `start`）。任一 parse 失敗 → false。
 * `parse` 回 null＝失敗（`parseMarkdownForNote` 的 error）。
 */
export function makeBoundaryCheck(parse: (markdown: string) => AnyPartialBlock[] | null | Promise<AnyPartialBlock[] | null>): CheckBoundary {
  return async (kText, adjText, side) => {
    const k = await parse(kText);
    if (k === null || k.length === 0) return false;
    const joined = await parse(side === "before" ? `${adjText}\n${kText}` : `${kText}\n${adjText}`);
    if (joined === null) return false;
    const n = k.length;
    if (joined.length < n) return false;
    const picked = side === "before" ? joined.slice(joined.length - n) : joined.slice(0, n);
    return JSON.stringify(comparable(picked)) === JSON.stringify(comparable(k));
  };
}

const blank = (l: string | undefined): boolean => l === undefined || lineKey(l) === "";

export async function findRegions(
  segments: TransferSegment[],
  baseLineCount: number,
  agentLines: string[],
  diff: LineDiff,
  checkBoundary: CheckBoundary,
  opts: { yieldFn?: () => Promise<void>; now?: () => number } = {},
): Promise<RegionsResult> {
  const joined = agentLines.join("\n");
  if (joined.trim() === "" || stripClosedComments(joined).trim() === "") return { ok: false, code: "empty_content" };
  const yieldFn = opts.yieldFn ?? yieldToLoop;
  const now = opts.now ?? (() => performance.now());
  let last = now();
  const pair = diff.pair;
  const M = agentLines.length;
  const S = segments.length;

  // ② 行配對到 ③ 空段落段
  const matched = new Array<boolean>(S).fill(false);
  const emptyPara = new Array<boolean>(S).fill(false);
  for (let k = 0; k < S; k++) {
    const s = segments[k]!;
    if (s.count === 0) {
      matched[k] = true;
      emptyPara[k] = true;
      continue;
    }
    const p0 = pair[s.start]!;
    let ok = p0 !== -1;
    for (let t = 1; ok && t < s.count; t++) ok = pair[s.start + t] === p0 + t;
    matched[k] = ok;
    if (ok) {
      let allBlank = true;
      for (let t = 0; allBlank && t < s.count; t++) allBlank = lineKey(agentLines[p0 + t]!) === "";
      emptyPara[k] = allBlank;
    }
  }

  // ④ 邊界驗證（一輪；用 ② 的結果，不迭代）
  const unchanged = matched.slice();
  let boundaryChecks = 0;
  const adjUp = (from: number): string => {
    let p = from;
    while (p - 1 >= 0 && !blank(agentLines[p - 1])) p--;
    return agentLines.slice(p, from + 1).join("\n");
  };
  const adjDown = (from: number): string => {
    let q = from;
    while (q + 1 < M && !blank(agentLines[q + 1])) q++;
    return agentLines.slice(from, q + 1).join("\n");
  };
  for (let k = 0; k < S; k++) {
    if (!matched[k] || emptyPara[k]) continue;
    const s = segments[k]!;
    const a0 = pair[s.start]!;
    const a1 = a0 + s.count - 1;
    const kText = agentLines.slice(a0, a1 + 1).join("\n");
    let ok = true;
    if (a0 - 1 >= 0 && !blank(agentLines[a0 - 1]) && !(s.start - 1 >= 0 && pair[s.start - 1] === a0 - 1)) {
      boundaryChecks++;
      ok = await checkBoundary(kText, adjUp(a0 - 1), "before");
      if (now() - last >= YIELD_AFTER_MS) {
        await yieldFn();
        last = now();
      }
    }
    if (ok && a1 + 1 < M && !blank(agentLines[a1 + 1]) && !(s.start + s.count < baseLineCount && pair[s.start + s.count] === a1 + 1)) {
      boundaryChecks++;
      ok = await checkBoundary(kText, adjDown(a1 + 1), "after");
      if (now() - last >= YIELD_AFTER_MS) {
        await yieldFn();
        last = now();
      }
    }
    unchanged[k] = ok;
  }

  // 沒改的段在 agent 檔中的位置。0 行段（頭尾空段落）：開頭的在最前（-1）、結尾的在最後（M）。
  let seenLines = false;
  const span = segments.map(s => {
    if (s.count > 0) {
      seenLines = true;
      const a0 = pair[s.start]!;
      return { a0, a1: a0 + s.count - 1 };
    }
    return seenLines ? { a0: M, a1: M - 1 } : { a0: 0, a1: -1 };
  });

  // 未閉合 fence（審查 m3）：開頭那一行不在任何沒改的段裡（＝agent 新增或改過）才拒絕。
  // 精確預篩（複審 F3）：沒改的段以外沒有任何一行像 fence 開頭 → 結果必定是放行，不必整檔丟給 parser（它對 `*a _b` 交錯這類輸入
  // 是平方級）。真的 parse 了就補一次時間預算讓出。
  const inUnchanged = new Uint8Array(M);
  for (let k = 0; k < S; k++) {
    if (!unchanged[k] || segments[k]!.count === 0) continue;
    for (let j = span[k]!.a0; j <= span[k]!.a1; j++) inUnchanged[j] = 1;
  }
  if (agentLines.some((l, j) => inUnchanged[j] === 0 && FENCE_LIKE.test(l))) {
    const open = trailingOpenFenceLine(agentLines);
    if (now() - last >= YIELD_AFTER_MS) {
      await yieldFn();
      last = now();
    }
    if (open !== null && inUnchanged[open] === 0) return { ok: false, code: "unclosed_fence", fence: FENCE_LIKE.exec(agentLines[open]!)![1]! };
  }

  // ⑤–⑧ 合成區
  const regions: Region[] = [];
  const emit = (prevSeg: number, nextSeg: number, segIdx: number[]) => {
    const lo = prevSeg === -1 ? 0 : span[prevSeg]!.a1 + 1;
    const hi = nextSeg === -1 ? M - 1 : span[nextSeg]!.a0 - 1;
    let a = lo;
    let b = hi;
    while (a <= b && blank(agentLines[a])) a++;
    while (b >= a && blank(agentLines[b])) b--;
    let text = a <= b ? agentLines.slice(a, b + 1).join("\n") : "";
    if (segIdx.length === 0 && text === "") return;
    if (text !== "" && stripClosedComments(text).trim() === "") {
      if (segIdx.length === 0) return; // 只剩註解的插入：不算區
      text = ""; // 只剩註解的改寫：當刪除區
    }
    const baseIds = segIdx.flatMap(k => segments[k]!.ids);
    const baseFps = segIdx.flatMap(k => segments[k]!.fps);
    regions.push({ kind: segIdx.length === 0 ? "insert" : text === "" ? "delete" : "rewrite", segIdx, baseIds, baseFps, text, prevSeg, nextSeg });
  };
  let prev = -1;
  let run: number[] = [];
  for (let k = 0; k < S; k++) {
    if (!unchanged[k]) {
      run.push(k);
      continue;
    }
    emit(prev, k, run);
    prev = k;
    run = [];
  }
  emit(prev, -1, run);
  return { ok: true, regions, boundaryChecks };
}
