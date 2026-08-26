// 只需要這一支：`@blocknote/mantine/style.css` 自己 `@import` 了 mantine 主題與
// `@blocknote/react/style.css`（後者再帶進 core 的樣式）。刻意不引
// `@blocknote/core/fonts/inter.css`——那是 latin-only 的自帶字型（9 個 woff 檔），
// 對以中文為主的介面沒有幫助，只會讓 bundle 變大；字型交給 app 自己的 CSS 決定。
import "@blocknote/mantine/style.css";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import {
  FilePanelController,
  FormattingToolbarController,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { useCreateNote, useNotes } from "@/api/notes";
import { classifyMediaTransfer, type BlockedTransferReason, noteSchema } from "@/collab/schema";
import { createMarkdownPasteHandler } from "@/collab/paste";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import { toast } from "@/components/ui/toast";
import { cardSurface } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTheme } from "@/theme";
import { buildWikilinkMenuItems, type EditorRef } from "@/components/wikilink/menu";
import { safeMediaUrl } from "@/lib/media-url";
import { createUploadFile } from "@/uploads/upload-file";
import { createFilePanel } from "@/components/FilePanel";
import { AiSessionProvider } from "@/components/ai/AiSession";
import { AiPanel } from "@/components/ai/AiPanel";
import { AiToolbar } from "@/components/ai/AiToolbar";

/**
 * 共編游標的顏色。同一個使用者在任何裝置、任何筆記都要是同一色，所以不能用亂數——
 * 從 userId 做一個穩定的 32-bit 雜湊再映到色相環。飽和度/亮度寫死，確保深淺兩個
 * 主題下都看得見（y-prosemirror 會把這個顏色同時當游標線與名牌背景）。
 */
