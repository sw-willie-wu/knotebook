import { diffWordsWithSpace } from "diff";

/**
 * 版本預覽的 diff（spec §8.4，A7：在 client 算）。純函式、不碰 DOM、不碰 Y.Doc。
 *
 * 配對是**逐層**的（起草裁定 11）：只在同一個父的子清單之間配對，所以跨層搬移＝刪除＋新增（§13-7）。
 * 同一層內分三道（spec rev 11 §8.4 規則 1，每道只處理前一道剩下的）：1a 以 `id` 配對——但內容不同的一對若任一顆
 * 的內容在對側未配對區塊裡有完全相同、且己側沒有別顆能接走的，就讓位（區塊開頭按 Enter：舊 id 留在空區塊、原文字
 * 換新 id）；1b 內容完全相同者依出現順序配（整篇貼上重發所有 id）；1c 文字型區塊在候選帶內取 token bigram Dice
 * 最高且 ≥ 0.5 者配（空的文字型區塊 token 為 0，不做 1c）。兩側都是空文字區塊的對子不標 moved。
 * `moved` 對三道的全部對子一起算 LIS。
 * 渲染 id：b 側（新增、保留）沿用 b 的 id；刪除的區塊與其子孫一律換合成 id `diff-del-<n>`（§8.4-4）——
 * 否則「父刪子升」時 a 側的子和 b 側的同一顆會撞 id。缺 id 或同一側重複出現的 id（RF1：壞掉的快照）一律
 * 當成無法配對：b 側合成 `diff-anon-<n>` 當新增、a 側當刪除。
 */
export interface DiffBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: DiffBlock[];
}
export type DiffStatus = "added" | "deleted" | "changed" | "unchanged";
export type DiffMark = "added" | "deleted" | "changed" | "moved" | "context" | "collapsed";
export interface DiffEntry {
  key: string;
  status: DiffStatus;
  moved: boolean;
  before: DiffBlock | null;
  after: DiffBlock | null;
  children: DiffEntry[];
}
export interface DiffMarkInfo {
  mark: DiffMark;
  moved: boolean;
  nonText: boolean;
}
export interface DiffRender {
  blocks: DiffBlock[];
  marks: Map<string, DiffMarkInfo>;
}

/** inline diff 只做這六種有 inline content 的型別（spec §8.4-5）；其餘只標 changed、內容取 b。 */
export const INLINE_DIFF_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
]);

interface Ctx {
  del: number;
  anon: number;
}

const shallow = (b: DiffBlock) => JSON.stringify({ type: b.type, props: b.props ?? {}, content: b.content ?? null });

/** 每個值在序列中的位置；回最長遞增子序列所佔的位置集合（O(n log n)）。 */
function lisPositions(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    keep.add(k);
    k = prev[k];
  }
  return keep;
}

/** 同一層內「可配對」的 id：非空字串、且在該層只出現一次。 */
function pairableIds(level: readonly DiffBlock[]): Set<string> {
  const seen = new Map<string, number>();
  for (const b of level) if (typeof b.id === "string" && b.id !== "") seen.set(b.id, (seen.get(b.id) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n === 1).map(([id]) => id));
}

function deletedSubtree(b: DiffBlock, ctx: Ctx): DiffEntry {
  ctx.del += 1;
  const key = `diff-del-${ctx.del}`;
  return { key, status: "deleted", moved: false, before: b, after: null, children: (b.children ?? []).map((c) => deletedSubtree(c, ctx)) };
}

function addedSubtree(b: DiffBlock, ctx: Ctx, pairable: boolean): DiffEntry {
  let key = b.id ?? "";
  if (!pairable) {
    ctx.anon += 1;
    key = `diff-anon-${ctx.anon}`;
  }
  const childIds = pairableIds(b.children ?? []);
  return {
    key,
    status: "added",
    moved: false,
    before: null,
    after: b,
    children: (b.children ?? []).map((c) => addedSubtree(c, ctx, typeof c.id === "string" && childIds.has(c.id))),
  };
}

