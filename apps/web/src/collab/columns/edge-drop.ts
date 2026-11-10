/**
 * ⋮⋮ 拖曳放下時的兩種接手：直線放置（建列、加欄）與橫線放進空欄（取代欄裡唯一的空段落）。兩者都掛在直接傳入的 `handleDrop`
 * prop：PM 走到那裡時所有 `handleDOMEvents.drop`（tiptap PasteRule、UniqueID 的拖放記帳）都已照常跑過；回 true 後 PM 自己
 * `preventDefault()`、清 `view.dragging`。
 *
 * 交易的形狀（兩種相同）：
 * 1. 先在 `view.state.apply(移除 X 的 tr)` 預測出的文件上跑一次 `buildInsert`；不成立就回 false、一筆都不送。
 * 2. 成立才在一個撤銷步裡依序送兩次 `editor.transact`：第一次只移除 X（不收欄），第二次在實際文件上再跑一次 `buildInsert`。
 *    y-prosemirror 對每次 view update 做一次 diff；移除與插入放在同一筆時，diff 的中段會把兩處之間不相干的 block 也包進去原地改寫，
 *    對方同時在那些 block 打的字會消失。拆成兩次，每次 diff 只碰一處。兩次之間不呼叫 `stopCapturing`，UndoManager 把兩筆併成一步。
 * 3. 兩筆都不帶 `uiEvent`（PasteRule 只在 `uiEvent === "drop"` 時對 diff 範圍跑 paste rule，會把中間 block 的網址轉成連結）、
 *    都帶 `preventAutolink`（autolink 對任何改文件的交易都跑；搬移沒有新打的字）。
 *
 * 另外兩支接線：DropCursor 的 hook（`computeDropPosition`，拖曳中畫的線與放下時同一個判斷），以及落在欄與欄之間的拖放
 * （`withGutterFileDrop`，掛在 `handleDOMEvents.drop`）。
 */
import { removeAndInsertBlocks, type BlockNoteEditor, type ComputeDropPositionContext } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import type { EditorView } from "prosemirror-view";
import { TEXT_REPRESENTATION_MIME_TYPES } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";
import { dragMoves, edgeTargetAt, insideAny, isEmptyParagraph, type DraggedBlocks, type EdgeTarget } from "./drag-geometry";
import { draggedBlocksOf } from "./drag-source";
import { buildInsert, textSelectionNear, type InsertPlan } from "./edge-drop-insert";
import { findNodeById, type PMNodeLike } from "./position";
import { asUndoStep } from "./undo-step";
import { addColumnWidths, equalHeightWidths } from "./widths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;
type PMNode = EditorView["state"]["doc"];
type Transaction = EditorView["state"]["tr"];
type Slice = NonNullable<EditorView["dragging"]>["slice"];
type ResolvedPos = ReturnType<PMNode["resolve"]>;

const BLOCK_CONTAINER = "blockContainer";

const find = (doc: PMNode, id: string, type?: string): { node: PMNode; pos: number } | null =>
  findNodeById(doc as unknown as PMNodeLike, id, type) as { node: PMNode; pos: number } | null;

/** X 的節點，依記下的 id 從當下文件取（遠端改過 X 的屬性或文字時用新值）；任一個找不到 → null。 */
function nodesOf(doc: PMNode, ids: readonly string[]): { node: PMNode; pos: number }[] | null {
  const out: { node: PMNode; pos: number }[] = [];
  for (const id of ids) {
    const hit = find(doc, id);
    if (!hit) return null;
    out.push(hit);
  }
  return out;
}

