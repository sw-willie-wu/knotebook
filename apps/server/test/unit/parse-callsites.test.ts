/**
 * #398 結構守衛：伺服器的 markdown 寫入解析一律經 `EditingRuntime.parser`（生產＝worker pool）。`src/` 裡**提到**（import、別名 import、
 * 命名空間取用、呼叫——去掉註解後只要出現這個名字就算）`parseMarkdownForNote`、`trailingOpenFenceLine`、`tryParseHTMLToBlocks` 的，
 * 只能是定義它的檔與解析核心——新的寫入路徑若在主執行緒自己解析，這裡會紅（原本只找呼叫，`import { x as y }` 抓不到）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
/** 去掉註解（`//` 行尾與 `/* … *\/`）後，出現這個名字的檔。 */
const mentioning = (name: string) => {
  const re = new RegExp(`\\b${name}\\b`);
  return files(src)
    .filter(f => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
    .map(f => path.relative(src, f).replaceAll("\\", "/"))
    .sort();
};

describe("解析的取用點（#398）", () => {
  it("parseMarkdownForNote 只出現在定義它的 markdown.ts 與 parse-core.ts", () => {
    expect(mentioning("parseMarkdownForNote")).toEqual(["notes/editing/markdown.ts", "notes/editing/parse-core.ts"]);
  });
  it("trailingOpenFenceLine（批次寫回的未閉合 fence 判斷：整檔 markdownToHTML，`*a ` 重複 256 KiB 約 64 秒）只出現在 transfer/regions.ts（定義）與 parse-core.ts", () => {
    expect(mentioning("trailingOpenFenceLine")).toEqual(["notes/editing/parse-core.ts", "transfer/regions.ts"]);
  });
  it("tryParseHTMLToBlocks 只出現在 markdown.ts（parseMarkdownForNote 裡）", () => {
    expect(mentioning("tryParseHTMLToBlocks")).toEqual(["notes/editing/markdown.ts"]);
  });
});

/**
 * 讀出與套用的轉換搬出主執行緒之後（`doc-jobs.ts`）：Y 文件 ⇄ BlockNote／markdown 的轉換函式只能經 `executeDocOp` 呼叫（worker 裡，或
 * `EditingRuntime.runDoc` 判定很小時在主執行緒）。新的路徑若在主執行緒自己轉換，這裡會紅。例外（known-limitations 有寫）：套用版本
 * （`apply-version.ts` 經 `apply.ts` 的 `prepareEdit` → `editOnFork`）與升級後一次性的連結轉換（`link-conversion.ts` 自己 mount）。
 */
describe("轉換的取用點（讀出與套用搬出主執行緒）", () => {
  it("readNoteContentFromDoc：定義的 read.ts 與 doc-jobs.ts", () => {
    expect(mentioning("readNoteContentFromDoc")).toEqual(["notes/editing/doc-jobs.ts", "notes/editing/read.ts"]);
  });
  it("exportNoteForTransfer／exportNoteBody：定義的 export-note.ts 與 doc-jobs.ts", () => {
    expect(mentioning("exportNoteForTransfer")).toEqual(["notes/editing/doc-jobs.ts", "transfer/export-note.ts"]);
    expect(mentioning("exportNoteBody")).toEqual(["notes/editing/doc-jobs.ts", "transfer/export-note.ts"]);
  });
  it("planSync／applySync：定義的檔與 doc-jobs.ts", () => {
    expect(mentioning("planSync")).toEqual(["notes/editing/doc-jobs.ts", "transfer/sync-plan.ts"]);
    expect(mentioning("applySync")).toEqual(["notes/editing/doc-jobs.ts", "transfer/sync-apply.ts"]);
  });
  it("prepareRevertOnFork：定義的 revert-core.ts 與 doc-jobs.ts；editOnFork：doc-jobs.ts 與套用版本用的 apply.ts（prepareEdit）", () => {
    expect(mentioning("prepareRevertOnFork")).toEqual(["notes/editing/doc-jobs.ts", "notes/editing/revert-core.ts"]);
    expect(mentioning("editOnFork")).toEqual(["notes/editing/apply.ts", "notes/editing/doc-jobs.ts"]);
    expect(mentioning("prepareEdit")).toEqual(["notes/editing/apply-version.ts", "notes/editing/apply.ts"]);
  });
  it("EditorSession.open（mount）：doc-jobs.ts 呼叫的那幾支，加上連結轉換", () => {
    const re = /EditorSession\.open\(/;
    const hits = files(src)
      .filter(f => re.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
      .map(f => path.relative(src, f).replaceAll("\\", "/"))
      .sort();
    expect(hits).toEqual(["notes/editing/doc-jobs.ts", "notes/editing/read.ts", "notes/editing/revert-core.ts", "notes/link-conversion.ts", "transfer/export-note.ts", "transfer/sync-apply.ts", "transfer/sync-plan.ts"]);
  });
});
