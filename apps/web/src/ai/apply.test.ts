import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor, markdownToHTML } from "@blocknote/core";
import type { SiteLinkCandidate } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { createTestEditor } from "@/test/ai-host";
import { IMG, P, integrity, row, shape, withChildren } from "@/test/columns-fixtures";
import { diffBlocks, markOf } from "@/lib/version-diff";
import { blockSnapshot, captureAnchor, verifyAnchor } from "./anchor";
import { buildPreview } from "./preview";
import { anchorPlacement, applyAiResult, hasNonTextBlock, prepareAiResult, revertAiResult, type PreparedResult } from "./apply";

// Golden shared with the server's `note-markdown-goldens.test.ts` (under web's vitest `import.meta.url` is not a file: URL, so the path is computed from the apps/web root).
const goldens = JSON.parse(readFileSync(`${process.cwd()}/../../packages/shared/test-fixtures/note-markdown-goldens.json`, "utf8")) as {
  cases: { id: string; markdown: string }[];
};
const golden = (id: string): string => {
  const c = goldens.cases.find((x) => x.id === id);
  if (!c) throw new Error(`找不到 golden ${id}`);
  return c.markdown;
};

// Wrapped in a spy that calls through to the real implementation (asserts the identity of the written array); not automock, which would turn the writes of the real-editor cases into no-ops.
vi.mock("@/collab/columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/collab/columns/keep-columns")>();
  return { ...m, replaceBlocksKeepColumns: vi.fn(m.replaceBlocksKeepColumns) };
});
beforeEach(() => {
  vi.mocked(replaceBlocksKeepColumns).mockReset(); // Not an arrow returning it: a function returned from beforeEach runs as teardown; mockReset also clears the mockImplementationOnce queue and restores the wrapped original
});

// Harness shim: wikilink is a React inline content built with `createReactInlineContentSpec`. When ProseMirror inserts such a node into a mounted (non-headless) editor it synchronously calls `renderHTML` of `ReactInlineContentSpec.tsx` (the Tiptap `toDOM`, used for the initial NodeViewDesc DOM shell), which picks its Content as `toExternalHTML || render`. `wikilinkSpec` sets `toExternalHTML` (`WikilinkExternalHTML`, pure, no hooks; see `components/wikilink/spec.tsx`), so the interactive `WikilinkInline` (which reads `useNotes()`/`useNavigate()`/`useTranslation()`) is not what renders here.
// `renderHTML` then calls `renderToDOMSpec` (`@blocknote/react/.../ReactRenderUtil.ts`), which only accepts `editor.elementRenderer` (set by the real `<BlockNoteView>` through `withReactContext`); a mounted editor is not headless, and a null `elementRenderer` throws `Error: elementRenderer not available, expected headless editor`. The harness only calls `editor.mount(el)` without rendering `<BlockNoteView>`, hence this shim. Since the hook-free `toExternalHTML` is what renders, the shim only has to be non-null and insert the node into the DOM synchronously; no `QueryClientProvider`/`MemoryRouter`/`fetch` stub is needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- initialContent uses the widest BlockNote generic-triple type, per repo convention
function mountedEditor(initial?: any[]) {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: initial });
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) =>
    flushSync(() => createRoot(container).render(node as never));
  return editor;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
function prep(editor: any, markdown: string, notes: SiteLinkCandidate[] = []): PreparedResult {
  const prepared = prepareAiResult(editor, markdown, { notes, placement: "top" });
  if ("empty" in prepared || "invalid" in prepared) throw new Error("預期非空結果");
  return prepared;
}

