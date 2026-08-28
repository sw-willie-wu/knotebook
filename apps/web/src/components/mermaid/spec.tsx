import type { JSX } from "react";
import { createReactBlockSpec, type ReactCustomBlockRenderProps } from "@blocknote/react";
import { useTheme } from "@/theme";
import { MermaidView } from "./MermaidView";

/**
 * mermaid 圖表 block（issue #94）。這個 repo 的**第一個自訂 block spec**
 * （`wikilink` 是 inline content spec，走的是另一支 API）。
 *
 * ⚠ **`createReactBlockSpec` 回傳的是 factory，不是 spec 本身**——與
 * `createReactInlineContentSpec`（直接回傳 spec，見 `wikilink/spec.tsx`）不同。
 * 掛進 `collab/schema.ts` 時要記得**呼叫它**：`mermaid: mermaidSpec()`。
 * 漏掉括號會得到一個型別看起來很像、執行期卻不是 block spec 的東西。
 */

/** 程式碼區塊的語言識別字。匯出與貼上兩端共用，避免兩處字面量漂移。 */
export const MERMAID_LANGUAGE = "mermaid";

/**
 * block 設定。**內容存在 `code` prop、不是 BlockNote 的 inline content**
 * （`content: "none"`）：圖的原始碼是一整段純文字，不該被拆成 inline nodes、
 * 也不該讓 BlockNote 對它套用行內樣式。
 */
export const mermaidBlockConfig = {
  type: MERMAID_LANGUAGE,
  content: "none",
  propSchema: {
    code: { default: "" },
  },
} as const;

/**
 * 匯出（複製到別的 app／`toExternalHTML`）：輸出 ```mermaid 的 code block，**不是畫好的 SVG**。
 *
 * 理由：① 貼到 GitHub／Obsidian 等支援 mermaid 的地方會自動畫出來，不支援的地方至少看得到
 * 原始碼且**可再編輯**；② SVG 又長又不可編輯；③ 順帶避開「匯出的 SVG 夾帶外部資源」這一整類
 * 問題——那正是 #43 對四個檔案類 block 套 `withGuardedExternalHTML` 的動機。
 *
 * `{code}` 作為 JSX 子節點會被 React 轉義，原始碼裡的 `<img …>` 之類只會是文字。
 */
export function MermaidExternalHTML({ code }: { code: string }): JSX.Element {
  return (
    <pre>
      <code className={`language-${MERMAID_LANGUAGE}`}>{code}</code>
    </pre>
  );
}

/**
 * ⚠ **這裡刻意沒有 `parse` 規則。** 曾經有一條（接管
 * `<pre><code class="language-mermaid">`），2026-08-28 審查實測證明它**永遠不會被呼叫**：
 * BlockNote 內建 codeBlock 的 `pre` 解析規則優先序更高，HTML 貼上路徑一律先變成
 * `codeBlock(language="mermaid")`。當時那條規則有 6 條測試全綠，但它們是直接呼叫匯出函式、
 * 完全不經過 BlockNote——典型的假綠。真正在做轉換的是 `collab/mermaid-paste.ts`（blocks 層），
 * HTML 與 markdown 兩條路徑都走它。要再加 `parse` 規則前，先寫一條
 * `editor.tryParseHTMLToBlocks(...)` 的測試證明它真的會被呼叫（`spec.test.tsx` 有一條反向釘）。
 */

/**
 * React 渲染層。`useTheme()` 在這裡讀而不是由外面傳——block 的 render 由 BlockNote 呼叫，
 * 沒有我們能插入 props 的縫；`ThemeProvider` 在 app 根層，這裡讀得到。
 */
type MermaidRenderProps = ReactCustomBlockRenderProps<typeof mermaidBlockConfig>;

/**
 * 寫回原始碼。**`updateBlock` 會拋**：共編時遠端把這個 block 刪掉，而本地正好開著原始碼，
 * Esc／失焦提交就會撞到 `Block with ID … not found`（審查實測）。例外從 React 事件 handler
 * 拋出去對使用者是「剛打的東西無聲消失」，所以這裡吞掉——block 都不在了，沒有地方可寫。
 * 同 `collab/mermaid-paste.ts` 對 `replaceBlocks` 的既有處理。
 */
export function commitCode(editor: MermaidRenderProps["editor"], block: MermaidRenderProps["block"], code: string): void {
  try {
    editor.updateBlock(block, { props: { code } });
  } catch {
    /* 這個 block 已經被遠端刪掉了 */
  }
}

function MermaidBlock({ block, editor }: MermaidRenderProps): JSX.Element {
  const { resolvedTheme } = useTheme();
  return (
    <MermaidView
      code={block.props.code}
      editable={editor.isEditable}
      theme={resolvedTheme}
      onChange={(code) => commitCode(editor, block, code)}
    />
  );
}

/** ⚠ 這是 **factory**，掛進 schema 時要呼叫：`mermaid: mermaidSpec()`。 */
export const mermaidSpec = createReactBlockSpec(mermaidBlockConfig, {
  render: MermaidBlock,
  toExternalHTML: ({ block }: MermaidRenderProps) => <MermaidExternalHTML code={block.props.code} />,
});
