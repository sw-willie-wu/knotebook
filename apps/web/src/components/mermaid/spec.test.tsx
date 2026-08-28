import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MERMAID_LANGUAGE, MermaidExternalHTML, mermaidBlockConfig, parseMermaidElement } from "./spec";

/** 把一段 HTML 字串變成第一個元素，模擬 BlockNote 餵給 `parse` 的東西。 */
function el(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.firstElementChild as HTMLElement;
}

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

describe("parseMermaidElement — 貼上（HTML 路徑）", () => {
  it("認得 <pre><code class=\"language-mermaid\">", () => {
    expect(parseMermaidElement(el('<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>'))).toEqual({
      code: "graph TD; A-->B;",
    });
  });

  it("class 含多個值時仍認得", () => {
    expect(parseMermaidElement(el('<pre><code class="hljs language-mermaid">flowchart LR; X-->Y;</code></pre>'))).toEqual({
      code: "flowchart LR; X-->Y;",
    });
  });

  it("其他語言的 code block 一律不接管", () => {
    expect(parseMermaidElement(el('<pre><code class="language-ts">const a = 1;</code></pre>'))).toBeUndefined();
    expect(parseMermaidElement(el("<pre><code>plain</code></pre>"))).toBeUndefined();
  });

  it("不是 pre>code 的東西不接管", () => {
    expect(parseMermaidElement(el('<div class="language-mermaid">graph TD;</div>'))).toBeUndefined();
    expect(parseMermaidElement(el("<p>graph TD; A-->B;</p>"))).toBeUndefined();
  });

  it("保留原始碼的換行與縮排（圖的語法對縮排敏感）", () => {
    const source = "graph TD;\n  A-->B;\n  B-->C;";
    const node = el('<pre><code class="language-mermaid"></code></pre>');
    node.querySelector("code")!.textContent = source;
    expect(parseMermaidElement(node)).toEqual({ code: source });
  });

  it("只有空白的 mermaid code block 不接管（避免把空 code block 變成空圖）", () => {
    expect(parseMermaidElement(el('<pre><code class="language-mermaid">   \n  </code></pre>'))).toBeUndefined();
  });
});
