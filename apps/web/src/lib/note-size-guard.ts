import * as Y from "yjs";

/**
 * 筆記大小上限的前端檢查（server `NOTE_MAX_BYTES`，經 `GET /api/auth/config` 的 `noteMaxBytes` 拿到）。**軟性檢查**：瀏覽器的協作更新
 * 不在 server 檢查，會一次塞進大量內容的動作——貼上、拖放、站內 AI 套用——在插入之前估「現在的大小＋這次會長多少」，超過上限就不放、
 * 跳提示（{@link exceedsNoteLimit}）。一般打字不擋；刪除永遠可以。估計值有誤差（見 {@link PER_ELEMENT_BYTES}），筆記可能因此稍微超過
 * 上限；REST、MCP、批次寫回仍由 server 精確檢查。
 *
 * - 現在的大小：`Y.encodeStateAsUpdate(doc)` 的位元組數（＝server 存的大小）。編輯器的 UndoManager 會留住本機刪掉的內容（墓碑，server 那邊
 *   會回收），所以原始大小會讓檢查擋下（或讓提示出現）時，改量一份回收過的複本再決定（{@link noteStateBytes}）。
 * - 這次會長多少：解析好、要插入的內容（ProseMirror slice 或 BlockNote 的 blocks）的文字 UTF-8 位元組＋每個元素節點 {@link PER_ELEMENT_BYTES}
 *   ＋格式標記，減去被取代的選取範圍（同樣估法）。
 */

/**
 * 每個區塊層級的元素節點（blockContainer、段落、清單項、表格列、儲存格、儲存格裡的段落…）在 Yjs 狀態裡大約佔的位元組數。實測（jsdom 掛
 * 真的 BlockNote＋y-prosemirror，貼上後回收過的狀態增量；審查探針 probe1 的形狀，各 1 000 個）：一個段落 block（兩個元素節點）約 210、
 * 一個清單項約 215、表格每格（儲存格＋段落，每列再一個）約 200——每個節點都帶 id 與一組預設屬性（顏色、對齊…），跟裡面的文字多寡無關。
 * 取 105：段落、清單約 1.0×（表格、巢狀清單、待辦清單另見 ELEMENT_BYTES_BY_TYPE）。
 */
export const PER_ELEMENT_BYTES = 105;
/** 行內的非文字節點（換行 `hardBreak`、wikilink…）：y-prosemirror 把它存成文字裡的一個嵌入項，實測每個約 39 B（1 000 行純文字貼上）。 */
export const PER_INLINE_NODE_BYTES = 36;
/**
 * 每個格式標記（粗體、斜體、inline code、連結…）的固定成本：Yjs 在文字裡用一對格式項（開始／結束）表示。實測（每個字都粗體、粗體與一般字
 * 交錯、每 3 個字一個 inline code、類 Wikipedia 的連結段落）約 54／個；連結另外算屬性的 key 與值（`markBytes`）。
 */
export const PER_MARK_BYTES = 55;
/**
 * 不是每個元素節點都一樣大：子清單外面那層 blockGroup 幾乎不帶屬性（三層巢狀清單實測，按 105 算會高估約 1.2×）；待辦清單項多一個 `checked`
 * 屬性（按 105 算低估約 0.9×）；表格的儲存格與格內段落比 block 少一組屬性（按 105 算高估約 1.15–1.2×）。其餘一律 {@link PER_ELEMENT_BYTES}。
 */
const ELEMENT_BYTES_BY_TYPE: Readonly<Record<string, number>> = { blockGroup: 20, checkListItem: 130, tableCell: 95, tableHeader: 95, tableParagraph: 95 };
const TABLE_CELL_BYTES = 2 * 95; // 儲存格＋格內段落（block JSON 那條估法用）
/** 連結在文件裡除了 href 還帶的屬性（key＋預設值：`href`、`target: _blank`、`rel: noopener noreferrer nofollow`）；BlockNote 的 block JSON 只有 href。 */
const LINK_DEFAULT_ATTR_BYTES = ("href" + "target" + "_blank" + "rel" + "noopener noreferrer nofollow").length; // 全是 ASCII
/** 節點上的字串屬性超過這麼長才另外算（網址、mermaid 原始碼…）；短的（顏色、對齊、id）已含在每個節點的固定成本裡。 */
const LONG_ATTR_CHARS = 16;

const encoder = new TextEncoder();
export function utf8Bytes(s: string): number {
  return encoder.encode(s).byteLength;
}

