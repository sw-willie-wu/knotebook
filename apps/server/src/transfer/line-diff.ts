/**
 * bulk transfer：agent 行雜湊＋逐行 diff（自寫 Myers，不引套件）。
 *
 * 基底只有每行 8 bytes 的 HMAC（`transfer_bases.line_hashes`），沒有原文，所以 diff 在**雜湊空間**做。agent 每行算兩份雜湊
 * （原文鍵、編號正規化鍵），都用**該基底列的鹽**、同一支 `hmacOf`／`lineKey`／`normalizeNumbered`（不變量 2：另寫一份正規化
 * 會讓每一行都「改了」）。等價：`eq(i, j) = kinds[i] === 1 ? num[j] === base[i] : raw[j] === base[i]`。
 *
 * `diffSpan`（一開始＝整份）：① 剝共同前後綴 ② 有界 Myers（D ≤ `maxD`，trace 每步只存 `[-d-1, d+1]`；相等行的配對＝最短
 * 編輯腳本，多解時取「刪除優先於插入」的標準回溯序）③ 溢位 → 唯一行錨點：子區段內基底鍵只出現一次、且 agent 側等價行也只出現
 * 一次的行對為候選（同一個 agent 行同時是 kind 0 與 kind 1 兩個基底鍵的候選 → 兩者都不當錨點），依 agent 位置取嚴格遞增的
 * 最長遞增子序列（patience）當錨點，錨點之間的子區段遞迴回 ①（唯一性以子區段重新計算）④ 子區段溢位且找不到錨點 → 只有這個
 * 子區段的行全部不配對，`degradedLines` 加上它（剝完前後綴後）的基底行數 ⑤ 工作量上限（全域 Myers 步數 ≤
 * `workFactor·(N+M)·maxD`）與遞迴深度上限（`maxDepth`）：任一超過 → 尚未處理的子區段一律退化 ⑥ 讓出按時間預算：Myers 的
 * d 迴圈與每個子區段入口是檢查點，距上次讓出 ≥ `YIELD_AFTER_MS` 才 `await yieldFn()`（跨遞迴共用一個計時器）。
 * 「Myers 步數」＝d 迴圈內每個對角線一步＋每次 snake 前進一步（不含剝前後綴與找錨點的掃描）。
 */
import { LINE_HASH_BYTES, hmacOf } from "./base-hash.js";
import { lineKey, normalizeNumbered } from "./normalize.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

/** `transfer_bases.line_hashes`（每行 8 bytes 串接）／`line_kinds`（每行 1 byte：0 原文、1 numbered）。 */
export interface BaseLines {
  hashes: Buffer;
  kinds: Buffer;
}
/** agent 每行兩份雜湊（8 bytes 的 latin1 字串）。 */
export interface AgentLines {
  raw: string[];
  num: string[];
}

export const DIFF_MAX_D = 2000;
/** 全域 Myers 步數 ≤ `DIFF_WORK_MAX_FACTOR·(N+M)·maxD`（⑤）。 */
export const DIFF_WORK_MAX_FACTOR = 4;
export const DIFF_DEPTH_MAX = 32;

export interface LineDiff {
  /** `pair[i]`＝基底第 i 行配到 agent 第幾行，-1＝沒配到。配對嚴格遞增（不交叉）。 */
  pair: Int32Array;
  /** 有任何子區段溢位，或撞到工作量／深度上限。 */
  overflow: boolean;
  /** 錨點數（所有層加總）。 */
  anchored: number;
  /** 所有退化子區段內、剝完該子區段共同前後綴之後、沒配到的**基底**行數總和（④，定義寫死）。 */
  degradedLines: number;
  /** 測試用：撞到哪一道上限（先撞到的那道；沒撞不帶）。 */
  capHit?: "work" | "depth";
  /** 測試用：處理過的子區段的最大遞迴深度（頂層＝0）。 */
  maxDepthSeen: number;
  /** 測試用：經過幾次「比較時間」的檢查點。 */
  checkpoints: number;
  /** 測試用：累計的 Myers 步數。 */
  work: number;
}

export interface DiffOptions {
  maxD?: number;
  yieldFn?: () => Promise<void>;
  /** 測試縫：時鐘（預設 `performance.now`）。 */
  now?: () => number;
  /** 測試縫：工作量上限的倍數（預設 `DIFF_WORK_MAX_FACTOR`）。 */
  workFactor?: number;
  /** 測試縫：遞迴深度上限（預設 `DIFF_DEPTH_MAX`）。 */
  maxDepth?: number;
}

const h8 = (b: Buffer): string => b.toString("latin1", 0, LINE_HASH_BYTES);

