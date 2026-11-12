/**
 * 功能導覽的演示站點用的交易過濾：開著時，使用者對文件的改動一律擋下，只放行不改文件的交易、導覽自己的交易、
 * 與經 Y 同步進來的交易。
 *
 * - 為什麼要在交易層擋：輸入法組字擋不住。組字期間的 keydown（keyCode 229）就算被 `preventDefault`，組出的字照樣
 *   寫進文件；它是一筆帶 `composition` meta 的改文件交易，只有 `filterTransaction` 攔得到。
 * - 為什麼常駐、用旗標開關，而不是演示時才 `registerPlugin`：註冊或拆除外掛會讓 ProseMirror 重建所有外掛的 view，
 *   選單開著時 BlockNote 的選單外掛狀態被重設成關（畫面上的選單還在），之後 `closeMenu()` 會拋錯。所以外掛在建編輯器時就掛上，
 *   整個生命週期只掛這一次，預設放行一切；開關是記在編輯器實例上的旗標（`tour-filter-flag.ts`），每筆交易當下才讀。
 * - 開關直接改旗標，不經任何交易：撤登記時編輯器可能已經卸載，這時不該再對它 dispatch。
 * - 附加交易（別的外掛 `appendTransaction` 產生的，例如補 block id、修表格、舊格式遷移）跟著根交易的判定走：根交易是在
 *   `view.state` 上過濾的，附加交易是在套完根交易之後的中間 state 上過濾的，所以 state 不是 `view.state` 的一律放行。
 *   根交易被擋就不會產生附加交易；使用者的輸入（打字、按鍵指令、貼上、拖放、組字）都是根交易，漏不過去。不這樣做的話，
 *   導覽自己插入的 block 會沒有 id，遠端同步之後的正規化也做不了。
 */
import { Extension } from "@tiptap/core";
import { createPmPlugin } from "./pm-plugin";
import { Y_SYNC_META } from "./site-link-pm";
import { isTourTransactionFilterOn, TOUR_TRANSACTION_META } from "./tour-filter-flag";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Transaction 型別在 apps/web 值層級拿不到
type Any = any;

/**
 * 開著時放行的三種根交易：不改文件的（選取、焦點、選單的 meta）；導覽自己的；經 y-prosemirror 進來的（遠端編輯、經 Y 回來的撤銷與重做
 * 都帶 `y-sync$`），擋下它們 PM 會和 Y.Doc 對不上。
 */
function allowedWhileFiltering(tr: Any): boolean {
  return !tr.docChanged || tr.getMeta(TOUR_TRANSACTION_META) !== undefined || tr.getMeta(Y_SYNC_META) !== undefined;
}

export function createTourTransactionFilterExtension(): Extension {
  return Extension.create({
    name: "knotebookTourTransactionFilter",
    addProseMirrorPlugins() {
      const { editor } = this;
      return [
        createPmPlugin({
          filterTransaction: (tr, state) => !isTourTransactionFilterOn(editor) || state !== editor.view.state || allowedWhileFiltering(tr),
        }) as never,
      ];
    },
  });
}
