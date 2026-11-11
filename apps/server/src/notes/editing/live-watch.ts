/**
 * 套用期間，活文件被別人改了哪些頂層 block。
 *
 * worker 對「取狀態那一刻」的文件算 diff（`doc-jobs.ts`）。合併時活文件若已不是那一份，舊做法一律重來，結果是有人在打字的
 * 中等大小筆記（約 0.2 MB 狀態起，worker 一趟比按鍵間隔長）三次都被超前、503。這裡改成：取狀態的同一個 tick 掛上 `afterTransaction`，
 * 記下之後每筆交易碰到的頂層容器（Yjs item id，`client:clock`），合併時只問「有沒有碰到這次寫入在意的 block」（{@link MergeGuard}）：
 * - 沒碰到 → 照樣把 diff 套進去。Yjs 的合併本身是 CRDT 安全的（舊版 `mergeDiff` 就是這麼做）：別人剛打的字與這次寫入都留著。
 * - 碰到了 → 從頭重來（worker 在新狀態上重比 if_match：目標段被改就是 409，語意同舊）；仍是至多 3 次、再不行 503。
 *
 * 成本：每筆交易只走「被改的型別往上到頂層容器」那幾層（與交易大小成正比）；新增或刪除頂層 block 的交易另走一次頂層清單（頂層 block 數，
 * 不是整篇內容）。合併時的判斷只看守衛裡那幾個 id。都不與筆記大小成正比——不在主執行緒轉換、不重算段落指紋。
 */
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";

/**
 * 這次寫入在意活文件的哪些改動（worker 依基底算，`DocPost.guard`）：
 * - `none`：什麼都不在意（不帶 `if_match` 的 append／replace_all、建立）。
 * - `any`：任何改動都算衝突（帶整篇 `if_match` 的 replace_all／append、批次寫回）。
 * - `blocks`：`items` 這幾個頂層容器（目標段）被改、被刪，或有新的頂層 block 緊接在其中一顆後面（會落進目標段）→ 衝突；`anchors` 被刪 → 衝突
 *   （撤回刪段的錨點，同舊 `mergeDiff` 的錨點重核對）；`absent` 這幾個 block id 回到頂層 → 不合併（撤回刪段時被刪的那幾顆，`mergeAtBase`
 *   在 transact 內走頂層判）。`items` 空（零 block 的段）＝只有頂層結構無法判讀時才衝突。
 */
export type MergeGuard = { kind: "none" } | { kind: "any" } | { kind: "blocks"; items: string[]; anchors: string[]; absent?: string[] };

export const itemKey = (id: Y.ID): string => `${id.client}:${id.clock}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs 型別樹的節點（泛型參數在這裡沒有意義）
type AnyType = Y.AbstractType<any>;

/** 基底文件裡這些 block id 的頂層容器的 item id（worker 裡算；容器是 ContentType item，長度 1、不會被切開，id 跨文件不變）。 */
export function containerItems(fragment: Y.XmlFragment, blockIds: readonly string[]): string[] {
  if (blockIds.length === 0) return [];
  const want = new Set(blockIds);
  const group = fragment.get(0);
  const out: string[] = [];
  if (!(group instanceof Y.XmlElement)) return out;
  for (const child of group.toArray()) {
    if (child instanceof Y.XmlElement && want.has(child.getAttribute("id") as string) && child._item !== null) out.push(itemKey(child._item.id));
  }
  return out;
}

export class LiveWatch {
  private readonly touched = new Set<string>();
  private readonly deleted = new Set<string>();
  /** 新增的頂層 block 左邊最近一顆還在的 block（新 block 落在它之後）。 */
  private readonly insertedAfter = new Set<string>();
  /** 有改動（任何一筆帶內容的交易）。 */
  private changed = false;
  /** 頂層結構改了、但說不出是哪幾顆（例如整份文件的根被換掉）。 */
  private unknown = false;
  private readonly handler: (tr: Y.Transaction) => void;
  private stopped = false;

  constructor(readonly doc: Y.Doc) {
    this.handler = tr => this.record(tr);
    doc.on("afterTransaction", this.handler);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.doc.off("afterTransaction", this.handler);
  }

  /** 這次寫入在意的改動有沒有發生（見 {@link MergeGuard}）。 */
  conflicts(guard: MergeGuard): boolean {
    if (guard.kind === "none") return false;
    if (guard.kind === "any") return this.changed;
    if (this.unknown) return true;
    for (const k of guard.items) if (this.touched.has(k) || this.deleted.has(k) || this.insertedAfter.has(k)) return true;
    for (const k of guard.anchors) if (this.deleted.has(k)) return true;
    return false;
  }

  private record(tr: Y.Transaction): void {
    if (tr.changed.size === 0 && tr.deleteSet.clients.size === 0) return;
    this.changed = true;
    const root = this.doc.getXmlFragment(YDOC_FRAGMENT);
    const first = root.length > 0 ? root.get(0) : null;
    const group = first instanceof Y.XmlElement && first.nodeName === "blockGroup" ? first : null;
    let structural = false;
    // 比較用不帶泛型的參照（`tr.changed` 的鍵是 `AbstractType<YEvent<any>>`）。
    const rootRef = root as unknown as AnyType;
    const groupRef = group as unknown as AnyType | null;
    for (const type of tr.changed.keys() as IterableIterator<AnyType>) {
      if (type === rootRef) {
        this.unknown = true;
        continue;
      }
      if (groupRef !== null && type === groupRef) {
        structural = true;
        continue;
      }
      // 往上走到頂層容器（父親是根 blockGroup 的那一層）。走到根型別還沒碰到 → 不是筆記內容（別的根型別），不管。
      let t: AnyType = type;
      while (t._item !== null && t._item.parent !== groupRef) t = t._item.parent as AnyType;
      if (t._item === null) {
        if (t === rootRef) this.unknown = true;
        continue;
      }
      this.touched.add(itemKey(t._item.id));
    }
    if (structural && group !== null) {
      // 頂層 block 增刪：走一次頂層清單（含墓碑），判哪幾顆是這筆交易新增或刪除的。
      for (let item = group._start; item !== null; item = item.right) {
        if (Y.isDeleted(tr.deleteSet, item.id)) this.deleted.add(itemKey(item.id));
        else if (!item.deleted && item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0)) {
          // 左邊最近一顆「交易之前就在、現在還在」的 block（一次貼上好幾顆時，跳過同一筆交易新增的）
          let left = item.left;
          while (left !== null && (left.deleted || left.id.clock >= (tr.beforeState.get(left.id.client) ?? 0))) left = left.left;
          if (left !== null) this.insertedAfter.add(itemKey(left.id));
        }
      }
    }
  }
}
