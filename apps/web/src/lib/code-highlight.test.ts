import { describe, expect, it } from "vitest";
import { getLanguageId } from "@blocknote/core";
import type { BundledLanguage } from "shiki";
import { CODE_BLOCK_OPTIONS, SUPPORTED_LANGUAGES, createHighlighter } from "./code-highlight";

/**
 * issue #96：程式碼區塊語法上色的核心契約。
 *
 * 這裡的斷言全部打在**真的 shiki** 上（不是 mock）——這族最大的風險不是我們的邏輯，
 * 而是「清單裡列了 shiki 載不動的東西」：`loadLanguage()` 對不在 bundle 裡的語言
 * 是 **throw**（實測 `ShikiError: Language \`x\` is not included in this bundle`），
 * 而 BlockNote 的 highlight plugin 是在使用者把游標放進 code block 時才 lazy 呼叫它，
 * 炸的時候只會是 console 裡一條 unhandled rejection、上色靜默失效。清單的每一個
 * key 在這裡先載一次，就把那種「執行期才知道」收斂成測試紅。
 */

// highlighter 建立一次全檔共用：每個 it 各建一顆要多花數百 ms，而 highlighter 本身
// 無狀態累積（loadLanguage 只增不減），共用不影響各測試的獨立性。
let highlighterPromise: ReturnType<typeof createHighlighter> | undefined;
function sharedHighlighter() {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}

describe("createHighlighter（css-variables theme）", () => {
  it("只載一個 theme——prosemirror-highlight 的 parser 寫死用 getLoadedThemes()[0]，多載一個且順序不對就靜默換色", async () => {
    const hl = await sharedHighlighter();
    expect(hl.getLoadedThemes()).toHaveLength(1);
  });

  it("上色輸出的顏色是 CSS 變數（var(--code-…)），不是寫死的色值——深淺切換靠 index.css 換變數值", async () => {
    const hl = await sharedHighlighter();
    await hl.loadLanguage("typescript");
    const { fg, bg, tokens } = hl.codeToTokens('const x = "hi"; // note', {
      lang: "typescript",
      theme: hl.getLoadedThemes()[0]!,
    });
    expect(fg).toBe("var(--code-foreground)");
    expect(bg).toBe("var(--code-background)");
    const colors = tokens.flat().map((t) => t.color);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color).toMatch(/^var\(--code-/);
    // 至少要真的分出語意（關鍵字≠字串），不能整行同色——那等於沒上色。
    expect(new Set(colors).size).toBeGreaterThan(1);
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("每個非純文字語言都真的載得動（loadLanguage 對 bundle 外的語言是 throw，清單打錯字＝執行期靜默失效）", async () => {
    const hl = await sharedHighlighter();
    for (const key of Object.keys(SUPPORTED_LANGUAGES)) {
      if (key === "text") continue;
      // cast 是斷言的一部分：清單 key **宣稱**自己是 bundled 語言 id，載不動就在這裡紅。
      await expect(hl.loadLanguage(key as BundledLanguage), `語言 ${key} 載入失敗`).resolves.not.toThrow();
    }
  });

  it("text（純文字）在清單裡且是預設語言——BlockNote 對 text 跳過上色，這是使用者的退路", () => {
    expect(SUPPORTED_LANGUAGES.text).toBeDefined();
    expect(CODE_BLOCK_OPTIONS.defaultLanguage).toBe("text");
  });

  it("常用別名映射到正確語言（``` 圍欄與語言下拉都吃這條）", () => {
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "py")).toBe("python");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "ts")).toBe("typescript");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "js")).toBe("javascript");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "sh")).toBe("bash");
    expect(getLanguageId(CODE_BLOCK_OPTIONS, "yml")).toBe("yaml");
  });

  // issue #111：語言下拉是**固定寬度**的（`index.css` 的 `width: 6rem`）——原生 select
  // 的寬度跟著目前選到的標籤走，不定死的話同一顆控制項會在 `C` 與 `Markdown` 之間
  // 縮放，換語言位置就跳。那個 6rem 是 headed 瀏覽器**量出來的**（目前最寬的標籤
  // `Markdown` 連內距與箭頭共 85.6px），不是算出來的：字寬由字型決定，字數不是好指標
  // （`TypeScript` 10 字反而比 `Markdown` 8 字窄）。
  //
  // 所以這條守的不是「寬度夠不夠」（jsdom 量不到文字），而是**量測的前提還在不在**：
  // 清單長出比當時更長的標籤時要紅，提醒重量一次再決定要不要加寬。
  const MEASURED_LONGEST_LABEL_CHARS = 10; // "Plain text" / "TypeScript" / "JavaScript" / "Dockerfile"

  it("issue #111：語言標籤沒有長過當初量固定寬度時的長度（長了就要重量一次）", () => {
    const longest = Object.values(SUPPORTED_LANGUAGES)
      .map((lang) => lang.name)
      .reduce((a, b) => (b.length > a.length ? b : a));
    expect(
      longest.length,
      `「${longest}」比當初量 index.css 那個固定寬度時的最長標籤還長——請在 headed 瀏覽器重量一次，` +
        `必要時同步調整 index.css 的 width 與這個常數`,
    ).toBeLessThanOrEqual(MEASURED_LONGEST_LABEL_CHARS);
  });

  it("CODE_BLOCK_OPTIONS 把三件事接在一起：語言清單、預設語言、createHighlighter", () => {
    expect(CODE_BLOCK_OPTIONS.supportedLanguages).toBe(SUPPORTED_LANGUAGES);
    expect(CODE_BLOCK_OPTIONS.createHighlighter).toBe(createHighlighter);
  });
});
