// 只需要這一支：`@blocknote/mantine/style.css` 自己 `@import` 了 mantine 主題與
// `@blocknote/react/style.css`（後者再帶進 core 的樣式）。刻意不引
// `@blocknote/core/fonts/inter.css`——那是 latin-only 的自帶字型（9 個 woff 檔），
// 對以中文為主的介面沒有幫助，只會讓 bundle 變大；字型交給 app 自己的 CSS 決定。
import "@blocknote/mantine/style.css";
import { lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { createCursorScroller, type CursorScroller } from "@/collab/cursor-scroll";
import { gateLocalCursor } from "@/collab/cursor-gate";
import { collabUserColor } from "@knotebook/shared";
import { BlockNoteEditor, filterSuggestionItems, SuggestionMenu } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  FilePanelController,
  SideMenuController,
  SuggestionMenuController,
  TableHandlesController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { NoteDto } from "@knotebook/shared";
import { useCreateNote, useNotes } from "@/api/notes";
import { classifyMediaTransfer, type BlockedTransferReason } from "@/collab/schema";
import { createCodeBlockCaretExtension } from "@/collab/code-block-caret";
import { createColumnEdgeKeymapExtension } from "@/collab/columns/edge-keymap";
import { clearDraggedBlocks } from "@/collab/columns/drag-source";
import { computeDropPosition, edgeDrop, emptyColumnDrop, withGutterFileDrop } from "@/collab/columns/edge-drop";
import { createColumnsPasteExtension, withColumnsDropPoint } from "@/collab/columns/paste-rule";
import { buildCollabEditorBase } from "@/collab/editor-options";
import { createMarkdownLinkExtension } from "@/collab/markdown-link";
import { createMarkdownPasteHandler } from "@/collab/paste";
import { createSiteLinkConvertExtension, createSiteLinkEnv, createSiteLinkPasteHook, withSiteLinkDrop, type SiteLinkEnvRef } from "@/collab/site-link-convert";
import { useCollabUndoLifeline } from "@/collab/undo";
import { buildSlashMenuItems } from "@/components/slash-menu";
import { LinkDialog } from "@/components/LinkDialog";
import { toast } from "@/components/ui/toast";
import { cardSurface } from "@/components/ui/card";
import { ARTICLE_COLUMN_PADDING, articleColumn } from "@/components/ui/article-column";
import { useNoteWidth } from "@/components/note-width";
import { cn } from "@/lib/utils";
import { useTheme } from "@/theme";
import { buildWikilinkMenuItems, type EditorRef } from "@/components/wikilink/menu";
import { safeMediaUrl } from "@/lib/media-url";
import { createUploadFile, type Translate } from "@/uploads/upload-file";
import { createFilePanel } from "@/components/FilePanel";
import { AiSessionProvider } from "@/components/ai/AiSession";
import { createNoteSizeGuard, createNoteSizePasteHandlers, formatNoteLimit } from "@/lib/note-size-guard";
import { CornerStack } from "@/components/CornerStack";
import { useVersions } from "@/lib/versions-context";
import { VERSIONS_ERROR_FRAME, VersionsLazyBoundary } from "@/components/versions/VersionsLazyBoundary";
import { useVersionsPanelWidth } from "@/components/versions/versions-panel-width";
import { SelectionAiController } from "@/components/ai/SelectionAiController";
import { KnotebookSideMenu, NotePathContext, SIDE_MENU_FLOATING_OPTIONS } from "@/components/editor/KnotebookSideMenu";
import { useDragActiveClass } from "@/components/editor/use-drag-active-class";
import { KnotebookTableCellButton, KnotebookTableHandle } from "@/components/editor/colors/KnotebookTableMenus";
import { HeadingAnchorButtons } from "@/components/editor/HeadingAnchorButtons";
import { ColumnDividers } from "@/components/editor/ColumnDividers";
import { LinkLongPress } from "@/components/LinkLongPress";

const VersionsPanel = lazy(() =>
  import("@/components/versions/VersionsLazy").then(m => ({ default: m.VersionsPanel })),
);

// #293：搬到 shared，頭像列與 #312 共用同一份；這裡原地 re-export，既有 import 不動。
export { collabUserColor };

/** {@link classifyMediaTransfer} 的攔截原因 → toast i18n key。 */
const BLOCKED_TRANSFER_TOAST_KEYS: Record<BlockedTransferReason, string> = {
  dataUrl: "note.transferDataUrl",
  textRepresentation: "note.transferSaveFirst",
  nonImageFile: "note.transferNonImage",
};

/**
 * 媒體 data URL／非圖片檔案阻擋的 tiptap `editorProps.handleDOMEvents`。
 *
 * ⚠ **必須是 `handleDOMEvents`，不能用 `handlePaste`/`handleDrop`**（瀏覽器實測踩過，
 * 用後者，貼上等於完全沒有防線，只帶檔案的拖放也一樣）：BlockNote 自己註冊了 `handleDOMEvents.paste` 的外掛，
 * 而且**進來就無條件 `event.preventDefault()` 並自行處理**（`pasteExtension.ts`）；
 * drop 則由 `fileDropExtension.ts` 依 `acceptedMIMETypes` 的順序取第一個命中的型別，只在那是 `Files`（沒有 text/html、
 * text/plain 等排在前面的型別）或沒有已知型別時接走，其餘交給 PM。ProseMirror 的 DOM 事件流程是
 * 「先 `someProp('handleDOMEvents')`，那一層沒人認領才輪到內建的 editHandlers」，
 * 而 `handlePaste`/`handleDrop` 是在**內建 editHandlers 裡面**才被查詢的——換句話說
 * 貼上時 `handlePaste` 一次都不會被呼叫；drop 只帶 `Files`（沒有 text/html、text/plain 等排在前面的型別）時
 * （非圖片檔案阻擋要攔的正是這種）`handleDrop` 也不會被呼叫。
 * 反過來 `handleDOMEvents` 這一層，`someProp` 是**先看直接傳入的 editorProps、
 * 再看外掛**，所以我們的 handler 跑得比 BlockNote 的外掛早。
 *
 * 回傳 `true` ＝已處理，事件不再往下走（BlockNote 的貼上邏輯完全不會執行）；
 * 回傳 `false` ＝正常落回 BlockNote，一般文字貼上不受影響。
 *
 * `view` 參數刻意型別為 `unknown`：這裡完全用不到它，而 `unknown` 參數的函式對
 * 「吃 `EditorView` 的位置」是可指派的，測試也能直接傳 `null` 呼叫。
 */
export function createMediaBlockingDOMEvents(translate: Translate): {
  paste: (view: unknown, event: ClipboardEvent) => boolean;
  drop: (view: unknown, event: DragEvent) => boolean;
} {
  const block = (event: ClipboardEvent | DragEvent, data: DataTransfer | null): boolean => {
    const reason = classifyMediaTransfer(data);
    if (!reason) return false;
    event.preventDefault();
    toast({ title: translate(BLOCKED_TRANSFER_TOAST_KEYS[reason]) });
    return true;
  };
  return {
    paste: (_view, event) => block(event, event.clipboardData),
    drop: (_view, event) => block(event, event.dataTransfer),
  };
}

export interface NoteEditorOptionsInput {
  doc: Y.Doc;
  provider: Pick<HocuspocusProvider, "awareness">;
  user: { id: string; name: string };
  /** i18next 目前的語言代碼（`i18n.language`）。 */
  language: string;
  translate: Translate;
  /** late-bound 編輯器參照：`buildNoteEditorOptions` 是純函式，在
   * `useCreateBlockNote` 真正建出 editor 之前就會被呼叫，下面 `handleTextInput` 的
   * `[[` 觸發偵測要在使用者真的打字的當下才讀取 editor，只能透過這個 ref 取得
   * ——見 `@/components/wikilink/menu` 的 `EditorRef` 說明。 */
  editorRef: EditorRef;
  /** 目前這篇筆記的 id：`createUploadFile` 組 `POST
   * /api/notes/:noteId/uploads` 的路徑要用。 */
  noteId: string;
  /** #269：站內連結轉換的 env（late-bound ref：快取與編輯器都在建立之後才有）。 */
  siteLinks: SiteLinkEnvRef;
  /** #293：本分頁此刻可否送游標（late-bound：editor 不隨 editable 重建）。省略＝一律可送。 */
  canSendCursor?: () => boolean;
  /**
   * 筆記大小上限的前端檢查（`lib/note-size-guard.ts`）：貼上、拖放在解析好、插入之前，帶著估計的成長（位元組）問一次，回傳 true＝會超過
   * 上限（已提示），這次不放。late-bound（上限設定在編輯器建立之後才載入）。省略＝不檢查。
   */
  sizeGuard?: (incomingBytes: number) => boolean;
  /** 單檔上傳上限（位元組）的 getter：上傳前驗在每次上傳當下才讀（late-bound：設定在編輯器建立之後才載入、可被調整）。省略或回傳 `undefined`＝不前驗。 */
  maxUploadBytes?: () => number | undefined;
}

/**
 * 組出交給 `useCreateBlockNote` 的完整選項。抽成獨立函式**是為了可測**：BlockNote
 * 本身依賴大量 jsdom 沒有的 DOM/Range API，掛起來只測得到環境；但這些選項才是
 * 媒體貼上規則（image block 掛 `uploadFile`，其餘媒體
 * data URL 仍攔截）、共編 fragment 名稱、字典選擇這幾條契約的所在，而且純粹是
 * 資料——測試可以直接呼叫並斷言，不必掛編輯器。
 */
export function buildNoteEditorOptions({
  doc,
  provider,
  user,
  language,
  translate,
  editorRef,
  noteId,
  siteLinks,
  canSendCursor,
  sizeGuard,
  maxUploadBytes,
}: NoteEditorOptionsInput) {
  const sizeHandlers = createNoteSizePasteHandlers(sizeGuard ?? (() => false));
  return withCollaboration({
    // schema／字典／collaboration（fragment 名、provider 形狀）抽在共用底層——公開
    // 唯讀頁（#72 `buildReadonlyNoteEditorOptions`）用同一份，兩邊不各寫一份。
    ...buildCollabEditorBase({
      doc,
      // #293：唯讀時不送游標（as-built；理由見 `@/collab/cursor-gate`）。
      awareness: provider.awareness ? gateLocalCursor(provider.awareness, canSendCursor ?? (() => true)) : undefined,
      language,
      user: { id: user.id, name: user.name, color: collabUserColor(user.id) },
    }),
    // 貼上/拖放純圖片檔案時（上面 `createMediaBlockingDOMEvents` 規則③放行）
    // BlockNote 自己的 paste/drop 外掛會呼叫 `handleFileInsertion`，進而呼叫這裡的
    // `uploadFile`——`createUploadFile` 保證絕不 reject（見該模組檔頭），失敗時自行
    // toast + 清除 placeholder block，`handleFileInsertion` 完全不必知道失敗發生過。
    uploadFile: createUploadFile({ noteId, editorRef, translate, maxUploadBytes }),
    // issue #12：渲染端的 URL 守衛。UI 的 Embed tab 早就擋過一次危險 scheme，但筆記內容是
    // Yjs 文件——**任何有 editor 權限的協作者都能直接寫 block props**，繞過整條 UI。BlockNote
    // 對 image/video/audio 的預覽、以及工具列的「開啟／下載」按鈕，都會先過 `resolveFileUrl`
    // （已對 @blocknote/core 與 @blocknote/react 0.52.1 的 dist 核實），這是唯一一個不必改寫
    // block spec 就能攔在所有 sink 之前的縫。
    //
    // 這個回呼**必須放行相對網址**：自家上傳拿到的是 `/api/uploads/<id>`，套輸入端那條
    // 「必須是完整 http(s)」的規則會把所有上傳的圖片一起擋掉（規則見 shared
    // `note-schema-config.ts`；web 的 base 預設見 `lib/media-url.ts`）。
    resolveFileUrl: (url: string) => Promise.resolve(safeMediaUrl(url)),
    // 貼上 markdown 的兩個 Windows 破口（CRLF 不被解析、從 VS Code 貼會變成程式碼
    // 區塊）——判斷與理由都在 `@/collab/paste`，這裡只負責接線。
    pasteHandler: createMarkdownPasteHandler(createSiteLinkPasteHook(siteLinks)),
    // ⋮⋮ 拖到 block 左右緣時畫直線；與下面 `handleDrop` 的 `edgeDrop` 用同一個判斷（`@/collab/columns/edge-drop`）。
    dropCursor: { hooks: { computeDropPosition } },
    _tiptapOptions: {
      // issue #99：手打 markdown 連結語法（`[文字](網址)`）自動轉成真連結；#269：站內連結 → wikilink（link AddMarkStep
      // 外掛）。裁決與判準理由分別在 `@/collab/markdown-link`、`@/collab/site-link-convert`——這裡只負責接線。
      // 第三支：游標在 code block 裡 ⇒ 那塊掛 `data-caret-inside`，語言下拉現身（觸控沒有 hover 的入口；理由見 `@/collab/code-block-caret`）。
      extensions: [
        createMarkdownLinkExtension({ editorRef, siteLinks }),
        createSiteLinkConvertExtension({ envRef: siteLinks }),
        createCodeBlockCaretExtension(),
        // 並排的欄首 Backspace／欄尾 Delete（理由見 `@/collab/columns/edge-keymap`）。
        createColumnEdgeKeymapExtension({ editorRef }),
        // 貼上／拖放的列：頂層完整、非頂層攤平（理由見 `@/collab/columns/paste-rule`）。
        createColumnsPasteExtension(),
      ],
      editorProps: {
        // drop：最外層先由 `withSiteLinkDrop` 判斷要不要轉站內連結（#352）；再由 `withGutterFileDrop` 把落在欄與欄之間的拖放
        // 改到最近欄的最近 block（⋮⋮ 拖曳在記落點之前改，檔案在媒體阻擋之後改）；再記落點（給上面那條貼上規則判斷位置），再走媒體阻擋。
        handleDOMEvents: withSiteLinkDrop(siteLinks, editorRef, withGutterFileDrop(editorRef, withColumnsDropPoint(createMediaBlockingDOMEvents(translate)))),
        // 筆記大小上限的前端檢查：貼上、拖放在解析好（slice）、插入之前估成長，超過上限就不放（`lib/note-size-guard.ts`）。直接傳入的
        // editorProps 比外掛先被問到；回傳 false 照常往下（BlockNote、並排的貼上規則）。
        handlePaste: sizeHandlers.handlePaste,
        // ⋮⋮ 拖曳放下：先問直線放置（建列、加欄），再問橫線放進空欄，都不接手才做大小上限的檢查（搬移不增加內容，接手時不必估）。
        // 不論誰接手，跑完都清掉 dragstart 記下的被拖 block，下一次拖放不會讀到這次的。
        handleDrop: (view, event, slice, moved) => {
          try {
            return edgeDrop(editorRef.current, view, event) || emptyColumnDrop(editorRef.current, view, event, slice) || sizeHandlers.handleDrop(view, event, slice, moved);
          } finally {
            clearDraggedBlocks(view);
          }
        },
        // `[[` 觸發偵測。這裡刻意**不**倚賴 `SuggestionMenu`
        // extension 自己對多字元 trigger 的內建偵測：它算的是
        // `textBetween(from - trigger.length, from) + text` 再與 trigger 嚴格相等，
        // 而 `textBetween` 在 block 開頭會回傳不足 2 個字元——於是那條路**只在
        // 「第一個 `[` 正好是 block 首字」時成立，其餘一律不相等**（已對
        // @blocknote/core 0.52.1 的 dist 核實）。語意不完整，不能委派給它。
        // 我們的 handler 掛在 `_tiptapOptions.editorProps` 這層，ProseMirror 對
        // `handleTextInput` 的查詢順序是「先看直接傳入的 editorProps、才輪到各外掛」，
        // 所以會比 extension 內建的偵測先跑一步。
        //
        // ⚠ **判斷的是「這次輸入落地後、游標前是不是 `[[`」，不是「這次輸入的字元是
        // 什麼」**（issue #98）。一般打字不走 `input.ts` 的 keypress 分支（那條外面包著
        // 「選取狀態異常」的守衛），而是瀏覽器先寫進 DOM、再由 `domchange.ts` 的
        // `readDOMChange` 回收——它的語意是**「把舊文件的 [from, to) 換成 text」**：
        // `text` 可以是任意長度（快速連打會併成 `"[["`，IME 組字結束整串送達如
        // `"測試[["`），`from` 也可以不等於 `to`。原本的逐字元比對（`text === "["`）
        // 對這兩件事都不成立，於是中文輸入法下必然失效。
        handleTextInput: (view, from, to, text) => {
          const sel = view.state.selection;
          // ⚠ 下面的刪除用**參數座標**算，但真正把 `[[` 放進文件的 `openSuggestionMenu`
          // 走的是無位置的 `insertText()`——那作用在**當下的 selection**。兩者必須指同
          // 一段，否則會刪在一處、插在另一處，把文件改壞。ProseMirror 實務上一定相等
          // （`readDOMChange` 的 `findDiff` 以 `state.selection.from` 當 `preferredPos`），
          // 這裡把這個隱含前提寫成明確守衛，而不是倚賴它碰巧成立。
          if (sel.from !== from || sel.to !== to) return false;

          const doc = view.state.doc;
          // 游標前的 1 個字元。`from >= 1` 是保險（上面的 selection 守衛已經蘊含它，
          // 因為文件內的合法 selection 位置最小是 1），但擋在 `resolve(from - 1)` 之前
          // 才不會有「位置 -1」的可能。same-parent 判斷同樣是把意圖寫死：跨 block 邊界
          // 時 `textBetween` 本來就回空字串（範圍內沒有文字葉節點），所以它其實攔不到
          // 任何實際情形——留著是為了讓「上一個 block 結尾的 `[` 不算數」這件事在原始碼
          // 層級看得見。
          let before = "";
          if (from >= 1) {
            const $prev = doc.resolve(from - 1),
              $cur = doc.resolve(from);
            if ($prev.parent === $cur.parent) before = doc.textBetween(from - 1, from);
          }
          if (!(before + text).endsWith("[[")) return false;

          // 拿不到 extension 就交還 ProseMirror：回傳 true 卻沒開選單，等於把使用者剛打
          // 的字整段吞掉（IME 整串送達時是一整段中文）。
          const menu = editorRef.current?.getExtension(SuggestionMenu);
          if (!menu) return false;

          // trigger 的兩個 `[` 有幾個來自這次的 `text`：`text` 自己就以 `[[` 結尾 → 兩個
          // 都是，文件裡不必刪；否則是「文件裡既有一個 ＋ `text` 的最後一個」→ 要把文件
          // 裡那個刪掉。
          const fromText = text.endsWith("[[") ? 2 : 1;
          // `text` 裡 `[[` 之前的內容——IME 整串送達時就是使用者剛打完的那段中文。
          const keep = text.slice(0, text.length - fromText);
          const start = from - (2 - fromText);
          const tr = view.state.tr;
          // ② 被選取的內容要取代掉（＝ ProseMirror 的預設行為）；`from === to` 時是 no-op。
          if (from < to) tr.delete(from, to);
          // ③ 刪掉文件中既存的那個 `[`（僅當這次的 trigger 借用了它）。
          if (start < from) tr.delete(start, from);
          // 回傳 true 等於吞掉本次輸入，ProseMirror 不會插入 `text`——`[[` 由下面的
          // `openSuggestionMenu` 補上，但 **`[[` 之前的內容必須由我們自己插回去**，
          // 否則使用者剛打的字會憑空消失。
          if (keep) tr.insertText(keep, start);
          if (tr.docChanged) view.dispatch(tr);
          // ④ `deleteTriggerCharacter: true`——由 plugin 當下把 `[[` 插入文件（作用在
          // selection，此時已被上面的 transaction 映射到 `start`），`clearQuery` 屆時
          // 刪除範圍才會涵蓋 `[[`+query；省略/false 必然殘留 `[[`。
          menu.openSuggestionMenu("[[", { deleteTriggerCharacter: true });
          return true; // ① 吞掉本次輸入
        },
      },
    },
  });
}

/**
 * `LinkDialog` 送出後真正落地的地方（issue #99）：把 selection 還原到開對話框
 * 當下存的那個位置，再呼叫 `editor.createLink`。抽成獨立、匯出的純函式方便直接對
 * 真編輯器斷言（`NoteEditor.test.ts` 的 `insertLinkAtSavedSelection` 描述塊）。
 *
 * ⚠ **還原 selection 這一步不是防禦性寫法**：
 * `editor.createLink(href, text)` 打在**當下** selection，不是開啟對話框那一刻的
 * selection——省略還原，真編輯器實測會插到錯的位置（見該描述塊的斷言）。
 */
export function insertLinkAtSavedSelection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 wikilink/menu.ts、ai/apply.ts）
  editor: any,
  savedSelection: { from: number; to: number } | null,
  { text, href }: { text: string; href: string },
): void {
  if (savedSelection) editor._tiptapEditor.commands.setTextSelection(savedSelection);
  editor.createLink(href, text);
}