/** 單一、顯示預覽、沒有子 block 的圖片 → 畫面上 `<img>` 的寬高比；不是這種 block 或原圖尺寸未知 → null。 */
function imageAspect(view: EditorView, block: PMNode): number | null {
  const content = block.firstChild;
  if (block.type.name !== BLOCK_CONTAINER || block.childCount !== 1 || content?.type.name !== "image" || content.attrs.showPreview === false) return null;
  const id = block.attrs.id;
  const hit = typeof id === "string" ? find(view.state.doc, id, BLOCK_CONTAINER) : null;
  const dom = hit ? view.nodeDOM(hit.pos) : null;
  const img = dom instanceof HTMLElement ? dom.querySelector("img") : null;
  if (!img || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return null;
  return img.naturalWidth / img.naturalHeight;
}

/** 一欄恰好一個 block 時取它的寬高比，否則 null。 */
const columnAspect = (view: EditorView, blocks: readonly PMNode[]): number | null => (blocks.length === 1 ? imageAspect(view, blocks[0]!) : null);

/**
 * 直線目標 → 插入計畫。欄寬：結果列每欄都是單一圖片、原圖尺寸都已知 → 依寬高比等高；否則新列 `[1, 1]`、加欄時新欄＝既有平均。
 * 加欄的既有欄內容從 `predicted`（移除 X 之後）讀：X 原本就在這列時，它的來源欄在結果裡已經沒有 X。
 */
function planFor(view: EditorView, predicted: PMNode, target: EdgeTarget, xNodes: PMNode[]): InsertPlan | null {
  const xAspect = columnAspect(view, xNodes);
  if (target.kind === "newRow") {
    const y = find(predicted, target.yId, BLOCK_CONTAINER);
    if (!y) return null;
    const yAspect = columnAspect(view, [y.node]);
    const order = target.side === "left" ? [xAspect, yAspect] : [yAspect, xAspect];
    const widths = (equalHeightWidths(order) ?? [1, 1]) as [number, number];
    return { kind: "newRow", yId: target.yId, side: target.side, xNodes, widths };
  }
  const row = find(predicted, target.rowId, COLUMN_LIST_TYPE);
  if (!row) return null;
  const existing: number[] = [];
  const aspects: (number | null)[] = [];
  let k = -1;
  row.node.forEach((col, _offset, i) => {
    existing.push(col.attrs.width as number);
    const blocks: PMNode[] = [];
    col.forEach((b) => void blocks.push(b));
    aspects.push(columnAspect(view, blocks));
    if (col.attrs.id === target.columnId) k = i;
  });
  if (k < 0) return null;
  const newIndex = target.side === "left" ? k : k + 1;
  aspects.splice(newIndex, 0, xAspect);
  const widths = equalHeightWidths(aspects) ?? addColumnWidths(existing, newIndex);
  return { kind: "addColumn", rowId: target.rowId, columnId: target.columnId, side: target.side, xNodes, widths };
}

/**
 * y-prosemirror 在 undo 之後留著「操作前的選取」，下一次 redo 時以相對位置拿來還原。⋮⋮ 拖單一 block 時那是 X 的 NodeSelection：
 * 搬走之後 X 原本的位置常常已經沒有節點，還原時 `NodeSelection.create` 丟例外、redo 整個失敗。送交易之前先把它換成 X 開頭的
 * 文字選取（只改選取、不寫 Yjs），還原文字選取時 y-prosemirror 會找最近的合法位置。
 */
function collapseNodeSelection(view: EditorView): void {
  const sel = view.state.selection;
  if (!("node" in sel)) return;
  const text = textSelectionNear(sel, sel.$from);
  if (text) view.dispatch(view.state.tr.setSelection(text));
}

function removeX(tr: Transaction, ids: readonly string[]): void {
  removeAndInsertBlocks(tr, [...ids], [], { fixColumns: false });
  tr.setMeta("preventAutolink", true);
}

/**
 * 預先驗證後送出兩次交易（見檔頭）。`makePlan` 拿到預測的文件；回 null 或 `buildInsert` 在預測文件上不成立 → false、不送。
 * 兩次交易之間是同步的，遠端更新插不進來，所以實際文件上的 `buildInsert` 不會失敗；失敗屬程式錯誤，丟例外。
 */
function commitMove(editor: AnyEditor, view: EditorView, ids: readonly string[], makePlan: (predicted: PMNode) => InsertPlan | null): boolean {
  const tr1 = view.state.tr;
  removeX(tr1, ids);
  const predicted = view.state.apply(tr1);
  const plan = makePlan(predicted.doc);
  if (!plan || !buildInsert(predicted.tr, plan)) return false;
  // 必須在驗證通過之後：core 設的 `view.dragging` 沒有 `node`，回 false 時 PM 預設的 drop 以 `deleteSelection()` 移除來源，
  // 先換掉選取再回 false，刪的就不是 X，X 留在原處又被插入一份。
  collapseNodeSelection(view);
  asUndoStep(editor, () => {
    editor.transact((tr) => removeX(tr, ids));
    editor.transact((tr) => {
      if (!buildInsert(tr, plan)) throw new Error("edge-drop: insert target vanished after pre-validation");
      tr.setMeta("preventAutolink", true);
    });
  });
  // PM 預設的 drop 會 focus 編輯器；這裡接手之後就沒有人做了。
  view.focus();
  return true;
}

/** 直線放置：`edgeTargetAt` 說是直線才接手（唯讀、合成事件、複製拖、非 ⋮⋮ 拖曳都由它擋掉）。 */
export function edgeDrop(editor: AnyEditor | null, view: EditorView, event: DragEvent): boolean {
  if (!editor) return false;
  const dragged = draggedBlocksOf(view);
  const target = edgeTargetAt(view, event, dragged);
  if (!target || !dragged) return false;
  const x = nodesOf(view.state.doc, dragged.ids);
  if (!x) return false;
  const xNodes = x.map((hit) => hit.node);
  return commitMove(editor, view, dragged.ids, (predicted) => planFor(view, predicted, target, xNodes));
}

/**
 * 同 prosemirror-transform 的 `dropPoint`（PM 預設 drop 用它決定插入點）：apps/web 在值層級 import 不到 prosemirror-transform，
 * 這裡照它的演算法寫一份，只用節點與 content match 自己的方法。
 */
function pmDropPoint(doc: PMNode, pos: number, slice: Slice): number | null {
  const $pos: ResolvedPos = doc.resolve(pos);
  if (!slice.content.size) return pos;
  let content = slice.content;
  for (let i = 0; i < slice.openStart; i++) content = content.firstChild!.content;
  for (let pass = 1; pass <= (slice.openStart === 0 && slice.size ? 2 : 1); pass++) {
    for (let d = $pos.depth; d >= 0; d--) {
      const bias = d === $pos.depth ? 0 : $pos.pos <= ($pos.start(d + 1) + $pos.end(d + 1)) / 2 ? -1 : 1;
      const insertPos = $pos.index(d) + (bias > 0 ? 1 : 0);
      const parent = $pos.node(d);
      let fits: boolean;
      if (pass === 1) {
        fits = parent.canReplace(insertPos, insertPos, content);
      } else {
        const wrapping = parent.contentMatchAt(insertPos).findWrapping(content.firstChild!.type);
        fits = !!wrapping && parent.canReplaceWith(insertPos, insertPos, wrapping[0]!);
      }
      if (fits) return bias === 0 ? $pos.pos : bias < 0 ? $pos.before(d + 1) : $pos.after(d + 1);
    }
  }
  return null;
}

/** X 裡的頂層列換成「第 1 欄全部、第 2 欄全部…」（同貼上規則 `flattenRows` 的順序），免得把列放進欄裡變成巢狀列。 */
function flattenX(nodes: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    if (node.type.name === COLUMN_LIST_TYPE) node.forEach((col) => col.forEach((b) => void out.push(b)));
    else out.push(node);
  }
  return out;
}

