/**
 * bulk transfer spec 2026-11-02 §6.4-2～-5：把整篇匯出的行與逐顆匯出對齊，得到段表（純函式，不碰編輯器）。
 *
 * 規則（照順序實作；E12、E13、E16、E17；spike S1 的 `alignRev5` 是演算法參考）：
 * 1. 比對前每行 `lineKey`（trimEnd）；表格列（`/^\s*\|/`）再把儲存格填充空白與分隔列的 `-` 個數正規化——只用於比對。
 * 2. numbered：該顆第一行兩邊都是 `/^(\d+)\. /` 時剝掉編號比其餘；子行允許整篇那邊多出 `delta` 格縮排（編號寬度差，E3）。
 * 3. 開頭與結尾的空段落（逐顆匯出零行）記 0 行段、不吃空行；中間的空段落吃一個空行。
 * 4. 每個位置先逐顆、再群組；同一種之下先試 1 個分隔空行、再 0 個；`pos === 0` 只試 0。
 * 5. 群組（局部合段）：第 i 顆是清單項時，取「從 i 起同家族連續」的最長串、由長到短試；`(i, j)` 的群組匯出快取；
 *    每個起點至多 `cap` 次群組匯出，超過＝這個起點的群組全部放棄。群組只在 DP 回溯到這個起點、逐顆走不出完整解時才試。
 * 6. 失敗記憶化 `(i, pos)`；回傳依優先序的**第一個**完整解；找不到 → `segs: null`（§6.4-5，不可寫回）。
 * 7. **顯式堆疊**（plan §0.2 S6、gate r1 I3）：不遞迴、不以 spread 串接段陣列——遞迴版在 5 000 顆起爆 stack，
 *    `[seg, ...rest]` 每層複製一次是 O(n²)。UI 存得出超過 `MAX_BLOCKS` 的筆記（它只管寫入）。成功時段表直接從堆疊讀出。
 */
import { lineKey } from "./normalize.js";

/** §6.4-3：每個起點至多幾次群組匯出。 */
export const GROUP_EXPORT_CAP = 32;

export type ListFamily = "num" | "star" | null;

/** numberedListItem → `num`；bullet／check／toggle → `star`；其他 → null（不參與局部合段）。 */
export function listFamily(type: string): ListFamily {
  if (type === "numberedListItem") return "num";
  if (type === "bulletListItem" || type === "checkListItem" || type === "toggleListItem") return "star";
  return null;
}

export interface AlignSeg {
  idx: number[];
  start: number;
  count: number;
}
export interface AlignStats {
  groupCalls: number;
  capHits: number;
  groupUsedWhilePerMatched: number;
}

const TABLE_ROW = /^\s*\|/;
/** 規則 1 的比對鍵：trimEnd；表格列再收儲存格填充與分隔列 `-` 數（行內色佔位符位數讓整篇與逐顆的欄寬不同，spike S1）。 */
function matchKey(line: string): string {
  const k = lineKey(line);
  return TABLE_ROW.test(k) ? k.replace(/ *\| */g, "|").replace(/-{3,}/g, "---") : k;
}

const NUM_PREFIX = /^(\d+)\. /;

/** `per` 能不能從 `W` 的 `pos` 起對上；對得上回行數，否則 -1。`W`／`per` 都已是比對鍵。 */
function matchAt(W: readonly string[], pos: number, per: readonly string[], numbered: boolean): number {
  if (pos + per.length > W.length) return -1;
  let delta = 0;
  for (let k = 0; k < per.length; k++) {
    let w = W[pos + k]!;
    let p = per[k]!;
    if (k === 0 && numbered) {
      const mw = NUM_PREFIX.exec(w);
      const mp = NUM_PREFIX.exec(p);
      if (mw && mp) {
        delta = mw[0].length - mp[0].length;
        w = w.slice(mw[0].length);
        p = p.slice(mp[0].length);
      }
    } else if (k > 0 && delta !== 0 && p !== "" && w === " ".repeat(Math.max(delta, 0)) + p) {
      continue;
    }
    if (w !== p) return -1;
  }
  return per.length;
}

/** 一個 DP 狀態 `(i, pos)` 的游標：依優先序逐一產生要試的子狀態。 */
interface Frame {
  i: number;
  pos: number;
  /** 0＝頭尾空段落（單一選項）；1＝逐顆；2＝群組；3＝用完。 */
  stage: 0 | 1 | 2 | 3;
  sepK: number;
  j: number;
  jMax: number;
  group: string[] | null;
  perMatched: boolean;
  /** 目前正在試的子狀態用的那一段（成功時就是答案的一段）。 */
  seg: AlignSeg | null;
  segIsGroup: boolean;
}

