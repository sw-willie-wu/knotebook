import { diffWordsWithSpace } from "diff";

/**
 * 版本預覽的 diff（spec §8.4，A7：在 client 算）。純函式、不碰 DOM、不碰 Y.Doc。
 *
 * 配對是**逐層**的（起草裁定 11）：只在同一個父的子清單之間以 `id` 配對，所以跨層搬移＝刪除＋新增（§13-7）。
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

function diffLevel(a: readonly DiffBlock[], b: readonly DiffBlock[], ctx: Ctx): DiffEntry[] {
  const aOk = pairableIds(a);
  const bOk = pairableIds(b);
  const both = new Set([...aOk].filter((id) => bOk.has(id)));
  const aIndex = new Map<string, number>();
  a.forEach((blk, i) => {
    if (blk.id !== undefined && both.has(blk.id)) aIndex.set(blk.id, i);
  });

  const common = b.filter((blk) => blk.id !== undefined && both.has(blk.id));
  const keep = lisPositions(common.map((blk) => aIndex.get(blk.id!)!));
  const moved = new Set(common.filter((_, i) => !keep.has(i)).map((blk) => blk.id!));

  const out: DiffEntry[] = [];
  const posOf = new Map<string, number>(); // b 側 id → 在 out 裡的位置
  for (const blk of b) {
    if (blk.id !== undefined && both.has(blk.id)) {
      const before = a[aIndex.get(blk.id)!];
      out.push({
        key: blk.id,
        status: shallow(before) === shallow(blk) ? "unchanged" : "changed",
        moved: moved.has(blk.id),
        before,
        after: blk,
        children: diffLevel(before.children ?? [], blk.children ?? [], ctx),
      });
    } else {
      out.push(addedSubtree(blk, ctx, typeof blk.id === "string" && bOk.has(blk.id)));
    }
    posOf.set(out[out.length - 1].key, out.length - 1);
  }

  // 刪除：依 a 的順序，插在「a 裡它前一顆存活區塊」之後（同一顆存活區塊後的多顆刪除維持 a 的順序）；沒有就放開頭。
  let headInsert = 0;
  const afterCount = new Map<string, number>();
  for (let i = 0; i < a.length; i += 1) {
    const blk = a[i];
    if (blk.id !== undefined && both.has(blk.id)) continue;
    let anchor: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const cand = a[j].id;
      if (cand !== undefined && both.has(cand)) {
        anchor = cand;
        break;
      }
    }
    const entry = deletedSubtree(blk, ctx);
    let at: number;
    if (anchor === null) {
      at = headInsert;
      headInsert += 1;
    } else {
      const n = afterCount.get(anchor) ?? 0;
      at = posOf.get(anchor)! + 1 + n;
      afterCount.set(anchor, n + 1);
    }
    out.splice(at, 0, entry);
    for (const [k, v] of posOf) if (v >= at) posOf.set(k, v + 1);
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