/** 只限 ⋮⋮ 拖曳：有記下的 X、可編輯、在拖曳中、不是複製拖、不是 core SideMenu 夾進框內的合成事件。 */
function isBlockMove(editor: AnyEditor, view: EditorView, event: DragEvent, dragged: DraggedBlocks | null): dragged is DraggedBlocks {
  return dragged != null && editor.isEditable && view.dragging != null && dragMoves(view, event) && (event as { synthetic?: boolean }).synthetic !== true;
}

/**
 * 橫線放進空欄：欄 C 只有一個空段落 E 時，以 X 取代 E（PM 預設會留下 `[E, X]` 或 `[X, E]`）。全部成立才接手：
 * 1. 這次不是直線。
 * 2. 落點有最近的 `column` 祖先 C。
 * 3. C 恰好一個子 block 且是空段落（有任何格式就不算空）。
 * 4. E 不在任何 X 的子樹內：拖 E 自己，或多選含列、放回那列自己的空欄（移除 X 會連 C 一起刪掉）。
 * 5. PM 自己會插的位置（`dropPoint`）也在 C 內：指標與實際插入點不一致時不取代別處。
 * `edgeTargetAt` 在唯讀、合成事件、複製拖時本來就回 null，在這裡 null 代表「不是直線」，所以這些情形要先由 `isBlockMove` 擋。
 */
