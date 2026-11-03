// 硬規則：永遠算在未 mount 的 Yjs 結構上（mount 會正規化空文件）；同步 hash 才能在 transact 內重算。
// 指紋是樂觀併發的判準，不是安全邊界。after_fingerprint 依文件順序；id 缺或順序變＝null＝不符，
// 呼叫端一律當 409／stale——不得在不符時退回整篇指紋（會讓過期的段落更新誤放行）。
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { canonicalizeElements, canonicalizeSection, sectionize, topLevelContainers, type SectionInfo } from "@knotebook/shared";

export function fingerprintOf(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
export const EMPTY_SECTION_FINGERPRINT = fingerprintOf("");
export interface OutlineEntry extends SectionInfo {
  fingerprint: string;
}

export function outlineOf(fragment: Y.XmlFragment): { outline: OutlineEntry[]; whole: string } {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelContainers(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("outlineOf：頂層 block 缺 id 屬性（文件不是 BlockNote 結構）");
    byId.set(id, c);
  }
  const outline = sectionize(fragment).map(s => ({ ...s, fingerprint: fingerprintOf(canonicalizeElements(s.blockIds.map(id => byId.get(id)!))) }));
  return { outline, whole: fingerprintOf(outline.map(o => o.fingerprint).join("")) };
}

/**
 * bulk transfer spec §6.4-1（F11）：頂層每顆的 id 與單顆指紋，**一次走完**（`topLevelContainers` 一次、每顆
 * `canonicalizeElements([c])` 一次）。結果與逐顆 `fingerprintForIds(fragment, [id])` 逐位元組相同，但那支每次都重建
 * 整個頂層表（`canonicalizeSection`），n 顆就是 O(n²)——2 000 顆 14–15 s（§25.5）。整篇匯出的指紋一律走這支。
 * 缺 id 同 `outlineOf` 丟錯。
 */
export function topLevelFingerprints(fragment: Y.XmlFragment): { ids: string[]; fps: string[] } {
  const ids: string[] = [];
  const fps: string[] = [];
  for (const c of topLevelContainers(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("topLevelFingerprints：頂層 block 缺 id 屬性（文件不是 BlockNote 結構）");
    ids.push(id);
    fps.push(fingerprintOf(canonicalizeElements([c])));
  }
  return { ids, fps };
}

/**
 * bulk transfer plan PR-2 §0.1-4：`topLevelFingerprints` 再多回每顆的型別，同樣一次走完。`types[i]`＝容器第一個子元素的
 * `nodeName`（blockContent 的節點名＝block 型別）；**容器本身是 `columnList` 就回 `columnList`**（與 `editor.document` 的 type
 * 一致，gate r1 m3）。決策表要「錨點前一顆是不是 numbered」、合併要每個倖存者各自的指紋——都用這一支。缺 id 同樣丟錯。
 */
export function topLevelSnapshot(fragment: Y.XmlFragment): { ids: string[]; fps: string[]; types: string[] } {
  const ids: string[] = [];
  const fps: string[] = [];
  const types: string[] = [];
  for (const c of topLevelContainers(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id !== "string" || id === "") throw new Error("topLevelSnapshot：頂層 block 缺 id 屬性（文件不是 BlockNote 結構）");
    ids.push(id);
    fps.push(fingerprintOf(canonicalizeElements([c])));
    const first = c.get(0);
    types.push(c.nodeName === "columnList" ? "columnList" : first instanceof Y.XmlElement ? first.nodeName : "");
  }
  return { ids, fps, types };
}

/**
 * bulk transfer plan PR-2 §0.1-5：`mergeDiff` 多期望分支的檢查本體（純函式，吃 fragment）。頂層走一次建 `id → 容器` 表，
 * 只對要比的那幾顆各 canonicalize 一次；每個 `expectEach` 的指紋各自比（**不比順序**）、`anchorIds` 都要在頂層。
 * **禁止逐 id 呼叫 `fingerprintForIds`**（每次重建頂層表，O(n²)；2 000 顆 14–15 s，§25.5）。
 */
export function checkExpectations(fragment: Y.XmlFragment, expectEach: ReadonlyArray<{ id: string; fp: string }>, anchorIds: readonly string[]): boolean {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelContainers(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id === "string") byId.set(id, c);
  }
  for (const e of expectEach) {
    const c = byId.get(e.id);
    if (c === undefined || fingerprintOf(canonicalizeElements([c])) !== e.fp) return false;
  }
  return anchorIds.every(id => byId.has(id));
}

/**
 * 每組 id 的合併後指紋（一次走完頂層）：與 `fingerprintForIds(fragment, group)` 逐位元組相同（`canonicalizeSection` 的形），
 * 但**空陣列 → null**（紀錄列的 `after_block_ids: []` 對 `after_fingerprint: null`，`fingerprint_chk`）；任一 id 不在頂層或
 * 順序與文件順序不符 → null。
 */
export function fingerprintsOfGroups(fragment: Y.XmlFragment, groups: ReadonlyArray<readonly string[]>): (string | null)[] {
  const byId = new Map<string, { c: Y.XmlElement; i: number }>();
  topLevelContainers(fragment).forEach((c, i) => {
    const id = c.getAttribute("id");
    if (typeof id === "string") byId.set(id, { c, i });
  });
  return groups.map(g => {
    if (g.length === 0) return null;
    const picked: Y.XmlElement[] = [];
    let last = -1;
    for (const id of g) {
      const hit = byId.get(id);
      if (hit === undefined || hit.i <= last) return null;
      last = hit.i;
      picked.push(hit.c);
    }
    return fingerprintOf(canonicalizeElements(picked));
  });
}

/** 空陣列 → EMPTY_SECTION_FINGERPRINT；任一 id 不在頂層或順序與文件順序不符 → null（＝不符）。 */
export function fingerprintForIds(fragment: Y.XmlFragment, ids: string[]): string | null {
  if (ids.length === 0) return EMPTY_SECTION_FINGERPRINT;
  const canonical = canonicalizeSection(fragment, ids);
  return canonical === null ? null : fingerprintOf(canonical);
}
