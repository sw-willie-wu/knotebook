// 只需要這一支：`@blocknote/mantine/style.css` 自己 `@import` 了 mantine 主題與
// `@blocknote/react/style.css`（後者再帶進 core 的樣式）。刻意不引
// `@blocknote/core/fonts/inter.css`——那是 latin-only 的自帶字型（9 個 woff 檔），
// 對以中文為主的介面沒有幫助，只會讓 bundle 變大；字型交給 app 自己的 CSS 決定。
import "@blocknote/mantine/style.css";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { withCollaboration } from "@blocknote/core/yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { isBlockedMediaTransfer, noteSchema } from "@/collab/schema";
import { blocknoteZhTW } from "@/i18n/blocknote-zh-TW";
import { toast } from "@/components/ui/toast";
import { useTheme } from "@/theme";

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

/**
 * 圖片阻擋（spec §11.1）的 tiptap `editorProps.handleDOMEvents`。
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
    if (!isBlockedMediaTransfer(data)) return false;
    event.preventDefault();
    toast({ title: translate("note.imageUnsupported") });
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
}

/**
 * 組出交給 `useCreateBlockNote` 的完整選項。抽成獨立函式**是為了可測**：BlockNote
 * 本身依賴大量 jsdom 沒有的 DOM/Range API，掛起來只測得到環境；但這些選項才是
 * §11.1（無 image block + 貼上攔截）、共編 fragment 名稱、字典選擇這幾條契約的所在，
 * 而且純粹是資料——測試可以直接呼叫並斷言，不必掛編輯器。
 */
export function buildNoteEditorOptions({ doc, provider, user, language, translate }: NoteEditorOptionsInput) {
  return withCollaboration({
    schema: noteSchema,
    // BlockNote 的預設字典就是英文，只有 zh-TW 需要換掉。
    dictionary: language.startsWith("zh") ? blocknoteZhTW : undefined,
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
}

/**
 * BlockNote 編輯器本體。刻意跟 `NotePage` 分開成獨立元件：
 * ① 它只在 provider/doc 都備妥之後才掛載，內部不必處理 null；
 * ② 頁面層的測試可以把整個模組 mock 掉——BlockNote 依賴大量 jsdom 沒有的
 *    DOM/Range API，硬掛進單元測試只會測到環境而不是行為。
 *
 * 共編綁定、圖片阻擋（spec §11.1）、字典選擇全部在 `buildNoteEditorOptions` 裡，
 * 那支是純函式且有專屬測試（`NoteEditor.test.ts`）——這個元件只負責把它接上 React。
 */
export function NoteEditor({ doc, provider, editable, user }: NoteEditorProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();

  // handler 是在 editor 建立時就固定下來的閉包；用 ref 取用最新的 t，語言切換時
  // 不必為了文案而重建整個 editor（重建會扯斷 y-prosemirror 綁定）。
  const translateRef = useRef(t);
  translateRef.current = t;

  const editor = useCreateBlockNote(
    buildNoteEditorOptions({
      doc,
      provider,
      user,
      language: i18n.language,
      translate: (key) => translateRef.current(key),
    }),
    // 語言不進 deps：字典只在建立時讀一次，換語言要重開頁面才生效（換成
    // 「重建 editor」的代價是共編綁定重掛，不值得）。
    [doc, provider],
  );

  return (
    <BlockNoteView
      editor={editor}
      editable={editable}
      theme={resolvedTheme}
      data-testid="note-editor"
      className="min-h-full"
    />
  );
}