export function emptyColumnDrop(editor: AnyEditor | null, view: EditorView, event: DragEvent, slice: Slice): boolean {
  if (!editor) return false;
  const dragged = draggedBlocksOf(view);
  if (!isBlockMove(editor, view, event, dragged)) return false;
  if (edgeTargetAt(view, event, dragged) !== null) return false;

  const doc = view.state.doc;
  let mouse: number | undefined;
  try {
    mouse = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  } catch {
    return false;
  }
  if (mouse === undefined) return false;
  const $mouse = doc.resolve(mouse);
  let depth = -1;
  for (let d = $mouse.depth; d > 0; d--) {
    if ($mouse.node(d).type.name === COLUMN_TYPE) {
      depth = d;
      break;
    }
  }
  if (depth < 0) return false;
  const column = $mouse.node(depth);
  const columnPos = $mouse.before(depth);
  const columnId = column.attrs.id;
  const empty = column.firstChild;
  if (typeof columnId !== "string" || column.childCount !== 1 || !empty || !isEmptyParagraph(empty)) return false;
  const emptyId = empty.attrs.id;
  if (typeof emptyId !== "string") return false;

  const x = nodesOf(doc, dragged.ids);
  if (!x) return false;
  // 以 E 的位置判斷：E 是 C 唯一的子 block，「E 在某個 X 的子樹內」恰好是「C 在 X 的子樹內，或 X 就是 E」。
  if (insideAny(columnPos + 1, x.map((hit) => [hit.pos, hit.pos + hit.node.nodeSize] as const))) return false;

  // 防線：slice 是 blockContainer 時 `dropPoint` 一定落在最近的欄，目前的拖曳碰不到這條。
  const at = pmDropPoint(doc, $mouse.pos, slice) ?? $mouse.pos;
  if (!(at > columnPos && at < columnPos + column.nodeSize)) return false;

  const xNodes = flattenX(x.map((hit) => hit.node));
  return commitMove(editor, view, dragged.ids, () => ({ kind: "replaceEmpty", columnId, emptyId, xNodes }));
}

type DropPos = ComputeDropPositionContext["defaultPosition"];

/**
 * core DropCursor 的 hook：與 `edgeDrop` 呼叫同一支 `edgeTargetAt`，畫的線與放下的結果一致。直線 → 目標左／右緣的直線
 * （`pos` 是頂層 Y 或目標欄之前，core 以 `nodeDOM(pos)` 的框畫線）；其餘照 core 的預設位置，放進空欄也照畫橫線。
 * 不回 null：null 會讓 core 整個不畫線。
 */
export function computeDropPosition(ctx: ComputeDropPositionContext): DropPos {
  const view = ctx.view as unknown as EditorView;
  const target = edgeTargetAt(view, ctx.event, draggedBlocksOf(view));
  if (!target) return ctx.defaultPosition;
  return { pos: target.pos, orientation: target.side === "left" ? "block-vertical-left" : "block-vertical-right" };
}

/** 同 core `fileDropExtension`：`dataTransfer.types` 依 core 的已知型別順序，第一個命中的是 `Files`（文字表示都不在）。 */
function firstKnownTypeIsFiles(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes("Files") && !TEXT_REPRESENTATION_MIME_TYPES.some((type) => types.includes(type));
}

const distance = (value: number, from: number, to: number): number => (value < from ? from - value : value > to ? value - to : 0);

/**
 * 落點的位置父節點是 `columnList`（溝裡、欄與欄之間）→ 最近的欄裡、垂直最近的直接子 block 的框；其餘 null。
 * 欄先比水平距離、相同再比垂直距離：並排的列各欄 x 範圍不同，看 x 就分得出；堆疊的列各欄 x 範圍相同，要靠 y 分。
 * 框取 `nodeDOM`（block 的 `.bn-block-outer`，就是 core `handleFileInsertion` 以 `[data-id]` 查到、拿來判斷前／後的那個元素）。
 */
