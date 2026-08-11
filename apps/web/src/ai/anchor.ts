import type { BlockNoteEditor } from "@blocknote/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * 快照字串＝守門 2 與 revert-stale 判定的**唯一真相**（spec §13.3）。刻意不用雜湊：
 * WebCrypto 在非 secure context（LAN plain-http，rev 5.6 允許的正當拓撲）是
 * undefined，且 async 會打破「守門→replaceBlocks 全程同步」。
 */
export function blockSnapshot(editor: AnyEditor, blockId: string): string | null {
  const block = editor.getBlock(blockId);
  return block === undefined ? null : JSON.stringify(block);
}

export interface AiAnchor {
  noteId: string;
  blockIds: string[];
  snapshots: string[];
}

export function captureAnchor(editor: AnyEditor, noteId: string, blockIds: string[]): AiAnchor {
  return { noteId, blockIds, snapshots: blockIds.map((id) => blockSnapshot(editor, id) ?? "") };
}

export function verifyAnchor(editor: AnyEditor, anchor: AiAnchor): "ok" | "missing" | "changed" {
  for (let i = 0; i < anchor.blockIds.length; i += 1) {
    const now = blockSnapshot(editor, anchor.blockIds[i]);
    if (now === null) return "missing";
    if (now !== anchor.snapshots[i]) return "changed";
  }
  return "ok";
}
