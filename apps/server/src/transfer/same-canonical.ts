/**
 * bulk transfer spec 2026-11-02 §9.4-3（spike S2）：`same` 判準專用的正規序列化。**不是** `fingerprintOf`／`canonicalizeNode`
 * （那是 `if_match` 與版本指紋的契約，不准改）；形狀與 shared 的 `canonicalizeNode` 相同（排除 `id`、屬性排序、XmlText 走
 * delta），只多三條正規化，**範圍最小化**（gate r5 m5）：
 * ① 丟掉值為 `undefined` 的屬性（parse→`insertBlocks` 會寫進 Y，瀏覽器建的舊 block 沒有：numbered 的 `start`、image 的
 *    `previewWidth`）；② 丟掉 `numberedListItem` 的 `start`；③ **只對 wikilink 行內節點**丟掉 `snapshotTitle`，以及值為空字串的
 *    `label`、`anchorBlockId`（parse 時 rebind 成現行標題、多寫空字串）。其他元素的空字串屬性照常比（例：code `language: ""`）。
 */
import * as Y from "yjs";
import { topLevelContainers } from "@knotebook/shared";

function stable(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function keep(nodeName: string, k: string, v: unknown): boolean {
  if (k === "id" || v === undefined) return false;
  if (nodeName === "numberedListItem" && k === "start") return false;
  if (nodeName === "wikilink" && (k === "snapshotTitle" || ((k === "label" || k === "anchorBlockId") && v === ""))) return false;
  return true;
}

function canon(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
    return `T${stable(delta.map(d => ({ insert: d.insert, attributes: d.attributes ?? {} })))}`;
  }
  const attrs = node.getAttributes() as Record<string, unknown>;
  const kept = Object.keys(attrs)
    .filter(k => keep(node.nodeName, k, attrs[k]))
    .sort()
    .map(k => `${k}=${stable(attrs[k])}`);
  const children: string[] = [];
  // #398 審查 C1：Y 型別的 `get(i)` 每次從頭走（O(i)），索引迴圈是平方——`x<br>`×4.9 萬的段落有約 10 萬個子節點；一律 `toArray()` 一次走完。
  for (const c of node.toArray()) {
    if (c instanceof Y.XmlElement || c instanceof Y.XmlText) children.push(canon(c));
  }
  return `E${node.nodeName}(${kept.join(";")})[${children.join("|")}]`;
}

/** 一顆頂層容器的 same 正規序列化。 */
export function sameCanonicalOf(container: Y.XmlElement): string {
  return canon(container);
}

/**
 * 一個 fragment 的頂層索引＋每顆序列化的快取（審查 Important 1）：規劃對每區都要比一次，逐區重建頂層表＋重算是
 * O(區數×頂層數)（2 000 顆、1 000 區實測 6 s）。**每個 fragment 只建一次**（`topLevelContainers` 一次），每顆至多
 * canonicalize 一次。只能用在**不再變動**的 fragment 上（規劃時的 scratch 與 fork 都是 close 之後、未 mount 的結構）。
 */
/** 測試用計數：`sameCanonicalSeqIn` 實際 canonicalize 了幾顆（快取沒命中的次數）。 */
export const sameCanonicalStats = { canonicalized: 0 };

export interface SameIndex {
  byId: Map<string, Y.XmlElement>;
  cache: Map<string, string>;
}
export function indexTopLevel(fragment: Y.XmlFragment): SameIndex {
  const byId = new Map<string, Y.XmlElement>();
  for (const c of topLevelContainers(fragment)) {
    const id = c.getAttribute("id");
    if (typeof id === "string") byId.set(id, c);
  }
  return { byId, cache: new Map() };
}
/** 依 `ids` 的順序回每顆的序列化（走索引與快取）；任一 id 不在頂層 → null。 */
export function sameCanonicalSeqIn(index: SameIndex, ids: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const id of ids) {
    let s = index.cache.get(id);
    if (s === undefined) {
      const c = index.byId.get(id);
      if (c === undefined) return null;
      s = canon(c);
      sameCanonicalStats.canonicalized++;
      index.cache.set(id, s);
    }
    out.push(s);
  }
  return out;
}

/** 單次用：一次走完頂層（`topLevelContainers` 一次），依 `ids` 的順序回每顆的序列化；任一 id 不在頂層 → null。 */
export function sameCanonicalSeq(fragment: Y.XmlFragment, ids: readonly string[]): string[] | null {
  if (ids.length === 0) return [];
  return sameCanonicalSeqIn(indexTopLevel(fragment), ids);
}