function gutterTargetRect(view: EditorView, event: DragEvent): DOMRect | null {
  let pos: number | undefined;
  try {
    pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  } catch {
    return null;
  }
  if (pos === undefined) return null;
  const $pos = view.state.doc.resolve(pos);
  const rowNode = $pos.parent;
  if (rowNode.type.name !== COLUMN_LIST_TYPE) return null;
  const { clientX: x, clientY: y } = event;
  const column = nearestChild(view, rowNode, $pos.start(), (rect) => [distance(x, rect.left, rect.right), distance(y, rect.top, rect.bottom)]);
  if (!column) return null;
  return nearestChild(view, column.node, column.pos + 1, (rect) => [distance(y, rect.top, rect.bottom)])?.rect ?? null;
}

/** 依序比較，前面的項不同就以它決定。 */
function closer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** `parent` 的子節點裡（`start`＝第一個子節點的位置），`dist(畫面上的框)` 依序比較最小的那個；完全相同取前面的。 */
function nearestChild(
  view: EditorView,
  parent: PMNode,
  start: number,
  dist: (rect: DOMRect) => readonly number[],
): { node: PMNode; pos: number; rect: DOMRect } | null {
  let best: { node: PMNode; pos: number; rect: DOMRect; d: readonly number[] } | null = null;
  let pos = start;
  for (let i = 0; i < parent.childCount; i++) {
    const node = parent.child(i);
    const el = view.nodeDOM(pos);
    if (el instanceof HTMLElement) {
      const rect = el.getBoundingClientRect();
      const d = dist(rect);
      if (!best || closer(d, best.d)) best = { node, pos, rect, d };
    }
    pos += node.nodeSize;
  }
  return best;
}

/**
 * 事件座標改到 B 的框內：x 取水平中央，y 留在原本那一側的半邊（上半 → 上四分之一處、下半 → 下四分之一處），
 * core 以 B 的中線決定插在 B 之前或之後，結果與指標在 B 旁邊時相同。原生 DragEvent 的座標是 prototype 上的 getter，
 * 在事件本身定義同名屬性就蓋得過。
 */
function moveInto(event: DragEvent, rect: DOMRect): void {
  const mid = (rect.top + rect.bottom) / 2;
  const y = event.clientY < mid ? (rect.top + mid) / 2 : (mid + rect.bottom) / 2;
  Object.defineProperty(event, "clientX", { value: (rect.left + rect.right) / 2, configurable: true });
  Object.defineProperty(event, "clientY", { value: y, configurable: true });
}

/**
 * 包住 `handleDOMEvents.drop`，處理落在欄與欄之間的拖放。溝裡的位置父節點是 `columnList`，那裡放不下任何 block：
 * - ⋮⋮ 拖曳（`view.dragging` 有值）、這次不是直線 → 先把座標改到最近欄的最近 block 再交給內層。要在內層之前：
 *   內層的 `withColumnsDropPoint` 一進來就記落點，PM 預設的 drop 之後也讀同一份座標。直線（`edgeTargetAt` 有目標）不改，
 *   拖曳中畫出的直線與放下的結果才一致。
 * - 只帶檔案的拖放 → 內層先跑（媒體阻擋優先，被擋的就不處理）；內層回 false 才改座標，並回 false 讓 core 的
 *   `fileDropExtension` 照常插入與上傳，插入點落在那個 block 之前或之後。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler 的 view 型別各處不同（`unknown`／EditorView），這裡只轉手
export function withGutterFileDrop<T extends { drop: (view: any, e: DragEvent) => boolean }>(editorRef: EditorRef, events: T): T {
  return {
    ...events,
    drop: (view: EditorView | null, event: DragEvent) => {
      const editor = editorRef.current;
      const usable = !!view && !!editor && editor.isEditable && view.editable;
      if (usable && view.dragging != null && edgeTargetAt(view, event, draggedBlocksOf(view)) === null) {
        const rect = gutterTargetRect(view, event);
        if (rect) moveInto(event, rect);
      }
      if (events.drop(view, event)) return true;
      if (usable && view.dragging == null && firstKnownTypeIsFiles(event)) {
        const rect = gutterTargetRect(view, event);
        if (rect) moveInto(event, rect);
      }
      return false;
    },
  };
}
