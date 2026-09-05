import type { Block, BlockNoteEditor } from "@blocknote/core";
import { isBlankParseResult, rebindWikilinks, type WikilinkTarget } from "@knotebook/shared";
import { verifyAnchor, type AiAnchor } from "./anchor"; // 只 import 有呼叫點的符號——no-unused-vars 是 error 且 root lint --max-warnings=0

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/wikilink/menu.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;

export type { WikilinkTarget };
export interface ApplyDeps {
  notes: WikilinkTarget[];
}
export type ApplyOutcome =
  // fix round 1 M-2：公開型別誠實化——`replacedSnapshot` 是 `AnyEditor.getBlock()` 拿到的
  // `Block<any,any,any>`（含本專案 wikilink inline content 的實際形狀），裸 `Block`
  // 只解析成 `@blocknote/core` 的預設 schema 三元組（不含 wikilink），硬套會需要
  // `as unknown as` 這種掩蓋型別落差的轉型；改標實際型別，讓呼叫端（Task 6）看到的
  // 契約跟 runtime 值一致。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 見上方理由，BlockNote 編輯器泛型三元組走 repo 慣例用 any
  | { ok: true; insertedIds: string[]; replacedSnapshot: Block<any, any, any>[]; unboundCount: number }
  // fix round 1 I-2：markdown 解析出零 blocks（空字串／純空白）不能讓 replaceBlocks 把
  // 使用者原文砍成空——多一個 "empty" 失敗態，守門式提早 return，不動文件。
  | { ok: false; reason: "missing" | "changed" | "empty" };

const NON_TEXT_TYPES = new Set(["image", "audio", "video", "file"]);

export function hasNonTextBlock(editor: AnyEditor, blockIds: string[]): boolean {
  return blockIds.some((id) => NON_TEXT_TYPES.has(editor.getBlock(id)?.type ?? ""));
}

// `isBlankParseResult`（空／純空白 markdown 的精確判定）與 `rebindWikilinks`
// （唯一命中才綁、重名／找不到留純文字並計數；`isInlineType` 由呼叫端傳
// `editor.schema.blockSchema[type]?.content === "inline"`，區分吃 inline content 的
// block 與 `plain`／`none`／`table`）住 `@knotebook/shared` 的 `note-markdown.ts`，
// 與 mermaid-paste.ts 同規則。

/** 守門→重綁→replaceBlocks：**全程同步、無 await**（spec §13.3）。 */
export function applyAiResult(editor: AnyEditor, anchor: AiAnchor, markdown: string, deps: ApplyDeps): ApplyOutcome {
  const verdict = verifyAnchor(editor, anchor);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  const parsed = editor.tryParseMarkdownToBlocks(markdown);
  // 不擋的話下面 `replaceBlocks(anchor.blockIds, parsed)` 會把使用者原本的段落換成
  // 一個空段落（或在真的拿到空陣列時直接砍空），卻回傳 `{ok:true}`，看起來像
  // 「AI 把這段清空了」。空結果不算合法套用，提早 return，不呼叫 `replaceBlocks`、
  // 不動文件（判定式的實測依據見 `@knotebook/shared` 的 `note-markdown.ts` 的
  // `isBlankParseResult`）。
  if (isBlankParseResult(parsed)) return { ok: false, reason: "empty" };
  const [blocks, unboundCount] = rebindWikilinks(
    parsed,
    deps.notes,
    (type) => editor.schema.blockSchema[type]?.content === "inline",
  );
  // 守門已在上方 `verifyAnchor` 保證所有 blockIds 存在（否則已提早 return "missing"），
  // 這裡的 `!` 只是把已被驗證過的事實告訴型別系統——brief 原始程式碼在 strict TS 下
  // 會撞 TS2322（`getBlock` 回傳型別含 `undefined`）。`replacedSnapshot` 的公開型別
  // 已改標 `Block<any,any,any>[]`（見上方 M-2 說明），跟 `getBlock` 的實際回傳型別
  // 一致，不需要額外轉型。
  const replacedSnapshot = anchor.blockIds.map((id) => editor.getBlock(id)!);
  const { insertedBlocks } = editor.replaceBlocks(anchor.blockIds, blocks);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- insertedBlocks 元素為 BlockNote 內部泛型 Block，走 repo 慣例用 any
  return { ok: true, insertedIds: insertedBlocks.map((b: any) => b.id), replacedSnapshot, unboundCount };
}

export type RevertOutcome = "ok" | "stale";

/** spec §13.3 單一規則：插入 ids「任一消失**或**快照字串已變」→ stale，一律在這裡判——
 * 不拆給面板（拆開＝面板忘了做就靜默覆蓋他人編輯）。insertedAnchor＝applyAiResult 成功後
 * 呼叫端**立刻** captureAnchor(editor, noteId, out.insertedIds) 存下的錨點。 */
export function revertAiResult(
  editor: AnyEditor,
  insertedAnchor: AiAnchor,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同 ApplyOutcome.replacedSnapshot（M-2），BlockNote 編輯器泛型三元組走 repo 慣例用 any
  replacedSnapshot: Block<any, any, any>[],
): RevertOutcome {
  if (verifyAnchor(editor, insertedAnchor) !== "ok") return "stale";
  editor.replaceBlocks(insertedAnchor.blockIds, replacedSnapshot);
  return "ok";
}
