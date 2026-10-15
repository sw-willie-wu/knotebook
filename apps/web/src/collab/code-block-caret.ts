/**
 * 「游標在這個 code block 裡」的 DOM 訊號：在含游標的 codeBlock 的 block content 上掛 `data-caret-inside`，
 * 讓 `index.css` 把語言下拉叫出來。
 *
 * 為什麼要外掛、不用 CSS 的 `:focus-within`：游標在 code block 裡時，**持有焦點的是編輯器根**
 * （`.ProseMirror` 那個 contenteditable），不是 block——block 是焦點元素的**後代**，`:focus-within`
 * 只往祖先方向成立，所以永遠不匹配（Chrome 實測：游標點進程式碼後 `document.activeElement` 是
 * `.bn-editor`，block content `.matches(":focus-within")` 為 false）。觸控裝置沒有 hover，語言下拉
 * 要叫得出來只能靠這條（control 搬進方塊內之後的定案）。
 *
 * 只在**可編輯且編輯器有焦點**時掛：唯讀頁沒有可選的語言（下拉是 disabled 的純文字標籤），
 * 失焦後游標還留在原處，不該讓控制項一直浮在那塊程式碼上。焦點翻面時 tiptap 的 focusEvents
 * 外掛會 dispatch 一筆 tr，decorations 因此重算；`setEditable` 走 `view.setProps`，同樣重算。
 *
 * Decoration 是純 view 層的東西：不進 Yjs、不進 undo 堆疊、別的協作者看不到。
 */
import { Extension } from "@tiptap/core";
// ⚠ 這份 prosemirror-view 必須與 BlockNote／`@tiptap/pm` 用的是**同一份**：`package.json` 的範圍刻意照抄 BlockNote 宣告的
// （不釘死，釘死反而在 BlockNote 解到新版時保證分岔）。分岔時 view 端 `DecorationGroup.from` 的 instanceof 判斷不認這裡的
// DecorationSet，整個編輯器 mount 會丟 TypeError（審查時實測：`reading 'localsInner'`）——本檔的測試掛真編輯器，會先紅。
import { Decoration, DecorationSet } from "prosemirror-view";
import { createPmPlugin } from "./pm-plugin";

/** 掛在 block content（`.bn-block-content[data-content-type=codeBlock]`）上的屬性名。`index.css` 與測試共用。 */
export const CARET_INSIDE_ATTR = "data-caret-inside";

/** 只取用得到的那幾個欄位——PM 的 EditorState 型別在 apps/web 值層級拿不到（見 `pm-plugin.ts`）。 */
interface CaretState {
  doc: Parameters<typeof DecorationSet.create>[0];
  selection: { $head: { parent: { type: { name: string } }; depth: number; before(): number; after(): number } };
}

/**
 * 含游標（selection head）的 codeBlock 掛一個 node decoration；其餘一律空集合。
 * `$head.parent` 是 codeBlock ⇔ 游標落在程式碼文字裡（codeBlock 是 textblock）；選取整個 block
 * （NodeSelection）時 head 在 block 外，不算——那時沒有游標可言。
 */
export function caretCodeBlockDecorations(state: CaretState, active: boolean): DecorationSet {
  const { $head } = state.selection;
  if (!active || $head.depth === 0 || $head.parent.type.name !== "codeBlock") return DecorationSet.empty;
  return DecorationSet.create(state.doc, [Decoration.node($head.before(), $head.after(), { [CARET_INSIDE_ATTR]: "true" })]);
}

export function createCodeBlockCaretExtension(): Extension {
  return Extension.create({
    name: "knotebookCodeBlockCaret",
    addProseMirrorPlugins() {
      const { editor } = this;
      return [
        createPmPlugin({
          props: { decorations: (state) => caretCodeBlockDecorations(state, editor.isEditable && editor.isFocused) },
        }) as never,
      ];
    },
  });
}
