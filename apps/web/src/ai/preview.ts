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
  /** 前後上下文塊的 id（`DiffEditor` 對它們貼 `data-diff="surround"`）。 */
  surroundIds: string[];
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
 * §5.4 預覽資料：`before = [prev?, ...錨點區塊, next?]`、`after = [prev?, ...afterBlocks, next?]`。prev／next 是首／末區塊在**自己那一層**
 * 的前／後兄弟，存在才放、一律 `children: []`（不帶子樹）。排除兩種：祖先——open() 到串流完成之間文件被搬動時可達，錨點仍可能
 * verify ok；錨點子樹內的區塊——只在錨點已 `changed` 時可達（snapshot 含子樹），但串流完成時 buildPreview 先於守門呼叫，所以仍會跑到。
 * `afterBlocks` 原物件放進 after（預覽與寫入同一份）。
 */
export function buildPreview(editor: AnyEditor, blockIds: readonly string[], afterBlocks: readonly DiffBlock[], noChange: boolean): AiPreview {
  const anchorBlocks = blockIds.map((id) => editor.getBlock(id)).filter((block): block is AnyBlock => block !== undefined);
  const excluded = new Set<string>();
  const collect = (block: AnyBlock): void => {
    excluded.add(block.id);
    block.children.forEach(collect);
  };
  anchorBlocks.forEach(collect);
  for (const id of blockIds) {
    for (let parent = editor.getParentBlock(id); parent; parent = editor.getParentBlock(parent.id)) excluded.add(parent.id);
  }
  const asSurround = (block: AnyBlock | undefined): DiffBlock | null =>
    block && !excluded.has(block.id) ? { ...block, children: [] } : null;
  const prev = blockIds.length > 0 ? asSurround(editor.getPrevBlock(blockIds[0])) : null;
  const next = blockIds.length > 0 ? asSurround(editor.getNextBlock(blockIds[blockIds.length - 1])) : null;
  const head = prev ? [prev] : [];
  const tail = next ? [next] : [];
  return {
    before: [...head, ...anchorBlocks, ...tail],
    after: [...head, ...afterBlocks, ...tail],
    surroundIds: [prev?.id, next?.id].filter((id): id is string => typeof id === "string"),
    noChange,
  };
}
