import type { CodeBlockOptions } from "@blocknote/core";

/**
 * 程式碼區塊語法上色（issue #96）：shiki 接進 BlockNote 的 `createCodeBlockSpec`。
 *
 * **刻意不用官方的 `@blocknote/code-block`**——那個包是 MPL-2.0（本 repo 是 MIT，
 * 比照 #106 拒用 `@blocknote/server-util` 的同一判準），還會多拖 `@blocknote/react`
 * 與 precompiled grammars；而 `createCodeBlockSpec({ createHighlighter })` 收的就是
 * 任何 shiki highlighter，直接用 shiki 本體（MIT）零損失。
 *
 * **深淺主題的機制**：BlockNote 的 highlight plugin 走 `prosemirror-highlight`，
 * 而那個 parser **寫死用 `getLoadedThemes()[0]`**（不帶 options 呼叫
 * `createParser`）——「載兩個 theme 依主題切換」這條路不存在。所以這裡只載一個
 * `createCssVariablesTheme`：token 顏色全部輸出成 `var(--code-…)`，實際色值定義在
 * `index.css` 的 `:root`／`.dark` 兩塊，跟著 `resolvedTheme` 即時切換，且與六色
 * accent 完全脫鉤（issue 的兩條設計限制）。變數清單見 `index.css` 的 code 區塊註解。
 */

/**
 * 語言下拉與 ``` 圍欄 input rule 的支援清單。key 必須是 shiki bundle 的語言 id——
 * `highlighter.loadLanguage()` 對 bundle 外的 id 是 **throw**（不是靜默跳過），而
 * BlockNote 是在游標進入 code block 時才 lazy 載入，打錯字的症狀是「執行期 console
 * 一條 unhandled rejection、上色靜默失效」。`code-highlight.test.ts` 逐 key 真載一次
 * 把這種錯收斂成測試紅。
 *
 * 挑選原則：常用語言 ＋ 每個 grammar 都是獨立 lazy chunk（Vite 對 shiki 的動態
 * import 自動 code-split），多列不影響 entry 體積，但別列到「沒人會在筆記裡貼」的
 * 長尾。`text` 是刻意的第一項：BlockNote 對 `text` 跳過上色，是純文字的退路。
 */
export const SUPPORTED_LANGUAGES: NonNullable<CodeBlockOptions["supportedLanguages"]> = {
  text: { name: "Plain text", aliases: ["txt", "plaintext"] },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  javascript: { name: "JavaScript", aliases: ["js", "mjs", "cjs"] },
  tsx: { name: "TSX" },
  jsx: { name: "JSX" },
  python: { name: "Python", aliases: ["py"] },
  java: { name: "Java" },
  c: { name: "C" },
  cpp: { name: "C++", aliases: ["c++"] },
  csharp: { name: "C#", aliases: ["cs", "c#"] },
  go: { name: "Go", aliases: ["golang"] },
  rust: { name: "Rust", aliases: ["rs"] },
  bash: { name: "Shell", aliases: ["sh", "shell", "zsh"] },
  sql: { name: "SQL" },
  json: { name: "JSON" },
  yaml: { name: "YAML", aliases: ["yml"] },
  toml: { name: "TOML" },
  html: { name: "HTML" },
  css: { name: "CSS" },
  xml: { name: "XML" },
  markdown: { name: "Markdown", aliases: ["md"] },
  docker: { name: "Dockerfile", aliases: ["dockerfile"] },
  diff: { name: "Diff" },
};

/**
 * BlockNote 首次渲染 code block 時才會呼叫（highlight plugin 內部 lazy），所以
 * shiki 本體與 grammar 都不進 entry——比照 `lib/mermaid.ts` 的動態載入模式，
 * `scripts/check-bundle-size.mjs` 的 entry 上限守著這件事。
 *
 * `langs: []` 起步：個別 grammar 由 plugin 對 `loadLanguage()` 的呼叫按需載入。
 * JS regex engine（不是預設的 oniguruma）省掉 WASM 那顆 chunk；本清單的語言全數
 * 相容（`code-highlight.test.ts` 逐一載過）。
 */
export async function createHighlighter() {
  const [{ createHighlighter: create, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki"),
    import("shiki/engine/javascript"),
  ]);
  const theme = createCssVariablesTheme({
    name: "knotebook-code",
    variablePrefix: "--code-",
    // fontStyle: comment 的斜體之類由 theme 的 fontStyle 規則帶出，不影響顏色變數。
    fontStyle: true,
  });
  return create({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() });
}

/** `collab/schema.ts` 的 `createCodeBlockSpec` 唯一應該吃的選項物件。 */
export const CODE_BLOCK_OPTIONS: CodeBlockOptions = {
  defaultLanguage: "text",
  supportedLanguages: SUPPORTED_LANGUAGES,
  createHighlighter,
};
