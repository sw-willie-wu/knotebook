import { useContext, useRef, useState, type MouseEvent } from "react";
import type { BlockNoteEditor, DefaultStyleSchema } from "@blocknote/core";
import { createReactInlineContentSpec, type ReactCustomInlineContentRenderProps } from "@blocknote/react";
import { canonicalNotePath, normalizeAnchor, wikilinkConfig, wikilinkHref, wikilinkVisibleText, type PublicLinkDto } from "@knotebook/shared";
import { useNotes } from "@/api/notes";
import { WikilinkContext } from "./context";
import { useWikilinkActivate, useWikilinkClick } from "./useWikilinkClick";
import { removeWikilinkNode, WikilinkToolbar } from "./WikilinkToolbar";

// ⚠ 防循環 import：`collab/schema.ts` 會 import 本檔來組 `inlineContentSpecs`，所以本檔絕不能反過來 import `@/collab/schema`
// ——需要編輯器型別時一律 `BlockNoteEditor<any,any,any>`。
// propSchema（`targetNoteId`、`snapshotTitle`、#269 的 `label`／`anchorBlockId`）住 `@knotebook/shared` 的 `note-schema-config.ts`。
// ⚠ 編輯器的 renderHTML（站內複製的 `blocknote/html`、拖曳）用的也是 `toExternalHTML` 那個元件，所以它**不得**接 `contentRef`
// （wikilink 是 atom，接了會帶出 contentDOM，見 `WikilinkExternalHTML` 內的說明）；`render` 用的元件不在此限。

type WikilinkRenderProps = ReactCustomInlineContentRenderProps<typeof wikilinkConfig, DefaultStyleSchema>;

/**
 * 樣式（issue #153、#269）：活連結＝主題色＋實線底線（與外部連結同一套），**刻意不帶外連圖示**（同分頁導航）；
 * 斷鏈＝muted＋虛線底線、不套主題色。⚠ 顏色寫 `text-(--color-brand)` 而**不是** `text-brand`（理由見 memory knotebook-link-styling：
 * `.bn-root.dark` 會把巢狀的 `--brand` 重設回 indigo；`--color-brand` 只宣告在 `@theme inline`，`theme.link-guard.test.ts` 守）。
 */
const LIVE_LINK_CLASS = "cursor-pointer text-(--color-brand) underline";
const BROKEN_CLASS = "cursor-pointer border-b border-dashed border-muted-foreground text-muted-foreground";

/**
 * `toExternalHTML`——headless 匯出（`blocksToHTMLLossy`／markdown、`toClipboard`）。**必須是無副作用的純 FC，只讀 props**：headless
 * 匯出下沒有 React context（任何 hook 都會炸）。#269 §7.3：輸出 `<a href="/notes/<id>[#b-…]">label || snapshotTitle || href</a>`
 * （包在一層 `<span>` 裡，理由見函式內；與 shared headless spec 同形；`collab/schema.test.ts` 的 parity 案守）。現行標題由呼叫端在匯出副本上換入（`wikilinksToLinks`）。
 */
function WikilinkExternalHTML({ inlineContent }: WikilinkRenderProps) {
  // 不可接 contentRef：wikilink 是 atom（content:"none"），接了會讓 renderHTML 回 contentDOM，
  // 站內複製的 serializeForClipboard 就拋 RangeError「Content hole not allowed in a leaf node spec」、剪貼簿被清空（#269 Task 2）。
  // 外層 `<span>` 不可省：renderHTML 把 `data-inline-content-type` 等屬性寫在根元素上；根若是 `<a href>`，站內貼上（PM raw parse）
  // 時 link mark 的 `a[href]` 規則先於 wikilink 規則命中，貼出來變成一般連結（`wikilink-props.facts.test.tsx` 的站內複製貼上案守）。
  const { targetNoteId, anchorBlockId } = inlineContent.props;
  return (
    <span>
      <a href={wikilinkHref(targetNoteId, normalizeAnchor(anchorBlockId))}>
        {wikilinkVisibleText(inlineContent.props)}
      </a>
    </span>
  );
}

/** §7.1：依情境分派。hook 不能條件式呼叫，所以 member／public 是兩個元件——public **不呼叫** `useNotes()`。 */
export function WikilinkInline(props: WikilinkRenderProps) {
  const mode = useContext(WikilinkContext);
  return mode.mode === "public" ? <PublicWikilink {...props} links={mode.links} /> : <MemberWikilink {...props} />;
}

/**
 * §7.2 member（編輯頁、viewer、版本預覽）。三態：
 * 1. 清單未到／失敗（`isPending || !data`）：`<a href=/notes/<id>[#b-…]>`、文字 `label || snapshotTitle`。**列表查詢失敗也併進這一態**——
 *    沒有足夠資訊斷言目標不存在，放行導航、讓筆記頁自己處理 404。
 * 2. 命中：`<a href=canonical[#b-…]>`、文字 `label || 現行標題`。
 * 3. 清單到了卻沒有這個 id（已刪或無權）：`<span>` 斷鏈樣式、文字 `label || snapshotTitle`；點擊 toast。
 */
