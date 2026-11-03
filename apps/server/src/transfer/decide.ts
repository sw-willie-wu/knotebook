/**
 * bulk transfer spec 2026-11-02 §9.4：對現況判定每一區（純函式；只用 id、指紋與 `same` 回呼，不 mount）。plan PR-2 T6。
 *
 * - 每區：`S`＝基底 id、倖存者＝`S` 中還在頂層的（依現況順序）、被改＝倖存者中各自指紋 ≠ 基底那顆的、不見＝`S` − 倖存者。
 * - 決策表（§9.4-2）：改寫——預解析＝倖存者（`same`，`equal`）→ `same`；被改、不見皆空 → `applied`；其他 → `conflict`。倖存者全不見
 *   時改比錨點 `P`..`N` 之間的外來 block（`equal`，§9.4-3 末條）。刪除——倖存者全不見 → `same`；被改空 → `applied`；否則 `conflict`。
 *   插入——預解析整串是 `P`..`N` 之間外來 block 的一段連續子序列（`contiguous`，plan §0.1-16）→ `same`；否則 `applied`。
 * - 錨點 `P`／`N`：往前（後）最近一個 agent 沒改、仍有 block 在頂層的段，取其最後（第一）顆還在的；**0 行段不當錨點**；
 *   `P` 在 `N` 之後 → `P` 不可用。外來＝`cur.ids` 減去**基底全部段**的 id（gate r2 m-7）。
 * - 放置：改寫有倖存者 → 第一個倖存者之前；否則（改寫倖存者全不見、插入）→ `P` 之後、無則 `N` 之前、都無則文件開頭。
 *   `stripStart`＝插入點前一顆是 numbered 且預解析第一顆是 numbered（§9.4-2，E18）。
 * - 刪除區的錨點（rev 4 m-8，守 spec §9.4-4）：候選依序 `P` after、`N` before、現況裡倖存者的實際鄰居（往外掃，外來也可），全部
 *   排除「本次要移除的 block」（所有非 `same` 改寫區與刪除區的倖存者）。找不到：其餘區都是 `same`／刪除、且現況頂層全部要移除
 *   （結果真的會變空）→ `replaceWithEmpty`；否則 `deferred`（`applySync` 在插入與改寫之後、合併之前找實際鄰居）。
 */
import type { TransferSegment } from "../db/schema.js";
import type { Region } from "./regions.js";

export type Mark = "applied" | "same" | "conflict";
/** `placeholder`：刪光時補的那顆空段落（只由 `applySync` 的 toEmpty 設；總管追加 T11-1）。 */
export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };
export type Place = { ref: string; where: "before" | "after" } | { start: true } | { replaceSurvivors: true };
export type SameMode = "equal" | "contiguous";

export interface Decision {
  kind: Region["kind"];
  mark: Mark;
  /** 依現況順序。 */
  survivors: string[];
  changed: string[];
  missing: string[];
  place: Place;
  stripStart: boolean;
  /** `same` 是比外來 block 判的（倖存者全不見的改寫區、插入區）。 */
  preferForeignSame: boolean;
  /** 判 `same` 所依據的外來 block（`P`..`N` 之間的全部外來；併進 `mergeDiff` 的 `expectEach`，gate r2 m-12）。 */
  sameForeign: string[];
  /**
   * 比外來 block 判 `same` 時，比中那一段的最後一顆（R19，複審 F1）：`applySync` 把同一接點的接續鏈尾設成它，
   * 後一區才會接在被吸收的內容之後、不會排到它前面。其他情形 null。
   */
  sameTail: string | null;
  /** 刪除區（非 `same`）才有。 */
  anchor?: Anchor | "deferred" | "replaceWithEmpty";
  P: string | null;
  N: string | null;
}

/**
 * 匯出的純函式（gate r2 I-2）：`equal`＝逐項相等；`contiguous`＝`preparsed` 非空且是 `foreign` 的一段連續子序列。
 * 回比中那一段在 `foreign` 的起點（`equal` 比中恆為 0），沒比中 → -1（複審 F1：`decide` 要知道比中的是哪一段）。
 */
export function foreignContains(preparsed: readonly string[], foreign: readonly string[], mode: SameMode): number {
  if (mode === "equal") return preparsed.length === foreign.length && preparsed.every((x, i) => x === foreign[i]) ? 0 : -1;
  const n = preparsed.length;
  if (n === 0 || n > foreign.length) return -1;
  for (let s = 0; s + n <= foreign.length; s++) {
    let ok = true;
    for (let t = 0; ok && t < n; t++) ok = foreign[s + t] === preparsed[t];
    if (ok) return s;
  }
  return -1;
}

const indexOf = (cur: { ids: string[] }): Map<string, number> => new Map(cur.ids.map((id, i) => [id, i]));

