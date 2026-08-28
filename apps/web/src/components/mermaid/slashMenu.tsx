import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { getDefaultReactSlashMenuItems, type DefaultReactSuggestionItem } from "@blocknote/react";
import { Diagram } from "@/components/ui/icons";

/**
 * `/` slash 選單的項目清單：**內建項目全數保留 ＋ 追加 mermaid 圖表**（issue #94）。
 *
 * ⚠ 掛載端（`NoteEditorView`）必須同時設 `slashMenu={false}`，否則會有兩個
 * `/` 選單 controller 疊在一起——同 `filePanel={false}`／`formattingToolbar={false}`
 * 的既有理由，見該檔註解。
 *
 * ⚠ **一定要 spread 預設項**。只回自己的項＝靜默把整個內建選單換掉（使用者按 `/`
 * 只剩一個「圖表」可選），而且不會有任何型別錯誤——與 `collab/schema.ts` 對
 * `inlineContentSpecs` 整組覆寫的雷是同一款。`slashMenu.test.tsx` 有一條釘住這件事。
 */
export function buildSlashMenuItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 wikilink/menu.ts、ai/apply.ts）
  editor: any,
  translate: (key: string) => string,
): DefaultReactSuggestionItem[] {
  return [
    ...getDefaultReactSlashMenuItems(editor),
    {
      title: translate("note.mermaid.slashTitle"),
      subtext: translate("note.mermaid.slashSubtext"),
      // 中英文別名都給：這個 app 的介面語言可切換，使用者打 `/圖表` 或 `/diagram`
      // 都應該找得到。`mermaid` 本身也留著（知道這個名字的人會直接打）。
      aliases: ["mermaid", "diagram", "chart", "flowchart", "圖表", "流程圖"],
      group: translate("note.mermaid.slashGroup"),
      icon: <Diagram className="h-4 w-4" />,
      // 刻意**不帶 `props`**：新 block 的 `code` 由 `mermaidBlockConfig.propSchema.code.default`
      // 決定（空字串），讓「空 block 長什麼樣」只有一處真相。
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "mermaid" }),
    },
  ];
}
