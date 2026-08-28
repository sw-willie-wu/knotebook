import { useLayoutEffect } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { UndoManager } from "yjs";

/**
 * 共編模式下的 undo/redo 生命線（issue #97）。
 *
 * ## 病灶
 *
 * 共編模式下 BlockNote 會 `disableExtensions: ["history"]`，把 undo/redo 換成 Yjs 的
 * `UndoManager`（由 y-prosemirror 的 `yUndoPlugin` 持有）。那個 plugin 的
 * **state** 建立一次就跟著 `EditorState` 一輩子，但它的 **view** 在 `destroy()` 時
 * 會呼叫 `undoManager.destroy()`（y-prosemirror 1.3.7 `plugins/undo-plugin.js`，
 * 逐行核實過）：
 *
 * ```js
 * view: view => { …; return { destroy: () => { undoManager.destroy() } } }
 * ```
 *
 * 而 `UndoManager.destroy()`（yjs 13.6.32）做的是**解除對 Y.Doc 的訂閱**：
 *
 * ```js
 * destroy () {
 *   this.trackedOrigins.delete(this)
 *   this.doc.off('afterTransaction', this.afterTransactionHandler)
 *   this.doc.off('destroy', this.destroy)
 *   super.destroy()
 * }
 * ```
 *
 * ProseMirror 的 view 是可以被拆掉再重掛的（tiptap 的 `unmount()` 註解逐字寫著
 * 「still allow remounting at a different point in time」，BlockNote 也把
 * `mount`/`unmount` 當公開 API）——**但重掛時沿用的是同一個 `EditorState`**，
 * 也就是同一個「已經被 destroy 過」的 `UndoManager`。新的 view 會照常在它身上註冊
 * `stack-item-added`／`stack-item-popped`，`undoManager.undo()` 也照常被呼叫、
 * 不丟例外——只是它再也收不到 `afterTransaction`，`undoStack` 永遠是空的。
 * **症狀就是 Ctrl+Z／Ctrl+Shift+Z／Ctrl+Y 完全沒反應、console 零錯誤。**
 *
 * ## 這個 app 有兩條路徑會把 view 拆掉重掛（兩條都實測過）
 *
 * 1. **`editable` 一變就重掛（正式版的兇手）**：`@blocknote/react` 0.52.1 把
 *    `editor.mount()/unmount()` 綁在一個 `useCallback` 的 ref callback 上，而
 *    `editable` 是它的依賴之一（`blocknote-react.js`：
 *    `n.isEditable = t.editorProps.editable !== !1, e ? n.mount(e, …) : n.unmount()`，
 *    deps `[t.editorProps.editable, n, r, i]`）。identity 一換 React 就
 *    detach 舊 ref（→ `unmount()`）再 attach 新的（→ `mount()`）。
 *    我們的 `NotePage` 是 `editable = roleCanEdit && synced`（issue #48 的離線可見性），
 *    `synced` 每次開筆記都必然 false→true 翻一次 ⇒ **每開一篇筆記，undo 就死一次**。
 * 2. **React `StrictMode` 的模擬重掛（開發模式）**：`main.tsx` 有 `<StrictMode>`，
 *    每次掛載都會 mount → unmount → mount。所以就算把 ①（`editable` 依賴）繞掉，
 *    `pnpm dev` 下的 undo 一樣是死的。
 *
 * 換句話說「別讓 view 被拆」不是可靠的修法（下一個 prop 依賴就會再破一次），
 * **要修的不變量是「編輯器活著的期間，UndoManager 必須一直訂閱著它的 Y.Doc」**。
 *
 * ## 這不是「從外面戳私有狀態」，是補平 library 自己的不對稱
 *
 * 同一份 y-prosemirror 裡，**sync** plugin 對重掛是有處理的：它的 `view()` 每次都
 * 呼叫 `binding.initView(view)`（`sync-plugin.js:190`），而 `initView`
 * （同檔 662-668）會 `if (this.prosemirrorView != null) this.destroy()` 之後
 * **重新掛上** `beforeAllTransactions`／`afterAllTransactions`／`observeDeep`。
 * **undo plugin 的 `view()` 沒有對應的重掛動作**——它只在 `destroy` 裡拆，從不補。
 * 我們補的就是那一半。
 *
 * 順帶解釋為什麼「不重建 manager」能保住 undo 後的選取還原：`binding` 是
 * **plugin 層級的單一實例**（`sync-plugin.js:111`，在 plugin factory 裡 new 一次，
 * 不是每個 view 一個），而 undo plugin 把選取快照存成 `stackItem.meta.set(binding, …)`
 * ——binding 身分跨重掛不變，所以重掛之前那些歷史格子的游標 meta 仍然查得到。
 *
 * ## 修法
 *
 * 每次 view 掛好之後補回 `destroy()` 拆掉的那三件事。三件都是**冪等**的
 * （`trackedOrigins` 是 `Set`；lib0 的 `Observable.on` 也是往 `Set` 裡加同一個
 * 函式參照），所以第一次掛載時呼叫等同 no-op，不必先偵測「有沒有被 destroy 過」。
 *
 * ⚠ **刻意不重建 UndoManager**：`destroy()` 不會清 `undoStack`/`redoStack`，
 * 重新訂閱等於**連歷史一起復活**；重建則會把重掛前的歷史丟掉，而且 plugin 的
 * `view()` 已經把 `stack-item-added`（游標位置還原）註冊在舊實例上，換掉會讓
 * undo 之後的選取還原失效、下一次 `destroy()` 也會拆錯對象。
 *
 * ⚠ **不會串味到別篇筆記**：`useCollab` 每篇筆記各開一份 `Y.Doc`/provider，
 * `useCreateBlockNote` 的 deps 是 `[doc, provider]` ⇒ 換筆記＝全新 editor＋全新
 * `UndoManager`，這裡完全沒有跨 editor 的共用狀態。
 *
 * ## 這條修正**沒有**涵蓋的殘留缺陷（issue #100）
 *
 * 「撤銷到空白文件」之後重做仍然無效，且是確定性的：撤到空白會讓 ProseMirror 重新
 * 正規化（補回空段落、重產 block id），y-prosemirror 的 sync plugin 隨即把這個差異
 * 以 `ySyncPluginKey`——也就是 `UndoManager` 追蹤的那個 origin——寫回 Y.Doc，
 * `afterTransactionHandler` 於是當成「使用者又編輯了」而 `clear(false, true)`
 * 清掉整個 redoStack（真瀏覽器探針實測，約在 undo 後 12ms）。
 * 那是 library 層的問題、與本檔無關（本檔修正之前 undo/redo 是整組死的），
 * 三條可能的修法都會動到共編 undo 語意或需要上游配合——完整分析在 issue #100。
 */

