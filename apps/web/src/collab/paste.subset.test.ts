import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasMarkdownStructure } from "./paste";

/**
 * 不變量測試：`hasMarkdownStructure` 必須是 BlockNote `isMarkdown` 的**子集**。
 *
 * 為什麼這條性質值得一個專門的檔案：`decideMarkdownPaste` 只在「剪貼簿同時有 HTML」
 * 時用這個門檻決定要不要把貼上從 HTML 路徑接過來。只要維持子集關係，接手就等於
 * 「與 BlockNote 相同的判斷，外加行尾正規化」——不可能把它原本會用 HTML 處理的內容
 * 拉走（那正是四輪審查裡反覆抓到的回歸：JSDoc 的 ` * ` 續行被當清單、超長 `#` 註解被
 * 當標題、psql 的 `-----|-----` 被當表格、shell 的 `1) ` 被當編號清單）。
 *
 * oracle 直接讀 `node_modules` 裡安裝的那份原始碼來執行——**刻意不把它複製進本專案**
 * （BlockNote 是 MPL-2.0，本專案 MIT）。升版後這個檔案若消失或形狀改變，這條測試會
 * 直接紅掉，那正是應該重新確認這條不變量的時機。
 */
function loadBlockNoteIsMarkdown(): (src: string) => boolean {
  const path = `${process.cwd()}/node_modules/@blocknote/core/src/api/parsers/markdown/detectMarkdown.ts`;
  const source = readFileSync(path, "utf8")
    .replace(/^export /gm, "")
    .replace(/\(src: string\): boolean =>/, "(src) =>");

  return new Function(`${source}\nreturn isMarkdown;`)() as (src: string) => boolean;
}

/** 前四輪審查用真剪貼簿量到的形狀，加上一般 markdown 文件。子集關係要對整組成立。 */
const CORPUS: Array<[string, string]> = [
  ["JSDoc 註解", "/**\n * Adds two numbers together.\n * @param {number} a - first\n */\nfunction add(a, b) {\n  return a + b;\n}"],
  ["C/Java 授權標頭", "/*\n * Copyright 2026 Someone.\n * Licensed under the Apache License.\n */"],
  ["超長 # 註解＋空行＋設定", "# This file configures the reverse proxy for the production cluster, see docs\n\nserver {\n  listen 80;\n}"],
  ["短 # 註解＋空行＋設定", "# proxy config\n\nserver {\n  listen 80;\n}"],
  ["# 註解緊接指令", "# install deps\nnpm install foo"],
  ["diff 新增側", "+ const a = 1;\n+ const b = 2;"],
  ["diff 兩側", "- old line\n+ new line"],
  ["shell case 分支", 'case "$1" in\n1) echo one ;;\n2) echo two ;;\nesac'],
  ["psql 輸出", "id    | name\n------|-------\n1     | foo"],
  ["ASCII 方框表格", "| a | b |\n|---|---|\n| 1 | 2 |"],
  ["heredoc 內含圍籬", "cat <<'EOF' > README.md\n```bash\nnpm run dev\n```\nEOF"],
  ["YAML 兩個序列項（2 空格縮排）", "services:\n  - name: web\n  - name: db"],
  ["YAML 深縮排序列項", 'ports:\n      - "80:80"\n      - "443:443"'],
  ["CLI --help 輸出", "options:\n  -v, --verbose\n  -q, --quiet"],
  ["# 橫線分隔", "# ------------------------------\n# section\n# ------------------------------"],
  ["SQL 註解橫線", "-- ------------------------\n-- table defs\n-- ------------------------"],
  ["ini 註解", "# database settings\n\n[db]\nhost = localhost"],
  ["Makefile 註解", "# build everything\n\nall:\n\tgo build ./..."],
  ["一般段落", "就是一段普通文字，沒有任何標記。"],
  ["只有行內標記", "這段有 **粗體** 和 `code` 還有 [連結](https://example.com)"],
  ["標題＋空行＋內容", "# 標題\n\n內文一段"],
  ["兩個 - 清單項", "- 一\n- 二"],
  ["兩個編號項", "1. 一\n2. 二"],
  ["成對圍籬", "```bash\nls\n```\n"],
  ["完整文件", "# 全域備忘\n\n## 環境\n\n- 一\n- 二\n\n```bash\nls\n```\n"],
  ["單一清單項", "- 只有一項"],
  ["單獨標題", "# 標題"],
  ["郵件引用", "> 引用一句\n> 第二句"],
  ["水平線", "Part one.\n\n---\n\nPart two."],
];

describe("hasMarkdownStructure ⊆ BlockNote isMarkdown", () => {
  const isMarkdown = loadBlockNoteIsMarkdown();

  it("oracle 本身載得起來且行為合理（防止空跑造成假綠）", () => {
    expect(isMarkdown("# 標題\n\n內文一段")).toBe(true);
    expect(isMarkdown("就是一段普通文字，沒有任何標記。")).toBe(false);
  });

  it.each(CORPUS)("%s：我們判斷為 markdown 時，BlockNote 也必須同意", (_name, source) => {
    if (hasMarkdownStructure(source)) {
      expect(isMarkdown(source)).toBe(true);
    }
  });

  /** 子集斷言在「我們一律回 false」時也會全綠——這條確保語料真的有踩到 true 分支。 */
  it("語料裡確實有數項通過我們的門檻（否則上面的子集斷言是空跑）", () => {
    const passing = CORPUS.filter(([, source]) => hasMarkdownStructure(source)).map(([name]) => name);

    expect(passing).toEqual(
      expect.arrayContaining(["標題＋空行＋內容", "兩個 - 清單項", "兩個編號項", "成對圍籬", "完整文件", "ASCII 方框表格"]),
    );
  });

  it("整組語料裡沒有任何一項違反子集關係", () => {
    const violations = CORPUS.filter(([, source]) => hasMarkdownStructure(source) && !isMarkdown(source)).map(([name]) => name);

    expect(violations).toEqual([]);
  });
});
