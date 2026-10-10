import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { DiffBlock } from "./version-diff";

/**
 * 版本快照 → blocks（spec §8.4）。**不 mount、不掛 collaboration**：`yXmlFragmentToBlocks` 只用 editor 的
 * ProseMirror schema（r1 實跑：未 mount 的編輯器讀得到完整 blocks、wikilink 的 targetNoteId 保留）。
 * ⚠ 禁止改成「對活 fragment mount 一顆 collaboration editor」——那顆編輯器會把正規化結果寫回活文件
 * （r2 實跑：mount 真空筆記會回寫空段落並傳到 server），等於預覽就改了筆記。
 *
 * 讀者編輯器只建一次、重複使用：它從不 mount，`yXmlFragmentToBlocks` 只用 `pmSchema` 做節點轉換。
 * ⚠ 讀取路徑並非唯讀：y-prosemirror 的 `createNodeFromYElement` 遇到 schema 不認得的節點型別，會在
 * `el.doc.transact` 裡刪掉那個 Y 節點；遇到本機 clientID 的相鄰 Y.Text 也會合併刪除。
 * 對活文件直接讀等於把這些寫回並同步到 server，所以「目前狀態」必須先 fork（見 `forkLiveBlocks`）。
 */
let reader: BlockNoteEditor<typeof noteSchema.blockSchema, typeof noteSchema.inlineContentSchema, typeof noteSchema.styleSchema> | null = null;
function getReader() {
  reader ??= BlockNoteEditor.create({ schema: noteSchema });
  return reader;
}

function blocksOf(doc: Y.Doc): DiffBlock[] {
  return yXmlFragmentToBlocks(getReader(), doc.getXmlFragment(YDOC_FRAGMENT)) as unknown as DiffBlock[];
}

export function ydocBytesToBlocks(bytes: Uint8Array): DiffBlock[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    return blocksOf(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * 「目前狀態」：先 fork 活文件（spec §8.4 逐字形）再讀 fork。fork 是承重的：讀取路徑可能對不合法節點／
 * 相鄰 Y.Text 寫回（見檔頭），寫回只發生在 fork 上，活文件零寫入。
 */
export function forkLiveBlocks(live: Y.Doc): DiffBlock[] {
  return ydocBytesToBlocks(Y.encodeStateAsUpdate(live));
}