/** 1c 的候選帶半寬（a 未配對序列中的位置差）與相似度門檻（spec rev 11 §8.4 規則 1c）。 */
export const FUZZY_WINDOW = 30;
export const FUZZY_THRESHOLD = 0.5;
/** 1c 兩側 token 至少要這麼多（bigram ≥ 3）才比；更短的只靠 1b 的完全相等。 */
export const FUZZY_MIN_TOKENS = 4;

/** 區塊的純文字（與 inline diff 同一套攤平；非文字 inline 如 wikilink 算一個 U+FFFC）。 */
function textOf(b: DiffBlock): string {
  return flatten(b.content)
    .map((u) => u.ch)
    .join("");
}

const LATIN_OR_DIGIT = /[\p{Script=Latin}\p{Nd}]/u;
const SEPARATOR = /[\s\p{P}]/u;

/**
 * 切 token（spec §8.4 規則 1c，review I-1）：連續的拉丁字母／數字一段為一個 token；其他字元（CJK、emoji、
 * U+FFFC 等）每個 code point 各自一個 token；空白與標點只當分隔、不成 token。
 * 字元 bigram 在英文上太寬鬆（同主題不相關段落常過 0.5），token bigram 對英文是詞對、對中文仍是字對。
 */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  let run = "";
  for (const ch of text) {
    if (LATIN_OR_DIGIT.test(ch)) {
      run += ch;
      continue;
    }
    if (run) out.push(run);
    run = "";
    if (!SEPARATOR.test(ch)) out.push(ch);
  }
  if (run) out.push(run);
  return out;
}

/** token bigram（相鄰 token 對）的多重集合；回 [集合, bigram 個數]。 */
function bigrams(tokens: readonly string[]): [Map<string, number>, number] {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const g = `${tokens[i]}\u0001${tokens[i + 1]}`;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return [m, Math.max(0, tokens.length - 1)];
}

/**
 * 兩個 bigram 多重集合的 Dice 係數。給了 `floor` 時，一旦證明結果必定 < floor 就提早回 -1
 * （剩下的 bigram 全數命中也到不了）——互不相似的長段落大多在掃到一半前就能放棄。
 */
function diceOf(x: Map<string, number>, xn: number, y: Map<string, number>, yn: number, floor = 0): number {
  if (xn + yn === 0) return 0;
  const [small, big, smallN] = x.size <= y.size ? [x, y, xn] : [y, x, yn];
  const need = (floor * (xn + yn)) / 2; // 交集至少要這麼大才 ≥ floor
  let inter = 0;
  let left = smallN; // small 裡還沒掃的 bigram 個數（含重複）
  for (const [g, n] of small) {
    inter += Math.min(n, big.get(g) ?? 0);
    left -= n;
    if (inter + left < need) return -1;
  }
  return (2 * inter) / (xn + yn);
}

/**
 * token bigram Dice 係數：2·|A∩B| ÷ (|A|+|B|)（多重集合交集）。任一側沒有 bigram（token < 2）→ 0。
 * （1c 另要求兩側 token ≥ `FUZZY_MIN_TOKENS` 才比；這裡不管那條，量測與單元測試用。）
 */
export function bigramDice(a: string, b: string): number {
  const [ga, na] = bigrams(tokensOf(a));
  const [gb, nb] = bigrams(tokensOf(b));
  if (na === 0 || nb === 0) return 0;
  return diceOf(ga, na, gb, nb);
}

/** INLINE 型且沒有任何文字的區塊（空段落等）：照常配對，但兩側都是空的對子不參與 LIS、不標 moved（review M-2：空行 moved 是雜訊）。 */
function isBlankText(b: DiffBlock): boolean {
  return INLINE_DIFF_TYPES.has(b.type) && textOf(b) === "";
}

/**
 * 同一層的三道配對（spec rev 11 §8.4 規則 1）。只在**可配對**的區塊之間進行（RF1：缺 id、同層重複 id 一律不配）。
 * 回傳 b 索引 → a 索引。
 */
