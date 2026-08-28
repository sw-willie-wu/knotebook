import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { MERMAID_LANGUAGE, MermaidExternalHTML, mermaidBlockConfig } from "./spec";

describe("mermaidBlockConfig", () => {
  it("type 與 content 形狀固定（schema 掛載端依賴這兩個值）", () => {
    expect(mermaidBlockConfig.type).toBe("mermaid");
    // content:"none" ⇒ 這個 block 沒有 BlockNote 管理的 inline content，
    // 原始碼整份存在 `code` prop 裡。改成 "inline" 會讓既有文件的內容全部讀不到。
    expect(mermaidBlockConfig.content).toBe("none");
  });

  it("code prop 預設為空字串（/mermaid 建立的空 block 走這條）", () => {
    expect(mermaidBlockConfig.propSchema.code.default).toBe("");
  });
});

describe("MermaidExternalHTML — 匯出", () => {
  it("輸出 ```mermaid 的 code block 形狀，而不是 SVG", () => {
    // 貼到 GitHub／Obsidian 等支援 mermaid 的地方會自動畫出來；不支援的地方至少看得到原始碼。
    // 選原始碼而非 SVG 也順帶避開「匯出的 SVG 夾帶外部資源」這一整類問題（比照 #43 的守衛動機）。
    const { container } = render(<MermaidExternalHTML code="graph TD; A-->B;" />);
    const code = container.querySelector("pre > code");
    expect(code).not.toBeNull();
    expect(code?.getAttribute("class")).toBe(`language-${MERMAID_LANGUAGE}`);
    expect(code?.textContent).toBe("graph TD; A-->B;");
  });

  it("原始碼裡的 HTML 以文字輸出，不成為真的節點", () => {
    const { container } = render(<MermaidExternalHTML code={'graph TD; A["<img src=x onerror=1>"]-->B;'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre > code")?.textContent).toContain("<img src=x onerror=1>");
  });

  it("空原始碼也輸出合法結構（不產生半截 HTML）", () => {
    const { container } = render(<MermaidExternalHTML code="" />);
    expect(container.querySelector("pre > code")).not.toBeNull();
  });
});

describe("貼上（HTML 路徑）真正的落點", () => {
  it("⚠ <pre><code class=\"language-mermaid\"> 經 BlockNote 解析後是 codeBlock，不是 mermaid block", async () => {
    // 這條釘的是「為什麼這支 spec 沒有 `parse` 規則」：BlockNote 內建 codeBlock 的 `pre` 規則
    // 優先序更高，自訂 `parse` 永遠不會被呼叫（2026-08-28 審查實測）。HTML 與 markdown 兩條
    // 貼上路徑都先變成 codeBlock，再由 `collab/mermaid-paste.ts` 在 blocks 層轉成圖。
    // 哪天 BlockNote 改了優先序、這條轉紅，才是可以考慮加回 `parse` 規則的時候。
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const blocks = await editor.tryParseHTMLToBlocks('<pre><code class="language-mermaid">graph TD; A--&gt;B;</code></pre>');

    expect(blocks[0]?.type).toBe("codeBlock");
    expect((blocks[0] as { props: { language?: string } }).props.language).toBe(MERMAID_LANGUAGE);
  });
});
