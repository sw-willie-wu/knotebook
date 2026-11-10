import * as Y from "yjs";
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import type { BlockNoteEditor } from "@blocknote/core";

/**
 * #293：點頭像捲到對方游標。
 *
 * 換算照 y-prosemirror 1.3.7 `plugins/cursor-plugin.js` 的 `createDecorations`（遠端游標就是這樣畫出來的）：
 * 同一個 `ySync` plugin state、同一支 `relativePositionToAbsolutePosition`、同一組早退條件。
 * plugin 走 `editor.getExtension("ySync")?.prosemirrorPlugins?.[0]`，**不 import `ySyncPluginKey`**——
 * 理由同 `collab/undo.ts` 的 `collabUndoManager`（pnpm 給出兩份 y-prosemirror 時 PluginKey 身分對不上）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

export type CursorScroller = (cursor: unknown) => boolean;

/** y-prosemirror `ySync` plugin state（只取用得到的幾格）。 */
interface YSyncState {
  doc?: Y.Doc;
  type?: Y.XmlFragment;
  binding?: { mapping: Map<unknown, unknown> } | null;
  snapshot?: unknown;
  prevSnapshot?: unknown;
}

/** 遠端 awareness `cursor.head` → 本機 PM 位置；任何一步拿不到回 null，絕不丟錯。 */
export function cursorHeadPosition(editor: AnyEditor, cursor: unknown): number | null {
  if (typeof cursor !== "object" || cursor === null) return null;
  // 只用 head：游標在選取的移動端。
  const head = (cursor as { head?: unknown }).head;
  if (head == null) return null;
  const plugin = editor.getExtension("ySync")?.prosemirrorPlugins?.[0];
  const ystate = plugin?.getState(editor.prosemirrorState) as YSyncState | undefined;
  // 早退照抄 y-prosemirror createDecorations（binding 在 1.3.7 建 plugin 時就建好、不會是 null；這裡多擋一層防衛）。
  if (
    !ystate?.doc ||
    !ystate.type ||
    !ystate.binding ||
    ystate.binding.mapping.size === 0 ||
    ystate.snapshot != null ||
    ystate.prevSnapshot != null
  ) {
    return null;
  }
  let pos: number | null;
  try {
    pos = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      Y.createRelativePositionFromJSON(head),
      // 本地只宣告成 Map<unknown, unknown>，不 import y-prosemirror 的 ProsemirrorMapping 內部型別；值就是 binding 自己的 mapping。
      ystate.binding.mapping as never,
    );
  } catch {
    return null;
  }
  if (pos === null) return null;
  return Math.min(Math.max(pos, 0), editor.prosemirrorState.doc.content.size);
}

/**
 * getRoot 回 null（含版本預覽中）→ false；換算不到 → false；否則捲動容器 smooth 捲到「該行在容器高度 1/3 處」、回 true。
 * 不動選取、不搶焦點。
 */
export function createCursorScroller({ editor, getRoot }: { editor: AnyEditor; getRoot: () => HTMLElement | null }): CursorScroller {
  return (cursor) => {
    const root = getRoot();
    if (!root) return false;
    const pos = cursorHeadPosition(editor, cursor);
    if (pos === null) return false;
    let coords: { top: number };
    try {
      coords = editor.prosemirrorView.coordsAtPos(pos);
    } catch {
      return false;
    }
    const top = root.scrollTop + (coords.top - root.getBoundingClientRect().top) - root.clientHeight / 3;
    root.scrollTo({ top: Math.max(0, Math.round(top)), behavior: "smooth" });
    return true;
  };
}
