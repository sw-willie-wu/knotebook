import type { Block, BlockNoteEditor } from "@blocknote/core";
import { isBlankParseResult, rebindWikilinks, type WikilinkTarget } from "@knotebook/shared";
import { verifyAnchor, type AiAnchor } from "./anchor"; // 只 import 有呼叫點的符號——no-unused-vars 是 error 且 root lint --max-warnings=0

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/wikilink/menu.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;

export type { WikilinkTarget };
export interface ApplyDeps {
  notes: WikilinkTarget[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote Block 的泛型三元組，走 repo 慣例用 any（同 ApplyOutcome 的 M-2 說明）
type AnyBlock = Block<any, any, any>;

/** #263 §5.2 第 1 步的產物：預覽（`buildPreview` 的 after）與寫入（`applyAiResult`）用**同一個** `blocks` 陣列。 */
export interface PreparedResult {
  blocks: AnyBlock[];
  unboundCount: number;
}

/**
 * parse → 空結果判定 → 重綁 wikilink（#263 從 `applyAiResult` 抽出的純函式，不碰文件）。空字串／純空白回 `{ empty: true }`：
 * `tryParseMarkdownToBlocks("")` 回單一空段落而不是 `[]`（`@knotebook/shared` 的 `isBlankParseResult` 實測註記），
 * 不擋的話套用會把原文換成空段落。
 */
export function prepareAiResult(editor: AnyEditor, markdown: string, deps: ApplyDeps): PreparedResult | { empty: true } {
  const parsed = editor.tryParseMarkdownToBlocks(markdown);
  if (isBlankParseResult(parsed)) return { empty: true };
  const [blocks, unboundCount] = rebindWikilinks(
    parsed,
    deps.notes,
    (type) => editor.schema.blockSchema[type]?.content === "inline",
  );
  return { blocks, unboundCount };
}

export type ApplyOutcome =
  // fix round 1 M-2：`replacedSnapshot` 是 `AnyEditor.getBlock()` 拿到的 `Block<any,any,any>`（含本專案 wikilink inline content 的實際形狀）。
  | { ok: true; insertedIds: string[]; replacedSnapshot: AnyBlock[] }
  | { ok: false; reason: "missing" | "changed" };

const NON_TEXT_TYPES = new Set(["image", "audio", "video", "file"]);

export function hasNonTextBlock(editor: AnyEditor, blockIds: string[]): boolean {
  return blockIds.some((id) => NON_TEXT_TYPES.has(editor.getBlock(id)?.type ?? ""));
}

/** 守門→replaceBlocks：**全程同步、無 await**（spec §13.3）。寫入的是 `prepared.blocks` 本身（#263：與預覽同一份）。 */
export function applyAiResult(editor: AnyEditor, anchor: AiAnchor, prepared: PreparedResult): ApplyOutcome {
  const verdict = verifyAnchor(editor, anchor);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  // 守門已保證所有 blockIds 存在（否則已提早 return "missing"），這裡的 `!` 只是把已驗證的事實告訴型別系統。
  const replacedSnapshot = anchor.blockIds.map((id) => editor.getBlock(id)!);
  const { insertedBlocks } = editor.replaceBlocks(anchor.blockIds, prepared.blocks);
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
  editor.replaceBlocks(insertedAnchor.blockIds, replacedSnapshot);
  return "ok";
}
