import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 來源層守衛：web 原始碼裡我們發動的移除／取代一律走 `collab/columns/keep-columns.ts`。
 * core 的 `removeBlocks`／`replaceBlocks` 會收欄、把剩一欄的列攤平；改回它們時 jsdom 測試只在有欄的案才會紅，
 * 新增的呼叫點根本沒有那種案——所以靠讀原始碼擋。
 *
 * 掃描語意：`src` 下所有 `.ts`／`.tsx`，排除 `*.test.*` 與任何 `test/` 目錄（測試可以直接用 core 方法建內容），
 * 只放行 `collab/columns/keep-columns.ts` 一個檔。比對的是字面 `.removeBlocks(`／`.replaceBlocks(`，註解裡寫出來也算。
 * 守不到的：解構（`const { removeBlocks } = editor`）或 `editor["removeBlocks"](…)` 這類寫法；只比對單行字面，
 * 斷行或加空白的寫法（`.removeBlocks` 與 `(` 分在兩行、`.removeBlocks (`）也守不到。
 */

const root = `${process.cwd()}/src`;
const ALLOWED = new Set(["collab/columns/keep-columns.ts"]);

function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "test") continue;
      out.push(...sourceFiles(`${dir}/${entry.name}`, path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const scanned = sourceFiles(root).filter((path) => !ALLOWED.has(path));

describe("來源層守衛：移除／取代走 keep-columns", () => {
  it("G1：除 keep-columns.ts 外，web 原始碼不含 `.removeBlocks(`／`.replaceBlocks(`", () => {
    const hits = scanned.flatMap((path) => {
      const lines = readFileSync(`${root}/${path}`, "utf8").split(/\r?\n/);
      return lines.flatMap((line, i) => (line.includes(".removeBlocks(") || line.includes(".replaceBlocks(") ? [`${path}:${i + 1}: ${line.trim()}`] : []));
    });
    expect(hits).toEqual([]);
  });

  it("G1b：關鍵檔都在掃描範圍內（放行清單沒有吃掉它們）", () => {
    for (const path of [
      "ai/apply.ts",
      "collab/mermaid-paste.ts",
      "collab/paste.ts",
      "uploads/upload-file.ts",
      "components/ai/AiToolbar.tsx",
      "components/editor/KnotebookFileDeleteButton.tsx",
      "components/editor/KnotebookSideMenu.tsx",
    ]) {
      expect(scanned).toContain(path);
    }
  });

  it("G2：側選單不再用 core 的刪除項", () => {
    const source = readFileSync(`${root}/components/editor/KnotebookSideMenu.tsx`, "utf8");
    expect(source.match(/(?<![A-Za-z])RemoveBlockItem\b/g) ?? []).toHaveLength(0);
  });

  it("G3：掃到的檔數 > 50（防掃空）", () => {
    expect(scanned.length).toBeGreaterThan(50);
  });
});
