import type { Block, BlockNoteEditor } from "@blocknote/core";
// ⚠ 只准 import type：version-diff 的值（diffBlocks／renderDiff）會把 `diff` 套件拉進 NotePage chunk（Global Constraints 16）。
import type { DiffBlock } from "@/lib/version-diff";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyBlock = Block<any, any, any>;

/** 預覽資料（#263 §5.2）：串流完成時**先凍結**（自動套用之前），之後不再讀現值。日後的原位覆蓋層（#265）以它為輸入。 */
export interface AiPreview {
  before: DiffBlock[];
  after: DiffBlock[];
  noChange: boolean;
}

/** §5.2 第 0 步：模型若仍回吐外層 `<text>…</text>`（忽略前後空白）就剝掉，連同標記內緊鄰的一個換行。 */
export function stripTextWrapper(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<text>") || !trimmed.endsWith("</text>")) return raw;
  return trimmed
    .slice("<text>".length, trimmed.length - "</text>".length)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
}

/** 兩端 trim、統一換行（CRLF／CR → LF）。 */
export function normalizeMarkdown(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

/** §5.2 第 3 步：結果與送出的原文正規化後相等＝沒有變更（守門判越界時模型回原文，RF5）。 */
export function isNoChange(result: string, original: string): boolean {
  return normalizeMarkdown(result) === normalizeMarkdown(original);
}

/**
 * §5.4 預覽資料：`before` ＝錨點區塊（呼叫當下的現值，含子樹；找不到的 id 略過）、`after` ＝ `afterBlocks` 原物件（預覽與寫入同一份）。
 * 只放被改的區塊——#263 後續（2026-10-13）拿掉了前後各一塊的淡色上下文：結果框改蓋在被改區塊上，旁邊的正文就是上下文。
 */
export function buildPreview(editor: AnyEditor, blockIds: readonly string[], afterBlocks: readonly DiffBlock[], noChange: boolean): AiPreview {
  const anchorBlocks = blockIds.map((id) => editor.getBlock(id)).filter((block): block is AnyBlock => block !== undefined);
  return { before: anchorBlocks, after: [...afterBlocks], noChange };
}
