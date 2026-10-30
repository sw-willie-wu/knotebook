import type { Block, BlockNoteEditor } from "@blocknote/core";
import {
  COLUMN_BLOCK_TYPES,
  COLUMN_TYPE,
  checkNoteMarkdownSyntax,
  convertSiteLinks,
  findDisallowedColor,
  findStructureError,
  isBlankParseResult,
  normalizeTableWidths,
  rebindWikilinks,
  relativizeSiteUploads,
  restoreMermaidBlocks,
  targetFromList,
  type MarkdownPlacement,
  type MarkdownSyntaxError,
  type SiteLinkCandidate,
  type WikilinkTarget,
} from "@knotebook/shared";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { verifyAnchor, type AiAnchor } from "./anchor"; // 只 import 有呼叫點的符號——no-unused-vars 是 error 且 root lint --max-warnings=0

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/wikilink/menu.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;

export type { WikilinkTarget };
export interface ApplyDeps {
  /** `["notes"]` 快取（使用者可見清單）——`[[…]]` 重綁與 #269 站內連結比對共用。 */
  notes: readonly SiteLinkCandidate[];
  /** 站內網址判準的 origin；不給＝`window.location.origin`。 */
  siteOrigin?: string;
  /** 套回的目標位置（{@link anchorPlacement}）：`"nested"` 時 AI 結果不得含並排。 */
  placement: MarkdownPlacement;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote Block 的泛型三元組，走 repo 慣例用 any（同 ApplyOutcome 的 M-2 說明）
type AnyBlock = Block<any, any, any>;

/** #263 §5.2 第 1 步的產物：預覽（`buildPreview` 的 after）與寫入（`applyAiResult`）用**同一個** `blocks` 陣列。 */
export interface PreparedResult {
  blocks: AnyBlock[];
  unboundCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同 AnyBlock 的說明，BlockNote 泛型三元組
function hasColumnBlock(blocks: readonly { type?: string; children?: readonly any[] }[]): boolean {
  return blocks.some((b) => COLUMN_BLOCK_TYPES.has(b.type as string) || (b.children ? hasColumnBlock(b.children) : false));
}

/**
 * 語法檢查（並排 PR-2，與 MCP 同一套 S1–S10）→ parse → mermaid 還原 → 欄寬正規化 → 站內上傳網址還原相對形 → 結構檢查
 * → 色值（#222）→ 空結果判定（同 server 的順序）→ 重綁 wikilink（#263 從 `applyAiResult` 抽出的純函式，不碰文件）。兩道檢查不過、或 parse 丟例外，回 `{ invalid: 碼 }`。空字串／純空白回 `{ empty: true }`：
 * parse `""` 回單一空段落而不是 `[]`（`@knotebook/shared` 的 `isBlankParseResult` 實測註記），
 * 不擋的話套用會把原文換成空段落。
 */
export function prepareAiResult(
  editor: AnyEditor,
  markdown: string,
  deps: ApplyDeps,
): PreparedResult | { empty: true } | { invalid: MarkdownSyntaxError | "unsupported_color" } {
  const syntax = checkNoteMarkdownSyntax(markdown, deps.placement);
  if (!syntax.ok) return { invalid: syntax.error };
  let raw: AnyBlock[];
  try {
    raw = editor.tryParseHTMLToBlocks(syntax.html);
  } catch {
    // core 對部分編輯器內部形會丟例外（例：`<div data-content-type="paragraph">`）：同 server，當成存不了的內容；不接的話例外丟在串流續體裡、框停在串流中
    return { invalid: "unsupported_block" };
  }
  // 同 server 管線：mermaid 還原（```mermaid 的 codeBlock → mermaid block，含欄內）→ 欄寬正規化 → 站內上傳網址還原相對形。
  // 讀碼發現 15：parse 所用 DOM 的 base（瀏覽器＝`window.location`）；`deps.siteOrigin` 是站內連結判準，不混用
  const parsed = relativizeSiteUploads(normalizeTableWidths(restoreMermaidBlocks(raw)), new URL(document.baseURI).origin);
  const shape = findStructureError(parsed, deps.placement);
  if (shape !== null) return { invalid: shape };
  // #222：同 MCP，色值只收內建色名，其他值整筆拒絕（編輯器畫面不顯示，不能靜默存進去）
  if (findDisallowedColor(parsed) !== null) return { invalid: "unsupported_color" };
  if (isBlankParseResult(parsed)) return { empty: true };
  const [rebound, unboundCount] = rebindWikilinks(
    parsed,
    [...deps.notes],
    (type) => editor.schema.blockSchema[type]?.content === "inline",
  );
  // #269 §8.6：站內連結 → wikilink，只以已載入的快取解析（沒有後備，§17-14）。預覽與寫入仍是同一份 blocks。
  const [blocks] = convertSiteLinks(rebound, (_href, p) => targetFromList(p.path, deps.notes) ?? null, deps.siteOrigin ?? window.location.origin);
  return { blocks, unboundCount };
}

export type ApplyOutcome =
  // fix round 1 M-2：`replacedSnapshot` 是 `AnyEditor.getBlock()` 拿到的 `Block<any,any,any>`（含本專案 wikilink inline content 的實際形狀）。
  | { ok: true; insertedIds: string[]; replacedSnapshot: AnyBlock[] }
  | { ok: false; reason: "missing" | "changed" };

/**
 * 框選錨點「擴大成整列」的觸發條件（{@link expandAnchorForColumns}，spec §7.5、Q7）：選取含欄／列本身（跨欄、從列外選進列）、或各 block 不在同一欄
 * （從欄內選到列外，core 的清單裡沒有欄節點，見 selection-delete.test.ts C8）→ true。
 * 完全在單一欄內、或不碰並排 → false。
 * 只比首尾兩個 block 的所在欄：core 的清單是文件順序上連續的一段，跨過整列時清單裡會有那個列（上一行已擋），
 * 所以首尾同欄（或都不在欄內）時中間的 block 也一樣（每個 block 都查會是 O(N²)，final review r2 m-2）。
 */
export function selectionTouchesColumns(editor: Pick<AnyEditor, "getParentBlock">, blocks: readonly AnyBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (hasColumnBlock(blocks)) return true;
  const columnOf = (id: string): string | null => {
    for (let parent = editor.getParentBlock(id); parent; parent = editor.getParentBlock(parent.id)) {
      if (parent.type === COLUMN_TYPE) return parent.id;
    }
    return null;
  };
  return columnOf(blocks[0].id) !== columnOf(blocks[blocks.length - 1].id);
}

/** 選取碰到並排（{@link selectionTouchesColumns}）時，每個 block 換成它的頂層祖先（自己就是頂層則不變），去重保序；否則原樣回 ids。 */
export function expandAnchorForColumns(editor: Pick<AnyEditor, "getParentBlock">, blocks: readonly AnyBlock[]): string[] {
  if (!selectionTouchesColumns(editor, blocks)) return blocks.map((b) => b.id);
  const ids = new Set<string>();
  for (const block of blocks) {
    let top = block.id;
    for (let parent = editor.getParentBlock(top); parent; parent = editor.getParentBlock(parent.id)) top = parent.id;
    ids.add(top);
  }
  return [...ids];
}

/** 錨點每個 block 都在頂層 → "top"；否則 "nested"（Q6：欄內與縮排子 block 都算）。 */
export function anchorPlacement(editor: Pick<AnyEditor, "getParentBlock">, blockIds: readonly string[]): MarkdownPlacement {
  return blockIds.every((id) => editor.getParentBlock(id) === undefined) ? "top" : "nested";
}

const NON_TEXT_TYPES = new Set(["image", "audio", "video", "file"]);

/** 錨點 block 或其任一子孫（欄、縮排子 block）是 image／audio／video／file。 */
export function hasNonTextBlock(editor: AnyEditor, blockIds: string[]): boolean {
  const stack: AnyBlock[] = blockIds.map((id) => editor.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (NON_TEXT_TYPES.has(b.type)) return true;
    stack.push(...(b.children as AnyBlock[]));
  }
  return false;
}

/** 守門→取代：**全程同步、無 await**（spec §13.3）。寫入的是 `prepared.blocks` 本身（#263：與預覽同一份）；走 D25 helper，欄內套用不收欄。 */
export function applyAiResult(editor: AnyEditor, anchor: AiAnchor, prepared: PreparedResult): ApplyOutcome {
  const verdict = verifyAnchor(editor, anchor);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  // 守門只比內容不比位置：預覽期間錨點被縮排或搬進欄時，以「現在」的位置重驗結構（Q6），否則會寫出巢狀列、弄壞 id
  if (findStructureError(prepared.blocks, anchorPlacement(editor, anchor.blockIds)) !== null) return { ok: false, reason: "changed" };
  // 守門已保證所有 blockIds 存在（否則已提早 return "missing"），這裡的 `!` 只是把已驗證的事實告訴型別系統。
  const replacedSnapshot = anchor.blockIds.map((id) => editor.getBlock(id)!);
  const { insertedBlocks } = replaceBlocksKeepColumns(editor, anchor.blockIds, prepared.blocks);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- insertedBlocks 元素為 BlockNote 內部泛型 Block，走 repo 慣例用 any
  return { ok: true, insertedIds: insertedBlocks.map((b: any) => b.id), replacedSnapshot };
}

export type RevertOutcome = "ok" | "stale";

/** spec §13.3 單一規則：插入 ids「任一消失**或**快照字串已變」→ stale，一律在這裡判——
 * 不拆給面板（拆開＝面板忘了做就靜默覆蓋他人編輯）。insertedAnchor＝applyAiResult 成功後
 * 呼叫端**立刻** captureAnchor(editor, noteId, out.insertedIds) 存下的錨點。 */
export function revertAiResult(
  editor: AnyEditor,
  insertedAnchor: AiAnchor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同 ApplyOutcome.replacedSnapshot（M-2），BlockNote Block 的泛型三元組走 repo 慣例用 any
  replacedSnapshot: Block<any, any, any>[],
): RevertOutcome {
  if (verifyAnchor(editor, insertedAnchor) !== "ok") return "stale";
  replaceBlocksKeepColumns(editor, insertedAnchor.blockIds, replacedSnapshot);
  return "ok";
}