/** agent 每行的兩份雜湊；`normalizeNumbered(k) === k` 時 `num = raw`（省一次 HMAC）。每 `YIELD_AFTER_MS` 讓出。 */
export async function hashAgentLines(
  key: Buffer,
  salt: Buffer,
  lines: string[],
  opts: { yieldFn?: () => Promise<void>; now?: () => number } = {},
): Promise<AgentLines> {
  const yieldFn = opts.yieldFn ?? yieldToLoop;
  const now = opts.now ?? (() => performance.now());
  const raw = new Array<string>(lines.length);
  const num = new Array<string>(lines.length);
  let last = now();
  for (let i = 0; i < lines.length; i++) {
    const k = lineKey(lines[i]!);
    const r = h8(hmacOf(key, salt, k));
    raw[i] = r;
    const nk = normalizeNumbered(k);
    num[i] = nk === k ? r : h8(hmacOf(key, salt, nk));
    if ((i & 63) === 63 && now() - last >= YIELD_AFTER_MS) {
      await yieldFn();
      last = now();
    }
  }
  return { raw, num };
}

interface Ctx {
  baseId: Int32Array;
  baseKind: Uint8Array;
  rawId: Int32Array;
  numId: Int32Array;
  pair: Int32Array;
  maxD: number;
  maxDepth: number;
  workCap: number;
  work: number;
  overflow: boolean;
  anchored: number;
  degradedLines: number;
  capHit?: "work" | "depth";
  maxDepthSeen: number;
  checkpoints: number;
  last: number;
  now: () => number;
  yieldFn: () => Promise<void>;
}

const eq = (c: Ctx, i: number, j: number): boolean => (c.baseKind[i] === 1 ? c.numId[j] : c.rawId[j]) === c.baseId[i];

async function checkpoint(c: Ctx): Promise<void> {
  c.checkpoints++;
  if (c.now() - c.last >= YIELD_AFTER_MS) {
    await c.yieldFn();
    c.last = c.now();
  }
}

