/**
 * #398 審查 C1（續）：jsdom 30 在大的子節點清單上有三處平方，全在主執行緒（MCP `read_note_section`、REST `/content`、批次下載、
 * 409 的 `current` 都要把筆記匯出成 markdown），也在 parse worker 裡：
 *
 * 1. `Node-impl._modified()` 在節點每次改動時**立刻**把已被取用過的 `childNodes`／`children` 活清單整份重算（O(子數)）。BlockNote 的
 *    `blocksToHTMLLossy` 先讀 `fragment.childNodes.length`、再把子節點一個個搬走——`x<br>`×6 000 的段落匯出 3.2 秒、×2.4 萬 82 秒。
 *    活清單的每個讀取口（`length`、`item`、索引、迭代）本來就先 `_update()`（看版本號，過期才重算），改動當下的重算是多餘的：
 *    這裡讓 `_modified()` 執行時暫時看不到那兩份清單，版本號照加、其他照做。
 * 2. `_insert(node, child)` 一開頭就算 `child` 的索引（symbol-tree 的 `index()`：上次改動之後要從頭數到它，O(位置)），只為了更新
 *    掛在這個父節點上的活 Range；3. `_remove(node)` 同理（掛在父節點或被移除的子樹上的 Range）。在大段落中間逐一插入／換掉節點
 *    （`tokenizeInlineColors` 的 `before`／`replaceWith`）於是平方：有色字×8 000 的段落讀出 19 秒。沒有任何 Range 掛著時（我們建的
 *    分離 DOM 都是），那次索引的結果用不到：這裡在那一次呼叫回 -1，其餘照算。有 Range 就完全照原本走。
 *
 * 結果與原本相同（`jsdom-perf.test.ts` 釘住活清單、插入、移除的語意與線性）。jsdom 的內部結構變了（找不到模組或方法）就不修補、
 * 回 false，不擋開機（`EditingRuntime.installGlobals` 會 warn）；修補沒生效時平方會回來，測試會紅。
 */
import { createRequire } from "node:module";

type Ranges = { size: number } | undefined;
interface NodeImpl {
  _childNodesList: unknown;
  _childrenList: unknown;
  _referencedRanges?: Ranges;
}
interface NodeImplProto {
  _modified(this: NodeImpl): void;
  _insert(this: NodeImpl, node: NodeImpl, child: NodeImpl | null, suppress?: boolean): void;
  _remove(this: NodeImpl, node: NodeImpl, suppress?: boolean): void;
}
interface Tree {
  index(child: NodeImpl): number;
  treeIterator(root: NodeImpl): Iterable<NodeImpl>;
}

let applied: boolean | null = null;

const hasRanges = (n: NodeImpl): boolean => (n._referencedRanges?.size ?? 0) > 0;

export function patchJsdomForLargeTrees(): boolean {
  if (applied !== null) return applied;
  try {
    const req = createRequire(import.meta.url);
    const proto = (req("jsdom/lib/jsdom/living/nodes/Node-impl.js") as { implementation?: { prototype: NodeImplProto } }).implementation?.prototype;
    const tree = (req("jsdom/lib/jsdom/living/helpers/internal-constants.js") as { domSymbolTree?: Tree }).domSymbolTree;
    const modified = proto?._modified;
    const insert = proto?._insert;
    const remove = proto?._remove;
    if (proto === undefined || tree === undefined || typeof modified !== "function" || typeof insert !== "function" || typeof remove !== "function" || typeof tree.index !== "function") return (applied = false);
    const realIndex = tree.index;
    /** 跑 `fn` 時，`index(target)` 的第一次呼叫回 -1（不數），其他照算。 */
    const skippingFirstIndexOf = <T>(target: NodeImpl, fn: () => T): T => {
      const before = Object.getOwnPropertyDescriptor(tree, "index");
      let skipped = false;
      tree.index = function (this: Tree, child: NodeImpl) {
        if (!skipped && child === target) {
          skipped = true;
          return -1;
        }
        return realIndex.call(this, child);
      };
      try {
        return fn();
      } finally {
        if (before) Object.defineProperty(tree, "index", before);
        else delete (tree as Partial<Tree>).index;
      }
    };
    proto._modified = function (this: NodeImpl) {
      const nodes = this._childNodesList;
      const elements = this._childrenList;
      this._childNodesList = null;
      this._childrenList = null;
      try {
        modified.call(this);
      } finally {
        this._childNodesList = nodes;
        this._childrenList = elements;
      }
    };
    proto._insert = function (this: NodeImpl, node: NodeImpl, child: NodeImpl | null, suppress?: boolean) {
      if (child === null || child === undefined || hasRanges(this)) return insert.call(this, node, child, suppress);
      return skippingFirstIndexOf(child, () => insert.call(this, node, child, suppress));
    };
    proto._remove = function (this: NodeImpl, node: NodeImpl, suppress?: boolean) {
      if (hasRanges(this)) return remove.call(this, node, suppress);
      for (const d of tree.treeIterator(node)) if (hasRanges(d)) return remove.call(this, node, suppress);
      return skippingFirstIndexOf(node, () => remove.call(this, node, suppress));
    };
    return (applied = true);
  } catch {
    return (applied = false);
  }
}
