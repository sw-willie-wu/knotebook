/**
 * bulk transfer spec 2026-11-02 §9.4：判定每一區（純函式；只用 id 與 `same` 回呼，不 mount）。plan PR-2 T6。
 *
 * **前提**（呼叫端 `NoteWriteService.syncFile` 先驗，不再三方合併）：筆記自下載後沒有被動過——
 * 現況頂層與基底段表逐顆相同（id、單顆指紋、順序）。動過就整篇 409 `note_changed`，走不到這裡。所以每區的基底 block 都在、
 * 都沒被改，現況也沒有基底以外的 block。唯一例外（審查 M1）：基底 0 顆、現況恰一顆空段落（`isLoneEmptyParagraph`）——只有一個插入區、
 * 放在文件開頭，`applySync` 把那顆當正規化出的空段落換掉。
 *
 * - 決策：改寫——預解析＝基底那幾顆（`same`，canonical 逐顆相等）→ `same`（不寫、id 不換）；否則 `applied`。刪除、插入 → `applied`。
 * - 錨點 `P`／`N`：往前（後）最近一個 agent 沒改的段，取其最後（第一）顆；**0 行段不當錨點**。
 * - 放置：改寫 → 第一顆基底 block 之前（套用時插入新的、再移除基底那幾顆）；插入 → `P` 之後、無則 `N` 之前、都無則文件開頭。
 *   `stripStart`＝插入點前一顆是 numbered 且預解析第一顆是 numbered（§9.4-2，E18）。
 * - 刪除區的錨點（守 spec §9.4-4）：`P` after、無則 `N` before（`P`、`N` 都不在任何區裡，不會被這次移除）；都沒有 → 往外掃現況
 *   鄰居，排除「本次要移除的 block」（所有非 `same` 改寫區與刪除區的基底 block）。找不到：其餘區都是 `same`／刪除、且現況頂層
 *   全部要移除（結果真的會變空）→ `replaceWithEmpty`；否則 `deferred`（`applySync` 在插入與改寫之後、合併之前找實際鄰居）。
 */
import * as Y from "yjs";
import { topLevelContainers } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import type { Region } from "./regions.js";

export type Mark = "applied" | "same";
/** `placeholder`：刪光時補的那顆空段落（只由 `applySync` 的 toEmpty 設）。 */
export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };
export type Place = { ref: string; where: "before" | "after" } | { start: true } | { replaceSurvivors: true };

export interface Decision {
  kind: Region["kind"];
  mark: Mark;
  /** 區內的基底 block（＝現況裡的那幾顆，文件順序）；插入區空。 */
  survivors: string[];
  place: Place;
  stripStart: boolean;
  /** 刪除區（非 `same`）才有。 */
  anchor?: Anchor | "deferred" | "replaceWithEmpty";
  P: string | null;
  N: string | null;
}

/**
 * 上面那條前提的判準：現況頂層的 id 與單顆指紋，依序逐顆等於基底段表攤平後的 id 與指紋（段表涵蓋每一顆頂層 block，`align.ts`）。
 * 不等 → 呼叫端回 409 `note_changed`。
 */
export function matchesBase(segments: readonly TransferSegment[], cur: { ids: readonly string[]; fps: readonly string[] }): boolean {
  let k = 0;
  for (const s of segments) {
    for (let j = 0; j < s.ids.length; j++, k++) if (cur.ids[k] !== s.ids[j] || cur.fps[k] !== s.fps[j]) return false;
  }
  return k === cur.ids.length;
}

/**
 * 審查 M1：頂層恰一顆、沒有子層的空段落（沒有字；打過字又刪光留下的空文字節點也算空）。基底 0 顆（從未開過的筆記）而現況是這形，
 * 是瀏覽器打開時正規化出來的，呼叫端當「沒動過」。段落的屬性（顏色、對齊）不看。
 */
export function isLoneEmptyParagraph(fragment: Y.XmlFragment): boolean {
  const top = topLevelContainers(fragment);
  if (top.length !== 1) return false;
  const c = top[0]!;
  if (c.length !== 1) return false;
  const p = c.get(0);
  if (!(p instanceof Y.XmlElement) || p.nodeName !== "paragraph") return false;
  // #398 審查 C1：Y 型別的 `get(i)` 每次從頭走（O(i)），索引迴圈是平方——`x<br>`×4.9 萬的段落有約 10 萬個子節點；一律 `toArray()` 一次走完。
  for (const t of p.toArray()) {
    if (!(t instanceof Y.XmlText) || t.length !== 0) return false;
  }
  return true;
}

