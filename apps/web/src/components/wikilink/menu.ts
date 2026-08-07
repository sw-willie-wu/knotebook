import { trackPosition, type BlockNoteEditor } from "@blocknote/core";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { NoteDto } from "@knotebook/shared";
import { insertWikilink } from "./spec.js";

/**
 * late-bound 編輯器參照。`NoteEditor.tsx` 的 `buildNoteEditorOptions` 是純函式，在
 * `useCreateBlockNote` 真正建出 editor **之前**就會被呼叫（Task 3 brief「editor 閉包
 * 時序」陷阱）；`[[` 觸發的 `handleTextInput` 與這裡的選單 item handler 都只在使用者
 * 真的互動時才會執行，所以只能透過這個 ref 在「事件當下」讀取當時的 editor 實例，
 * 不能在 `buildNoteEditorOptions` 呼叫當下就把 editor 閉包進去（那時它還不存在）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組在這裡無法具體化（跨 Task 2/3/14 共用，型別具體化需要 `noteSchema`，但 `wikilink/*` 不能反向 import `@/collab/schema`，見 spec.tsx 檔頭說明），走 repo 慣例用 any
export type EditorRef = { current: BlockNoteEditor<any, any, any> | null };

/** `@/components/ui/toast` 的 `toast()` 最小介面——只用到 `title`。 */
export type ToastFn = (item: { title: string }) => void;

export interface BuildWikilinkMenuItemsDeps {
  /** 使用者在 `[[` 之後打的查詢字串（SuggestionMenu 的 query，不含 `[[`）。 */
  query: string;
  /** 候選來源——既有的 `GET /api/notes` React Query cache（側欄同一份，不重新打 API）。 */
  notes: NoteDto[];
  /** 由呼叫端（`NoteEditor`）注入既有的 `useCreateNote().mutateAsync`；其 `onSuccess`
   * 已內建 `invalidateQueries(["notes"])`，這裡不必也不該重複 invalidate。 */
  createNote: (title: string) => Promise<NoteDto>;
  editorRef: EditorRef;
  /** `i18next` 的 `t`，但呼叫端要先把 query 插值好（`(key) => t(key, { query })`）——
   * 這支的簽章刻意只吃 key，menu.ts 不需要知道插值細節。 */
  translate: (key: string) => string;
  toast: ToastFn;
}

/**
 * `[[` 補全選單的候選項：既有筆記（標題 substring、case-insensitive）＋（query 非空
 * 時）「建立『<query>』並連結」。
 *
 * `SuggestionMenuWrapper` 的 `onItemClickCloseMenu`（`@blocknote/react`）呼叫順序是
 * **先 `closeMenu()`、再 `clearQuery()`，最後才呼叫這裡回傳的 item 的 `onItemClick`**：
 * 呼叫到這裡時，`[[`+query 已經被 `clearQuery()` 同步從文件裡刪掉，游標落在刪除點，
 * 既有筆記的 item 因此可以直接在目前選取位置插入 `insertWikilink`。
 *
 * 「建立並連結」則要等一個非同步的 `createNote`——這段等待期間使用者可能繼續打字，
 * 絕對位置會漂移，所以下 `createNote` 之前先用 `trackPosition`（`@blocknote/core`）把
 * 當下的插入點釘住；等 promise 落地（成功或失敗）後，用它換算出目前真正的位置，把
 * 選取移過去再插入（成功：`insertWikilink`；失敗：插回純文字 `[[<query>]]` + toast，
 * 不讓使用者辛苦打的查詢字串憑空消失）。
 */
export function buildWikilinkMenuItems(deps: BuildWikilinkMenuItemsDeps): DefaultReactSuggestionItem[] {
  const { query, notes, createNote, editorRef, translate, toast } = deps;
  const lowerQuery = query.toLowerCase();

  const items: DefaultReactSuggestionItem[] = notes
    .filter((note) => note.title.toLowerCase().includes(lowerQuery))
    .map((note) => ({
      title: note.title,
      onItemClick: () => {
        const editor = editorRef.current;
        if (!editor) {
          return;
        }
        insertWikilink(editor, { targetNoteId: note.id, snapshotTitle: note.title });
      },
    }));

  if (query.length > 0) {
    items.push({
      title: translate("note.wikilink.createAndLink"),
      onItemClick: () => {
        const editor = editorRef.current;
        if (!editor) {
          return;
        }

        const insertionPos = editor.transact((tr) => tr.selection.from);
        const getInsertionPos = trackPosition(editor, insertionPos);

        void createNote(query).then(
          (note) => {
            const current = editorRef.current;
            if (!current) {
              return;
            }
            current._tiptapEditor.chain().focus().setTextSelection(getInsertionPos()).run();
            insertWikilink(current, { targetNoteId: note.id, snapshotTitle: note.title });
          },
          () => {
            const current = editorRef.current;
            if (!current) {
              return;
            }
            current._tiptapEditor.chain().focus().setTextSelection(getInsertionPos()).run();
            current.insertInlineContent([`[[${query}]]`]);
            toast({ title: translate("note.wikilink.createFailed") });
          },
        );
      },
    });
  }

  return items;
}
