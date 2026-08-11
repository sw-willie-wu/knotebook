import type { Block, BlockNoteEditor } from "@blocknote/core";
import { verifyAnchor, type AiAnchor } from "./anchor"; // 只 import 有呼叫點的符號——no-unused-vars 是 error 且 root lint --max-warnings=0

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/wikilink/menu.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;

export interface WikilinkTarget {
  id: string;
  title: string;
}
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

// fix round 1 M-3：module-level 帶 `g` 旗標的 regex 有全域 lastIndex 狀態——目前唯一呼叫點
// `node.text.matchAll(WIKILINK_RE)` 安全（`matchAll` 內部會 clone 一份帶 lastIndex=0 的
// regex，不讀寫這個模組層級的實例，見 MDN／TC39 String.prototype.matchAll 規格），但日後
// 若有人手滑改成 `WIKILINK_RE.test(...)`／`WIKILINK_RE.exec(...)` 直接呼叫，lastIndex 會在
// 呼叫之間殘留、造成間歇性漏配對——改動這個 regex 的呼叫方式前请先確認呼叫方式仍是
// `matchAll`（或改成 function-local 建構避免共享狀態）。
const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g;

/** 唯一命中才綁；零/多重命中原樣保留純文字。回傳 [新 inline 陣列, 未綁數]。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote inline content 內部形狀（parse 出的原始節點），走 repo 慣例用 any
function rebindInline(content: any[], notes: WikilinkTarget[]): [any[], number] {
  let unbound = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  const out: any[] = [];
  for (const node of content) {
    if (node?.type !== "text" || typeof node.text !== "string" || !node.text.includes("[[")) {
      out.push(node);
      continue;
    }
    let last = 0;
    for (const m of node.text.matchAll(WIKILINK_RE)) {
      const title = m[1];
      const hits = notes.filter((n) => n.title === title);
      if (m.index! > last) out.push({ ...node, text: node.text.slice(last, m.index) });
      if (hits.length === 1) {
        out.push({ type: "wikilink", props: { targetNoteId: hits[0].id, snapshotTitle: title } });
      } else {
        unbound += 1;
        out.push({ ...node, text: m[0] });
      }
      last = m.index! + m[0].length;
    }
    if (last < node.text.length) out.push({ ...node, text: node.text.slice(last) });
  }
  return [out, unbound];
}

// fix round 1 I-2：`tryParseMarkdownToBlocks` 對空字串／純空白字串**不會**回傳 `[]`——
// 實測（`editor.tryParseMarkdownToBlocks("")` 與 `("   \n  \n")`）兩種輸入都回傳
// `[{ type: "paragraph", content: [], children: [] }]` 這個單一「空段落」形狀（審查
// 原文假設的「parse 出零 blocks」在本專案安裝的 0.52.1 上沒有實際發生過，這裡照觀察到
// 的行為修正判定式，意圖不變：空／純空白 markdown 不該讓 replaceBlocks 把使用者原文
// 砍空）。判定式因此不能只查 `blocks.length === 0`（防禦性保留，理論上若上游行為改變
// 回真的空陣列也接得住），還要認得出這個「單一空段落」訊號——刻意收斂到「只有一個
// block、type 是 paragraph、content 與 children 皆空」這個精確形狀，不要用更寬鬆的
// 「所有 block 都沒 content」條件：那樣會誤判合法的 `divider`（`content:"none"`，天生
// 沒有 content 陣列）等真實內容 block 為空。
function isBlankParseResult(blocks: unknown[]): boolean {
  if (blocks.length === 0) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote block 內部形狀（parse 出的原始節點），走 repo 慣例用 any
  const only = blocks[0] as any;
  return (
    blocks.length === 1 &&
    only?.type === "paragraph" &&
    (!Array.isArray(only.content) || only.content.length === 0) &&
    (!Array.isArray(only.children) || only.children.length === 0)
  );
}

// fix round 1 I-1：`b.content` 是陣列不代表可以塞 inline content——`codeBlock` 的
// `propSchema.content` 宣告是 `"plain"`（`@blocknote/core/src/blocks/Code/block.ts`），
// 但 parse 出來的節點形狀一樣是 `{ type: "text", text: "..." }[]` 陣列（純文字碼跟一般
// 段落文字在 markdown parse 出的 JSON 結構層級沒有區分）。原本只憑 `Array.isArray`
// 判斷會把 AI 回的 code fence 裡剛好命中的 `[[X]]` 也重綁成 wikilink inline
// node、塞進宣告 content 為 "plain" 的 block——ProseMirror 的 schema 驗證接下來可能直接
// throw，會在守門通過之後、`replaceBlocks` 之前的同步鏈路上炸掉。改成查
// `editor.schema.blockSchema[b.type]?.content === "inline"`（`schema.ts:153-156`：
// `blockSchema[type]` 就是各 block spec 的 `config`，跟各 `blocks/*/block.ts` 裡宣告的
// `content: "inline" | "plain" | "none" | "table"` 同一份）——只有真正吃 inline content
// 的 block 才做重綁，`plain`／`none`／`table` 一律原樣放行。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote block 內部形狀（parse 出的原始節點），走 repo 慣例用 any
function rebindBlocks(editor: AnyEditor, blocks: any[], notes: WikilinkTarget[]): [any[], number] {
  let unbound = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  const walk = (bs: any[]): any[] =>
    bs.map((b) => {
      const next = { ...b };
      const isInlineContent = editor.schema.blockSchema[b.type]?.content === "inline";
      if (isInlineContent && Array.isArray(b.content)) {
        const [content, n] = rebindInline(b.content, notes);
        unbound += n;
        next.content = content;
      }
      if (Array.isArray(b.children) && b.children.length > 0) next.children = walk(b.children);
      return next;
    });
  return [walk(blocks), unbound];
}

/** 守門→重綁→replaceBlocks：**全程同步、無 await**（spec §13.3）。 */
export function applyAiResult(editor: AnyEditor, anchor: AiAnchor, markdown: string, deps: ApplyDeps): ApplyOutcome {
  const verdict = verifyAnchor(editor, anchor);
  if (verdict !== "ok") return { ok: false, reason: verdict };
  const parsed = editor.tryParseMarkdownToBlocks(markdown);
  // 不擋的話下面 `replaceBlocks(anchor.blockIds, parsed)` 會把使用者原本的段落換成
  // 一個空段落（或在真的拿到空陣列時直接砍空），卻回傳 `{ok:true}`，看起來像
  // 「AI 把這段清空了」。空結果不算合法套用，提早 return，不呼叫 `replaceBlocks`、
  // 不動文件（判定式見上方 `isBlankParseResult` 的實測依據）。
  if (isBlankParseResult(parsed)) return { ok: false, reason: "empty" };
  const [blocks, unboundCount] = rebindBlocks(editor, parsed, deps.notes);
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
