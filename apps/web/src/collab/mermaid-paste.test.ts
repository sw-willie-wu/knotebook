import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CB, P, mountEditor, row, shape, type AnyEditor } from "@/test/columns-fixtures";
import { replaceBlocksKeepColumns } from "./columns/keep-columns";
import { collectBlockIds, convertPastedMermaidBlocks, findPastedMermaidCodeBlocks } from "./mermaid-paste";

// Wrapped in a spy that calls through to the real implementation; not automock, which would turn the real-editor conversion into a no-op.
vi.mock("./columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("./columns/keep-columns")>();
  return { ...m, replaceBlocksKeepColumns: vi.fn(m.replaceBlocksKeepColumns) };
});
beforeEach(() => {
  vi.mocked(replaceBlocksKeepColumns).mockReset(); // Not an arrow returning it: a function returned from beforeEach runs as teardown; mockReset also clears the mockImplementationOnce queue and restores the wrapped original
});

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
  it("includes nested children", () => {
    const doc = [paragraph("a", [paragraph("a1"), codeBlock("a2", "ts", "x")]), paragraph("b")];
    expect(collectBlockIds(doc)).toEqual(new Set(["a", "a1", "a2", "b"]));
  });

  it("empty document gives an empty set", () => {
    expect(collectBlockIds([])).toEqual(new Set());
  });
});

describe("findPastedMermaidCodeBlocks", () => {
  it("picks only code blocks that are **newly inserted** and have language mermaid", () => {
    const before = new Set(["old"]);
    const doc = [codeBlock("old", "mermaid", "graph TD; A-->B;"), codeBlock("new", "mermaid", "graph LR; X-->Y;")];
    expect(findPastedMermaidCodeBlocks(doc, before)).toEqual([{ id: "new", code: "graph LR; X-->Y;" }]);
  });

  it("an existing mermaid code block must not be touched", () => {
    // The module's key invariant: a user may deliberately turn a diagram back into code and keep it, and pasting elsewhere later must not convert it into a diagram again. So the decision is bounded by "newly inserted this time" and can't scan the whole document.
    const doc = [codeBlock("kept-as-code", "mermaid", "graph TD; A-->B;")];
    expect(findPastedMermaidCodeBlocks(doc, collectBlockIds(doc))).toEqual([]);
  });

  it("code blocks of other languages are untouched", () => {
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "ts", "const a = 1;")], new Set())).toEqual([]);
  });

  it("code blocks with no language set are untouched", () => {
    const block = { id: "n", type: "codeBlock", props: {}, content: [{ type: "text", text: "x" }], children: [] };
    expect(findPastedMermaidCodeBlocks([block], new Set())).toEqual([]);
  });

  it("a mermaid code block with blank content is untouched (no empty diagram is made)", () => {
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "mermaid", "  \n ")], new Set())).toEqual([]);
  });

  it("ones inside nested children are found too", () => {
    const doc = [paragraph("p", [codeBlock("deep", "mermaid", "graph TD; A-->B;")])];
    expect(findPastedMermaidCodeBlocks(doc, new Set())).toEqual([{ id: "deep", code: "graph TD; A-->B;" }]);
  });

  it("matches mermaid language case-insensitively (#590)", () => {
    const doc = [
      codeBlock("a", "Mermaid", "graph TD; A-->B;"),
      codeBlock("b", "MERMAID", "graph LR; X-->Y;"),
    ];
    expect(findPastedMermaidCodeBlocks(doc, new Set())).toEqual([
      { id: "b", code: "graph LR; X-->Y;" },
      { id: "a", code: "graph TD; A-->B;" },
    ]);
  });

  it("keeps the source's line breaks and indentation", () => {
    const source = "graph TD\n  A-->B\n  B-->C";
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "mermaid", source)], new Set())).toEqual([
      { id: "n", code: source },
    ]);
  });
});

describe("convertPastedMermaidBlocks", () => {
  // The fake editor's `transact` doesn't run the callback: the helper calls through to the real implementation but doesn't touch the document; assertions are made on the helper's spy.
  it("replaces the found code blocks with mermaid blocks", () => {
    const doc = [codeBlock("new", "mermaid", "graph TD; A-->B;")];
    const editor = { document: doc, transact: vi.fn() };
    const count = convertPastedMermaidBlocks(editor, new Set());
    expect(count).toBe(1);
    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["new"], [{ type: "mermaid", props: { code: "graph TD; A-->B;" } }]);
  });

  it("with nothing to convert the editor isn't touched at all", () => {
    const editor = { document: [paragraph("p")], transact: vi.fn() };
    expect(convertPastedMermaidBlocks(editor, new Set())).toBe(0);
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("an error thrown by the replacement doesn't propagate (the paste has already completed, and a failed conversion mustn't make the whole paste look broken)", () => {
    vi.mocked(replaceBlocksKeepColumns).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const doc = [codeBlock("new", "mermaid", "graph TD; A-->B;")];
    expect(() => convertPastedMermaidBlocks({ document: doc, transact: vi.fn() }, new Set())).not.toThrow();
  });

  it("several are converted together, replaced one by one (one failure doesn't affect the others)", () => {
    vi.mocked(replaceBlocksKeepColumns).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const doc = [codeBlock("a", "mermaid", "graph TD; A-->B;"), codeBlock("b", "mermaid", "graph LR; X-->Y;")];
    convertPastedMermaidBlocks({ document: doc, transact: vi.fn() }, new Set());
    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledTimes(2);
  });

  describe("real editor", () => {
    let destroy: (() => void) | undefined;
    afterEach(() => destroy?.());

    // The other column in the row is empty: core's fixColumnList deletes all empty columns and flattens a row left with one column; removals triggered by code don't take that path.
    it("the only block in a column is a ```mermaid codeBlock -> converted to mermaid, the row still has two columns", () => {
      const m = mountEditor([
        P("x", "x"),
        row([[{ ...CB("m", "graph TD; A-->B;"), props: { language: "mermaid" } }], [P("", "e")]], "r"),
        P("z", "z"),
      ]);
      destroy = m.destroy;
      const editor: AnyEditor = m.editor;
      expect(convertPastedMermaidBlocks(editor, new Set(["x", "r", "rc0", "rc1", "e", "z"]))).toBe(1);
      expect(shape(editor)).toBe("paragraph:x  ROW[COL(mermaid) | COL(paragraph)]  paragraph:z");
    });
  });
});
