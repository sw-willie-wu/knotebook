/**
 * 並排的版面外掛：整列堆疊與「只含圖片的欄」標記，外加欄內圖片把手（`image-resize.ts`）。
 *
 * - 為何掛在 block spec（`withColumnsLayout`，web `collab/schema.ts` 的 `columnList`）而不是編輯器選項：凡是用 `noteSchema` 的編輯器
 *   （筆記頁、公開頁、版本預覽、框選 AI 預覽）都要堆疊，而唯讀選項規定不得有 `_tiptapOptions`（`editor-options.test.ts`）。
 *   回新物件、不改傳入的 spec：shared 的 `columnListBlockSpec` 也給 headless schema 用，server 不該帶上版面外掛。
 *   簡報的匯出 schema（`present/schema.ts` 展開 `noteSchema.blockSpecs`）也帶著它，但那個編輯器從不 mount，plugin view 不會跑。
 * - 函式形 `createExtension(fn)()`：每個編輯器各自執行 fn，拿得到 editor、各有自己的 plugin 實例。
 * - 結果以 node decoration 掛在列與欄上（`data-stacked`、`data-kb-col-kind`），不直接改 PM 管的 DOM——直接改屬性會被 PM 的
 *   DOMObserver 當成文件變更來讀（jsdom 驗不到，交 e2e）。也不輸出 `style`：欄的 renderHTML 先寫 `flex:N 1 0`，decoration 的 style 會蓋掉它。
 * - 列寬用 `ResizeObserver` 量（`clientWidth`）。`clientWidth` 為 0（未排版、隱藏）→ 不堆疊（`shouldStack`）。
 *   `view()` 建立時就掃一次並 observe：mount 之後沒有交易時 `update()` 不會被呼叫（靜態唯讀編輯器）。
 * - 欄的種類會隨內容變、列寬不變時 RO 不觸發 → 文件改變時用最近量到的寬度（以列 id 記）重算。
 */
import { createExtension, type ExtensionOptions } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { Decoration, DecorationSet } from "prosemirror-view";
import { createPmPlugin } from "../pm-plugin";
import { attachColumnImageResize } from "./image-resize";
import { columnKindOf, shouldStack, type ColumnKind, type PMNodeLike } from "./layout";

export const STACKED_ATTR = "data-stacked";
/** 只在 image 欄掛 `"image"`。 */
export const COLUMN_KIND_ATTR = "data-kb-col-kind";

const ROW_SELECTOR = `[data-node-type="${COLUMN_LIST_TYPE}"]`;

/** 只取用得到的欄位——PM 的 EditorState／EditorView 型別在 apps/web 值層級拿不到（見 `pm-plugin.ts`）。 */
interface StateLike {
  doc: PMNodeLike;
}
interface TransactionLike {
  getMeta(key: unknown): unknown;
  setMeta(key: unknown, value: unknown): TransactionLike;
}
interface ViewLike {
  dom: HTMLElement;
  state: StateLike & { tr: TransactionLike };
  dispatch(tr: TransactionLike): void;
}
interface PluginLike {
  getState(state: StateLike): ReadonlySet<string>;
}

/** 頂層（`doc.firstChild` 的子節點）的每一列與其起點。 */
function forEachRow(doc: PMNodeLike, f: (row: PMNodeLike, pos: number) => void): void {
  doc.firstChild?.forEach((node, offset) => {
    if (node.type.name === COLUMN_LIST_TYPE) f(node, offset + 1);
  });
}

