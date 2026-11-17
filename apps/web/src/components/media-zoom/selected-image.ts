import type { EditorView } from "prosemirror-view";
import { isNodeSelection } from "@tiptap/core";

const IMAGE_CONTENT = '.bn-block-content[data-content-type="image"]';
const OWN_CONTENT = ":scope > .bn-block > .bn-block-content, :scope > .bn-block-content";

/**
 * 選取是整個 image block（NodeSelection，例如方向鍵選到、觸控點選）時回那張 `img.bn-visual-media`，否則 null。
 * 只看被選那個節點自己這一層：巢狀的子 block 不算（選外層時不能回子 block 的圖）。
 */
export function selectedImageOf(view: EditorView | undefined): HTMLImageElement | null {
  if (!view) return null;
  const { selection } = view.state;
  if (!isNodeSelection(selection)) return null;
  const dom = view.nodeDOM(selection.from);
  if (!(dom instanceof HTMLElement)) return null;
  const content = dom.matches(IMAGE_CONTENT)
    ? dom
    : Array.from(dom.querySelectorAll<HTMLElement>(OWN_CONTENT)).find((el) => el.matches(IMAGE_CONTENT));
  return content?.querySelector<HTMLImageElement>("img.bn-visual-media") ?? null;
}
