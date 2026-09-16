import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";
import { resolveTrailingMarkdownLink } from "./markdown-link";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
let editor: BlockNoteEditor<any, any, any>;
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
});

/** spec §2.10「必須觸發」8 案，逐字比對——不是「有 link 就好」。
 *
 * `# 標題裡的 [a](…)` 這一案：`text` 來自 `$from.parent`，**一般打字路徑到不了**這個
 * 形狀（`# ` 一打完空格就先被 heading input rule 吃掉，變成 heading block，真編輯器
 * 裡剩下的 textBefore 會是 `標題裡的 [a](…)`，不含 `# ` 前綴）。⚠ 但它**不是不可達**
 * ——`resolveTrailingMarkdownLink` 本身是純函式，不管字串怎麼來；用「先打
 * `x# 標題裡的 [a](https://x.com`、刪掉開頭的 `x`、再打 `)`」這類迂迴路徑一樣能讓
 * heading 規則來不及先吃掉 `# `，把這個形狀的 `textBefore` 真的餵給規則。實測行為
 * 正確（下表最後一案），所以列進來、不再宣稱它到不了。 */
describe("resolveTrailingMarkdownLink 必須觸發", () => {
  it.each([
    ["[a](https://x.com)", "a", "https://x.com", 18],
    ["[水星](https://zh.wikipedia.org/wiki/水星_(行星))", "水星", "https://zh.wikipedia.org/wiki/水星_(行星)", 43],
    ["[a [b] c](https://x.com)", "a [b] c", "https://x.com", 24],
    ["前面有字 [a](https://x.com)", "a", "https://x.com", 18],
    ["[a](https://x.com) 然後 [b](https://y.com)", "b", "https://y.com", 18],
    ["[寄信](mailto:me@example.com)", "寄信", "mailto:me@example.com", 27],
    ["[區域](/n/my-note)", "區域", "/n/my-note", 16],
    ["# 標題裡的 [a](https://x.com)", "a", "https://x.com", 18],
  ])("%s", (input, text, href, matchedLength) => {
    expect(resolveTrailingMarkdownLink(editor, input)).toEqual({ text, href, matchedLength });
  });
});

/** spec §2.10「必須不觸發」。前三案在補 null 防呆前會丟 TypeError（image 沒有 content
 * 欄位、空顯示文字的 paragraph content 是空陣列、table 的 content 是物件）——它們是
 * 「判準寫成正面條件」（spec D4）的證據，不是形式主義。 */
describe("resolveTrailingMarkdownLink 必須不觸發", () => {
  it.each([
    ["![a](https://x.com/i.png)"], // image block，無 content 欄位
    ["[](https://x.com)"], // paragraph，content 是空陣列
    ["<table><tr><td>[a](https://x.com)"], // table，content 是物件
    ["\\[a](https://x.com)"], // 反斜線跳脫：由構造擋掉，不靠黑名單
    ["![a](https://x.com/i.png) 後面還有 ![b](https://y.com/j.png)"],
    ["[水星](https://zh.wikipedia.org/wiki/水星_(行星)"], // 少一個右括號
    ['[a](https://x.com "標題")'],
    ["[a](<https://x.com>)"],
    ["[a](  https://x.com  )"],
    ["[*a*](https://x.com)"],
    ["[壞](javascript:alert(1))"],
    ["[文字]()"],
    ["前面有字但沒有連結)"],
  ])("%s", (input) => {
    expect(resolveTrailingMarkdownLink(editor, input)).toBeNull();
  });
});

/**
 * INV-3（code block／行內 code 內不套用）：這件事目前天然成立，靠的是「我們用
 * `addInputRules()` 而不是手寫 `editorProps.handleTextInput`」（D5——tiptap 的
 * `inputRulesPlugin` 自帶 code 跳過，四條入口全經過，見 spec §2.5）。這裡守的是
 * 一條**結構性**事實：本檔用了 `addInputRules`，且不含 `handleTextInput` 的掛載形。
 *
 * ⚠ 判準不能寫成「不得出現 `handleTextInput` 這個字串」——Step 7 的 handler 註解
 * 逐字含它（在解釋偏移量為什麼隨入口而異），那樣寫對自己的成品就必紅。定案用
 * `/handleTextInput\s*[:(]/`：只命中「掛載形」（物件屬性 `handleTextInput:` 或函式呼叫
 * `handleTextInput(`），不命中反引號包住的散文引用。
 */
describe("INV-3 結構守衛：本檔用 addInputRules 而不是手寫 handleTextInput", () => {
  // `import.meta.url` 在 vitest 的轉換環境下不保證是 file: scheme（實測會炸
  // "The URL must be of scheme file"），改用 `process.cwd()` 組路徑——同檔案
  // `paste.subset.test.ts` 讀 node_modules 原始碼用的就是這個既有慣例。
  const source = readFileSync(`${process.cwd()}/src/collab/markdown-link.ts`, "utf8");

  it("含 addInputRules() 註冊", () => {
    expect(source).toMatch(/addInputRules\s*\(\s*\)\s*\{/);
  });

  it("不含 handleTextInput 的掛載形（散文引用可以有，掛載形不行）", () => {
    expect(source).not.toMatch(/handleTextInput\s*[:(]/);
  });
});
