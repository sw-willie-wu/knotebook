// 並排排版（spec 2026-10-21 columns-layout §5.1）的兩個節點：`columnList`（列）與 `column`（欄）。
// MIT 自寫、clean-room：不引入也不參考 `@blocknote/xl-multi-column`。節點名沿用 core 的 `columnList`／`column`，
// 才吃得到 core 內建的 `UniqueID`（types 含這兩名）、`fixColumnList`、鍵盤與 SideMenu 行為（spec §4-1）。
// 同 note-schema-config.ts：只有 renderHTML／toExternalHTML 閉包碰 document，且只在掛載與匯出時被呼叫。
//
// parse：列的規則以 getAttrs 限定至少兩欄；外部形的欄規則（`div[data-kb-column]`）另限定父元素是合格的外部列——
// 只靠列層限定擋不住單欄外部 HTML，內層的欄仍會被認成欄、被 PM 包成補了空欄的兩欄列。站內形的欄規則不加限定
// （從欄內複製再貼上靠它重建）；也不用 `context: "columnList/"`，那會讓欄內複製再貼上丟例外。
//
// 改這裡的節點名、group、content、prop＝改 note schema：同步升 `note-schema-version.ts` 的 NOTE_SCHEMA_VERSION。
import { createBlockSpecFromTiptapNode } from "@blocknote/core";
import { Node } from "@tiptap/core";

export const COLUMN_LIST_TYPE = "columnList";
export const COLUMN_TYPE = "column";
export const COLUMN_LIST_GROUP = "childContainer bnBlock blockGroupChild";
export const COLUMN_LIST_CONTENT = "column column+";
export const COLUMN_GROUP = "bnBlock childContainer";
export const COLUMN_CONTENT = "blockContainer+";
export const COLUMNS_MIN = 2;
export const COLUMNS_MAX = 4;
export const COLUMN_WIDTH_MIN = 0.1;
export const COLUMN_WIDTH_MAX = 10;
export const COLUMN_WIDTH_DEFAULT = 1;
export const COLUMN_BLOCK_TYPES: ReadonlySet<string> = new Set([COLUMN_LIST_TYPE, COLUMN_TYPE]);
export const COLUMNS_STYLE = "display:flex;gap:16px";
export const COLUMNS_OPEN_TAG = `<div data-kb-columns style="${COLUMNS_STYLE}">`;

/** 非有限數 → 1；夾 [0.1, 10]；四捨五入到兩位小數。 */
export function clampColumnWidth(n: number): number {
  if (!Number.isFinite(n)) return COLUMN_WIDTH_DEFAULT;
  return Math.round(Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, n)) * 100) / 100;
}

/** 外部形的寬度字面：1 → "1"、1.5 → "1.5"、0.756 → "0.76"。 */
export function formatColumnWidth(n: number): string {
  return String(clampColumnWidth(n));
}

export function columnOpenTag(width: number): string {
  return `<div data-kb-column style="flex:${formatColumnWidth(width)}">`;
}

const FLEX_RE = /(?:^|;)\s*flex\s*:\s*([0-9]+(?:\.[0-9]+)?)/i;
/** 取 `flex` 屬性（不認 `-webkit-flex`、`display:flex`）的第一個數字；沒有 → 1。 */
export function parseColumnFlex(style: string | null): number {
  const m = FLEX_RE.exec(style ?? "");
  return m ? clampColumnWidth(Number(m[1])) : COLUMN_WIDTH_DEFAULT;
}

// #398 順手：走兄弟（`firstElementChild`／`nextElementSibling`）——server 端 DOM（jsdom）的 `children` 每讀一次是 O(子數)。
const countChildren = (el: Element, selector: string) => {
  let n = 0;
  for (let c = el.firstElementChild; c !== null; c = c.nextElementSibling) if (c.matches(selector)) n++;
  return n;
};
const hasEnoughColumns = (el: HTMLElement) =>
  countChildren(el, "div[data-node-type=column],div[data-kb-column]") >= COLUMNS_MIN ? {} : false;
const inExternalRow = (el: HTMLElement) => {
  const parent = el.parentElement;
  return parent && parent.matches("div[data-kb-columns]") && countChildren(parent, "div[data-kb-column]") >= COLUMNS_MIN ? {} : false;
};

function container(className: string, nodeType: string, attrs: Record<string, unknown>, style?: string): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = className;
  dom.setAttribute("data-node-type", nodeType);
  if (style !== undefined) dom.setAttribute("style", style);
  for (const [k, v] of Object.entries(attrs)) if (v != null) dom.setAttribute(k, String(v));
  return dom;
}

export const ColumnListNode = Node.create({
  name: COLUMN_LIST_TYPE,
  group: COLUMN_LIST_GROUP,
  content: COLUMN_LIST_CONTENT,
  priority: 40,
  parseHTML() {
    return [
      { tag: "div[data-node-type=columnList]", getAttrs: hasEnoughColumns },
      { tag: "div[data-kb-columns]", getAttrs: hasEnoughColumns },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    const dom = container("bn-block-column-list", COLUMN_LIST_TYPE, HTMLAttributes);
    return { dom, contentDOM: dom };
  },
});

export const ColumnNode = Node.create({
  name: COLUMN_TYPE,
  group: COLUMN_GROUP,
  content: COLUMN_CONTENT,
  priority: 40,
  addAttributes() {
    return {
      // 寬度由 node 的 renderHTML 寫進 style（`flex:N 1 0`），屬性本身不輸出。
      width: { default: COLUMN_WIDTH_DEFAULT, parseHTML: (el: HTMLElement) => parseColumnFlex(el.getAttribute("style")), renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-node-type=column]" }, { tag: "div[data-kb-column]", getAttrs: inExternalRow }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const dom = container("bn-block-column", COLUMN_TYPE, HTMLAttributes, `flex:${formatColumnWidth(node.attrs.width as number)} 1 0`);
    return { dom, contentDOM: dom };
  },
});

// toExternalHTML 自寫、不經 defaultBlockToHTML（spec §4-2）：只帶 §11.1 的屬性，不帶 class／data-id／data-node-type。
const listSpec = createBlockSpecFromTiptapNode({ node: ColumnListNode, type: COLUMN_LIST_TYPE, content: "none" }, {});
export const columnListBlockSpec: typeof listSpec = {
  ...listSpec,
  implementation: {
    ...listSpec.implementation,
    toExternalHTML: () => {
      const dom = document.createElement("div");
      dom.setAttribute("data-kb-columns", "");
      dom.setAttribute("style", COLUMNS_STYLE);
      return { dom, contentDOM: dom };
    },
  },
};

const colSpec = createBlockSpecFromTiptapNode(
  { node: ColumnNode, type: COLUMN_TYPE, content: "none" },
  { width: { default: COLUMN_WIDTH_DEFAULT } },
);
export const columnBlockSpec: typeof colSpec = {
  ...colSpec,
  implementation: {
    ...colSpec.implementation,
    toExternalHTML: (block: { props: { width: number } }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-kb-column", "");
      dom.setAttribute("style", `flex:${formatColumnWidth(block.props.width)}`);
      return { dom, contentDOM: dom };
    },
  },
};
