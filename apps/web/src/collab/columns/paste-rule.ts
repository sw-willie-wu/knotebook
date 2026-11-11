/**
 * 貼上的列：一條 `transformPasted` 規則。
 *
 * - PM 對站內拖曳也呼叫 `transformPasted`（`prosemirror-view` `handleDrop`：`view.dragging.slice` 先過一次再放），
 *   所以「drop 的 slice 含列、落點不在頂層 → 先攤平」也在這裡做；`handleDOMEvents.drop` 只記落點。
 *   外部拖入（`view.dragging` 為 null）同樣用落點、不用游標判斷位置。
 * - core 的 `transformPasted` 掛在 editorProps、比外掛先跑：游標在表格格子內時 block 已被轉成行內＋換行，這裡看不到列。
 * - 頂層封閉 slice 的代價：貼上「段落＋列＋段落」時第一段不併進游標段落、貼在非空段落開頭多一個空段落；
 *   不封閉的話 PM 的 `Slice.maxOpen` 會把列拆開（首欄併進游標段落、多一個空欄）。
 * - 單欄外部 HTML 由 shared `columns.ts` 的外部欄 parse 限定擋下；這裡處理的單欄列是從欄內複製時
 *   PM 依 `data-pm-slice` 的 open context 重建的。
 *
 * `Slice`／`Fragment` 在 apps/web 值層級拿不到，由傳進來的 slice 取 constructor。
 */
import { Extension } from "@tiptap/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMNS_MIN } from "@knotebook/shared";
import { createPmPlugin } from "../pm-plugin";
import { isTopLevelPosition, type ResolvedPosLike } from "./position";

interface NodeLike {
  type: { name: string };
  childCount: number;
  isLeaf: boolean;
  isText: boolean;
  content: FragmentLike;
  firstChild: NodeLike | null;
  lastChild: NodeLike | null;
  forEach(f: (node: NodeLike) => void): void;
  copy(content: FragmentLike): NodeLike;
}

interface FragmentLike {
  childCount: number;
  firstChild: NodeLike | null;
  lastChild: NodeLike | null;
  forEach(f: (node: NodeLike) => void): void;
  descendants(f: (node: NodeLike, pos: number, parent: NodeLike | null) => boolean | void): void;
}

export interface SliceLike {
  content: FragmentLike;
  openStart: number;
  openEnd: number;
}

export interface ViewLike {
  state: { doc: { resolve(pos: number): ResolvedPosLike }; selection: { from: number } };
  dragging: unknown;
  posAtCoords(coords: { left: number; top: number }): { pos: number; inside: number } | null;
}

type SliceCtor = new (content: FragmentLike, openStart: number, openEnd: number) => SliceLike;
const newSlice = (like: SliceLike, content: FragmentLike, openStart = 0, openEnd = 0) =>
  new (like.constructor as SliceCtor)(content, openStart, openEnd);
const fragmentFrom = (like: SliceLike, nodes: NodeLike[]) =>
  (like.content.constructor as unknown as { from(nodes: NodeLike[]): FragmentLike }).from(nodes);

let dropPoint: number | null = null;

/** drop 落點（handleDOMEvents.drop 記下，同一個同步呼叫鏈結束時清掉）。view 為 null 時什麼都不做。
 * `posAtCoords` 丟例外時記成 null：不得讓例外穿出、跳過其後的媒體阻擋。 */
export function recordDropPoint(view: ViewLike | null, event: Pick<DragEvent, "clientX" | "clientY">): void {
  if (!view) return;
  try {
    dropPoint = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
  } catch {
    dropPoint = null;
  }
  queueMicrotask(() => {
    dropPoint = null;
  });
}

export function takeDropPoint(): number | null {
  const pos = dropPoint;
  dropPoint = null;
  return pos;
}

const isSingle = (node: NodeLike) => node.type.name === COLUMN_LIST_TYPE && node.childCount < COLUMNS_MIN;
/** 不在 columnList 裡的單獨 column：Ctrl＋點欄（整欄 NodeSelection）複製而來，open 為 0。不換掉的話 PM 會把它包成補了空欄的列、貼進段落的子 block（巢狀列）。 */
const isLoneColumn = (node: NodeLike, parent: NodeLike | null) => node.type.name === COLUMN_TYPE && parent?.type.name !== COLUMN_LIST_TYPE;