describe("AI apply chain", () => {
  it("apply: markdown result replaces the anchored blocks; returns inserted ids and a snapshot of the replaced ones", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文一" }, { type: "paragraph", content: "原文二" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    const out = applyAiResult(editor, anchor, prep(editor, "改寫後的第一段\n\n改寫後的第二段"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.insertedIds.length).toBeGreaterThan(0);
    expect(out.replacedSnapshot).toHaveLength(2);
    const text = JSON.stringify(editor.document);
    expect(text).toContain("改寫後的第一段");
    expect(text).not.toContain("原文一");
  });

  it("anchor block deleted -> {ok:false, reason:'missing'}, document unchanged", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }, { type: "paragraph", content: "乙" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    editor.removeBlocks([ids[0]]);
    const before = JSON.stringify(editor.document);
    const out = applyAiResult(editor, anchor, prep(editor, "任何結果"));
    expect(out).toEqual({ ok: false, reason: "missing" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("anchor block content edited -> {ok:false, reason:'changed'}, document unchanged", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }]);
    const id = editor.document[0].id;
    const anchor = captureAnchor(editor, "note-1", [id]);
    editor.updateBlock(id, { content: "被協作者改掉了" });
    const out = applyAiResult(editor, anchor, prep(editor, "任何結果"));
    expect(out).toEqual({ ok: false, reason: "changed" });
  });

  it("revert: replacing (inserted ids, snapshot) restores the original text; reverts return 'stale' without touching the document after an inserted block was edited or deleted", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const out = applyAiResult(editor, anchor, prep(editor, "新文"));
    if (!out.ok) throw new Error("apply 應成功");
    const inserted = captureAnchor(editor, "note-1", out.insertedIds);
    expect(revertAiResult(editor, inserted, out.replacedSnapshot)).toBe("ok");
    expect(JSON.stringify(editor.document)).toContain("原文");
    const anchor2 = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const out2 = applyAiResult(editor, anchor2, prep(editor, "新文二"));
    if (!out2.ok) throw new Error("apply 應成功");
    const inserted2 = captureAnchor(editor, "note-1", out2.insertedIds);
    editor.updateBlock(out2.insertedIds[0], { content: "他人改動" });
    const before = JSON.stringify(editor.document);
    expect(revertAiResult(editor, inserted2, out2.replacedSnapshot)).toBe("stale");
    expect(JSON.stringify(editor.document)).toBe(before);
    editor.removeBlocks([out2.insertedIds[0]]);
    expect(revertAiResult(editor, inserted2, out2.replacedSnapshot)).toBe("stale");
  });

  it("wikilink rebinding, three outcomes: unique match -> wikilink node; zero or multiple matches -> plain text kept + unboundCount", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "上下文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const notes: SiteLinkCandidate[] = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", title: "產品規劃", slug: "plan", groupId: null, ownerHandle: "alice" },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", title: "重複標題", slug: "dup-1", groupId: null, ownerHandle: "alice" },
      { id: "aaaaaaaa-0000-0000-0000-000000000003", title: "重複標題", slug: "dup-2", groupId: null, ownerHandle: "alice" },
    ];
    const p = prep(editor, "見 [[產品規劃]] 與 [[重複標題]] 及 [[不存在]]", notes);
    const out = applyAiResult(editor, anchor, p);
    if (!out.ok) throw new Error("apply 應成功");
    const doc = JSON.stringify(editor.document);
    expect(doc).toContain('"wikilink"');
    expect(doc).toContain("aaaaaaaa-0000-0000-0000-000000000001");
    expect(doc).toContain("[[重複標題]]");
    expect(doc).toContain("[[不存在]]");
    expect(p.unboundCount).toBe(2);
  });

  // A codeBlock's content type is "plain", but its parsed node has the same `{type:"text"}[]` shape as paragraph inline content: rebinding that only checks `Array.isArray` would turn a `[[X]]` that happens to match inside a code fence into a wikilink inline node, placed in a block that doesn't accept inline content.
  it("rebinding skips plain-content blocks: a uniquely matching [[X]] in a code block stays plain text and isn't counted in unboundCount", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "上下文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const notes: SiteLinkCandidate[] = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "產品規劃", slug: "plan", groupId: null, ownerHandle: "alice" }];
    const p = prep(editor, "```\n見 [[產品規劃]]\n```", notes);
    const out = applyAiResult(editor, anchor, p);
    if (!out.ok) throw new Error("apply 應成功");
    const doc = JSON.stringify(editor.document);
    expect(doc).toContain('"codeBlock"');
    expect(doc).not.toContain('"wikilink"');
    expect(doc).toContain("[[產品規劃]]");
    expect(p.unboundCount).toBe(0);
  });

  // `tryParseMarkdownToBlocks` returns a single empty paragraph (not `[]`) for empty or whitespace-only markdown (see `isBlankParseResult` in apply.ts); without the guard `replaceBlocks` would replace the user's paragraph with an empty one yet report ok.
  it("empty result: empty/whitespace-only markdown -> prepareAiResult returns {empty:true}, document untouched", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別刪我" }]);
    const before = JSON.stringify(editor.document);
    expect(prepareAiResult(editor, "", { notes: [], placement: "top" })).toEqual({ empty: true });
    expect(prepareAiResult(editor, "   \n  \n", { notes: [], placement: "top" })).toEqual({ empty: true });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  // #386: line breaks inside a paragraph of an AI result (three spellings) are stored as a newline with no extra leading space on the next line (same `checkNoteMarkdownSyntax` html as MCP).
  it.each(["L1\nL2", "L1\\\nL2", "L1  \nL2"])("line break %j inside a paragraph -> one paragraph, text L1 newline L2 (no extra space)", (md) => {
    const editor = mountedEditor([{ type: "paragraph", content: "x" }]);
    const p = prepareAiResult(editor, md, { notes: [], placement: "top" });
    if (!("blocks" in p)) throw new Error(JSON.stringify(p));
    expect(p.blocks.map((b) => b.type)).toEqual(["paragraph"]);
    expect(p.blocks[0]!.content).toEqual([{ type: "text", text: "L1\nL2", styles: {} }]);
  });

  const ROW2 = golden("G1-cols-spec");
  it("canonical two-column form, placement top -> PreparedResult with one row of two columns, widths [1, 1.5]", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, ROW2, { notes: [], placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0]!.type).toBe("columnList");
    expect(p.blocks[0]!.children.map((c) => (c.props as { width: number }).width)).toEqual([1, 1.5]);
  });

  it("same paragraph, placement nested -> { invalid: unsupported_columns }, document unchanged", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const before = JSON.stringify(editor.document);
    expect(prepareAiResult(editor, ROW2, { notes: [], placement: "nested" })).toEqual({ invalid: "unsupported_columns" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("markdown without columns still returns PreparedResult", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, "# T\n\n- a\n- b", { notes: [], placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    expect(p.blocks.map((b) => b.type)).toEqual(["heading", "bulletListItem", "bulletListItem"]);
  });

  it("orphan columnList/column (parse result replaced) -> structure check rejects with unsupported_columns", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    for (const type of ["columnList", "column"]) {
      const spy = vi.spyOn(editor, "tryParseHTMLToBlocks").mockReturnValue([{ id: "c", type, props: { width: 1 }, children: [] }] as never);
      try {
        expect(prepareAiResult(editor, "x", { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_columns" });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("bare <img width> (not inside a figure) -> unsupported_size", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    expect(prepareAiResult(editor, '<img src="/x" width="300">', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_size" });
  });

  it("other div laid out with display:flex -> unsupported_columns", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    expect(prepareAiResult(editor, '<div style="display:flex">x</div>', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_columns" });
  });

  it("input that makes core parse throw (editor-internal data-content-type form) -> { invalid: unsupported_block }, no throw, document unchanged", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const md = '<div data-content-type="paragraph">x</div>';
    expect(() => editor.tryParseHTMLToBlocks(markdownToHTML(md))).toThrow(); // fixture self-check: core really throws in jsdom
    const before = JSON.stringify(editor.document);
    expect(prepareAiResult(editor, md, { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_block" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  // #398: parse guards are the same as the server's (shared `findParseGuardFailure` / `premergedHtml`).
  it("paragraph nested in a paragraph (<button> in <p>, <p> in <button>) -> { invalid: unsupported_block }, core parse not called", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const parse = vi.spyOn(editor, "tryParseHTMLToBlocks");
    expect(prepareAiResult(editor, "<p>a<button><p>b</p><p>c</p></button></p>", { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_block" });
    expect(parse).not.toHaveBeenCalled();
  });
  it("nesting deeper than MAX_HTML_DEPTH (129 levels) -> { invalid: unsupported_block }; 128 levels accepted", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "x" }]);
    const bq = (d: number) => "<blockquote><p>a</p>".repeat(d) + "</blockquote>".repeat(d);
    expect(prepareAiResult(editor, bq(128), { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_block" });
    expect(prepareAiResult(editor, bq(127), { notes: [], placement: "top" })).not.toHaveProperty("invalid");
  });
  it("multiple paragraphs in a quote are merged before core sees them (core sees one <p>); result equals the unmerged case", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "x" }]);
    const md = "> a\n>\n> **b**\n>\n> c";
    const expected = editor.tryParseHTMLToBlocks(markdownToHTML(md));
    const parse = vi.spyOn(editor, "tryParseHTMLToBlocks");
    const out = prep(editor, md);
    expect((parse.mock.calls[0]![0] as string).match(/<p>/g)).toHaveLength(1);
    const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === "id" ? undefined : v));
    expect(strip(out.blocks)).toBe(strip(expected));
  });

  // core clones <details> children into the live document while parsing, which fires <img onerror> in a browser; the syntax check rejects first so it never reaches core parse
  it("<img onerror> inside <details> or inside a figure -> { invalid: unsupported_block }, core parse not called; same for top and nested", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const parse = vi.spyOn(editor, "tryParseHTMLToBlocks");
    try {
      for (const md of [
        '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>',
        '<figure><img alt="a" src="/x" width="300" onerror="alert(1)"></figure>',
      ]) {
        for (const placement of ["top", "nested"] as const) {
          expect(prepareAiResult(editor, md, { notes: [], placement })).toEqual({ invalid: "unsupported_block" });
        }
      }
      expect(parse).not.toHaveBeenCalled();
      expect(prepareAiResult(editor, '<figure><img alt="a" src="/x" width="300"></figure>', { notes: [], placement: "top" })).not.toHaveProperty("invalid");
    } finally {
      parse.mockRestore();
    }
  });

  // Same as the server pipeline (#94): a ```mermaid codeBlock is restored to a mermaid block, otherwise applying the AI result would turn the diagram into a code block
  const FENCE = "```mermaid\ngraph TD; A-->B\n```";
  const mermaidOf = (markdown: string, placement: "top" | "nested") => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, markdown, { notes: [], placement });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    return p.blocks;
  };
  it("top-level ```mermaid fence -> mermaid block (code verbatim)", () => {
    const blocks = mermaidOf(FENCE, "top");
    expect(blocks.map((b) => b.type)).toEqual(["mermaid"]);
    expect(blocks[0]!.props).toEqual({ code: "graph TD; A-->B" });
  });

  it("mermaid fence inside a column (anchor top-level) -> mermaid block in the column; anchor inside a column with the AI returning a fence (nested) -> mermaid block", () => {
    const rowMd = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n${FENCE}\n\n</div>\n<div data-kb-column style="flex:1">\n\nB\n\n</div>\n</div>`;
    const [list] = mermaidOf(rowMd, "top");
    expect(list!.type).toBe("columnList");
    expect(list!.children[0]!.children.map((b) => [b.type, b.props])).toEqual([["mermaid", { code: "graph TD; A-->B" }]]);
    expect(mermaidOf(FENCE, "nested").map((b) => b.type)).toEqual(["mermaid"]);
  });

  it("a diagram the AI didn't change is context in the preview diff (the parse-assigned id is kept after restoring, so it can match)", () => {
    const CODE = "graph TD; A-->B";
    const editor = mountedEditor([P("old words", "p1"), { id: "m", type: "mermaid", props: { code: CODE } }, P("tail", "p3")]);
    const p = prep(editor, "new words\n\n```mermaid\n" + CODE + "\n```\n\ntail");
    expect(typeof p.blocks[1]!.id).toBe("string");
    const preview = buildPreview(editor, ["p1", "m", "p3"], p.blocks, false);
    const marks = diffBlocks(preview.before as never, preview.after as never).filter((e) => (e.after ?? e.before)?.type === "mermaid").map(markOf);
    expect(marks).toEqual(["context"]);
  });

  // A ```math fence is restored the same way; ```latex is a code language only (no block of its own).
  const MATH_FENCE = "```math\n\\frac{a_1}{b_1}\n```";
  it("top-level ```math fence -> math block (tex verbatim, underscores intact)", () => {
    const blocks = mermaidOf(MATH_FENCE, "top");
    expect(blocks.map((b) => b.type)).toEqual(["math"]);
    expect(blocks[0]!.props).toEqual({ tex: "\\frac{a_1}{b_1}" });
  });

  it("a top-level ```latex fence stays a code block", () => {
    const blocks = mermaidOf("```latex\n\\frac{a_1}{b_1}\n```", "top");
    expect(blocks.map((b) => b.type)).toEqual(["codeBlock"]);
    expect(blocks[0]!.props).toMatchObject({ language: "latex" });
  });

  it("math fence inside a column -> math block in the column", () => {
    const rowMd = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n${MATH_FENCE}\n\n</div>\n<div data-kb-column style="flex:1">\n\nB\n\n</div>\n</div>`;
    const [list] = mermaidOf(rowMd, "top");
    expect(list!.children[0]!.children.map((b) => [b.type, b.props])).toEqual([["math", { tex: "\\frac{a_1}{b_1}" }]]);
  });

  it("a formula the AI didn't change is context in the preview diff (the parse-assigned id is kept after restoring)", () => {
    const TEX = "\\frac{a_1}{b_1}";
    const editor = mountedEditor([P("old words", "p1"), { id: "f", type: "math", props: { tex: TEX } }, P("tail", "p3")]);
    const p = prep(editor, "new words\n\n```math\n" + TEX + "\n```\n\ntail");
    expect(typeof p.blocks[1]!.id).toBe("string");
    const preview = buildPreview(editor, ["p1", "f", "p3"], p.blocks, false);
    const marks = diffBlocks(preview.before as never, preview.after as never).filter((e) => (e.after ?? e.before)?.type === "math").map(markOf);
    expect(marks).toEqual(["context"]);
  });

  it("merged header with only one column width (colwidth=\"120,\") -> PreparedResult, second columnWidths entry is undefined (not NaN)", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, golden("G3-table-colspan-partial"), { notes: [], placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    const ws = (p.blocks[0]!.content as { columnWidths: unknown[] }).columnWidths;
    expect(ws).toHaveLength(3);
    expect(ws[0]).toBe(120);
    expect(Object.is(ws[1], undefined)).toBe(true);
    expect(ws[2]).toBe(80);
  });

  it("on-site uploaded image under a collapsed heading -> url restored to relative form; same-shape external URL left as is", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const md = golden("G2-img-in-toggle-heading");
    const urlOf = (markdown: string): unknown => {
      const p = prepareAiResult(editor, markdown, { notes: [], placement: "top" });
      if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
      return p.blocks[0]!.children[0]!.props.url;
    };
    expect(urlOf(md)).toBe("/api/uploads/00000000-0000-4000-8000-000000000001");
    const external = "https://other.example/api/uploads/00000000-0000-4000-8000-000000000001";
    expect(urlOf(md.replace('src="/api/uploads/', 'src="https://other.example/api/uploads/'))).toBe(external);
  });

  it("anchorPlacement: top-level -> top; inside a column -> nested; indented child block -> nested; top-level paragraph + top-level row -> top; top-level + in-column -> nested", () => {
    const editor = mountedEditor([P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r"), withChildren(P("p", "p"), [P("c", "c1")])]);
    expect(anchorPlacement(editor, ["x"])).toBe("top");
    expect(anchorPlacement(editor, ["a1"])).toBe("nested");
    expect(anchorPlacement(editor, ["c1"])).toBe("nested");
    expect(anchorPlacement(editor, ["x", "r"])).toBe("top");
    expect(anchorPlacement(editor, ["x", "a1"])).toBe("nested");
  });

  it("#263: applyAiResult writes this very prepared.blocks array into the document (same object, preview and write share it)", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const prepared = prep(editor, "新文");
    const out = applyAiResult(editor, anchor, prepared);
    expect(vi.mocked(replaceBlocksKeepColumns).mock.calls[0]?.[2]).toBe(prepared.blocks);
    expect(out.ok).toBe(true);
  });

  // The other column in the row is empty: core's fixColumnList deletes all empty columns and flattens a row left with one column; removals triggered by code don't take that path.
  it("anchor is the sole block in a column -> neither apply nor revert collapses the column", () => {
    const editor = mountedEditor([P("x", "x"), row([[P("原文", "b")], [P("", "e")]], "r"), P("z", "z")]);
    const anchor = captureAnchor(editor, "note-1", ["b"]);
    const out = applyAiResult(editor, anchor, prep(editor, "新一\n\n新二"));
    if (!out.ok) throw new Error("apply 應成功");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:新一,paragraph:新二) | COL(paragraph)]  paragraph:z");
    const inserted = captureAnchor(editor, "note-1", out.insertedIds);
    expect(revertAiResult(editor, inserted, out.replacedSnapshot)).toBe("ok");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:原文) | COL(paragraph)]  paragraph:z");
  });

  it("hasNonTextBlock: image block inside the anchor -> true (degrades the preview)", () => {
    const editor = mountedEditor([
      { type: "paragraph", content: "文" },
      { type: "image", props: { url: "https://example.com/a.png" } },
    ]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    expect(hasNonTextBlock(editor, ids)).toBe(true);
    expect(hasNonTextBlock(editor, [ids[0]])).toBe(false);
  });

  it("hasNonTextBlock looks at the anchor's descendants: image in column 2 of a row -> true; indented image under a paragraph -> true; text-only row -> false", () => {
    const editor = mountedEditor([
      row([[P("a", "a1")], [P("b", "b1"), IMG("i1")]], "r"),
      withChildren(P("p", "p"), [IMG("i2")]),
      row([[P("c", "c1")], [P("d", "d1")]], "t"),
    ]);
    expect(hasNonTextBlock(editor, ["r"])).toBe(true);
    expect(hasNonTextBlock(editor, ["p"])).toBe(true);
    expect(hasNonTextBlock(editor, ["t"])).toBe(false);
    expect(hasNonTextBlock(editor, ["gone"])).toBe(false); // anchor deleted during streaming: must not throw (finish would blow up here otherwise)
  });

  // verifyAnchor compares content, not position; if the anchor moved during the preview, structure is re-verified at the current position before applying.
  const ROW_AB = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nA\n\n</div>\n<div data-kb-column style="flex:1.5">\n\nB\n\n</div>\n</div>`;
  const clean = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
  it("indenting the top-level anchor during the preview (Tab / nestBlock) -> apply returns changed, document unchanged, no nested row; results without columns still apply", () => {
    const editor = mountedEditor([P("prev", "p0"), P("x", "x")]);
    const prepared = prep(editor, ROW_AB);
    const plain = prep(editor, "plain");
    const anchor = captureAnchor(editor, "note-1", ["x"]);
    editor.setTextCursorPosition("x", "end");
    editor.nestBlock();
    expect(anchorPlacement(editor, ["x"])).toBe("nested"); // fixture self-check: it really got indented
    const before = JSON.stringify(editor.document);
    expect(applyAiResult(editor, anchor, prepared)).toEqual({ ok: false, reason: "changed" });
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(integrity(editor)).toEqual(clean);
    expect(applyAiResult(editor, anchor, plain).ok).toBe(true);
    expect(shape(editor)).toBe("paragraph:prev{paragraph:plain}");
  });

  it("moving the top-level anchor into a column during the preview -> apply returns changed, document unchanged, no nested row / duplicate id / empty id", () => {
    const editor = mountedEditor([P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r")]);
    const prepared = prep(editor, ROW_AB);
    const anchor = captureAnchor(editor, "note-1", ["x"]);
    const xb = editor.getBlock("x")!;
    editor.transact(() => {
      editor.removeBlocks(["x"]);
      editor.insertBlocks([xb], "a1", "after");
    });
    expect(editor.getParentBlock("x")?.type).toBe("column"); // fixture self-check
    const before = JSON.stringify(editor.document);
    expect(applyAiResult(editor, anchor, prepared)).toEqual({ ok: false, reason: "changed" });
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(integrity(editor)).toEqual(clean);
  });

  // Same as MCP: color codes are accepted and normalized; a value that is neither a palette color name nor a color code is rejected as a whole
  it("text color as #hex (parsed to rgb()) -> accepted, prepared inline textColor is #ff0000", () => {
    const editor = mountedEditor([P("別動我")]);
    const ok = prepareAiResult(editor, '<span style="color:#ff0000">x</span>', { notes: [], placement: "top" });
    expect("blocks" in ok && JSON.stringify(ok.blocks[0]!.content)).toContain('"textColor":"#ff0000"');
    expect(prepareAiResult(editor, '<span style="color:tomato">x</span>', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_color" });
  });

  it("background color that is a valid CSS name but not in the palette -> unsupported_color; palette names still accepted", () => {
    const editor = mountedEditor([P("別動我")]);
    expect(prepareAiResult(editor, '<p data-background-color="chartreuse">x</p>', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_color" });
    const ok = prepareAiResult(editor, '<p data-background-color="red">x</p>', { notes: [], placement: "top" });
    expect("blocks" in ok && ok.blocks[0]!.props.backgroundColor).toBe("red");
  });

  it("parse result is a single empty paragraph with an off-palette background -> unsupported_color (as on the server: color check precedes the emptiness check); in-palette background is still empty", () => {
    const editor = mountedEditor([P("別動我")]);
    // Core 0.52.1 drops the paragraph when parsing an empty <p> and adds an empty paragraph with default props, so real markdown can't reach "empty but colored"; the parse result is faked with a spy (as in the orphan columnList/column case).
    expect(prepareAiResult(editor, '<p data-background-color="chartreuse"></p>', { notes: [], placement: "top" })).toEqual({ empty: true });
    for (const [color, expected] of [
      ["chartreuse", { invalid: "unsupported_color" }],
      ["red", { empty: true }],
    ] as const) {
      const spy = vi.spyOn(editor, "tryParseHTMLToBlocks").mockReturnValue([{ id: "e", type: "paragraph", props: { backgroundColor: color }, content: [], children: [] }] as never);
      try {
        expect(prepareAiResult(editor, "x", { notes: [], placement: "top" })).toEqual(expected);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("blockSnapshot: two calls on the same block give equal strings; a missing block returns null", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "穩定" }]);
    const id = editor.document[0].id;
    expect(blockSnapshot(editor, id)).toBe(blockSnapshot(editor, id));
    expect(blockSnapshot(editor, "no-such-id")).toBeNull();
  });

  it("verifyAnchor three outcomes: ok / missing / changed (public interface the revert button's enabled state depends on)", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }, { type: "paragraph", content: "乙" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    expect(verifyAnchor(editor, anchor)).toBe("ok");
    editor.updateBlock(ids[1], { content: "被改" });
    expect(verifyAnchor(editor, anchor)).toBe("changed");
    editor.removeBlocks([ids[0]]);
    expect(verifyAnchor(editor, anchor)).toBe("missing");
  });
});

describe("#269: on-site links -> wikilink (converted only on cache hit, no fallback)", () => {
  const notes2: SiteLinkCandidate[] = [
    { id: "11111111-1111-4111-8111-111111111111", title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" },
  ];
  it("[text](/notes/<id>), current /n/ URLs, and links in tables -> wikilink; ones not in the cache stay ordinary links; preview and write share one blocks array", () => {
    const editor = createTestEditor([{ id: "p", type: "paragraph", content: "x" }]);
    const p = prepareAiResult(
      editor,
      `see [Alpha](/notes/${notes2[0]!.id}#b-h1) and [mine](/n/alice/alpha) and [gone](/n/alice/missing)\n\n| a |\n| --- |\n| [t](/n/alice/alpha) |`,
      { notes: notes2, siteOrigin: window.location.origin, placement: "top" },
    );
    if ("empty" in p || "invalid" in p) throw new Error("empty");
    const json = JSON.stringify(p.blocks);
    expect(json.match(/"type":"wikilink"/g)).toHaveLength(3);
    expect(json).toContain('"anchorBlockId":"h1"');
    expect(json).toContain('"label":"mine"');
    expect(json).toContain('"href":"/n/alice/missing"');
  });

  it("escaped link text from an AI write-back (the form we send) round-trips to the original string: label kept verbatim, empty label when the text equals the current title", () => {
    const editor = createTestEditor([{ id: "p", type: "paragraph", content: "x" }]);
    const id = notes2[0]!.id;
    const titled: SiteLinkCandidate[] = [{ ...notes2[0]!, title: "[Draft] Plan *v2*" }];
    const p = prepareAiResult(editor, `a [\\[Draft\\] Plan \\*v2\\*](/notes/${id}) b [a\\]b\\\\](/notes/${id}) c`, { notes: titled, siteOrigin: window.location.origin, placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("empty");
    const links = (p.blocks[0]!.content as Array<{ type: string; props?: Record<string, string> }>).filter((n) => n.type === "wikilink");
    expect(links.map((n) => n.props!.label)).toEqual(["", "a]b\\"]);
    expect(links.map((n) => n.props!.snapshotTitle)).toEqual(["[Draft] Plan *v2*", "a]b\\"]);
  });
});
