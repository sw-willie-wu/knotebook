import type { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import type { NoteDto } from "@knotebook/shared";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { api } from "@/api/client";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import "@/i18n/tour-strings";
import type { TourEditor } from "@/lib/tour-bridge";

/**
 * 功能導覽用的範例筆記：建立（`createSampleNote`）與寫入內容（`seedSampleNote`）。
 * 每次開始導覽都建一篇新的，不查舊的、不讀任何本機或 server 紀錄。
 */

/** 建一篇新筆記（標題依目前介面語言）並讓側欄的筆記清單重抓；失敗時拋出 `api` 的錯誤，由呼叫端處理。 */
export async function createSampleNote(queryClient: QueryClient, t: TFunction): Promise<NoteDto> {
  const note = await api<NoteDto>("/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: t("tourGuide.sample.title") }),
  });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
  return note;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type SampleBlock = Record<string, any>;

const text = (value: string) => [{ type: "text" as const, text: value, styles: {} }];

const para = (value: string): SampleBlock => ({ type: "paragraph", content: text(value) });

/**
 * 範例筆記的內容（純函式）：常見的 block 都有，站內連結指向筆記自己。
 * 站台有開 AI（`hasAi`）時，倒數第二段是留給 AI 站框選的那句；沒開就不放那句。
 * 最後是空段落（給後續站放游標用）。
 */
export function buildSampleBlocks(
  t: TFunction,
  note: Pick<NoteDto, "id" | "title">,
  hasAi: boolean,
): SampleBlock[] {
  const s = (key: string) => t(`tourGuide.sample.${key}`);
  return [
    para(s("intro")),
    { type: "heading", props: { level: 2 }, content: text(s("heading")) },
    { type: "bulletListItem", content: text(s("bullet1")) },
    { type: "bulletListItem", content: text(s("bullet2")) },
    { type: "numberedListItem", content: text(s("number1")) },
    { type: "numberedListItem", content: text(s("number2")) },
    { type: "checkListItem", props: { checked: true }, content: text(s("todoDone")) },
    { type: "checkListItem", props: { checked: false }, content: text(s("todoOpen")) },
    { type: "quote", content: text(s("quote")) },
    { type: "codeBlock", props: { language: "javascript" }, content: text(s("code")) },
    {
      type: "paragraph",
      content: [
        ...text(s("linkBefore")),
        { type: "wikilink", props: { targetNoteId: note.id, snapshotTitle: note.title, label: "", anchorBlockId: "" } },
        ...text(s("linkAfter")),
      ],
    },
    {
      type: COLUMN_LIST_TYPE,
      children: [
        { type: COLUMN_TYPE, props: { width: 1 }, children: [para(s("columnLeft"))] },
        {
          type: COLUMN_TYPE,
          props: { width: 1 },
          children: [{ type: "bulletListItem", content: text(s("columnRight")) }],
        },
      ],
    },
    { type: "mermaid", props: { code: s("mermaidCode") } },
    {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: [text(s("tableName")), text(s("tableValue"))] },
          { cells: [text(s("tableRow1Name")), text(s("tableRow1Value"))] },
        ],
      },
    },
    ...(hasAi ? [para(s("aiSentence"))] : []),
    { type: "paragraph" },
  ];
}

type PmDoc = Parameters<Parameters<TourEditor["transact"]>[0]>[0]["doc"];

/** 文件是不是只有一個沒有內容的段落（BlockNote 的 doc > blockGroup > blockContainer > paragraph）。 */
function isSingleEmptyParagraph(doc: PmDoc): boolean {
  if (doc.textContent !== "") return false;
  const kinds: string[] = [];
  doc.descendants((node) => {
    kinds.push(node.type.name);
  });
  return kinds.length === 3 && kinds[1] === "blockContainer" && kinds[2] === "paragraph";
}

/**
 * 把範例內容寫進剛建好、還是空的筆記；回傳是否真的寫入。
 *
 * 判空和寫入在同一個交易裡、以交易的 `doc` 為準：判空若在交易外先算好再傳進來，
 * 另一個分頁剛打的字可能在那之後才同步到，寫入會把它吃掉。
 * 寫入標成不進撤銷：否則使用者多按一下 Ctrl+Z 就把整篇範例撤掉。
 */
export function seedSampleNote(
  editor: TourEditor,
  note: Pick<NoteDto, "id" | "title">,
  t: TFunction,
  hasAi: boolean,
): boolean {
  let written = false;
  editor.transact((tr) => {
    if (!isSingleEmptyParagraph(tr.doc)) return;
    tr.setMeta("addToHistory", false);
    replaceBlocksKeepColumns(
      editor,
      editor.document.map((block) => block.id),
      buildSampleBlocks(t, note, hasAi),
    );
    written = true;
  });
  return written;
}