/** 每區的錨點 `P`／`N`（§9.4-2）：前（後）最近一個不在任何區裡、非 0 行的段的最後（第一）顆。 */
export function anchors(segments: TransferSegment[], regions: Region[]): Array<{ P: string | null; N: string | null }> {
  const inRegion = new Set<number>(regions.flatMap(r => r.segIdx));
  const usable = (k: number) => !inRegion.has(k) && segments[k]!.count > 0;
  return regions.map(r => {
    const before = r.prevSeg === -1 ? (r.segIdx.length > 0 ? r.segIdx[0]! - 1 : -1) : r.prevSeg;
    const after = r.nextSeg === -1 ? (r.segIdx.length > 0 ? r.segIdx[r.segIdx.length - 1]! + 1 : segments.length) : r.nextSeg;
    let P: string | null = null;
    for (let k = before; k >= 0 && P === null; k--) if (usable(k)) P = segments[k]!.ids[segments[k]!.ids.length - 1]!;
    let N: string | null = null;
    for (let k = after; k < segments.length && N === null; k++) if (usable(k)) N = segments[k]!.ids[0]!;
    return { P, N };
  });
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
 * 預解析要放的位置（決策之前就定得出來：只看基底 block 與錨點），以及插入點前一顆的型別（`stripStart` 用）。
 * 改寫 → 第一顆基底 block 之前；否則 `P` 之後、無則 `N` 之前、都無則文件開頭。
 */
export function placeFor(
  r: Region,
  cur: { ids: string[]; types: string[] },
  a: { P: string | null; N: string | null },
  pre: { idx?: Map<string, number> } = {},
): { place: Place; prevType: string | null } {
  const idx = pre.idx ?? new Map(cur.ids.map((id, i) => [id, i]));
  const prevTypeOf = (i: number) => (i > 0 ? cur.types[i - 1]! : null);
  if (r.kind === "rewrite") {
    const first = r.baseIds.length > 0 ? idx.get(r.baseIds[0]!) : undefined;
    if (first !== undefined) return { place: { ref: cur.ids[first]!, where: "before" }, prevType: prevTypeOf(first) };
  }
  if (a.P !== null) return { place: { ref: a.P, where: "after" }, prevType: cur.types[idx.get(a.P)!]! };
  if (a.N !== null) return { place: { ref: a.N, where: "before" }, prevType: prevTypeOf(idx.get(a.N)!) };
  return { place: { start: true }, prevType: null };
}

export function decide(
  segments: TransferSegment[],
  regions: Region[],
  cur: { ids: string[]; types: string[] },
  /** 改寫區 `ri` 的預解析是否與 `against`（基底那幾顆）canonical 逐顆相等。 */
  same: (ri: number, against: string[]) => boolean,
  opts: { firstTypes?: ReadonlyArray<string | undefined>; prevTypes?: ReadonlyArray<string | null> } = {},
): Decision[] {
  const idx = new Map(cur.ids.map((id, i) => [id, i]));
  const anc = anchors(segments, regions);
  const out: Decision[] = regions.map((r, ri) => {
    const survivors = r.baseIds;
    const { P, N } = anc[ri]!;
    const placed = placeFor(r, cur, anc[ri]!, { idx });
    // `sync-plan.ts` 依接續鏈算出的實際前一顆型別優先（同一接點的後一區接在前一區之後）。
    const prevType = opts.prevTypes?.[ri] !== undefined ? opts.prevTypes[ri]! : placed.prevType;
    const stripStart = r.kind !== "delete" && shouldStripStart(prevType, opts.firstTypes?.[ri]);
    const base = { kind: r.kind, survivors, stripStart, P, N };
    if (r.kind === "delete") return { ...base, mark: "applied", place: { replaceSurvivors: true } };
    if (r.kind === "rewrite" && survivors.length > 0 && same(ri, survivors)) return { ...base, mark: "same", place: { replaceSurvivors: true } };
    return { ...base, mark: "applied", place: placed.place };
  });

  // 刪除區的錨點：`P`、`N` 不在任何區裡（不會被移除）；都沒有才往外掃，候選排除本次要移除的 block。
  const removing = new Set<string>();
  for (const d of out) if (d.mark !== "same" && (d.kind === "rewrite" || d.kind === "delete")) for (const id of d.survivors) removing.add(id);
  // 「本次會寫入內容的區」（非 same 的改寫與插入）有幾個——刪除區自己不算在內，所以只看總數是否為 0。
  const writing = out.filter(d => d.mark !== "same" && d.kind !== "delete").length;
  const allRemoved = cur.ids.every(id => removing.has(id));
  out.forEach(d => {
    if (d.kind !== "delete") return;
    let anchor: Anchor | null = null;
    if (d.P !== null) anchor = { block_id: d.P, position: "after" };
    else if (d.N !== null) anchor = { block_id: d.N, position: "before" };
    else {
      const first = idx.get(d.survivors[0]!)!;
      const last = idx.get(d.survivors[d.survivors.length - 1]!)!;
      for (let i = first - 1; i >= 0 && anchor === null; i--) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "after" };
      for (let i = last + 1; i < cur.ids.length && anchor === null; i++) if (!removing.has(cur.ids[i]!)) anchor = { block_id: cur.ids[i]!, position: "before" };
    }
    d.anchor = anchor ?? (writing === 0 && allRemoved ? "replaceWithEmpty" : "deferred");
  });
  return out;
}
