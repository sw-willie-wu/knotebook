import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { BlockNoteEditor, DefaultStyleSchema } from "@blocknote/core";
import { createReactInlineContentSpec, type ReactCustomInlineContentRenderProps } from "@blocknote/react";
import { canonicalNotePath } from "@knotebook/shared";
import { useNotes } from "@/api/notes";
import { toast } from "@/components/ui/toast";

// ⚠ 防循環 import（Task 2 brief 明寫）：`collab/schema.ts` 會 import 本檔案來組
// `inlineContentSpecs`，所以本檔案絕不能反過來 import `@/collab/schema`——需要編輯器
// 型別時一律用 `BlockNoteEditor<any,any,any>`（見下方 `insertWikilink`），不能借道
// `NoteSchema` 那個具體型別。

/** wikilink 的 propSchema——`targetNoteId` 指向目標筆記的 id，`snapshotTitle` 是插入
 * 當下的標題快照（目標筆記之後改名／被刪，這個字串仍留在文件裡，供斷鏈態顯示用）。
 * `content: "none"` ⇒ atom + 不可選取（見 `createReactInlineContentSpec` 原始碼）。 */
const wikilinkConfig = {
  type: "wikilink",
  content: "none",
  propSchema: {
    targetNoteId: { default: "" },
    snapshotTitle: { default: "" },
  },
} as const;

type WikilinkRenderProps = ReactCustomInlineContentRenderProps<typeof wikilinkConfig, DefaultStyleSchema>;

/**
 * `toExternalHTML`——headless 匯出（`blocksToHTMLLossy`／markdown，`toClipboard` 複製）
 * 唯一會呼叫的那支。**必須是無副作用的純 FC，只讀 `inlineContent.props`**：headless
 * 匯出下 `renderToDOMSpec` 完全沒有 React context（`elementRenderer` 未設定時直接
 * `createRoot(div)` 零 provider），任何 hook（`useTranslation`／`useNotes`／
 * `useNavigate`……）呼叫都會直接炸掉（`No QueryClient set` 之類）。
 *
 * 輸出純文字 `[[<snapshotTitle>]]`、絕不渲染 `<a>`——匯出的 HTML 可能落在別處
 * （複製貼上、未來的靜態匯出），這裡沒有能力確認目標筆記是否還存在，渲染成可點擊
 * 連結只會誤導。外層的 `data-inline-content-type`／`data-target-note-id`／
 * `data-snapshot-title` 屬性由 `createReactInlineContentSpec` 內建的
 * `InlineContentWrapper` 自動加上，這裡不必手動重複。
 */
function WikilinkExternalHTML({ inlineContent, contentRef }: WikilinkRenderProps) {
  return <span ref={contentRef}>{`[[${inlineContent.props.snapshotTitle}]]`}</span>;
}

/**
 * mounted 編輯器內的互動渲染。標題來源＝既有 `GET /api/notes` React Query cache
 * （`useNotes`，同側欄 queryKey，不新增 API）。三態：
 * 1. loading／未知（`notesQuery.isPending || !notesQuery.data`）：顯示 snapshotTitle，
 *    點擊以 `/notes/<targetNoteId>` 導航（此時還不知道 canonical slug，只能先用 id）。
 *    **刻意把「列表查詢失敗（重試耗盡，`isPending` 已是 false 但 `data` 仍是
 *    `undefined`）」也併進這一態**，不當成斷鏈：我們沒有足夠資訊斷言目標筆記真的
 *    不存在，寧可放行導到 `/notes/<id>`、讓筆記頁自己處理 404，也不要對使用者謊稱
 *    「這篇筆記不存在」而把導航整條路堵死。
 * 2. resolved 命中：顯示目標筆記**現行**標題（可能已改名），點擊用 `canonicalNotePath`
 *    導航。
 * 3. resolved 未命中（`notesQuery.data` 確實拿到手、清單裡卻沒有這個 id——目標筆記
 *    已被刪除）：斷鏈樣式（灰色＋虛線底線），顯示 snapshotTitle，點擊只跳 toast、
 *    不導航。
 *
 * `content:"none"` + `selectable:false`（見 `createReactInlineContentSpec`）⇒ 這個
 * inline node 沒有 NodeSelection 可用，導航／斷鏈 toast 都得靠這裡自己的 `onClick`，
 * 不能倚賴 BlockNote 內建「選取後跳轉」那套機制。用 `<button type="button">` 而非
 * `<a>`／`<span role="...">`：原生鍵盤可操作（Enter/Space），不必自己補
 * `onKeyDown`，且不會因為 href 觸發瀏覽器的整頁導航。
 */
export function WikilinkInline({ inlineContent, contentRef }: WikilinkRenderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notesQuery = useNotes();
  const { targetNoteId, snapshotTitle } = inlineContent.props;

  if (notesQuery.isPending || !notesQuery.data) {
    return (
      <button
        ref={contentRef}
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-inherit underline"
        onClick={() => void navigate(`/notes/${targetNoteId}`)}
      >
        {snapshotTitle}
      </button>
    );
  }

  const resolvedNote = notesQuery.data?.find((note) => note.id === targetNoteId);

  if (resolvedNote) {
    return (
      <button
        ref={contentRef}
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-inherit underline"
        onClick={() => void navigate(canonicalNotePath(resolvedNote))}
      >
        {resolvedNote.title}
      </button>
    );
  }

  return (
    <button
      ref={contentRef}
      type="button"
      className="cursor-pointer border-0 border-b border-dashed border-muted-foreground bg-transparent p-0 text-muted-foreground"
      onClick={() => toast({ title: t("note.wikilinkBroken") })}
    >
      {snapshotTitle}
    </button>
  );
}

/** wikilink 的 inline content spec——掛進 `collab/schema.ts` 的 `inlineContentSpecs`
 * （**整組覆寫**，掛載端要記得 `{ ...defaultInlineContentSpecs, wikilink: wikilinkSpec }`，
 * 漏 spread 會靜默毀掉 `text`/`link` 兩個預設 inline spec——見該檔說明）。 */
export const wikilinkSpec = createReactInlineContentSpec(wikilinkConfig, {
  render: WikilinkInline,
  toExternalHTML: WikilinkExternalHTML,
});

/**
 * 插入一個 wikilink + 補一個 trailing space（插入後游標緊接在 atom node 後面，沒有
 * 空格的話使用者會直接接著打字、字元黏在 node 上，體感像是「打不出東西」）。
 *
 * `editor` 型別故意寫 `BlockNoteEditor<any,any,any>`：呼叫端（`NoteEditor.tsx` 的
 * slash-menu／`/` 選單，或 `[[` 觸發的 suggestion menu）拿到的是掛好 `noteSchema` 的
 * 具體編輯器，但本檔案不能 import `@/collab/schema`（防循環），無法在這裡把型別
 * 具體化，只能吃 BlockNote 泛型三元組的最寬型別（repo 慣例）。
 */
export function insertWikilink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組在本檔案無法具體化（防循環 import，見上方檔案頂端說明），走 repo 慣例用 any
  editor: BlockNoteEditor<any, any, any>,
  wikilink: { targetNoteId: string; snapshotTitle: string },
): void {
  editor.insertInlineContent([{ type: "wikilink", props: wikilink }, " "]);
}
