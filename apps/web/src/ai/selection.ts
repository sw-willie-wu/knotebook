import { getNodeById, type BlockNoteEditor } from "@blocknote/core";
import { isTextSelection } from "@tiptap/core";
import { FOCUS_MAX_CODE_POINTS, truncateCodePoints } from "@knotebook/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
type AnyEditor = BlockNoteEditor<any, any, any>;

/** PM 的 `EditorState` 與 `Transaction` 都有 `doc`／`selection`。呼叫端一律 `editor.transact((tr) => fn(tr, …))`（BlockNote 建議的讀法；
 * 只讀不改的 tr 不會被 dispatch，見 StateManager.transact）。 */
export type PMLike = Pick<AnyEditor["prosemirrorState"], "doc" | "selection">;
type PMNode = PMLike["doc"];

export interface BlockRange {
  from: number;
  to: number;
}

/** 區塊（`blockContainer`）的 posBefore～posAfter；找不到回 null。 */
export function blockRange(doc: PMNode, blockId: string): BlockRange | null {
  const info = getNodeById(blockId, doc);
  return info ? { from: info.posBeforeNode, to: info.posBeforeNode + info.node.nodeSize } : null;
}

/** 首區塊 posBefore～末區塊 posAfter；任一端找不到回 null。 */
export function anchorRange(doc: PMNode, blockIds: readonly string[]): BlockRange | null {
  if (blockIds.length === 0) return null;
  const first = blockRange(doc, blockIds[0]);
  const last = blockRange(doc, blockIds[blockIds.length - 1]);
  return first && last ? { from: first.from, to: last.to } : null;
}

/**
 * 「內建工具列此刻會不會出現」（#263 S2）。**照抄**上游 `FormattingToolbarExtension.shouldShow`（BlockNote 0.52.1
 * `extensions/FormattingToolbar/FormattingToolbar.ts`，閉包私有、不可引用）的三個條件：選取非空、TextSelection 須含文字、不跨 code 節點；
 * NodeSelection／CellSelection 與上游一樣回 true。D12 自動關閉用它判「使用者做出了非空選取」；**不得**改用工具列 store
 * （store 在 pointerdown 期間恆為 false，pointerup 寫回 true 時不再有 selection change，滑鼠拖選會漏）。
 */
export function toolbarWouldShow({ doc, selection }: PMLike): boolean {
  if (selection.empty) return false;
  if (isTextSelection(selection) && doc.textBetween(selection.from, selection.to).length === 0) return false;
  let spansCode = false;
  selection.content().content.descendants((node) => {
    if (node.type.spec.code) spansCode = true;
    return !spansCode;
  });
  return !spansCode;
}

/**
 * 選取是否整個落在錨點範圍內（#263 §5.2；D12 自動關閉與工具列壓制共用的唯一判斷）。部分重疊算不在範圍內。
 * RF1：Ctrl+A 的 AllSelection 是 from=0、to=doc.content.size，落在根 blockGroup 的開合 token 上，比首區塊的 posBefore（=1）還外面——
 * 先夾回根 blockGroup 的內容區 [1, doc.content.size − 1] 再比，否則全選開的框永遠「不在範圍內」。
 */
export function selectionInsideAnchor({ doc, selection }: PMLike, blockIds: readonly string[]): boolean {
  const range = anchorRange(doc, blockIds);
  if (!range) return false;
  const from = Math.max(selection.from, 1);
  const to = Math.min(selection.to, doc.content.size - 1);
  return from >= range.from && to <= range.to;
}

/** `textBetween` 的 leaf 文字：wikilink 寫成 `[[標題]]`（與送出的 markdown 一致）、硬換行寫成 `\n`，其餘取 textContent。 */
export function leafText(node: PMNode): string {
  if (node.type.name === "wikilink") return `[[${String(node.attrs.snapshotTitle ?? "")}]]`;
  if (node.type.name === "hardBreak") return "\n";
  return node.textContent;
}

/**
 * `open()` 的 focus（#263 §5.2、D8）：選取恰好涵蓋錨點區塊的全部文字 → `""`；否則取選取文字（區塊間以 `\n` 分隔、leaf 輸出其文字），
 * 以 code point 截到 2000。「恰好涵蓋」以「選取文字＝錨點全文」判——三擊整段、跨區塊整段拖選、Ctrl+A 都成立（探針實測三形相等）。
 */
export function selectionFocus({ doc, selection }: PMLike, blockIds: readonly string[]): string {
  const selected = doc.textBetween(selection.from, selection.to, "\n", leafText);
  const range = anchorRange(doc, blockIds);
  if (range && selected === doc.textBetween(range.from, range.to, "\n", leafText)) return "";
  return truncateCodePoints(selected, FOCUS_MAX_CODE_POINTS);
}