/**
 * 文件現在的大小（＝server 存的大小）。原始編碼的大小超過 `remeasureAbove`（會讓檢查擋下、或提示出現的那個值）時，改量一份回收過的複本
 * （新 Y.Doc＋applyUpdate＋encode）：本機刪掉、被 UndoManager 留著的內容（墓碑）不算——server 那邊早就回收了。只有這時才多付這筆成本：
 * 重量約是一次原始編碼的 5 倍（大頭是 applyUpdate；jsdom 實測 4.2 MB 的筆記約 27 ms → 145 ms）。成本與整份文件成正比：只在需要時呼叫。
 */
export function noteStateBytes(doc: Y.Doc, remeasureAbove?: number): number {
  const raw = Y.encodeStateAsUpdate(doc);
  if (remeasureAbove === undefined || raw.byteLength <= remeasureAbove) return raw.byteLength;
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, raw);
    return Y.encodeStateAsUpdate(copy).byteLength;
  } finally {
    copy.destroy();
  }
}

/** ProseMirror 節點的最小形狀（只讀需要的欄位，不依賴 prosemirror-model 的型別）。 */
interface PmNodeLike {
  isText: boolean;
  type?: { name?: string };
  attrs?: Record<string, unknown>;
  isInline?: boolean;
  text?: string | null;
  marks: readonly { attrs?: Record<string, unknown> }[];
  forEach?: (f: (child: PmNodeLike) => void) => void;
  content?: { forEach(f: (child: PmNodeLike) => void): void };
}

/** 格式標記：固定成本＋每個有值的屬性的 key 與字串值（連結的 href／target／rel／class 都存成格式項的一部分）。 */
function markBytes(marks: readonly { attrs?: Record<string, unknown> }[]): number {
  let n = 0;
  for (const m of marks) {
    n += PER_MARK_BYTES;
    if (m.attrs)
      for (const [k, v] of Object.entries(m.attrs)) {
        if (v === null || v === undefined) continue;
        n += utf8Bytes(k) + (typeof v === "string" ? utf8Bytes(v) : 0);
      }
  }
  return n;
}

/** 節點上長的字串屬性（不含 id）：同 {@link estimateBlocksBytes} 對 block props 的算法。 */
function longAttrBytes(attrs: Record<string, unknown> | undefined): number {
  let n = 0;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (k !== "id" && typeof v === "string" && v.length > LONG_ATTR_CHARS) n += utf8Bytes(v);
  return n;
}

function pmNodeBytes(node: PmNodeLike): number {
  if (node.isText) return utf8Bytes(node.text ?? "") + markBytes(node.marks);
  let n = node.isInline ? PER_INLINE_NODE_BYTES + markBytes(node.marks) : (ELEMENT_BYTES_BY_TYPE[node.type?.name ?? ""] ?? PER_ELEMENT_BYTES);
  n += longAttrBytes(node.attrs);
  node.content?.forEach(child => (n += pmNodeBytes(child)));
  return n;
}

/** 一段 ProseMirror 內容（slice 或 fragment：有 `content.forEach` 或自己有 `forEach`）插進文件後大約讓狀態長多少位元組。 */
export function estimatePmBytes(sliceOrFragment: { content?: { forEach(f: (child: PmNodeLike) => void): void }; forEach?: (f: (child: PmNodeLike) => void) => void }): number {
  let n = 0;
  const each = sliceOrFragment.content?.forEach.bind(sliceOrFragment.content) ?? sliceOrFragment.forEach?.bind(sliceOrFragment);
  each?.((child: PmNodeLike) => (n += pmNodeBytes(child)));
  return n;
}

/** BlockNote 的文字：換行（`\n`）在文件裡是一個換行節點（{@link PER_INLINE_NODE_BYTES}）。 */
function textBytes(s: string): number {
  let breaks = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) breaks++;
  return utf8Bytes(s) + breaks * (PER_INLINE_NODE_BYTES - 1);
}

/** BlockNote 行內內容（文字、連結）的位元組數。 */
function inlineBytes(content: unknown, code = false): number {
  const text = code ? utf8Bytes : textBytes; // 程式碼區塊裡的換行就是文字裡的 \n，不是換行節點
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text") {
      n += text(String(c.text ?? ""));
      const styles = c.styles as Record<string, unknown> | undefined;
      if (styles) for (const v of Object.values(styles)) n += PER_MARK_BYTES + (typeof v === "string" ? utf8Bytes(v) : 0);
    } else if (c.type === "link") {
      n += PER_MARK_BYTES + LINK_DEFAULT_ATTR_BYTES + utf8Bytes(String(c.href ?? "")) + inlineBytes(c.content, code);
    } else {
      n += PER_ELEMENT_BYTES + inlineBytes(c.content, code);
    }
  }
  return n;
}