function MemberWikilink({ inlineContent, contentRef, editor, updateInlineContent }: WikilinkRenderProps) {
  const notesQuery = useNotes();
  const click = useWikilinkClick();
  const activate = useWikilinkActivate();
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const elRef = useRef<HTMLElement | null>(null);
  const { targetNoteId } = inlineContent.props;
  const label = inlineContent.props.label ?? "";
  const anchor = normalizeAnchor(inlineContent.props.anchorBlockId);
  const list = notesQuery.isPending || !notesQuery.data ? undefined : notesQuery.data;
  const note = list?.find((candidate) => candidate.id === targetNoteId);
  const broken = list !== undefined && note === undefined;
  const href = note ? `${canonicalNotePath(note)}${anchor ? `#b-${anchor}` : ""}` : wikilinkHref(targetNoteId, anchor);
  const text = broken ? wikilinkVisibleText(inlineContent.props) : wikilinkVisibleText(inlineContent.props, note?.title);
  const target = { href: broken ? "" : href, targetNoteId, anchorBlockId: anchor, broken };
  const setRefs = (el: HTMLElement | null) => {
    elRef.current = el;
    contentRef(el);
  };
  const onClick = (e: MouseEvent<HTMLElement>) => click(e, target, { editable: editor.isEditable, onEditableClick: () => setToolbarOpen(true) });
  // 可編輯時 `draggable={false}`：tiptap 的 NodeView.stopEvent 把不可選取節點的 dragstart 留給瀏覽器，原生 `<a>` 會被拖成
  // text/html 連結，放回編輯器就多出一個一般連結（拖放進來的不轉換）。唯讀不設，讀者照常可把連結拖到分頁列／書籤。
  const anchorEl = broken ? (
    <span ref={setRefs} className={BROKEN_CLASS} onClick={onClick}>
      {text}
    </span>
  ) : (
    <a ref={setRefs} href={href} className={LIVE_LINK_CLASS} draggable={editor.isEditable ? false : undefined} onClick={onClick}>
      {text}
    </a>
  );
  if (!editor.isEditable) return anchorEl;
  return (
    <WikilinkToolbar
      open={toolbarOpen}
      onOpenChange={setToolbarOpen}
      broken={broken}
      label={label}
      displayText={text}
      notes={list}
      onOpenTarget={() => activate(target)}
      onSaveLabel={(next) => updateInlineContent({ type: "wikilink", props: { ...inlineContent.props, label: next } })}
      onChangeTarget={(picked) =>
        updateInlineContent({ type: "wikilink", props: { ...inlineContent.props, targetNoteId: picked.id, snapshotTitle: picked.title, anchorBlockId: "" } })
      }
      onRemove={() => {
        if (elRef.current) removeWikilinkNode(editor, elRef.current, text);
      }}
      onRestoreFocus={() => editor.focus()}
    >
      {anchorEl}
    </WikilinkToolbar>
  );
}

/**
 * §11.2 公開頁：`links`（公開 payload，只含有自訂公開網址的目標）有此 id ⇒ `<a href=/p/…[#b-…]>`、文字 `label || 公開標題`；
 * 沒有、但有錨點且本頁有該 id 的區塊 ⇒ 同篇錨點 `<a href=#b-…>`（不論本頁是 token 形或自訂網址）；其餘 ⇒ 純文字。
 */
function PublicWikilink({ inlineContent, contentRef, editor, links }: WikilinkRenderProps & { links: ReadonlyMap<string, PublicLinkDto> }) {
  const click = useWikilinkClick();
  const { targetNoteId } = inlineContent.props;
  const anchor = normalizeAnchor(inlineContent.props.anchorBlockId);
  const target = links.get(targetNoteId.toLowerCase());
  if (target) {
    const href = `${target.path}${anchor ? `#b-${anchor}` : ""}`;
    return (
      <a ref={contentRef} href={href} className={LIVE_LINK_CLASS} onClick={(e) => click(e, { href, targetNoteId, anchorBlockId: anchor, broken: false })}>
        {wikilinkVisibleText(inlineContent.props, target.title)}
      </a>
    );
  }
  if (anchor !== "" && editor.getBlock(anchor) !== undefined) {
    const href = `#b-${anchor}`;
    return (
      <a ref={contentRef} href={href} className={LIVE_LINK_CLASS} onClick={(e) => click(e, { href, targetNoteId: null, anchorBlockId: anchor, broken: false })}>
        {wikilinkVisibleText(inlineContent.props)}
      </a>
    );
  }
  return <span ref={contentRef}>{wikilinkVisibleText(inlineContent.props)}</span>;
}

/** wikilink 的 inline content spec——掛進 `collab/schema.ts` 的 `inlineContentSpecs`（**整組覆寫**，記得 spread 預設的 text／link）。 */
export const wikilinkSpec = createReactInlineContentSpec(wikilinkConfig, {
  render: WikilinkInline,
  toExternalHTML: WikilinkExternalHTML,
});

/**
 * 插入一個 wikilink + 補一個 trailing space（不補的話使用者接著打的字會黏在 atom node 上）。#269 §8.7：`label`／`anchorBlockId`
 * 選配、預設空字串。`editor` 型別故意寫 `BlockNoteEditor<any,any,any>`（防循環 import，見檔頭）。
 */
export function insertWikilink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組在本檔案無法具體化（防循環 import），走 repo 慣例用 any
  editor: BlockNoteEditor<any, any, any>,
  wikilink: { targetNoteId: string; snapshotTitle: string; label?: string; anchorBlockId?: string },
): void {
  editor.insertInlineContent([{ type: "wikilink", props: { label: "", anchorBlockId: "", ...wikilink } }, " "]);
}