function kindsOf(row: PMNodeLike): ColumnKind[] {
  const kinds: ColumnKind[] = [];
  row.forEach((col) => {
    if (col.type.name === COLUMN_TYPE) kinds.push(columnKindOf(col));
  });
  return kinds;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function layoutDecorations(doc: PMNodeLike, stacked: ReadonlySet<string>): DecorationSet {
  const decorations: Decoration[] = [];
  forEachRow(doc, (row, pos) => {
    if (stacked.has(row.attrs.id as string)) decorations.push(Decoration.node(pos, pos + row.nodeSize, { [STACKED_ATTR]: "" }));
    row.forEach((col, offset) => {
      const from = pos + 1 + offset;
      if (columnKindOf(col) === "image") decorations.push(Decoration.node(from, from + col.nodeSize, { [COLUMN_KIND_ATTR]: "image" }));
    });
  });
  return DecorationSet.create(doc as unknown as Parameters<typeof DecorationSet.create>[0], decorations);
}

/** 每次呼叫回新的 plugin（每個編輯器一份）。state＝已堆疊列 id 的集合，以 `tr.getMeta(plugin)` 整組替換。 */
function createStackingPlugin(): never {
  const plugin: PluginLike = createPmPlugin({
    state: {
      init: () => new Set<string>(),
      apply: (tr: TransactionLike, value: ReadonlySet<string>) => (tr.getMeta(plugin) as ReadonlySet<string> | undefined) ?? value,
    },
    props: { decorations: (state: StateLike) => layoutDecorations(state.doc, plugin.getState(state)) },
    view(editorView: ViewLike) {
      if (typeof ResizeObserver === "undefined") return {};
      const observed = new WeakSet<Element>();
      const widths = new Map<string, number>();
      let destroyed = false;

      const compute = (state: StateLike): Set<string> => {
        const next = new Set<string>();
        forEachRow(state.doc, (row) => {
          const id = row.attrs.id as string;
          const width = widths.get(id);
          if (width !== undefined && shouldStack(kindsOf(row), width)) next.add(id);
        });
        return next;
      };
      const commit = () => {
        if (destroyed) return;
        const next = compute(editorView.state);
        if (sameSet(next, plugin.getState(editorView.state))) return;
        editorView.dispatch(editorView.state.tr.setMeta(plugin, next).setMeta("addToHistory", false));
      };

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // 被 PM 換掉／刪掉的舊列元素可能再報一次 0 寬：不記（免得蓋掉同 id 新元素的寬度）、不再觀察；
          // 從已觀察集合拿掉，元素若被接回 DOM，下一次 scan() 會重新 observe。
          if (!entry.target.isConnected) {
            observer.unobserve(entry.target);
            observed.delete(entry.target);
            continue;
          }
          const id = entry.target.getAttribute("data-id");
          if (id) widths.set(id, (entry.target as HTMLElement).clientWidth);
        }
        commit();
      });
      const scan = () => {
        editorView.dom.querySelectorAll(ROW_SELECTOR).forEach((el) => {
          if (observed.has(el)) return;
          observed.add(el);
          observer.observe(el);
        });
      };
      scan();

      return {
        update(view: ViewLike, prevState: StateLike) {
          scan();
          if (prevState.doc === view.state.doc) return;
          if (sameSet(compute(view.state), plugin.getState(view.state))) return;
          // 不在 update 裡同步 dispatch；排程時 commit 會再檢查 view 未 destroy、集合仍不同。
          queueMicrotask(commit);
        },
        destroy() {
          destroyed = true;
          observer.disconnect();
        },
      };
    },
  }) as PluginLike;
  return plugin as never;
}

export const columnsLayoutExtension = createExtension(({ editor }: ExtensionOptions<undefined>) => ({
  key: "knotebookColumnsLayout",
  prosemirrorPlugins: [createStackingPlugin()],
  mount: ({ dom, signal }: { dom: HTMLElement; signal: AbortSignal }) => attachColumnImageResize(editor, dom, signal),
}))();

interface BlockSpecLike {
  extensions?: readonly unknown[];
}

/** 回**新物件**，不就地改傳入的 spec（shared 的 `columnListBlockSpec` 也給 headless schema 用）。 */
export function withColumnsLayout<S extends BlockSpecLike>(spec: S): S {
  return { ...spec, extensions: [...(spec.extensions ?? []), columnsLayoutExtension] };
}