export function alignSegments(
  W: string[],
  P: string[][],
  types: string[],
  groupExport: (i: number, j: number) => string[],
  cap: number = GROUP_EXPORT_CAP,
): { segs: AlignSeg[] | null; stats: AlignStats } {
  const stats: AlignStats = { groupCalls: 0, capHits: 0, groupUsedWhilePerMatched: 0 };
  const n = types.length;
  if (P.length !== n) throw new Error("alignSegments: P and types differ in length");
  if (n === 0) return { segs: W.length === 0 ? [] : null, stats };

  const Wk = W.map(matchKey);
  const Wblank = Wk.map(l => l === "");
  const Pk = P.map(lines => lines.map(matchKey));
  const fams = types.map(listFamily);
  let firstNon = -1;
  let lastNon = -1;
  for (let i = 0; i < n; i++) {
    if (P[i]!.length > 0) {
      if (firstNon === -1) firstNon = i;
      lastNon = i;
    }
  }
  const isEdgeEmpty = (i: number) => P[i]!.length === 0 && (firstNon === -1 || i < firstNon || i > lastNon);

  const stride = W.length + 1;
  const failed = new Set<number>();
  const groupCount = new Map<number, number>();
  const groupCache = new Map<number, string[]>();
  const getGroup = (i: number, j: number): string[] | null => {
    const key = i * (n + 1) + j;
    const hit = groupCache.get(key);
    if (hit !== undefined) return hit;
    const c = groupCount.get(i) ?? 0;
    if (c >= cap) {
      stats.capHits++;
      return null;
    }
    groupCount.set(i, c + 1);
    stats.groupCalls++;
    const lines = groupExport(i, j).map(matchKey);
    groupCache.set(key, lines);
    return lines;
  };
  /** `pos` 起的 `sep` 行都是空行。 */
  const blanks = (pos: number, sep: number) => {
    for (let k = 0; k < sep; k++) if (pos + k >= W.length || !Wblank[pos + k]) return false;
    return true;
  };

  const newFrame = (i: number, pos: number): Frame => {
    let jMax = i;
    const fam = fams[i]!;
    if (P[i]!.length > 0 && fam !== null) while (jMax + 1 < n && fams[jMax + 1] === fam) jMax++;
    return { i, pos, stage: isEdgeEmpty(i) ? 0 : 1, sepK: 0, j: jMax, jMax, group: null, perMatched: false, seg: null, segIsGroup: false };
  };

  /** 推進游標，回傳下一個要試的子狀態 `[i', pos']`（並把那一段記在 `f.seg`）；用完回 null。 */
  const nextChild = (f: Frame): [number, number] | null => {
    const seps = f.pos === 0 ? 1 : 2; // pos 0：只試 0 行分隔；其餘：先 1 行、再 0 行
    const sepAt = (k: number) => (f.pos === 0 ? 0 : k === 0 ? 1 : 0);
    if (f.stage === 0) {
      f.stage = 3;
      f.seg = { idx: [f.i], start: f.pos, count: 0 };
      f.segIsGroup = false;
      return [f.i + 1, f.pos];
    }
    if (f.stage === 1) {
      const per = Pk[f.i]!;
      while (f.sepK < seps) {
        const sep = sepAt(f.sepK++);
        if (!blanks(f.pos, sep)) continue;
        const p = f.pos + sep;
        if (per.length === 0) {
          // 中間的空段落：吃一個空行
          if (p < W.length && Wblank[p]) {
            f.perMatched = true;
            f.seg = { idx: [f.i], start: p, count: 1 };
            f.segIsGroup = false;
            return [f.i + 1, p + 1];
          }
          continue;
        }
        const c = matchAt(Wk, p, per, types[f.i] === "numberedListItem");
        if (c >= 0) {
          f.perMatched = true;
          f.seg = { idx: [f.i], start: p, count: c };
          f.segIsGroup = false;
          return [f.i + 1, p + c];
        }
      }
      f.stage = 2;
      f.sepK = 0;
      f.j = f.jMax;
      f.group = null;
    }
    if (f.stage === 2) {
      while (f.j > f.i) {
        if (f.group === null) {
          const g = getGroup(f.i, f.j);
          if (g === null) {
            f.j = f.i; // 超過上限：這個起點的群組全部放棄
            break;
          }
          f.group = g;
          f.sepK = 0;
        }
        while (f.sepK < seps) {
          const sep = sepAt(f.sepK++);
          if (!blanks(f.pos, sep)) continue;
          const p = f.pos + sep;
          const c = matchAt(Wk, p, f.group, false);
          if (c >= 0) {
            const idx: number[] = [];
            for (let k = f.i; k <= f.j; k++) idx.push(k);
            f.seg = { idx, start: p, count: c };
            f.segIsGroup = true;
            return [f.j + 1, p + c];
          }
        }
        f.j--;
        f.group = null;
      }
      f.stage = 3;
    }
    return null;
  };

  const stack: Frame[] = [];
  /** 進入 `(i, pos)`：終點或已知失敗就直接回答，否則推一個 frame。回傳 true＝找到完整解。 */
  const enter = (i: number, pos: number): boolean | null => {
    if (i === n) return pos === W.length;
    if (failed.has(i * stride + pos)) return false;
    stack.push(newFrame(i, pos));
    return null;
  };

  let done = enter(0, 0);
  while (done !== true && stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const child = nextChild(top);
    if (child === null) {
      failed.add(top.i * stride + top.pos);
      stack.pop();
      continue;
    }
    done = enter(child[0], child[1]);
  }
  if (done !== true) return { segs: null, stats };

  const segs: AlignSeg[] = new Array(stack.length);
  for (let k = 0; k < stack.length; k++) {
    const f = stack[k]!;
    segs[k] = f.seg!;
    if (f.segIsGroup && f.perMatched) stats.groupUsedWhilePerMatched++;
  }
  return { segs, stats };
}

/** 每行的比對種類（§8.2 `line_kinds`）：含 numberedListItem 的段的行 → 1，其餘 0；段表 null → 全 0。 */
export function lineKindsOf(segs: AlignSeg[] | null, types: string[], nLines: number): number[] {
  const kinds = new Array<number>(nLines).fill(0);
  if (segs === null) return kinds;
  for (const s of segs) {
    if (!s.idx.some(i => types[i] === "numberedListItem")) continue;
    for (let k = s.start; k < s.start + s.count; k++) kinds[k] = 1;
  }
  return kinds;
}
