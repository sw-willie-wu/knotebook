import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CB, P, mountEditor, row, shape, type AnyEditor } from "@/test/columns-fixtures";
import { replaceBlocksKeepColumns } from "./columns/keep-columns";
import { collectBlockIds, convertPastedMermaidBlocks, findPastedFenceBlocks } from "./mermaid-paste";

// Mermaid-only view of findPastedFenceBlocks, so the pre-existing mermaid cases below keep their original assertions.
const findPastedMermaidCodeBlocks = (document: Parameters<typeof findPastedFenceBlocks>[0], ids: Set<string>) =>
  findPastedFenceBlocks(document, ids)
    .filter((t) => t.block.type === "mermaid")
    .map((t) => ({ id: t.id, code: t.block.props.code! }));

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
    expect(findPastedFenceBlocks([codeBlock("n", "ts", "const a = 1;")], new Set())).toEqual([]);
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

  it("keeps the source's line breaks and indentation", () => {
    const source = "graph TD\n  A-->B\n  B-->C";
    expect(findPastedMermaidCodeBlocks([codeBlock("n", "mermaid", source)], new Set())).toEqual([
      { id: "n", code: source },
    ]);
  });
});

describe("convertPastedMermaidBlocks (mermaid)", () => {
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

describe("findPastedFenceBlocks", () => {
  it("a newly inserted math code block becomes a math target with the tex verbatim", () => {
    const tex = "\\frac{a_1}{b_1}\n  + x_2";
    expect(findPastedFenceBlocks([codeBlock("new", "math", tex)], new Set())).toEqual([{ id: "new", block: { type: "math", props: { tex } } }]);
  });

  it("a newly inserted mermaid code block becomes a mermaid target in the same scan", () => {
    const doc = [codeBlock("a", "mermaid", "graph TD; A-->B;"), codeBlock("b", "math", "x")];
    expect(findPastedFenceBlocks(doc, new Set()).map((t) => t.block.type).sort()).toEqual(["math", "mermaid"]);
  });

  it.each(["latex", "tex", "LaTeX", "Math", "mathematica"])("a newly inserted %s code block is left alone", (language) => {
    expect(findPastedFenceBlocks([codeBlock("n", language, "x")], new Set())).toEqual([]);
  });

  it("a math code block that existed before the paste is not converted (only the newly inserted ones are)", () => {
    const doc = [codeBlock("kept-as-code", "math", "x^2"), codeBlock("new", "math", "y^2")];
    expect(findPastedFenceBlocks(doc, new Set(["kept-as-code"]))).toEqual([{ id: "new", block: { type: "math", props: { tex: "y^2" } } }]);
  });

  it("a math code block with blank content is untouched", () => {
    expect(findPastedFenceBlocks([codeBlock("n", "math", " \n ")], new Set())).toEqual([]);
  });

  it("a math code block nested in children is found", () => {
    expect(findPastedFenceBlocks([paragraph("p", [codeBlock("deep", "math", "x")])], new Set())).toEqual([
      { id: "deep", block: { type: "math", props: { tex: "x" } } },
    ]);
  });
});

describe("convertPastedMermaidBlocks", () => {
  it("replaces a pasted math code block with a math block through replaceBlocksKeepColumns", () => {
    const editor = { document: [codeBlock("new", "math", "E=mc^2")], transact: vi.fn() };
    expect(convertPastedMermaidBlocks(editor, new Set())).toBe(1);
    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["new"], [{ type: "math", props: { tex: "E=mc^2" } }]);
  });

  it("a pasted latex code block is not replaced", () => {
    const editor = { document: [codeBlock("new", "latex", "E=mc^2")], transact: vi.fn() };
    expect(convertPastedMermaidBlocks(editor, new Set())).toBe(0);
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  describe("real editor", () => {
    let destroy: (() => void) | undefined;
    afterEach(() => destroy?.());

    it("the only block in a column is a ```math codeBlock -> converted to math, the row still has two columns", () => {
      const m = mountEditor([
        P("x", "x"),
        row([[{ ...CB("m", "E=mc^2"), props: { language: "math" } }], [P("", "e")]], "r"),
        P("z", "z"),
      ]);
      destroy = m.destroy;
      const editor: AnyEditor = m.editor;
      expect(convertPastedMermaidBlocks(editor, new Set(["x", "r", "rc0", "rc1", "e", "z"]))).toBe(1);
      expect(shape(editor)).toBe("paragraph:x  ROW[COL(math) | COL(paragraph)]  paragraph:z");
    });

    // Real paste -> real parse -> conversion (the fake-editor paste tests don't run BlockNote's own HTML and markdown parsing).
    describe.each([
      ["pasteHTML", (e: AnyEditor, lang: string) => e.pasteHTML(`<pre><code class="language-${lang}">E=mc^2</code></pre>`)],
      ["pasteMarkdown", (e: AnyEditor, lang: string) => e.pasteMarkdown("```" + lang + "\nE=mc^2\n```")],
    ] as const)("%s", (_name, paste) => {
      const pasted = (lang: string): { converted: number; types: string[] } => {
        const m = mountEditor([P("x", "x"), P("", "e")]);
        destroy = m.destroy;
        const editor: AnyEditor = m.editor;
        editor.setTextCursorPosition("e", "end");
        const before = collectBlockIds(editor.document);
        paste(editor, lang);
        const converted = convertPastedMermaidBlocks(editor, before);
        return { converted, types: editor.document.map((b) => b.type) };
      };

      it("a math fence is converted to a math block", () => {
        const r = pasted("math");
        expect(r.converted).toBe(1);
        expect(r.types).toContain("math");
      });

      it.each(["latex", "Math"])("a %s fence stays a code block", (lang) => {
        const r = pasted(lang);
        expect(r.converted).toBe(0);
        expect(r.types).toContain("codeBlock");
        expect(r.types).not.toContain("math");
      });
    });
  });
});
