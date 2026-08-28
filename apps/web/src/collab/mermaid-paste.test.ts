import { describe, expect, it, vi } from "vitest";
import { collectBlockIds, convertPastedMermaidBlocks, findPastedMermaidCodeBlocks } from "./mermaid-paste";

/** 測試用的 block 形狀（只含本模組會讀的欄位）。 */
interface TestBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: TestBlock[];
}

function codeBlock(id: string, language: string, text: string, children: TestBlock[] = []): TestBlock {
  return { id, type: "codeBlock", props: { language }, content: [{ type: "text", text }], children };
}
function paragraph(id: string, children: TestBlock[] = []): TestBlock {
  return { id, type: "paragraph", props: {}, content: [{ type: "text", text: "hi" }], children };
}

describe("collectBlockIds", () => {
  it("含巢狀 children", () => {
    const doc = [paragraph("a", [paragraph("a1"), codeBlock("a2", "ts", "x")]), paragraph("b")];
    expect(collectBlockIds(doc)).toEqual(new Set(["a", "a1", "a2", "b"]));
  });

  it("空文件回空集合", () => {
    expect(collectBlockIds([])).toEqual(new Set());
  });
});

describe("findPastedMermaidCodeBlocks", () => {
  it("只挑**新插入**且 language 為 mermaid 的 code block", () => {
    const before = new Set(["old"]);
    const doc = [codeBlock("old", "mermaid", "graph TD; A-->B;"), codeBlock("new", "mermaid", "graph LR; X-->Y;")];
    expect(findPastedMermaidCodeBlocks(doc, before)).toEqual([{ id: "new", code: "graph LR; X-->Y;" }]);
  });

  it("⚠ 既有的 mermaid code block 不得被動到", () => {
    // 這是這個模組最重要的不變量：使用者可能刻意把一張圖「轉回程式碼」保留著，
    // 之後在別處貼上時**不該**把它again 轉成圖。所以判定必須以「這次新插入的」為界，
    // 不能掃全文。
    const doc = [codeBlock("kept-as-code", "mermaid", "graph TD; A-->B;")];
    expect(findPastedMermaidCodeBlocks(doc, collectBlockIds(doc))).toEqual([]);
  });

  it("其他語言的 code block 不動", () => {
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "ts", "const a = 1;")], new Set())).toEqual([]);
  });

  it("language 未設定的 code block 不動", () => {
    const block = { id: "n", type: "codeBlock", props: {}, content: [{ type: "text", text: "x" }], children: [] };
    expect(findPastedMermaidCodeBlocks([block], new Set())).toEqual([]);
  });

  it("內容為空白的 mermaid code block 不動（不製造空圖）", () => {
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "mermaid", "  \n ")], new Set())).toEqual([]);
  });

  it("巢狀 children 內的也找得到", () => {
    const doc = [paragraph("p", [codeBlock("deep", "mermaid", "graph TD; A-->B;")])];
    expect(findPastedMermaidCodeBlocks(doc, new Set())).toEqual([{ id: "deep", code: "graph TD; A-->B;" }]);
  });

  it("保留原始碼的換行與縮排", () => {
    const source = "graph TD\n  A-->B\n  B-->C";
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "mermaid", source)], new Set())).toEqual([
      { id: "n", code: source },
    ]);
  });
});

describe("convertPastedMermaidBlocks", () => {
  it("把找到的 code block 換成 mermaid block", () => {
    const replaceBlocks = vi.fn();
    const doc = [codeBlock("new", "mermaid", "graph TD; A-->B;")];
    const count = convertPastedMermaidBlocks({ document: doc, replaceBlocks }, new Set());
    expect(count).toBe(1);
    expect(replaceBlocks).toHaveBeenCalledWith(["new"], [{ type: "mermaid", props: { code: "graph TD; A-->B;" } }]);
  });

  it("沒有可轉的就完全不碰編輯器", () => {
    const replaceBlocks = vi.fn();
    expect(convertPastedMermaidBlocks({ document: [paragraph("p")], replaceBlocks }, new Set())).toBe(0);
    expect(replaceBlocks).not.toHaveBeenCalled();
  });

  it("⚠ replaceBlocks 拋錯不外傳（貼上已經完成，不能因為轉換失敗而讓整個貼上看起來壞掉）", () => {
    const replaceBlocks = vi.fn(() => {
      throw new Error("boom");
    });
    const doc = [codeBlock("new", "mermaid", "graph TD; A-->B;")];
    expect(() => convertPastedMermaidBlocks({ document: doc, replaceBlocks }, new Set())).not.toThrow();
  });

  it("多個一起轉，且逐一替換（一個失敗不影響其他）", () => {
    const replaceBlocks = vi.fn().mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const doc = [codeBlock("a", "mermaid", "graph TD; A-->B;"), codeBlock("b", "mermaid", "graph LR; X-->Y;")];
    convertPastedMermaidBlocks({ document: doc, replaceBlocks }, new Set());
    expect(replaceBlocks).toHaveBeenCalledTimes(2);
  });
});