/**
 * `/` 選單「連結」項的對話框狀態與 `getSlashItems` 組法（issue #99）。抽成獨立、
 * 匯出的 hook 是為了可測——「測試要釘的是 dialog 開關前後
 * `getSlashItems` 身分不變」，抽出來後可以直接 `renderHook` 驗證這個
 * hooks-composition 事實（見 `NoteEditor.test.ts` 的 `useLinkMenuState` 描述塊）。
 *
 * ⚠ `getSlashItems` 若把 `linkDialogOpen` 放進 deps（或用 inline arrow 取代
 * `openLinkDialog`），每次 render 都會換身分 ⇒ `SuggestionMenuController` 的
 * `useLoadSuggestionMenuItems` effect（deps 是 `[query, getItems]`）重跑 ⇒ 選單
 * loading 閃動重繪——這個 repo 已經為同一個 bug 踩過一次並留了註解（`getItems`
 * 那支，見下面 `NoteEditor` 本體）。
 */
export function useLinkMenuState(editorRef: EditorRef, translate: Translate) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  // 開對話框當下存下的 selection（驗出來的做法）：對話框搶走瀏覽器
  // focus 後 ProseMirror selection 本身不會變，但送出時仍明確還原一次，不倚賴
  // 「反正沒變」這個隱含事實。放 ref 不進 state——它不影響任何畫面輸出。
  const linkSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const openLinkDialog = useCallback(() => {
    const currentEditor = editorRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
    const sel = (currentEditor as any)?._tiptapEditor?.state?.selection;
    linkSelectionRef.current = sel ? { from: sel.from, to: sel.to } : null;
    setLinkDialogOpen(true);
  }, [editorRef]);

  // 對話框送出：呼叫抽出來的純函式（見上面 `insertLinkAtSavedSelection`）——
  // ⚠ `text.trim() || hit.href` 的 fallback 已經在 `LinkDialog` 內做過，
  // 這裡收到的 `text` 恆非空，不必再擋一次。
  const handleLinkInsert = useCallback(
    ({ text, href }: { text: string; href: string }) => {
      const currentEditor = editorRef.current;
      if (!currentEditor) return;
      insertLinkAtSavedSelection(currentEditor, linkSelectionRef.current, { text, href });
    },
    [editorRef],
  );

  const getSlashItems = useCallback(
    (query: string) =>
      Promise.resolve(filterSuggestionItems(buildSlashMenuItems(editorRef.current, translate, openLinkDialog), query)),
    [editorRef, translate, openLinkDialog],
  );

  return { linkDialogOpen, setLinkDialogOpen, openLinkDialog, handleLinkInsert, getSlashItems };
}