function pairLevel(a: readonly DiffBlock[], b: readonly DiffBlock[], aOk: Set<string>, bOk: Set<string>): Map<number, number> {
  const aCan = a.map((blk) => typeof blk.id === "string" && aOk.has(blk.id));
  const bCan = b.map((blk) => typeof blk.id === "string" && bOk.has(blk.id));
  const aKey = a.map(shallow);
  const bKey = b.map(shallow);
  const aIndexById = new Map<string, number>();
  a.forEach((blk, i) => {
    if (aCan[i]) aIndexById.set(blk.id!, i);
  });

  // 讓位池的材料：所有可配對區塊，**含空的文字型區塊**——在文末空段落打字時 BlockNote 會補一顆新的空段落，
  // 舊 id 那顆（原本空）讓位、兩顆空段落以 1b 配成 unchanged，新字才會是 added（修正輪 2 裁定）。
  // 空段落對子不參與 moved（見 diffLevel）；1c 因 token 數為 0 本來就不做。
  const aMat = aCan;
  const bMat = bCan;

  // 1a id 配對：同 id 且 shallow 相等 → 固定。不相等時，若某一顆的內容在對側未配對池裡「多出來」（對側池中相等者的
  // 個數 > 己側池中相等者的個數，即己側沒有別顆能接走它）→ 讓位（拆開回池）——解「區塊開頭按 Enter」。
  // 只看「有沒有」會在同層有重複內容時交叉配對、生出假 moved（review M-1），所以比個數。
  // 未配對池＝內容材料中不在 id 對子裡的＋已讓位的。讓位會讓池變大、可能觸發另一對讓位（連鎖），所以依 b 順序
  // 重跑到不再有新的讓位為止。
  const idPairs: Array<[number, number]> = []; // [bi, ai]，依 b 順序
  b.forEach((blk, bi) => {
    if (!bCan[bi]) return;
    const ai = aIndexById.get(blk.id!);
    if (ai !== undefined) idPairs.push([bi, ai]);
  });
  const aInIdPair = new Set<number>(idPairs.map(([, ai]) => ai));
  const bInIdPair = new Set<number>(idPairs.map(([bi]) => bi));
  const aPool = new Map<string, number>(); // 池中區塊的 shallow → 個數
  const bPool = new Map<string, number>();
  const bump = (pool: Map<string, number>, key: string) => pool.set(key, (pool.get(key) ?? 0) + 1);
  a.forEach((_, ai) => {
    if (aMat[ai] && !aInIdPair.has(ai)) bump(aPool, aKey[ai]);
  });
  b.forEach((_, bi) => {
    if (bMat[bi] && !bInIdPair.has(bi)) bump(bPool, bKey[bi]);
  });
  const surplus = (key: string, there: Map<string, number>, here: Map<string, number>) => (there.get(key) ?? 0) > (here.get(key) ?? 0);
  const contested = idPairs.filter(([bi, ai]) => aKey[ai] !== bKey[bi]);
  const yielded = new Set<number>(); // 讓位的 b 索引
  for (let grew = true; grew; ) {
    grew = false;
    for (const [bi, ai] of contested) {
      if (yielded.has(bi)) continue;
      const aWanted = aMat[ai] && surplus(aKey[ai], bPool, aPool);
      const bWanted = bMat[bi] && surplus(bKey[bi], aPool, bPool);
      if (!aWanted && !bWanted) continue;
      yielded.add(bi);
      if (aMat[ai]) bump(aPool, aKey[ai]);
      if (bMat[bi]) bump(bPool, bKey[bi]);
      grew = true;
    }
  }
  const pairs = new Map<number, number>();
  const aUsed = new Set<number>();
  for (const [bi, ai] of idPairs) {
    if (yielded.has(bi)) continue;
    pairs.set(bi, ai);
    aUsed.add(ai);
  }

  // 1b 內容精確配對：shallow 完全相等者依出現順序一一配（所有型別，含空的文字型區塊）。
  const byKey = new Map<string, number[]>();
  a.forEach((_, ai) => {
    if (!aCan[ai] || aUsed.has(ai)) return;
    const list = byKey.get(aKey[ai]);
    if (list) list.push(ai);
    else byKey.set(aKey[ai], [ai]);
  });
  const cursor = new Map<string, number>();
  b.forEach((_, bi) => {
    if (!bCan[bi] || pairs.has(bi)) return;
    const list = byKey.get(bKey[bi]);
    const k = cursor.get(bKey[bi]) ?? 0;
    if (!list || k >= list.length) return;
    cursor.set(bKey[bi], k + 1);
    pairs.set(bi, list[k]);
    aUsed.add(list[k]);
  });

  // 1c 文字相似配對：同 type、屬 INLINE_DIFF_TYPES、兩側 token ≥ FUZZY_MIN_TOKENS；在 a 未配對序列的候選帶內取
  // token bigram Dice 最高且 ≥ 門檻者（同分取前者）。
  // 候選帶的中心＝上一次 1c 配到的 a 在未配對序列中的位置＋1（起點 0）：b 側配不到的新區塊不推移中心，所以前面插入
  // 任意多顆新區塊仍配得到（照 b 在未配對序列中的位置當中心的話，b 側插入與 a 側刪除的淨差超過帶寬就整段配不到）。
  // 代價：a 側連續超過帶寬顆都配不到時，中心追不上，其後整段退回刪＋增（不會配錯）。
  type Fuzzy = { idx: number; type: string; grams: Map<string, number>; n: number };
  const fuzzyOf = (blk: DiffBlock, idx: number): Fuzzy | null => {
    if (!INLINE_DIFF_TYPES.has(blk.type)) return null;
    const tokens = tokensOf(textOf(blk));
    if (tokens.length < FUZZY_MIN_TOKENS) return null;
    const [grams, n] = bigrams(tokens);
    return { idx, type: blk.type, grams, n };
  };
  const aRest: Array<Fuzzy | null> = [];
  a.forEach((blk, ai) => {
    if (aCan[ai] && !aUsed.has(ai)) aRest.push(fuzzyOf(blk, ai));
  });
  const restTaken = new Array<boolean>(aRest.length).fill(false);
  let center = 0;
  b.forEach((blk, bi) => {
    if (!bCan[bi] || pairs.has(bi)) return;
    const fb = fuzzyOf(blk, bi);
    if (!fb) return;
    let best = -1;
    let bestScore = FUZZY_THRESHOLD;
    const hi = Math.min(aRest.length - 1, center + FUZZY_WINDOW);
    for (let r = Math.max(0, center - FUZZY_WINDOW); r <= hi; r += 1) {
      const fa = aRest[r];
      if (!fa || restTaken[r] || fa.type !== fb.type) continue;
      // Dice 的上界是 2·min/(和)：連上界都低於目前最佳（或門檻）就不必算交集。
      if ((2 * Math.min(fa.n, fb.n)) / (fa.n + fb.n) < bestScore) continue;
      const score = diceOf(fa.grams, fa.n, fb.grams, fb.n, bestScore);
      if (best === -1 ? score >= bestScore : score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (best === -1) return;
    restTaken[best] = true;
    pairs.set(bi, aRest[best]!.idx);
    center = best + 1;
  });
  return pairs;
}

function diffLevel(a: readonly DiffBlock[], b: readonly DiffBlock[], ctx: Ctx): DiffEntry[] {
  const bOk = pairableIds(b);
  const pairs = pairLevel(a, b, pairableIds(a), bOk); // b 索引 → a 索引
  const pairedA = new Map<number, number>(); // a 索引 → b 索引
  for (const [bi, ai] of pairs) pairedA.set(ai, bi);

  // moved：三道配對的全部對子一起，依 b 順序取 a 索引做 LIS（規則 3）。兩側都是空文字區塊的對子不參與、moved 恆 false
  // （空行的相對順序沒有意義，標 moved 只是雜訊；review M-2／修正輪 2）。
  const commonB = b.map((_, bi) => bi).filter((bi) => pairs.has(bi) && !(isBlankText(b[bi]) && isBlankText(a[pairs.get(bi)!])));
  const keep = lisPositions(commonB.map((bi) => pairs.get(bi)!));
  const moved = new Set(commonB.filter((_, i) => !keep.has(i)));

  const out: DiffEntry[] = [];
  const posOfB = new Array<number>(b.length).fill(-1); // b 索引 → 在 out 裡的位置
  b.forEach((blk, bi) => {
    const ai = pairs.get(bi);
    if (ai !== undefined) {
      const before = a[ai];
      out.push({
        key: blk.id!, // 配到的 b 一定可配對（b 內唯一）
        status: shallow(before) === shallow(blk) ? "unchanged" : "changed",
        moved: moved.has(bi),
        before,
        after: blk,
        children: diffLevel(before.children ?? [], blk.children ?? [], ctx),
      });
    } else {
      out.push(addedSubtree(blk, ctx, typeof blk.id === "string" && bOk.has(blk.id)));
    }
    posOfB[bi] = out.length - 1;
  });

  // 刪除：依 a 的順序，插在「a 裡它前一顆已配對區塊」（在 out 裡的位置）之後（同一錨點後的多顆刪除維持 a 的順序）；沒有就放開頭。
  // 錨點跳過「兩側皆空文字、且 id 不同」的對子（＝靠 1b 配起來的空行）：1b 會把被刪的空行配給任意遠處的新空行，
  // 拿它當錨點會讓緊接其後被刪的段落顯示到遠處（fix2 review I-A）。
  let headInsert = 0;
  const afterCount = new Map<number, number>(); // 錨點 b 索引 → 其後已插幾顆
  for (let i = 0; i < a.length; i += 1) {
    if (pairedA.has(i)) continue;
    let anchor: number | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const bj = pairedA.get(j);
      if (bj !== undefined && !(isBlankText(a[j]) && isBlankText(b[bj]) && a[j].id !== b[bj].id)) {
        anchor = bj;
        break;
      }
    }
    const entry = deletedSubtree(a[i], ctx);
    let at: number;
    if (anchor === null) {
      at = headInsert;
      headInsert += 1;
    } else {
      const n = afterCount.get(anchor) ?? 0;
      at = posOfB[anchor] + 1 + n;
      afterCount.set(anchor, n + 1);
    }
    out.splice(at, 0, entry);
    for (let k = 0; k < posOfB.length; k += 1) if (posOfB[k] >= at) posOfB[k] += 1;
  }
  return out;
}

export function diffBlocks(a: readonly DiffBlock[], b: readonly DiffBlock[]): DiffEntry[] {
  return diffLevel(a, b, { del: 0, anon: 0 });
}

export function markOf(e: DiffEntry): DiffMark {
  if (e.status === "added" || e.status === "deleted" || e.status === "changed") return e.status;
  return e.moved ? "moved" : "context";
}

// ── inline 重組 ────────────────────────────────────────────────────────────────

type Styles = Record<string, unknown>;
interface Unit {
  ch: string;
  styles: Styles;
  href?: string;
  node?: unknown;
}
const OBJ = "\uFFFC";

function flatten(content: unknown): Unit[] {
  const units: Unit[] = [];
  if (!Array.isArray(content)) return units;
  for (const item of content as Array<Record<string, unknown>>) {
    if (item.type === "text") {
      for (const ch of Array.from(String(item.text ?? ""))) units.push({ ch, styles: (item.styles as Styles) ?? {} });
    } else if (item.type === "link") {
      for (const inner of (item.content as Array<Record<string, unknown>>) ?? []) {
        for (const ch of Array.from(String(inner.text ?? ""))) units.push({ ch, styles: (inner.styles as Styles) ?? {}, href: String(item.href) });
      }
    } else {
      units.push({ ch: OBJ, styles: {}, node: item });
    }
  }
  return units;
}

function regroup(units: Unit[]): unknown[] {
  const out: Array<Record<string, unknown>> = [];
  for (const u of units) {
    if (u.node !== undefined) {
      out.push(u.node as Record<string, unknown>);
      continue;
    }
    const text = { type: "text", text: u.ch, styles: u.styles };
    const last = out[out.length - 1];
    if (u.href !== undefined) {
      if (last?.type === "link" && last.href === u.href) {
        const inner = last.content as Array<Record<string, unknown>>;
        const tail = inner[inner.length - 1];
        if (JSON.stringify(tail.styles) === JSON.stringify(u.styles)) tail.text = String(tail.text) + u.ch;
        else inner.push(text);
      } else {
        out.push({ type: "link", href: u.href, content: [text] });
      }
    } else if (last?.type === "text" && JSON.stringify(last.styles) === JSON.stringify(u.styles)) {
      last.text = String(last.text) + u.ch;
    } else {
      out.push(text);
    }
  }
  return out;
}

function inlineDiff(aContent: unknown, bContent: unknown): unknown[] {
  const ua = flatten(aContent);
  const ub = flatten(bContent);
  const parts = diffWordsWithSpace(ua.map((u) => u.ch).join(""), ub.map((u) => u.ch).join(""));
  const out: Unit[] = [];
  let ia = 0;
  let ib = 0;
  for (const part of parts) {
    const n = Array.from(part.value).length;
    if (part.added) {
      for (const u of ub.slice(ib, ib + n)) out.push(u.node !== undefined ? u : { ...u, styles: { ...u.styles, backgroundColor: "green" } });
      ib += n;
    } else if (part.removed) {
      for (const u of ua.slice(ia, ia + n)) out.push(u.node !== undefined ? u : { ...u, styles: { ...u.styles, strike: true, backgroundColor: "red" } });
      ia += n;
    } else {
      out.push(...ub.slice(ib, ib + n));
      ia += n;
      ib += n;
    }
  }
  return regroup(out);
}

// ── 渲染 ───────────────────────────────────────────────────────────────────────

function hasChange(e: DiffEntry): boolean {
  return markOf(e) !== "context" || e.children.some(hasChange);
}

function renderLevel(entries: DiffEntry[], marks: Map<string, DiffMarkInfo>, opts: { onlyChanges: boolean; collapsedText: (n: number) => string }, ctx: { collapsed: number }): DiffBlock[] {
  const out: DiffBlock[] = [];
  let run = 0;
  const flush = () => {
    if (run === 0) return;
    ctx.collapsed += 1;
    const id = `diff-ctx-${ctx.collapsed}`;
    out.push({ id, type: "paragraph", props: {}, content: [{ type: "text", text: opts.collapsedText(run), styles: {} }], children: [] });
    marks.set(id, { mark: "collapsed", moved: false, nonText: false });
    run = 0;
  };
  for (const e of entries) {
    if (opts.onlyChanges && !hasChange(e)) {
      run += 1;
      continue;
    }
    flush();
    const src = (e.status === "deleted" ? e.before : e.after)!;
    const mark = markOf(e);
    const nonText = e.status === "changed" && !INLINE_DIFF_TYPES.has(src.type);
    const content = e.status === "changed" && !nonText ? inlineDiff(e.before!.content, e.after!.content) : src.content;
    out.push({ ...src, id: e.key, content, children: renderLevel(e.children, marks, opts, ctx) });
    if (mark !== "context") marks.set(e.key, { mark, moved: e.moved, nonText });
  }
  flush();
  return out;
}

export function renderDiff(entries: DiffEntry[], opts: { onlyChanges?: boolean; collapsedText?: (n: number) => string } = {}): DiffRender {
  const marks = new Map<string, DiffMarkInfo>();
  const blocks = renderLevel(entries, marks, { onlyChanges: opts.onlyChanges ?? false, collapsedText: opts.collapsedText ?? ((n) => `… ${n} …`) }, { collapsed: 0 });
  if (blocks.length === 0) return { blocks: [{ id: "diff-empty", type: "paragraph" }], marks };
  return { blocks, marks };
}

/** 並排：左（a）標 deleted／changed，右（b）標 added／changed／moved；key 一律用原始 id（各自一顆編輯器、不會撞）。 */
export function sideBySideMarks(entries: DiffEntry[]): { left: Map<string, DiffMark>; right: Map<string, DiffMark> } {
  const left = new Map<string, DiffMark>();
  const right = new Map<string, DiffMark>();
  const walk = (es: DiffEntry[]) => {
    for (const e of es) {
      const m = markOf(e);
      if (e.status === "deleted" && e.before?.id) left.set(e.before.id, "deleted");
      if (e.status === "changed" && e.before?.id) left.set(e.before.id, "changed");
      if ((m === "added" || m === "changed" || m === "moved") && e.after?.id && !e.key.startsWith("diff-")) right.set(e.after.id, m);
      walk(e.children);
    }
  };
  walk(entries);
  return { left, right };
}