export function collabUserColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 65% 45%)`;
}

/** i18n 查表函式的最小介面（`useTranslation()` 的 `t` 相容）。 */
type Translate = (key: string) => string;

/** {@link classifyMediaTransfer} 的攔截原因 → toast i18n key（§12.4）。 */
const BLOCKED_TRANSFER_TOAST_KEYS: Record<BlockedTransferReason, string> = {
  dataUrl: "note.transferDataUrl",
  textRepresentation: "note.transferSaveFirst",
  nonImageFile: "note.transferNonImage",
};

/**
 * 媒體 data URL／非圖片檔案阻擋（spec §12.4）的 tiptap `editorProps.handleDOMEvents`。
 *
 * ⚠ **必須是 `handleDOMEvents`，不能用 `handlePaste`/`handleDrop`**（瀏覽器實測踩過，
 * 用後者等於完全沒有防線）：BlockNote 自己註冊了 `handleDOMEvents.paste` 的外掛，
 * 而且**進來就無條件 `event.preventDefault()` 並自行處理**（`pasteExtension.ts`）；
 * drop 同理由 `fileDropExtension.ts` 接走。ProseMirror 的 DOM 事件流程是
 * 「先 `someProp('handleDOMEvents')`，那一層沒人認領才輪到內建的 editHandlers」，
 * 而 `handlePaste`/`handleDrop` 是在**內建 editHandlers 裡面**才被查詢的——換句話說
 * BlockNote 的外掛永遠先攔走，那兩個 prop 一次都不會被呼叫。
 * 反過來 `handleDOMEvents` 這一層，`someProp` 是**先看直接傳入的 editorProps、
 * 再看外掛**，所以我們的 handler 跑得比 BlockNote 的外掛早。
 *
 * 回傳 `true` ＝已處理，事件不再往下走（BlockNote 的貼上邏輯完全不會執行）；
 * 回傳 `false` ＝正常落回 BlockNote，一般文字貼上不受影響。
 *
 * `view` 參數刻意型別為 `unknown`：這裡完全用不到它，而 `unknown` 參數的函式對
 * 「吃 `EditorView` 的位置」是可指派的，於是不必為了型別把 prosemirror-view 拉成
 * apps/web 的直接依賴，測試也能直接傳 `null` 呼叫。
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
  /** late-bound 編輯器參照（Task 3）：`buildNoteEditorOptions` 是純函式，在
   * `useCreateBlockNote` 真正建出 editor 之前就會被呼叫，下面 `handleTextInput` 的
   * `[[` 觸發偵測要在使用者真的打字的當下才讀取 editor，只能透過這個 ref 取得
   * ——見 `@/components/wikilink/menu` 的 `EditorRef` 說明。 */
  editorRef: EditorRef;
  /** 目前這篇筆記的 id（Task 13）：`createUploadFile` 組 `POST
   * /api/notes/:noteId/uploads` 的路徑要用。 */
  noteId: string;
}

/**
 * 組出交給 `useCreateBlockNote` 的完整選項。抽成獨立函式**是為了可測**：BlockNote
 * 本身依賴大量 jsdom 沒有的 DOM/Range API，掛起來只測得到環境；但這些選項才是
 * §11.1／§12.4（image block 已於 Plan 3 Task 14 恢復＋掛 `uploadFile`，其餘媒體
 * data URL 仍攔截）、共編 fragment 名稱、字典選擇這幾條契約的所在，而且純粹是
 * 資料——測試可以直接呼叫並斷言，不必掛編輯器。
 */
export function buildNoteEditorOptions({ doc, provider, user, language, translate, editorRef, noteId }: NoteEditorOptionsInput) {
  return withCollaboration({
    schema: noteSchema,
    // BlockNote 的預設字典就是英文，只有 zh-TW 需要換掉。
    dictionary: language.startsWith("zh") ? blocknoteZhTW : undefined,
    // Task 13：貼上/拖放純圖片檔案時（上面 `createMediaBlockingDOMEvents` 規則③放行）
    // BlockNote 自己的 paste/drop 外掛會呼叫 `handleFileInsertion`，進而呼叫這裡的
    // `uploadFile`——`createUploadFile` 保證絕不 reject（見該模組檔頭），失敗時自行
    // toast + 清除 placeholder block，`handleFileInsertion` 完全不必知道失敗發生過。
    uploadFile: createUploadFile({ noteId, editorRef, translate }),
    // issue #12：渲染端的 URL 守衛。UI 的 Embed tab 早就擋過一次危險 scheme，但筆記內容是
    // Yjs 文件——**任何有 editor 權限的協作者都能直接寫 block props**，繞過整條 UI。BlockNote
    // 對 image/video/audio 的預覽、以及工具列的「開啟／下載」按鈕，都會先過 `resolveFileUrl`
    // （已對 @blocknote/core 與 @blocknote/react 0.52.1 的 dist 核實），這是唯一一個不必改寫
    // block spec 就能攔在所有 sink 之前的縫。
    //
    // 這個回呼**必須放行相對網址**：自家上傳拿到的是 `/api/uploads/<id>`，套輸入端那條
    // 「必須是完整 http(s)」的規則會把所有上傳的圖片一起擋掉（見 `lib/media-url.ts`）。
    resolveFileUrl: (url: string) => Promise.resolve(safeMediaUrl(url)),
    // 貼上 markdown 的兩個 Windows 破口（CRLF 不被解析、從 VS Code 貼會變成程式碼
    // 區塊）——判斷與理由都在 `@/collab/paste`，這裡只負責接線。
    pasteHandler: createMarkdownPasteHandler(),
    collaboration: {
      provider: { awareness: provider.awareness ?? undefined },
      // fragment 名稱用 `@knotebook/shared` 的 `YDOC_FRAGMENT`——server 端
      // `collab/store.ts` 存取的是同一個名字，任何一邊寫死字串就會變成兩份互不相干
      // 的文件（看起來像「同步壞掉」，其實是連錯文件）。
      fragment: doc.getXmlFragment(YDOC_FRAGMENT),
      user: { id: user.id, name: user.name, color: collabUserColor(user.id) },
    },
    _tiptapOptions: {
      editorProps: {
        handleDOMEvents: createMediaBlockingDOMEvents(translate),
        // `[[` 觸發偵測（Task 3 §12.2 recipe，逐字照做）。這裡刻意**不**倚賴
        // `SuggestionMenu` extension 自己對多字元 trigger 的內建偵測（`addSuggestionMenu`
        // 註冊後，它的 `handleTextInput` 一樣會嘗試比對「[[」）：我們的 handler 掛在
        // `_tiptapOptions.editorProps` 這層，ProseMirror 對 `handleTextInput` 的查詢順序
        // 是「先看直接傳入的 editorProps、才輪到各外掛」，所以會比 extension 內建的偵測
        // 先跑一步，讓我們能加上下面這個 same-parent guard，並自己控制
        // `deleteTriggerCharacter` 的語意。
        //
        // guard：`from >= 1` 且 `from-1` 與游標同 parent——防跨 block 邊界時
        // `textBetween` 誤判（例如上一個 block 結尾字元恰好也是 `[`，那不該算數）。
        handleTextInput: (view, from, to, text) => {
          const $prev = view.state.doc.resolve(from - 1),
            $cur = view.state.doc.resolve(from);
          if (
            text === "[" &&
            from >= 1 &&
            $prev.parent === $cur.parent &&
            view.state.doc.textBetween(from - 1, from) === "["
          ) {
            // ② 刪掉文件中既存的那個 `[`（使用者剛打的第一個 `[` 已經被預設處理插入了）。
            view.dispatch(view.state.tr.delete(from - 1, from));
            // ③ `deleteTriggerCharacter: true`——由 plugin 當下把 `[[` 插入文件，
            // `clearQuery` 屆時刪除範圍才會涵蓋 `[[`+query；省略/false 必然殘留 `[[`。
            editorRef.current?.getExtension(SuggestionMenu)?.openSuggestionMenu("[[", { deleteTriggerCharacter: true });
            return true; // ① 吞掉本次輸入
          }
          return false;
        },
      },
    },
  });
}

export interface NoteEditorProps {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  /** 目前角色能不能編輯（`canEdit(role)`）。false → BlockNoteView 會把 `editor.isEditable` 設成 false。 */
  editable: boolean;
  user: { id: string; name: string };
  /** 目前這篇筆記的 id（Task 13）：轉交給 `buildNoteEditorOptions` 組上傳路徑。 */
  noteId: string;
  /** PR2（BC2 卡片版面，spec A 節）：內文卡頁頭——`NotePage` 組裝
   * TitleInput／ConnectionBadge／分享鈕／⋮ 選單後傳入。純 `ReactNode`，`NotePage`
   * 每次 render 傳新節點只影響這棵子樹，不會觸發 `useCreateBlockNote` 重建
   * （建立點與 deps 見下方，零改動）。 */
  headerSlot?: ReactNode;
  /** 內文卡頁尾——`NotePage` 組裝 backlinks chips 後傳入。同上，普通 slot props。 */
  footerSlot?: ReactNode;
}

/**
 * BlockNote 編輯器本體。刻意跟 `NotePage` 分開成獨立元件：
 * ① 它只在 provider/doc 都備妥之後才掛載，內部不必處理 null；
 * ② 頁面層的測試可以把整個模組 mock 掉——BlockNote 依賴大量 jsdom 沒有的
 *    DOM/Range API，硬掛進單元測試只會測到環境而不是行為。
 *
 * 共編綁定、媒體 transfer 守衛（spec §12.4：data URL 與非圖片檔攔截、純圖片檔放行上傳）、字典選擇全部在 `buildNoteEditorOptions` 裡，
 * 那支是純函式且有專屬測試（`NoteEditor.test.ts`）——這個元件只負責把它接上 React。
 */
export function NoteEditor({ doc, provider, editable, user, noteId, headerSlot, footerSlot }: NoteEditorProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();

  // handler 是在 editor 建立時就固定下來的閉包；用 ref 取用最新的 t，語言切換時
  // 不必為了文案而重建整個 editor（重建會扯斷 y-prosemirror 綁定）。
  const translateRef = useRef(t);
  translateRef.current = t;

  // Task 3：`[[` 觸發（`handleTextInput`）與「建立並連結」的 item handler 都要在
  // 使用者真的互動的當下讀取 editor，而 `buildNoteEditorOptions` 在 editor 存在之前
  // 就會被呼叫——用這個 late-bound ref 打通（見 `buildNoteEditorOptions` 內註解、
  // `@/components/wikilink/menu` 的 `EditorRef`）。
  const editorRef = useRef<EditorRef["current"]>(null);

  const editor = useCreateBlockNote(
    buildNoteEditorOptions({
      doc,
      provider,
      user,
      language: i18n.language,
      translate: (key) => translateRef.current(key),
      editorRef,
      noteId,
    }),
    // 語言不進 deps：字典只在建立時讀一次，換語言要重開頁面才生效（換成
    // 「重建 editor」的代價是共編綁定重掛，不值得）。noteId 同理不進 deps——`useCollab`
    // 的連線 effect 本身就是照 `noteId` 建新的 `Y.Doc`/`HocuspocusProvider`（見
    // `collab/useCollab.ts`），noteId 一換，`doc`/`provider` 必然跟著換、這裡就會
    // 重新跑，不會有「同一個 editor 實例、noteId 換手」這種情境。
    [doc, provider],
  );
  editorRef.current = editor;

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

  // B1（plan gate 定案，不得偏離）：AI 狀態／側欄／toolbar 全部收在這裡，editor
  // 建立點（上面 `useCreateBlockNote` 及其 deps）完全不動——`AiSessionProvider` 只是
  // 包住既有的版面，不會讓 `NotePage` 任何 re-render 有機會扯到 editor 重建。
  //
  // PR2（BC2 卡片版面，spec A 節）：內文卡＋AI 卡都在這裡。DOM 樹（逐字對齊
  // spec，寬度鏈 BLK-3 的起點）：
  //   根 row（flex h-full min-h-0 min-w-0 flex-1 gap-3）
  //     內文卡（cardSurface，flex-col）
  //       {headerSlot}                              ← NotePage 組裝
  //       捲動容器（min-w-0 flex-1 overflow-y-auto min-h-0）
  //         置中 wrapper（mx-auto max-w-[clamp(42.5rem,85%,66rem)] min-h-full flex-col px-4 py-6）
  //           ← 文章欄寬＝捲動容器的 85%，下限 42.5rem（680px＝改版前的固定值）、
  //             上限 66rem（1056px）。留白比例跟著螢幕走，寬螢幕不再停在窄欄；
  //             **下限承重**：中等視窗（捲動容器約 730px）的 85% 只有 620px，
  //             比舊版還窄——clamp 的下限把這段拉回舊行為，不得改成 min()。
  //             視窗更窄時 `w-full` 仍讓它縮到滿版（max-width 不會撐出橫向捲動）。
  //             百分比對 max-width 以父層（捲動容器）寬度解析。
  //           NoteEditorView                         ← className 加 flex-1（B-1 定案：
  //             wrapper 的 min-h-full 無法把百分比高度傳給孫層，唯一有效解是讓
  //             BlockNoteView 自己成為 flex-col wrapper 的成長項；除 className 外零改動）
  //       {footerSlot}                                ← NotePage 組裝（backlinks chips）
  //     AiPanel                                       ← AI 卡（見 AiPanel.tsx）
  // `data-testid="note-editor"` 留在 `NoteEditorView`／`BlockNoteView` 上，不隨這次
  // 改版搬家——e2e 的 `[data-testid="note-editor"] [contenteditable]` 與
  // `NoteEditor.layout.test.tsx` 的節點鏈都吊在這裡。
  return (
    <AiSessionProvider editor={editor} noteId={noteId} editable={editable}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 gap-3">
        <div className={cn(cardSurface, "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden")}>
          {headerSlot}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-[clamp(42.5rem,85%,66rem)] flex-col px-4 py-6">
              <NoteEditorView editor={editor} editable={editable} theme={resolvedTheme} noteId={noteId} getItems={getItems} />
            </div>
          </div>
          {footerSlot}
        </div>
        <AiPanel />
      </div>
    </AiSessionProvider>
  );
}

export interface NoteEditorViewProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 EditorRef/wikilink/menu.ts）
  editor: BlockNoteEditor<any, any, any>;
  /** 目前角色能不能編輯（`canEdit(role)`）。false → BlockNoteView 會把 `editor.isEditable` 設成 false。 */
  editable: boolean;
  theme: "light" | "dark";
  /** 目前這篇筆記的 id（Task 13/14）：轉交給 `createFilePanel` 組 FilePanel 的 noteId 閉包。 */
  noteId: string;
  /** `SuggestionMenuController` 的候選來源（Task 3）——呼叫端（`NoteEditor`）組好
   * notes cache／createNote／translate 的閉包後轉交進來，這裡不重新組。 */
  getItems: (query: string) => Promise<DefaultReactSuggestionItem[]>;
}

/**
 * `<BlockNoteView>` 本體 + 掛在它上面的兩個 controller（`SuggestionMenuController`／
 * `FilePanelController`）。抽成獨立、**exported** 元件是為了可測——比照
 * `buildNoteEditorOptions`「抽出來是為了可測」的既有慣例：`NoteEditor` 本體還要處理
 * `useCreateBlockNote` 的建構、`editorRef`/`translateRef` 的 late-bound 閉包，這些
 * 依賴大量 jsdom 沒有的 DOM/Range API；但「`filePanel={false}` 有沒有真的關掉內建
 * 面板」「`useMemo` 有沒有真的釘住 `filePanel` 的元件身分」這兩條 Task 14 的核心契約，
 * 只需要一個掛好的 `<BlockNoteView>` + 真編輯器就測得到（見
 * `NoteEditorView.test.tsx`；jsdom 缺的 `ResizeObserver`/`window.matchMedia` 兩個
 * mantine 內部會摸到的全域已經補進 `test/setup.ts`）。
 */
export function NoteEditorView({ editor, editable, theme, noteId, getItems }: NoteEditorViewProps) {
  // Task 14：`createFilePanel(noteId)` 回傳一個新的元件型別——`FilePanelController`
  // 拿它跟前一輪比對身分，身分一變就會整個卸載重掛（見 `createFilePanel` 檔頭的完整
  // 說明），所以這裡必須 `useMemo` 釘住，只在 `noteId` 真的換手時才重建。`noteId`
  // 在 `NoteEditor` 的生命週期內事實上不會變（同 `useCreateBlockNote` 上面的 deps
  // 註解：noteId 一換，`doc`/`provider` 必然跟著換，等於整個 `NoteEditor` 重新掛載），
  // 但依賴陣列仍誠實列出，不靠這個隱含假設省略。
  const filePanel = useMemo(() => createFilePanel(noteId), [noteId]);
  // Task 6：`AiToolbar` 本身是模組層級的具名匯出（不像 `createFilePanel` 是「依 noteId
  // 生一個新元件型別」的工廠），identity 本來就跨 render 穩定——這裡仍然 `useMemo` 釘一次
  // 是刻意逐字比照 filePanel 這支的既有寫法/註解風格（brief 明文要求）：
  // `FormattingToolbarController` 拿 `formattingToolbar` prop 跟前一輪比對身分，同一套
  // 「身分不穩會被當成換元件、整個卸載重掛」的風險模型也適用在它身上，`useMemo` 讓這個
  // 不變量在原始碼層級直接可見，不必倚賴「反正它是模組層級函式」這個隱含事實。
  const aiToolbar = useMemo(() => AiToolbar, []);

  return (
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
      // 同理關掉內建的 FormattingToolbarController：下面接管的是我們自家的
      // `AiToolbar`（`getFormattingToolbarItems()` 全數復原＋追加 AI 動作選單，見
      // `components/ai/AiToolbar.tsx` 檔頭）。
      formattingToolbar={false}
    >
      <SuggestionMenuController triggerCharacter="[[" getItems={getItems} />
      <FilePanelController filePanel={filePanel} />
      <FormattingToolbarController formattingToolbar={aiToolbar} />
    </BlockNoteView>
  );
}