export interface NoteEditorProps {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** 目前角色能不能編輯（`canEdit(role)`）。false → BlockNoteView 會把 `editor.isEditable` 設成 false。 */
  editable: boolean;
  user: { id: string; name: string };
  /** 目前這篇筆記的 id：轉交給 `buildNoteEditorOptions` 組上傳路徑。 */
  noteId: string;
  /** 卡片版面：內文卡頁頭——`NotePage` 組裝
   * TitleInput／ConnectionBadge／分享鈕／⋮ 選單後傳入。純 `ReactNode`，`NotePage`
   * 每次 render 傳新節點只影響這棵子樹，不會觸發 `useCreateBlockNote` 重建
   * （建立點與 deps 見下方，零改動）。 */
  headerSlot?: ReactNode;
  /** 內文卡頁尾——`NotePage` 組裝 backlinks chips 後傳入。同上，普通 slot props。 */
  footerSlot?: ReactNode;
  /** 版本預覽：有值時**捲動容器加 `hidden`**、同一張卡內在捲動容器之後渲染這個 slot；
   * 頁首（含預覽橫幅）、頁尾照常。⚠ 活編輯器**不 unmount**：`NoteEditorView` 的重掛會殺掉 y-prosemirror 的
   * UndoManager 訂閱；放在 `hidden` 容器裡的活編輯器仍收得到遠端更新。 */
  previewSlot?: ReactNode;
  /** #269：捲動容器（段落錨點的 root）。 */
  onScrollRoot?: (el: HTMLElement | null) => void;
  /** #293：editor 建好後交出「捲到某人游標」的函式，卸載時交出 null。呼叫端須給穩定的 identity
   *  （NotePage 用 useCallback 寫進 ref）；本元件只在 editor 換手時重交。 */
  onCursorScroller?: (scroller: CursorScroller | null) => void;
  /** #269：canonical 路徑（`canonicalNotePath(note)`），複製段落連結用。 */
  notePath?: string;
  /** 筆記大小上限（server `NOTE_MAX_BYTES`，`GET /api/auth/config`）：貼上、拖放、站內 AI 套用之前的檢查。還沒載入＝不檢查。 */
  noteMaxBytes?: number;
  /** 單檔上傳上限（`GET /api/auth/config` 的 `maxUploadBytes`）：貼上、拖放圖片的上傳前驗。還沒載入＝不前驗。 */
  maxUploadBytes?: number;
}