/** 每區的錨點 `P`／`N`（§9.4-2）。 */
export function anchors(segments: TransferSegment[], regions: Region[], cur: { ids: string[] }): Array<{ P: string | null; N: string | null }> {
  const idx = indexOf(cur);
  const inRegion = new Set<number>(regions.flatMap(r => r.segIdx));
  const usable = (k: number) => !inRegion.has(k) && segments[k]!.count > 0;
  const lastPresent = (k: number) => [...segments[k]!.ids].reverse().find(id => idx.has(id)) ?? null;
  const firstPresent = (k: number) => segments[k]!.ids.find(id => idx.has(id)) ?? null;
  return regions.map(r => {
    const before = r.prevSeg === -1 ? (r.segIdx.length > 0 ? r.segIdx[0]! - 1 : -1) : r.prevSeg;
    const after = r.nextSeg === -1 ? (r.segIdx.length > 0 ? r.segIdx[r.segIdx.length - 1]! + 1 : segments.length) : r.nextSeg;
    let P: string | null = null;
    for (let k = before; k >= 0 && P === null; k--) if (usable(k)) P = lastPresent(k);
    let N: string | null = null;
    for (let k = after; k < segments.length && N === null; k++) if (usable(k)) N = firstPresent(k);
    if (P !== null && N !== null && idx.get(P)! > idx.get(N)!) P = null;
    return { P, N };
  });
}

/** 外來 block 與比對範圍（gate r2 m-7；plan §0.1-16）：外來＝`cur.ids` − 基底全部段的 id；範圍照錨點規則。 */
export function foreignInRange(
  segments: TransferSegment[],
  cur: { ids: string[] },
  P: string | null,
  N: string | null,
  pre: { idx?: Map<string, number>; baseIds?: Set<string> } = {},
): string[] {
  const baseIds = pre.baseIds ?? new Set(segments.flatMap(s => s.ids));
  const idx = pre.idx ?? indexOf(cur);
  let lo = 0;
  let hi = cur.ids.length;
  const pi = P === null ? undefined : idx.get(P);
  const ni = N === null ? undefined : idx.get(N);
  if (pi !== undefined && (ni === undefined || pi < ni)) lo = pi + 1;
  if (ni !== undefined) hi = ni;
  return cur.ids.slice(lo, hi).filter(id => !baseIds.has(id));
}

/** `applySync` 的接續鏈 key：同一顆 `P` 之後、文件開頭有多區時，後一區接在前一區之後（`before` 天然保序，不需要鏈）。 */
export function chainKeyOf(place: Place): string | null {
  if ("ref" in place) return place.where === "after" ? `after:${place.ref}` : null;
  return "start" in place ? "start" : null;
}

/** §9.4-2（E18）：插入點前一顆是 numbered 且預解析第一顆是 numbered → 拿掉預解析第一顆的 `start`。`sync-plan.ts` 套用、`decide` 記錄，同一支。 */
export function shouldStripStart(prevType: string | null, firstType: string | undefined): boolean {
  return prevType === "numberedListItem" && firstType === "numberedListItem";
}

/**
 * 預解析要放的位置（決策之前就定得出來：只看倖存者與錨點），以及插入點前一顆的型別（`stripStart` 用）。
 * 改寫有倖存者 → 第一個倖存者之前；否則 `P` 之後、無則 `N` 之前、都無則文件開頭。
 */
export function placeFor(
  r: Region,
  cur: { ids: string[]; types: string[] },
  a: { P: string | null; N: string | null },
  pre: { idx?: Map<string, number> } = {},
): { place: Place; prevType: string | null } {
  const idx = pre.idx ?? indexOf(cur);
  const prevTypeOf = (i: number) => (i > 0 ? cur.types[i - 1]! : null);
  if (r.kind === "rewrite") {
    const firstSurvivor = r.baseIds.map(id => idx.get(id)).filter((i): i is number => i !== undefined).sort((x, y) => x - y)[0];
    if (firstSurvivor !== undefined) return { place: { ref: cur.ids[firstSurvivor]!, where: "before" }, prevType: prevTypeOf(firstSurvivor) };
  }
  if (a.P !== null) return { place: { ref: a.P, where: "after" }, prevType: cur.types[idx.get(a.P)!]! };
  if (a.N !== null) return { place: { ref: a.N, where: "before" }, prevType: prevTypeOf(idx.get(a.N)!) };
  return { place: { start: true }, prevType: null };
}