/** y-prosemirror `yUndoPlugin` 的 plugin state（只取我們用得到的那一格）。 */
interface YUndoPluginState {
  undoManager?: UndoManager;
}

/**
 * 取出目前這個 editor 的共編 `UndoManager`；非共編（`history` extension 那條路）
 * 回傳 `undefined`。
 *
 * 刻意走 `editor.getExtension("yUndo")` 再拿它自己的 `prosemirrorPlugins[0]`，
 * **不是** `import { yUndoPluginKey } from "y-prosemirror"`：後者比對的是 `PluginKey`
 * 物件身分，只要 pnpm 因為 peer 解析給了 apps/web 與 `@blocknote/core` 兩份不同的
 * y-prosemirror 實例，`getState()` 就會靜默回 `undefined`。從 extension 手上直接拿到
 * 「BlockNote 當初建出來的那一個 plugin 物件」沒有這個風險。
 */
export function collabUndoManager(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/wikilink/menu.ts）
  editor: BlockNoteEditor<any, any, any>,
): UndoManager | undefined {
  const plugin = editor.getExtension("yUndo")?.prosemirrorPlugins?.[0];
  return (plugin?.getState(editor.prosemirrorState) as YUndoPluginState | undefined)?.undoManager;
}

/**
 * 把 `UndoManager` 重新接回它的 Y.Doc——逐項對應 `UndoManager.destroy()` 拆掉的東西。
 * 冪等：沒被 destroy 過時呼叫是 no-op。
 */