/** 有界 Myers：成功回配對（`[i, j, i, j, …]`，倒序）；D 超過 `maxD` 回 "overflow"；撞工作量上限回 "capped"。 */
async function myers(c: Ctx, aLo: number, n: number, bLo: number, m: number): Promise<number[] | "overflow" | "capped"> {
  const dMax = Math.min(c.maxD, n + m);
  const off = dMax + 1;
  const v = new Int32Array(2 * dMax + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= dMax; d++) {
    await checkpoint(c);
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      c.work++;
      while (x < n && y < m && eq(c, aLo + x, bLo + y)) {
        x++;
        y++;
        c.work++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, aLo, bLo);
    }
    if (c.work > c.workCap) return "capped";
  }
  return "overflow";
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number, aLo: number, bLo: number): number[] {
  const out: number[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const t = trace[d]!;
    const base = d + 1;
    const k = x - y;
    const prevK = k === -d || (k !== d && t[base + k - 1]! < t[base + k + 1]!) ? k + 1 : k - 1;
    const prevX = t[base + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push(aLo + x - 1, bLo + y - 1);
      x--;
      y--;
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return out;
}

/** 子區段內的錨點（③）：兩邊唯一的等價行對，依 agent 位置取嚴格遞增的 LIS。回 `[i, j]` 依文件順序。 */
function findAnchors(c: Ctx, aLo: number, aHi: number, bLo: number, bHi: number): Array<[number, number]> {
  const baseCount = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) baseCount.set(c.baseId[i]!, (baseCount.get(c.baseId[i]!) ?? 0) + 1);
  const agentCount = new Map<number, number>();
  const agentAt = new Map<number, number>();
  const bump = (id: number, j: number) => {
    if (id < 0) return;
    agentCount.set(id, (agentCount.get(id) ?? 0) + 1);
    agentAt.set(id, j);
  };
  for (let j = bLo; j < bHi; j++) {
    bump(c.rawId[j]!, j);
    if (c.numId[j] !== c.rawId[j]) bump(c.numId[j]!, j);
  }
  const cand: Array<[number, number]> = [];
  const perAgent = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) {
    const id = c.baseId[i]!;
    if (baseCount.get(id) !== 1 || agentCount.get(id) !== 1) continue;
    const j = agentAt.get(id)!;
    cand.push([i, j]);
    perAgent.set(j, (perAgent.get(j) ?? 0) + 1);
  }
  // 同一個 agent 行同時是兩個基底鍵的候選（kind 0 與 kind 1 的雜湊相同）→ 兩者都不當錨點。
  const uniq = cand.filter(([, j]) => perAgent.get(j) === 1);
  // patience：tails[len] ＝長度 len+1 的遞增子序列中結尾最小者在 uniq 的索引；prev 回溯。
  const tails: number[] = [];
  const prev = new Int32Array(uniq.length).fill(-1);
  for (let q = 0; q < uniq.length; q++) {
    const j = uniq[q]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (uniq[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[q] = tails[lo - 1]!;
    tails[lo] = q;
  }
  const out: Array<[number, number]> = [];
  for (let q = tails.length === 0 ? -1 : tails[tails.length - 1]!; q !== -1; q = prev[q]!) out.push(uniq[q]!);
  return out.reverse();
}

function degrade(c: Ctx, n: number): void {
  c.overflow = true;
  c.degradedLines += n;
}

async function diffSpan(c: Ctx, aLo: number, aHi: number, bLo: number, bHi: number, depth: number): Promise<void> {
  while (aLo < aHi && bLo < bHi && eq(c, aLo, bLo)) c.pair[aLo++] = bLo++;
  while (aLo < aHi && bLo < bHi && eq(c, aHi - 1, bHi - 1)) c.pair[--aHi] = --bHi;
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0 || m === 0) return; // 一邊空：沒有可配的行（不是退化）
  if (depth > c.maxDepth) {
    c.capHit ??= "depth";
    return degrade(c, n);
  }
  if (depth > c.maxDepthSeen) c.maxDepthSeen = depth;
  if (c.work > c.workCap) {
    c.capHit ??= "work";
    return degrade(c, n);
  }
  await checkpoint(c);
  const r = await myers(c, aLo, n, bLo, m);
  if (r === "capped") {
    c.capHit ??= "work";
    return degrade(c, n);
  }
  if (r !== "overflow") {
    for (let q = 0; q < r.length; q += 2) c.pair[r[q]!] = r[q + 1]!;
    return;
  }
  c.overflow = true;
  const anchors = findAnchors(c, aLo, aHi, bLo, bHi);
  if (anchors.length === 0) return degrade(c, n);
  c.anchored += anchors.length;
  let pi = aLo;
  let pj = bLo;
  for (const [i, j] of anchors) {
    await diffSpan(c, pi, i, pj, j, depth + 1);
    c.pair[i] = j;
    pi = i + 1;
    pj = j + 1;
  }
  await diffSpan(c, pi, aHi, pj, bHi, depth + 1);
}

export async function diffLines(base: BaseLines, agent: AgentLines, opts: DiffOptions = {}): Promise<LineDiff> {
  const N = base.kinds.length;
  const M = agent.raw.length;
  if (base.hashes.length !== N * LINE_HASH_BYTES) throw new Error("diffLines: hashes and kinds differ in length");
  // 比較鍵 `k<kind>:<hash>` 換成整數 id：基底行一個、agent 行各兩個（kind 0／1；不在基底裡的 → -1）。
  const ids = new Map<string, number>();
  const baseId = new Int32Array(N);
  const baseKind = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const kind = base.kinds[i] === 1 ? 1 : 0;
    baseKind[i] = kind;
    const key = kind + base.hashes.toString("latin1", i * LINE_HASH_BYTES, (i + 1) * LINE_HASH_BYTES);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    baseId[i] = id;
  }
  const rawId = new Int32Array(M);
  const numId = new Int32Array(M);
  for (let j = 0; j < M; j++) {
    rawId[j] = ids.get("0" + agent.raw[j]!) ?? -1;
    numId[j] = ids.get("1" + agent.num[j]!) ?? -1;
  }
  const maxD = opts.maxD ?? DIFF_MAX_D;
  const now = opts.now ?? (() => performance.now());
  const c: Ctx = {
    baseId,
    baseKind,
    rawId,
    numId,
    pair: new Int32Array(N).fill(-1),
    maxD,
    maxDepth: opts.maxDepth ?? DIFF_DEPTH_MAX,
    workCap: (opts.workFactor ?? DIFF_WORK_MAX_FACTOR) * (N + M) * maxD,
    work: 0,
    overflow: false,
    anchored: 0,
    degradedLines: 0,
    maxDepthSeen: 0,
    checkpoints: 0,
    last: now(),
    now,
    yieldFn: opts.yieldFn ?? yieldToLoop,
  };
  await diffSpan(c, 0, N, 0, M, 0);
  const out: LineDiff = {
    pair: c.pair,
    overflow: c.overflow,
    anchored: c.anchored,
    degradedLines: c.degradedLines,
    maxDepthSeen: c.maxDepthSeen,
    checkpoints: c.checkpoints,
    work: c.work,
  };
  if (c.capHit !== undefined) out.capHit = c.capHit;
  return out;
}