export function decide(
  segments: TransferSegment[],
  regions: Region[],
  cur: { ids: string[]; fps: string[]; types: string[] },
  /** 回比中那一段在 `against` 的起點，沒比中 → -1（`foreignContains` 的語意）。 */
  same: (ri: number, against: string[], mode: SameMode) => number,
  opts: { firstTypes?: ReadonlyArray<string | undefined>; prevTypes?: ReadonlyArray<string | null>; preLengths?: ReadonlyArray<number> } = {},
): Decision[] {
  // 審查 Important 1：索引與基底 id 集合只建一次，傳給 placeFor／foreignInRange（逐區重建是 O(區數×頂層數)）。
  const idx = indexOf(cur);
  const baseIds = new Set(segments.flatMap(s => s.ids));
  const anc = anchors(segments, regions, cur);
  const out: Decision[] = regions.map((r, ri) => {
    const baseFp = new Map(r.baseIds.map((id, i) => [id, r.baseFps[i]!]));
    const survivors = r.baseIds.filter(id => idx.has(id)).sort((x, y) => idx.get(x)! - idx.get(y)!);
    const changed = survivors.filter(id => cur.fps[idx.get(id)!] !== baseFp.get(id));
    const missing = r.baseIds.filter(id => !idx.has(id));
    const { P, N } = anc[ri]!;
    const placed = placeFor(r, cur, anc[ri]!, { idx });
    const place = placed.place;
    // `sync-plan.ts` 依接續鏈算出的實際前一顆型別優先（同一接點的後一區接在前一區之後）。
    const prevType = opts.prevTypes?.[ri] !== undefined ? opts.prevTypes[ri]! : placed.prevType;
    const firstType = opts.firstTypes?.[ri];
    const stripStart = r.kind !== "delete" && shouldStripStart(prevType, firstType);
    const base = { kind: r.kind, survivors, changed, missing, stripStart, P, N };
    if (r.kind === "delete") {
      if (survivors.length === 0) return { ...base, mark: "same", place: { replaceSurvivors: true }, preferForeignSame: false, sameForeign: [], sameTail: null };
      return { ...base, mark: changed.length === 0 ? "applied" : "conflict", place: { replaceSurvivors: true }, preferForeignSame: false, sameForeign: [], sameTail: null };
    }
    if (r.kind === "insert") {
      const foreign = foreignInRange(segments, cur, P, N, { idx, baseIds });
      const at = same(ri, foreign, "contiguous");
      if (at >= 0) return { ...base, mark: "same", place, preferForeignSame: true, sameForeign: foreign, sameTail: foreign[at + Math.max(1, opts.preLengths?.[ri] ?? 1) - 1] ?? null };
      return { ...base, mark: "applied", place, preferForeignSame: false, sameForeign: [], sameTail: null };
    }
    if (survivors.length > 0) {
      if (same(ri, survivors, "equal") >= 0) return { ...base, mark: "same", place: { replaceSurvivors: true }, preferForeignSame: false, sameForeign: [], sameTail: null };
    } else {
      const foreign = foreignInRange(segments, cur, P, N, { idx, baseIds });
      if (same(ri, foreign, "equal") >= 0) return { ...base, mark: "same", place, preferForeignSame: true, sameForeign: foreign, sameTail: foreign[foreign.length - 1] ?? null };
    }
    return { ...base, mark: changed.length === 0 && missing.length === 0 ? "applied" : "conflict", place, preferForeignSame: false, sameForeign: [], sameTail: null };
  });

  // 刪除區的錨點（rev 4 m-8）：候選排除本次要移除的 block。
  const removing = new Set<string>();
  for (const d of out) if (d.mark !== "same" && (d.kind === "rewrite" || d.kind === "delete")) for (const id of d.survivors) removing.add(id);
  // 「本次會寫入內容的區」（非 same 的改寫與插入）有幾個——刪除區自己不算在內，所以只看總數是否為 0（O(1)，不逐區重掃）。
  const writing = out.filter(d => d.mark !== "same" && d.kind !== "delete").length;
  const allRemoved = cur.ids.every(id => removing.has(id));
  out.forEach(d => {
    if (d.kind !== "delete" || d.mark === "same") return;
    let anchor: Anchor | null = null;
    if (d.P !== null && !removing.has(d.P)) anchor = { block_id: d.P, position: "after" };
    else if (d.N !== null && !removing.has(d.N)) anchor = { block_id: d.N, position: "before" };
    else {
      const first = idx.get(d.survivors[0]!)!;
      const last = idx.get(d.survivors[d.survivors.length - 1]!)!;
      for (let i = first - 1; i >= 0 && anchor === null; i--) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "after" };
      for (let i = last + 1; i < cur.ids.length && anchor === null; i++) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "before" };
      // 審查 m1：往外掃不到 → 倖存者區間內、不在移除之列的 block（例：人在 A、B 之間插了 F，agent 刪 A、B → anchor＝F）。
      // 不這樣找，會落到 replaceWithEmpty／deferred 而多出一顆空段落（§9.4-4）。位置取 before：撤回時插回 F 之前。
      for (let i = first + 1; i < last && anchor === null; i++) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "before" };
    }
    d.anchor = anchor ?? (writing === 0 && allRemoved ? "replaceWithEmpty" : "deferred");
  });
  return out;
}