export function armCollabUndoManager(manager: UndoManager): void {
  // `afterTransactionHandler` 判斷 origin 時查的就是這個 Set，而 `destroy()` 會把自己
  // 移除。**這一條顧的是 redo**（實測：拿掉它 undo 照常、redo 全滅）：undo 送出的
  // transaction origin 就是 manager 自己，沒被 tracked 的話 handler 直接早退，
  // redoStack 永遠長不出東西。
  manager.trackedOrigins.add(manager);
  // 真正讓 undoStack 長出東西的那條訂閱（少了它 undo/redo 全滅）。
  manager.doc.on("afterTransaction", manager.afterTransactionHandler);
  // 文件被丟棄時自動收攤（`destroy` 在 constructor 裡就 bind 過，參照穩定）。
  // ⚠ 這一條是**對稱性/衛生**，沒有測試守著也守不到——但要小心兩件事都別寫錯：
  // ① **它確實會被呼叫**：`Y.Doc.destroy()` 是先 `emit('destroy')` 才 `super.destroy()`
  //    （yjs 13.6.32 dist 705-707 行）。
  // ② **而且呼叫的當下真的有事可做**：換筆記時 `useCollab` 的 cleanup 是
  //    `provider.destroy(); doc.destroy(); setSession(null);`（`useCollab.ts` 該 effect
  //    的 deps 是 `[noteId, dispatch]`）——`doc.destroy()` 跑在 `setSession(null)` 之前，
  //    而編輯器要等 session 變 null 才卸載，所以這一刻舊 view 還掛著、manager 還是活的。
  // 淨效果仍然是零，理由是**緊接著的 `super.destroy()` 反正會把所有訂閱一次清光**
  //（`trackedOrigins` 也隨 plugin 一起被丟棄）。保留它是為了「補回來的東西逐項對得上
  // `destroy()` 拆掉的東西」這個好懂的不變量，也擋掉未來卸載順序改變時的訂閱殘留。
  manager.doc.on("destroy", manager.destroy);
}

/**
 * 掛上生命線：立刻補一次，之後每次 view 重掛再補一次。回傳解除訂閱函式。
 *
 * **「立刻補一次」不是保險，是必要的**：React `StrictMode` 的模擬重掛順序是
 * 「拆 effect → detach ref（`unmount()`）→ attach ref（`mount()`，`onMount`
 * 在這裡發出）→ 重跑 effect」——`onMount` 發出的當下我們已經被解除訂閱了，
 * 只靠 `onMount` 會漏掉這一發。反過來 `editable` 翻面那條路徑不會重跑 effect，
 * 只有 `onMount` 接得到。兩條路徑各自被其中一半覆蓋，缺一不可。
 * （`undo.test.tsx` 兩邊各有一條測試釘住：拿掉 `arm()` 只有 StrictMode 那條紅，
 * 拿掉 `onMount` 只有 `editable` 那族紅。）
 *
 * ⚠ 上面那個順序對 layout effect 與 passive effect **都成立**，所以
 * {@link useCollabUndoLifeline} 換成 `useEffect` 一樣會過——別把「必須是 layout
 * effect」讀進這段話裡。選 layout 的理由只是讓補訂閱與 ref attach 收斂在同一個
 * commit 內完成，不留一個「view 已掛好但 undo 還沒接回來」的可見畫格。
 */
export function keepCollabUndoAlive(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  editor: BlockNoteEditor<any, any, any>,
): () => void {
  const arm = (): void => {
    const manager = collabUndoManager(editor);
    if (manager) armCollabUndoManager(manager);
  };
  arm();
  return editor.onMount(arm);
}

/** {@link keepCollabUndoAlive} 的 React 包裝。掛在真正持有 `<BlockNoteView>` 的元件上。 */
export function useCollabUndoLifeline(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  editor: BlockNoteEditor<any, any, any>,
): void {
  useLayoutEffect(() => keepCollabUndoAlive(editor), [editor]);
}