/**
 * 編輯器建立時就固定下來的閉包要讀「當下」的 `t`（語言切換不重建編輯器），所以包一層 late-bound。
 * **必須轉傳 `opts`**：上傳 409 的說明句帶 `{{used}}`／`{{quota}}` 插值；丟掉它，真 app 會印出原樣佔位，
 * 而單元測試直接傳樁、看不到。
 */
export function lateBoundTranslate(ref: { current: Translate }): Translate {
  return (key, opts) => ref.current(key, opts);
}

/**
 * BlockNote 編輯器本體。刻意跟 `NotePage` 分開成獨立元件：
 * ① 它只在 provider/doc 都備妥之後才掛載，內部不必處理 null；
 * ② 頁面層的測試可以把整個模組 mock 掉——BlockNote 依賴大量 jsdom 沒有的
 *    DOM/Range API，硬掛進單元測試只會測到環境而不是行為。
 *
 * 共編綁定、媒體 transfer 守衛（data URL 與非圖片檔攔截、純圖片檔放行上傳）、字典選擇全部在 `buildNoteEditorOptions` 裡，
 * 那支是純函式且有專屬測試（`NoteEditor.test.ts`）——這個元件只負責把它接上 React。
 */
export function NoteEditor({
  doc,
  provider,
  editable,
  user,
  noteId,
  headerSlot,
  footerSlot,
  previewSlot,
  onScrollRoot,
  onCursorScroller,
  notePath,
  noteMaxBytes,
  maxUploadBytes,
}: NoteEditorProps) {
  const { t, i18n } = useTranslation();
  const [columnEl, setColumnEl] = useState<HTMLElement | null>(null);
  // 任何拖放進行中，欄上掛 class，⋮⋮ 等編輯器外的浮層不吃指標，drop 才落得到底下的編輯器（規則在 `index.css`）。
  useDragActiveClass(columnEl);
  const { resolvedTheme } = useTheme();
  const { panelOpen } = useVersions();
  // #274：版本面板寬度。state 放在面板與錯誤外框的最近共同祖先（下方列容器），以 CSS 變數往下傳。
  const panelWidth = useVersionsPanelWidth();
  // #297：這篇的站內內文寬度（訂閱模組層 Map；換寬度只換欄 class，不重建 editor）。
  const [width] = useNoteWidth(noteId);
  const hasPreview = previewSlot !== undefined && previewSlot !== null;

  // #293：scroller 在點擊當下才讀捲動容器與「是否在版本預覽中」（預覽中容器 hidden → 不捲）。
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const setScrollRoot = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRootRef.current = el;
      onScrollRoot?.(el);
    },
    [onScrollRoot],
  );
  const hasPreviewRef = useRef(hasPreview);
  hasPreviewRef.current = hasPreview;
  const onCursorScrollerRef = useRef(onCursorScroller);
  onCursorScrollerRef.current = onCursorScroller;
  // #293：render 當下寫入——editable 翻面時 BlockNoteView 在 commit 重掛 PM view，那時 gate 已讀到新值。
  const editableRef = useRef(editable);
  editableRef.current = editable;

  // handler 是在 editor 建立時就固定下來的閉包；用 ref 取用最新的 t，語言切換時
  // 不必為了文案而重建整個 editor（重建會扯斷 y-prosemirror 綁定）。
  const translateRef = useRef<Translate>(t);
  translateRef.current = t;

  // 筆記大小上限的前端檢查（軟性，`lib/note-size-guard.ts`）：貼上、拖放、站內 AI 套用之前，現在的大小＋估計的成長超過上限 → 不放、提示。
  // 上限與文件都經 ref 讀當下的值（編輯器建立時就固定的閉包）。
  const noteMaxBytesRef = useRef(noteMaxBytes);
  noteMaxBytesRef.current = noteMaxBytes;
  // 上傳前驗的上限同理：`uploadFile` 在編輯器建立時就固定，直接傳值會停在第一次 render 的值。
  const maxUploadBytesRef = useRef(maxUploadBytes);
  maxUploadBytesRef.current = maxUploadBytes;
  const docRef = useRef(doc);
  docRef.current = doc;
  const [sizeGuard] = useState(() =>
    createNoteSizeGuard(
      () => docRef.current,
      () => noteMaxBytesRef.current,
      limit => toast({ title: translateRef.current("note.sizeLimitBlocked", { size: formatNoteLimit(limit) }) }),
    ),
  );

  // `[[` 觸發（`handleTextInput`）與「建立並連結」的 item handler 都要在
  // 使用者真的互動的當下讀取 editor，而 `buildNoteEditorOptions` 在 editor 存在之前
  // 就會被呼叫——用這個 late-bound ref 打通（見 `buildNoteEditorOptions` 內註解、
  // `@/components/wikilink/menu` 的 `EditorRef`）。
  const editorRef = useRef<EditorRef["current"]>(null);

  // #269：站內連結轉換的 env——每次 render 換新（讀最新的快取），外掛與後備都在使用者動作當下才讀 ref。
  const queryClient = useQueryClient();
  const siteLinksRef = useRef<SiteLinkEnvRef["current"]>(null);
  siteLinksRef.current = createSiteLinkEnv({
    origin: window.location.origin,
    getNotes: () => queryClient.getQueryData<NoteDto[]>(["notes"]),
    editorRef,
  });

  const editor = useCreateBlockNote(
    buildNoteEditorOptions({
      doc,
      provider,
      user,
      language: i18n.language,
      translate: lateBoundTranslate(translateRef),
      editorRef,
      noteId,
      siteLinks: siteLinksRef,
      canSendCursor: () => editableRef.current,
      sizeGuard,
      maxUploadBytes: () => maxUploadBytesRef.current,
    }),
    // 語言不進 deps：字典只在建立時讀一次，換語言要重開頁面才生效（換成
    // 「重建 editor」的代價是共編綁定重掛，不值得）。noteId 同理不進 deps——`useCollab`
    // 的連線 effect 本身就是照 `noteId` 建新的 `Y.Doc`/`HocuspocusProvider`（見
    // `collab/useCollab.ts`），noteId 一換，`doc`/`provider` 必然跟著換、這裡就會
    // 重新跑，不會有「同一個 editor 實例、noteId 換手」這種情境。
    [doc, provider],
  );
  editorRef.current = editor;

  useEffect(() => {
    const report = onCursorScrollerRef.current; // cleanup 不讀 ref
    report?.(createCursorScroller({ editor, getRoot: () => (hasPreviewRef.current ? null : scrollRootRef.current) }));
    return () => report?.(null);
  }, [editor]);

  // issue #99：`/` 選單「連結」項的對話框狀態與 `getSlashItems` 組法——抽成
  // `useLinkMenuState`（見該函式檔頭）方便直接對它
  // `renderHook`，不必掛真編輯器整棵渲染。
  const { linkDialogOpen, setLinkDialogOpen, handleLinkInsert, getSlashItems } = useLinkMenuState(editorRef, t);

  const notes = useNotes().data;
  const { mutateAsync: createNote } = useCreateNote();

  // `getItems` 是 `SuggestionMenuController` 內部 `useLoadSuggestionMenuItems` 的
  // effect 依賴——inline arrow 每次 render 都是新 identity，會讓那個 effect（連帶
  // `getItems(query)` 的呼叫）在選單開著、`NoteEditor` 因任何理由重render（例如
  // 這裡新加的 `useNotes()` 本身就是新的 render 來源）時重跑，選單出現 loading
  // 閃動重繪。用 `useCallback` 釘住 identity，只在真的影響輸出的依賴變動時才換。
  const getItems = useCallback(
    (query: string) =>
      Promise.resolve(
        buildWikilinkMenuItems({
          query,
          notes: notes ?? [],
          createNote: (title) => createNote({ title }),
          editorRef,
          translate: (key) => t(key, { query }),
          toast,
        }),
      ),
    [notes, createNote, t],
  );

  // issue #94／#99：`/` 選單接管（內建項全數保留 ＋ mermaid 圖表 ＋ 連結）的
  // `getSlashItems` 本體在 `useLinkMenuState`（上面）——這裡不重複組。

  // AI 狀態與框選 AI 框（#263）全部收在這裡，editor
  // 建立點（上面 `useCreateBlockNote` 及其 deps）完全不動——`AiSessionProvider` 只是
  // 包住既有的版面，不會讓 `NotePage` 任何 re-render 有機會扯到 editor 重建。
  //
  // 卡片版面：內文卡在這裡。DOM 樹（
  // 寬度鏈的起點）：
  //   根 row（flex h-full min-h-0 min-w-0 flex-1 gap-3）
  //     內文卡（cardSurface，flex-col）
  //       {headerSlot}                              ← NotePage 組裝
  //       捲動容器（min-w-0 flex-1 overflow-y-auto min-h-0 overflow-x-clip——
  //         `overflow-x-clip`＝#162，見下方 JSX 註解）
  //         置中 wrapper（articleColumn(width) ＋ ARTICLE_COLUMN_PADDING ＋ `relative` flex
  //           min-h-full flex-col py-6，`relative`＝#160，見下方 JSX 註解）
  //           ← 欄寬／內距一律取自 `ui/article-column.ts`：#297 起三段寬度（標準／寬／
  //             全寬），單一真相在該檔；headerSlot／footerSlot 是滿卡寬（置左置右），
  //             不套欄。欄寬下限承重的理由與 `<md` 內距 70→20 的斷點機制全寫在該檔；
  //             改欄寬請改該檔，別在這裡另寫一份。
  //           NoteEditorView                         ← className 加 flex-1（
  //             wrapper 的 min-h-full 無法把百分比高度傳給孫層，唯一有效解是讓
  //             BlockNoteView 自己成為 flex-col wrapper 的成長項；除 className 外零改動）
  //       {previewSlot}                               ← 版本預覽時才渲染；此時上面的捲動容器加 hidden（活編輯器不 unmount）
  //       {footerSlot}                                ← NotePage 組裝（backlinks chips）
  //     VersionsPanel                                 ← `panelOpen` 時才渲染（lazy，經 VersionsLazyBoundary）
  //     CornerStack                                   ← 右下歷史泡泡（fixed，不佔 row 的 flex 空間）
  // `data-testid="note-editor"` 留在 `NoteEditorView`／`BlockNoteView` 上，不隨這次
  // 改版搬家——e2e 的 `[data-testid="note-editor"] [contenteditable]` 與
  // `NoteEditor.layout.test.tsx` 的節點鏈都吊在這裡。
  return (
    <AiSessionProvider editor={editor} noteId={noteId} editable={editable} sizeGuard={sizeGuard}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 gap-3" style={panelWidth.style}>
        <div className={cn(cardSurface, "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden")}>
          {headerSlot}
          <div ref={setScrollRoot} className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip", hasPreview && "hidden")}>
            {/* issue #160：`relative` 承重——BlockNote 表格 hover 浮層走 FloatingPortal 到
                `editor.portalElement`，沒有 positioned 祖先時 containing block 落到
                `<html>`，撐出全頁滾軸；wrapper／捲動容器／`.bn-container` 三處等效，選
                wrapper。唯一會**往右／往下**溢出、因而長滾軸的是沒帶 flip()/shift() 的
                兩顆 extend 按鈕（`TableHandlesController.tsx:248-303`）；側邊 `+`/`⠿`
                把手（`SideMenuController.tsx:68-76`）同樣沒帶 middleware，但往左溢出、
                被卡片邊裁掉 → `docs/known-limitations.md` 的 #115 那條。公開唯讀頁靠
                `TableHandles.ts:230-238`／`ExtendButton.tsx:223-225` 的 `!isEditable`
                守衛整組關掉。
                issue #162：右緣溢出的「新增列」按鈕曾讓這層長橫向捲軸（`14-table-hover.spec.ts`
                水平孿生案量到 `scrollWidth` 506→2480，這兩個數字修好後不變——
                `scrollWidth` 不受 `overflow-x` 影響，見下方斷言 (A)）。補
                `overflow-x-clip` 裁掉：規範（css-overflow-3 §3.1，
                https://www.w3.org/TR/css-overflow-3/#overflow-properties）另一軸非
                visible/clip 時 `clip` 計算成 `hidden`；`overflow-x:auto` 本來就在同一個
                padding box 裁切，沒有新增任何裁切邊界，不會讓浮層更被裁。真瀏覽器實測：
                `hidden` 下滑鼠滾輪橫向 `scrollLeft` 恆為 0（`auto` 是 300）；
                `scrollIntoView` 在我們自己的碼零呼叫，已查到的程式化捲動
                （prosemirror-view caret-follow）先被 `.tableWrapper` 吃掉。細節見
                `14-table-hover.spec.ts`。 */}
            <div
              ref={setColumnEl}
              data-testid="article-column"
              className={cn(articleColumn(width), ARTICLE_COLUMN_PADDING, "relative flex min-h-full flex-col py-6")}
            >
              <NoteEditorView
                editor={editor}
                editable={editable}
                theme={resolvedTheme}
                noteId={noteId}
                getItems={getItems}
                getSlashItems={getSlashItems}
                notePath={notePath}
              >
                {/* #263：formatting toolbar controller 與框選 AI 框的唯一擁有者；NoteEditorView 不碰 AI context。 */}
                <SelectionAiController />
              </NoteEditorView>
              <HeadingAnchorButtons container={columnEl} />
              {/* 欄間分隔線（拖曳／鍵盤調欄寬）只在可編輯時掛；唯讀時沒有東西可調。 */}
              {editable && <ColumnDividers container={columnEl} editor={editor} />}
            </div>
          </div>
          {hasPreview && (
            <div data-testid="preview-slot" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              {previewSlot}
            </div>
          )}
          {footerSlot}
        </div>
        {panelOpen && (
          <VersionsLazyBoundary noteId={noteId} errorClassName={VERSIONS_ERROR_FRAME.panel}>
            <VersionsPanel doc={doc} width={panelWidth.width} onWidthChange={panelWidth.onChange} />
          </VersionsLazyBoundary>
        )}
        <CornerStack />
      </div>
      {/* issue #99：`/` 選單「連結」項的對話框。開合 state 在這一層（`openLinkDialog`
          給 `getSlashItems` 用），`LinkDialog` 自己不持有——關閉與焦點回歸的完整
          說明見該檔檔頭。 */}
      <LinkDialog editor={editor} open={linkDialogOpen} onOpenChange={setLinkDialogOpen} onSubmit={handleLinkInsert} />
    </AiSessionProvider>
  );
}