/**
 * BlockNote 的 blocks（站內 AI 的 `prepared.blocks`、被取代的原文）插進文件後大約讓狀態長多少位元組：每個 block 兩個元素節點
 * （blockContainer＋內容節點），有子 block 再一個 blockGroup；表格每列一個、每格兩個（儲存格＋段落）。
 */
export function estimateBlocksBytes(blocks: readonly unknown[]): number {
  let n = 0;
  for (const raw of blocks) {
    const b = raw as { type?: string; content?: unknown; children?: unknown[]; props?: Record<string, unknown> };
    n += PER_ELEMENT_BYTES + (ELEMENT_BYTES_BY_TYPE[b.type ?? ""] ?? PER_ELEMENT_BYTES); // blockContainer＋內容節點
    n += longAttrBytes(b.props); // 長的屬性值（網址、mermaid 原始碼）
    const content = b.content as { type?: string; rows?: Array<{ cells?: unknown[] }> } | unknown[] | string | undefined;
    if (content && !Array.isArray(content) && typeof content === "object" && content.type === "tableContent") {
      for (const row of content.rows ?? []) {
        n += PER_ELEMENT_BYTES;
        for (const cell of row.cells ?? []) {
          n += TABLE_CELL_BYTES;
          const c = cell as { content?: unknown } | unknown[];
          n += inlineBytes(Array.isArray(c) ? c : (c as { content?: unknown }).content);
        }
      }
    } else {
      n += inlineBytes(content, b.type === "codeBlock");
    }
    if (b.children && b.children.length > 0) n += (ELEMENT_BYTES_BY_TYPE.blockGroup ?? PER_ELEMENT_BYTES) + estimateBlocksBytes(b.children);
  }
  return n;
}

/** 這次會長 `growthBytes` 之後會不會超過上限。上限未知（設定還沒載入）或沒有成長（≤ 0）→ 不擋。 */
export function exceedsNoteLimit(doc: Y.Doc, growthBytes: number, limitBytes: number | undefined): boolean {
  if (limitBytes === undefined || growthBytes <= 0) return false;
  if (growthBytes > limitBytes) return true; // 光是這次就超過：不必量
  return noteStateBytes(doc, limitBytes - growthBytes) + growthBytes > limitBytes;
}

/** 上限的顯示（MB／KB，至多一位小數；1 MB＝1 048 576 位元組，同 `NOTE_MAX_BYTES` 的預設 5 MiB 顯示成 5 MB）。 */
export function formatNoteLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${Number.isInteger(kb) ? kb : Math.max(kb, 0.1).toFixed(1)} KB`;
}

/**
 * 編輯器用的檢查函式：回傳 true＝長 `growthBytes` 之後會超過上限（已呼叫 `notify(上限)` 提示），這次不放。文件與上限每次呼叫時才讀
 * （編輯器建立時就固定的閉包要讀當下的值）。
 */
export function createNoteSizeGuard(getDoc: () => Y.Doc, getLimit: () => number | undefined, notify: (limitBytes: number) => void): (growthBytes: number) => boolean {
  return growthBytes => {
    const limit = getLimit();
    if (limit === undefined || !exceedsNoteLimit(getDoc(), growthBytes, limit)) return false;
    notify(limit);
    return true;
  };
}

/** ProseMirror view 的最小形狀（`handlePaste`／`handleDrop` 用）。 */
interface PmViewLike {
  state: { selection: { empty: boolean; content(): { content?: { forEach(f: (child: PmNodeLike) => void): void } } } };
}

/**
 * tiptap `editorProps` 的 `handlePaste`／`handleDrop`：在**解析好、插入之前**（BlockNote 的貼上——純文字、HTML、markdown、站內的
 * blocknote/html——最後都經 `view.pasteHTML`／`pasteText` → `doPaste` → `handlePaste`；拖放經 `handleDrop`）估這次會長多少，問 `guard`
 * （回傳 true＝超過上限、已提示，這次不放）。貼上取代選取範圍時扣掉被取代的部分；站內拖曳搬移（`moved`）不會讓筆記變大，不擋。
 */
export function createNoteSizePasteHandlers(guard: (growthBytes: number) => boolean): {
  handlePaste: (view: PmViewLike, event: ClipboardEvent, slice: Parameters<typeof estimatePmBytes>[0]) => boolean;
  handleDrop: (view: PmViewLike, event: DragEvent, slice: Parameters<typeof estimatePmBytes>[0], moved: boolean) => boolean;
} {
  return {
    handlePaste: (view, _event, slice) => {
      const sel = view.state.selection;
      const replaced = sel.empty ? 0 : estimatePmBytes(sel.content());
      return guard(estimatePmBytes(slice) - replaced);
    },
    handleDrop: (_view, _event, slice, moved) => (moved ? false : guard(estimatePmBytes(slice))),
  };
}
