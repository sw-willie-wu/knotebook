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
  const defaults = getDefaultReactSlashMenuItems(editor);
  const group = translate("note.mermaid.slashGroup");
  const item: DefaultReactSuggestionItem = {
    title: translate("note.mermaid.slashTitle"),
    subtext: translate("note.mermaid.slashSubtext"),
    // 中英文別名都給：這個 app 的介面語言可切換，使用者打 `/圖表` 或 `/diagram`
    // 都應該找得到。`mermaid` 本身也留著（知道這個名字的人會直接打）。
    aliases: ["mermaid", "diagram", "chart", "flowchart", "圖表", "流程圖"],
    group,
    icon: <Diagram className="h-4 w-4" />,
    // 刻意**不帶 `props`**：新 block 的 `code` 由 `mermaidBlockConfig.propSchema.code.default`
    // 決定（空字串），讓「空 block 長什麼樣」只有一處真相。
    onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "mermaid" }),
  };

  // ⚠ 不能單純 push 到最後：選單只在「這一項的 group 跟上一項不同」時才畫分組標題，
  // 而內建順序是 …Advanced → Media → Others。塞在最尾會讓畫面上出現**第二個**同名
  // 分組標題。插到最後一個同 group 的項目後面，才會併進既有那一組。
  const lastInGroup = defaults.map((entry) => entry.group).lastIndexOf(group);
  if (lastInGroup === -1) return [...defaults, item];
  return [...defaults.slice(0, lastInGroup + 1), item, ...defaults.slice(lastInGroup + 1)];
}