export interface NoteEditorViewProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 EditorRef/wikilink/menu.ts）
  editor: BlockNoteEditor<any, any, any>;
  /** 目前角色能不能編輯（`canEdit(role)`）。false → BlockNoteView 會把 `editor.isEditable` 設成 false。 */
  editable: boolean;
  theme: "light" | "dark";
  /** 目前這篇筆記的 id：轉交給 `createFilePanel` 組 FilePanel 的 noteId 閉包。 */
  noteId: string;
  /** `SuggestionMenuController` 的候選來源——呼叫端（`NoteEditor`）組好
   * notes cache／createNote／translate 的閉包後轉交進來，這裡不重新組。 */
  getItems: (query: string) => Promise<DefaultReactSuggestionItem[]>;
  /** `/` 選單的候選來源（issue #94：內建項 ＋ mermaid）。同 `getItems`——閉包由
   * `NoteEditor` 組好轉交進來，這裡不重新組。 */
  getSlashItems: (query: string) => Promise<DefaultReactSuggestionItem[]>;
  /** #263：轉進 `<BlockNoteView>` 內（`NoteEditor` 傳 `SelectionAiController`）。BlockNoteView 的 children 加在預設 UI 之外。 */
  children?: ReactNode;
  notePath?: string;
}

/**
 * `<BlockNoteView>` 本體 + 掛在它上面的兩個 controller（`SuggestionMenuController`／
 * `FilePanelController`）。抽成獨立、**exported** 元件是為了可測——比照
 * `buildNoteEditorOptions`「抽出來是為了可測」的既有慣例：`NoteEditor` 本體還要處理
 * `useCreateBlockNote` 的建構、`editorRef`/`translateRef` 的 late-bound 閉包，這些
 * 依賴大量 jsdom 沒有的 DOM/Range API；但「`filePanel={false}` 有沒有真的關掉內建
 * 面板」「`useMemo` 有沒有真的釘住 `filePanel` 的元件身分」這兩條核心契約，
 * 只需要一個掛好的 `<BlockNoteView>` + 真編輯器就測得到（見
 * `NoteEditorView.test.tsx`；jsdom 缺的 `ResizeObserver`/`window.matchMedia` 兩個
 * mantine 內部會摸到的全域已經補進 `test/setup.ts`）。
 * #263 起 formatting toolbar 不在這裡掛：它與框選 AI 框由 children（`SelectionAiController`）擁有。
 */
