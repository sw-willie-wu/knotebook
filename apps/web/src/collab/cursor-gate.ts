import type { Awareness } from "y-protocols/awareness";

/** y-prosemirror cursor plugin 寫本機游標的 awareness 欄（`yCursorPlugin` 的預設 `cursorStateField`）。 */
const CURSOR_FIELD = "cursor";

/**
 * #293：交給 BlockNote collaboration 的 awareness 外包一層——`canSend()` 為 false（唯讀）時，
 * 丟掉非 null 的 `cursor` 寫入，本分頁不送游標（gate 只攔 `setLocalStateField("cursor", …)`；`setLocalState({ cursor })` 會繞過，目前沒有呼叫端這樣寫）。
 *
 * 為什麼攔在這裡：BlockNote 0.52.1 無條件給 `.ProseMirror` `tabIndex="0"`，唯讀時照樣可聚焦；
 * y-prosemirror 的 cursor plugin 在 `focusin` 與每次 view update 只看 `view.hasFocus()` 就寫 `cursor`
 * （`cursor-plugin.js:207`、`:255`），沒有開關。讓編輯區不能聚焦會連帶讓唯讀者無法選取複製。
 *
 * - null 一律放行（失焦、plugin destroy 時的清除）。可編輯翻成唯讀時，BlockNoteView 會重掛 PM view，
 *   舊 plugin 的 destroy 就把已送出的 cursor 清成 null（`NoteEditor.cursor.test.tsx` RC4 守這條）。
 * - 其餘欄位與所有讀取、訂閱都直通原物件（`this` 綁回原物件），別人的游標照樣畫。
 */
export function gateLocalCursor(awareness: Awareness, canSend: () => boolean): Awareness {
  const setLocalStateField = (field: string, value: unknown): void => {
    if (field === CURSOR_FIELD && value != null && !canSend()) return;
    awareness.setLocalStateField(field, value);
  };
  return new Proxy(awareness, {
    get(target, prop) {
      if (prop === "setLocalStateField") return setLocalStateField;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