function unwrapFragment(like: SliceLike, fragment: FragmentLike, parent: NodeLike | null): FragmentLike {
  const out: NodeLike[] = [];
  fragment.forEach((node) => {
    if (isSingle(node)) node.forEach((col) => unwrapFragment(like, col.content, col).forEach((b) => out.push(b)));
    else if (isLoneColumn(node, parent)) unwrapFragment(like, node.content, node).forEach((b) => out.push(b));
    else out.push(node.isLeaf || node.isText ? node : node.copy(unwrapFragment(like, node.content, node)));
  });
  return fragmentFrom(like, out);
}

/** open 路徑（首／尾）每經過一個單欄列，open 深度減 2（列＋欄兩層被拿掉）。 */
function adjustOpen(fragment: FragmentLike, open: number, first: boolean): number {
  let node = first ? fragment.firstChild : fragment.lastChild;
  let removed = 0;
  for (let d = 0; d < open && node; d++) {
    if (isSingle(node) && d + 1 < open) removed += 2;
    node = first ? node.firstChild : node.lastChild;
  }
  return open - removed;
}

/** 少於兩欄的 columnList 與單獨的 column 換成欄內 block；全空的列丟掉；open 路徑經過單欄列時 openStart／openEnd 各減 2。 */
export function unwrapSingleColumnLists(slice: SliceLike): SliceLike {
  let has = false;
  slice.content.descendants((node, _pos, parent) => {
    if (isSingle(node) || isLoneColumn(node, parent)) has = true;
  });
  if (!has) return slice;
  return newSlice(
    slice,
    unwrapFragment(slice, slice.content, null),
    adjustOpen(slice.content, slice.openStart, true),
    adjustOpen(slice.content, slice.openEnd, false),
  );
}

/** 有任何兩欄以上的 columnList。 */
export function sliceHasRow(slice: SliceLike): boolean {
  let has = false;
  slice.content.descendants((node) => {
    if (node.type.name === COLUMN_LIST_TYPE && node.childCount >= COLUMNS_MIN) has = true;
  });
  return has;
}

/** 外層唯一 blockGroup 剝掉、回封閉 slice。 */
export function closeTopLevel(slice: SliceLike): SliceLike {
  let fragment = slice.content;
  if (fragment.childCount === 1 && fragment.firstChild!.type.name === "blockGroup") fragment = fragment.firstChild!.content;
  return newSlice(slice, fragment);
}

function flatten(fragment: FragmentLike, out: NodeLike[]): NodeLike[] {
  fragment.forEach((node) => {
    if (node.type.name === COLUMN_LIST_TYPE) node.forEach((col) => col.forEach((b) => out.push(b)));
    else if (node.type.name === "blockGroup") flatten(node.content, out);
    else out.push(node);
  });
  return out;
}

/** 遞迴拆 blockGroup 與 columnList（第 1 欄全部、第 2 欄全部…），回封閉 slice。 */
export function flattenRows(slice: SliceLike): SliceLike {
  return newSlice(slice, fragmentFrom(slice, flatten(slice.content, [])));
}

export function columnsTransformPasted(slice: SliceLike, view: ViewLike): SliceLike {
  slice = unwrapSingleColumnLists(slice);
  if (!sliceHasRow(slice)) return slice;
  const drop = takeDropPoint();
  const { doc } = view.state;
  if (view.dragging) {
    // 站內拖曳：橫線放置照 PM／core，只在落點不在頂層時攤平。
    return drop !== null && !isTopLevelPosition(doc.resolve(drop)) ? flattenRows(slice) : slice;
  }
  return isTopLevelPosition(doc.resolve(drop ?? view.state.selection.from)) ? closeTopLevel(slice) : flattenRows(slice);
}

export function createColumnsPasteExtension(): Extension {
  return Extension.create({
    name: "knotebookColumnsPaste",
    addProseMirrorPlugins() {
      return [createPmPlugin({ props: { transformPasted: columnsTransformPasted } }) as never];
    },
  });
}

/** drop：先記落點，再交給原 handler。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handler 的 view 型別各處不同（`unknown`／EditorView），這裡只轉手
export function withColumnsDropPoint<T extends { drop: (view: any, e: DragEvent) => boolean }>(events: T): T {
  return {
    ...events,
    drop: (view: ViewLike | null, event: DragEvent) => {
      recordDropPoint(view, event);
      return events.drop(view, event);
    },
  };
}