export function NoteEditorView({ editor, editable, theme, noteId, getItems, getSlashItems, children, notePath }: NoteEditorViewProps) {
  // `createFilePanel(noteId)` 回傳一個新的元件型別——`FilePanelController`
  // 拿它跟前一輪比對身分，身分一變就會整個卸載重掛（見 `createFilePanel` 檔頭的完整
  // 說明），所以這裡必須 `useMemo` 釘住，只在 `noteId` 真的換手時才重建。`noteId`
  // 在 `NoteEditor` 的生命週期內事實上不會變（同 `useCreateBlockNote` 上面的 deps
  // 註解：noteId 一換，`doc`/`provider` 必然跟著換，等於整個 `NoteEditor` 重新掛載），
  // 但依賴陣列仍誠實列出，不靠這個隱含假設省略。
  const filePanel = useMemo(() => createFilePanel(noteId), [noteId]);

  // issue #97：共編的 undo/redo 生命線。`<BlockNoteView>` 會在 `editable` 翻面時把
  // ProseMirror view 拆掉重掛，而 y-prosemirror 的 undo plugin 在 view 銷毀時會
  // `undoManager.destroy()`、plugin state 卻沿用同一個（已解除訂閱的）manager——
  // 不補這一條，`editable = roleCanEdit && synced` 一從 false 翻成 true，Ctrl+Z
  // 就永久失效。掛在這裡（不是 `NoteEditor`）是因為**持有 `<BlockNoteView>` 的是
  // 這個元件**，重掛時序也發生在這棵子樹裡。完整病灶與兩條觸發路徑見 `@/collab/undo`。
  useCollabUndoLifeline(editor);

  return (
    <NotePathContext.Provider value={notePath ?? null}>
      <BlockNoteView
        editor={editor}
        editable={editable}
        theme={theme}
        data-testid="note-editor"
        className="min-h-full flex-1"
        // 關掉 BlockNote 內建的 FilePanelController：下面接管的是我們自家的
        // `filePanel`（自家 Upload tab 呼叫 `postUpload`，不用 `editor.uploadFile`，
        // 理由見 `components/FilePanel.tsx` 檔頭）。不明確設 `false` 這裡會同時掛兩個
        // file panel controller，使用者點開檔案 block 會看到兩份面板疊在一起。
        filePanel={false}
        // 同理關掉內建的 FormattingToolbarController：接管的是 children 裡的 `SelectionAiController`（#263：它獨自擁有
        // formatting toolbar controller 與框選 AI 框，含「框開著時壓住工具列」）。**這個 false 不可拿掉**：拿掉會多出一份預設工具列，
        // 壓制只壓得到 controller 那一份。
        formattingToolbar={false}
        // 同理關掉內建的 slash menu controller（issue #94）：下面接管的是我們自己的
        // `getSlashItems`（內建項全數保留＋mermaid 圖表＋連結，見 `components/slash-menu.tsx`）。
        // 不明確設 `false` 會同時掛兩個 `/` 選單 controller，按 `/` 會看到兩份選單疊在一起。
        slashMenu={false}
        // #269：關掉內建側邊選單，自掛一份（拖曳把手選單多一項「複製段落連結」）。不明確設 false 會疊兩份。
        sideMenu={false}
        // 關掉內建的表格把手，自掛一份：儲存格與列／欄把手的顏色選單多了「自訂…」。不明確設 false 會疊兩份把手。
        tableHandles={false}
      >
        <SuggestionMenuController triggerCharacter="[[" getItems={getItems} />
        <SuggestionMenuController triggerCharacter="/" getItems={getSlashItems} />
        <SideMenuController sideMenu={KnotebookSideMenu} floatingUIOptions={SIDE_MENU_FLOATING_OPTIONS} />
        <TableHandlesController tableHandle={KnotebookTableHandle} tableCellHandle={KnotebookTableCellButton} />
        <FilePanelController filePanel={filePanel} />
        {/* 觸控長按一般連結 ⇒ BlockNote 原生連結工具列（wikilink 的長按在它自己的元件裡）。 */}
        <LinkLongPress />
        {children}
      </BlockNoteView>
    </NotePathContext.Provider>
  );
}
