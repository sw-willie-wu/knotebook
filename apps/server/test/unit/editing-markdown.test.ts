import { DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { MAX_BLOCKS, parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";
const GID = "99999999-9999-4999-8999-999999999999";
/** The writer's visible list (#269: carries slug/groupId/ownerHandle, used for in-site URL matching). */
const notes = [
  { id: "11111111-1111-4111-8111-111111111111", title: "A", slug: "a", groupId: null, ownerHandle: "alice" },
  { id: "22222222-2222-4222-8222-222222222222", title: "Group Doc", slug: "plan", groupId: GID, ownerHandle: null },
];

// Every `EditorSession.open` needs `try { ... } finally { s.close() }`: `close()` is what releases the runtime lease, `rt` here is shared at
// module level, and a throwing callback would permanently hold an in-flight slot (`session.ts`). A failed assertion is itself a throw,
// so closing before expect is not an alternative.
const withSession = async (fn: (ed: EditorSession["editor"]) => void) => {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    fn(s.editor);
  } finally {
    s.close();
  }
};
/** Writes blocks into a fresh Y.Doc (normalized through the real editor). */
const docWith = async (blocks: unknown[]) => {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
    s.editor.replaceBlocks(s.editor.document, blocks as any);
  } finally {
    s.close();
  }
  return doc;
};
/** Read-path export (the same markdown as MCP read_note_section / the whole-note form of REST /content). */
const readMd = async (doc: Y.Doc) => {
  const r = await readNoteContentFromDoc(rt, doc, undefined, new Map(), undefined, DEFAULT_KNOWLEDGE_FIELD_VIEW);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
};
const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; markdown: string }> };
const golden = (id: string): string => goldens.cases.find(c => c.id === id)!.markdown;
/** Example (the markdown of the G1-cols-spec golden). */
const ROW2 =
  '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n<figure><img alt="A 點" src="/api/uploads/u1" width="300"></figure>\n\n</div>\n' +
  '<div data-kb-column style="flex:1.5">\n\n## 設備規格\n\n型號：x\n\n</div>\n</div>\n';

describe("parseMarkdownForNote", () => {
  it("ROW2 is identical, character for character, to golden G1-cols-spec", () => {
    expect(ROW2).toBe(golden("G1-cols-spec"));
  });
  it("wikilink rebinding, mermaid restoration, unbound count", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "x [[A]] [[B]]\n\n```mermaid\ngraph TD\n```", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.unbound).toBe(1);
      expect(r.blocks.map(b => b.type)).toEqual(["paragraph", "mermaid"]);
    });
  });
  it("a ```math fence is restored to a math block; a ```latex or ```tex fence stays a code block", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "```math\nE=mc^2\n```\n\n```latex\n\\sum_{i} w_i\n```\n\n```tex\nx\n```", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.blocks.map(b => b.type)).toEqual(["math", "codeBlock", "codeBlock"]);
      expect(r.blocks[0]!.props).toMatchObject({ tex: "E=mc^2" });
      const latex = r.blocks[1] as { props: { language?: string }; content: Array<{ text: string }> };
      expect(latex.props.language).toBe("latex");
      expect(latex.content.map(c => c.text).join("")).toBe("\\sum_{i} w_i");
      expect((r.blocks[2] as { props: { language?: string } }).props.language).toBe("tex");
    });
  });
  it("a math fence keeps TeX that markdown would mangle (underscores, backslashes, blank-free multi-line)", async () => {
    await withSession(ed => {
      const tex = "R(c) = \\sum_{i} \\frac{w_i}{K}\n  + x_1 \\\\ y_2";
      const r = parseMarkdownForNote(ed, "```math\n" + tex + "\n```", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.blocks.map(b => b.type)).toEqual(["math"]);
      expect(r.blocks[0]!.props).toMatchObject({ tex });
    });
  });
  it("empty / whitespace-only -> empty_content; > MAX_BLOCKS -> too_many_blocks", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, "   \n  \n", notes, ORIGIN)).toEqual({ error: "empty_content" });
      expect(parseMarkdownForNote(ed, Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => `p${i}`).join("\n\n"), notes, ORIGIN)).toEqual({ error: "too_many_blocks" });
    });
  });
  it("unknown type rejects the whole write (no silent stripping)", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "<custom-widget>x</custom-widget>", notes, ORIGIN);
      // BlockNote usually degrades unknown HTML elements to paragraph; this case pins "if parse yields a type outside the schema allowlist ->
      // unsupported_block", using a fake editor with a narrowed allowlist. The real schema is the full defaultBlockSpecs plus mermaid/codeBlock
      // (see createHeadlessNoteSchema in shared), so a type the markdown/HTML parser can produce is always in it; an integration test can then
      // only produce the parse-throws variant (see the throw case below and test/mcp-write-guards.test.ts).
      const narrowed = { ...ed, schema: { blockSchema: { paragraph: ed.schema.blockSchema.paragraph } }, tryParseHTMLToBlocks: ed.tryParseHTMLToBlocks.bind(ed) } as unknown as typeof ed;
      expect(parseMarkdownForNote(narrowed, "# heading", notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "unknown_block" });
      expect("error" in r ? r.error : "ok").not.toBe("unsupported_block"); // with the real schema, plain HTML doesn't blow up into a 500
    });
  });

  // Columns and size write validation: syntax check -> parse -> structure check; failing any rejects the whole write.
  type B = { type: string; props?: Record<string, unknown>; content?: unknown; children?: B[] };
  const okBlocks = (r: ReturnType<typeof parseMarkdownForNote>): B[] => {
    if ("error" in r) throw new Error(r.error);
    return r.blocks as B[];
  };
  const COLS = { error: "unsupported_columns" };
  const SIZE = { error: "unsupported_size" };
  /** Row structure (types, column widths, each column's child block types and previewWidth), no text. */
  const rowShape = (bs: B[]) =>
    bs.map(b => ({ type: b.type, cols: (b.children ?? []).map(c => ({ type: c.type, width: c.props?.width, kids: (c.children ?? []).map(k => [k.type, k.props?.previewWidth]) })) }));

  it("canonical two-column form (example) -> one row, two columns, widths [1, 1.5], left column image previewWidth 300, right column [heading, paragraph]", async () => {
    await withSession(ed => {
      const bs = okBlocks(parseMarkdownForNote(ed, ROW2, notes, ORIGIN));
      expect(bs.map(b => b.type)).toEqual(["columnList"]);
      const cols = bs[0]!.children!;
      expect(cols.map(c => [c.type, c.props?.width])).toEqual([["column", 1], ["column", 1.5]]);
      expect(cols[0]!.children!.map(k => [k.type, k.props?.previewWidth])).toEqual([["image", 300]]);
      expect(cols[1]!.children!.map(k => k.type)).toEqual(["heading", "paragraph"]);
    });
  });
  it("two columns indented under a list item -> unsupported_columns", async () => {
    await withSession(ed => {
      const nested = `- item\n\n${ROW2.split("\n").map(l => (l === "" ? l : `  ${l}`)).join("\n")}`;
      expect(parseMarkdownForNote(ed, nested, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("in-editor form data-node-type=columnList with two columns -> unsupported_columns", async () => {
    await withSession(ed => {
      const siteForm = `<div data-node-type="columnList"><div data-node-type="column" data-width="1"><p>A</p></div><div data-node-type="column" data-width="1"><p>B</p></div></div>`;
      expect(parseMarkdownForNote(ed, siteForm, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("single-column external form -> unsupported_columns (the old version flattened it to ordinary paragraphs)", async () => {
    await withSession(ed => {
      const one = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nonly\n\n</div>\n</div>`;
      expect(parseMarkdownForNote(ed, one, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("layout with only display:flex -> unsupported_columns (the old version accepted and flattened it)", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, `<div style="display:flex"><div><p>L</p></div><div><p>R</p></div></div>`, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("markdown without columns (heading, list, table, mermaid) passes as before", async () => {
    await withSession(ed => {
      const md = "# T\n\n- a\n- b\n\n| h1 | h2 |\n| -- | -- |\n| 1 | 2 |\n\n```mermaid\ngraph TD\n```";
      const r = parseMarkdownForNote(ed, md, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.blocks.map(b => b.type)).toEqual(["heading", "bulletListItem", "bulletListItem", "table", "mermaid"]);
    });
  });
  it("orphan column (parse result replaced with blocks containing a column) -> the structure check returns unsupported_columns", async () => {
    await withSession(ed => {
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockReturnValue([{ id: "c", type: "column", props: { width: 1 }, children: [{ id: "p", type: "paragraph", content: "x" }] }] as never);
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual(COLS);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("orphan columnList (no column children) -> the structure check returns unsupported_columns", async () => {
    await withSession(ed => {
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockReturnValue([{ id: "r", type: "columnList", children: [] }] as never);
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual(COLS);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("orphan column and a non-palette color in the same write -> unsupported_columns (the structure check runs before color)", async () => {
    await withSession(ed => {
      const bad = [{ id: "c", type: "column", props: { width: 1 }, children: [{ id: "p", type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "tomato" } }] }] }];
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockReturnValue(bad as never);
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual(COLS);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("<figure> containing an img with width -> image previewWidth 300, name kept; a bare img with width -> unsupported_size", async () => {
    await withSession(ed => {
      const bs = okBlocks(parseMarkdownForNote(ed, '<figure><img alt="p" src="/api/uploads/u9" width="300"></figure>', notes, ORIGIN));
      expect(bs.map(b => [b.type, b.props?.previewWidth, b.props?.name])).toEqual([["image", 300, "p"]]);
      expect(parseMarkdownForNote(ed, '<img alt="p" src="/api/uploads/u9" width="300">', notes, ORIGIN)).toEqual(SIZE);
    });
  });
  it("first-row colwidth -> columnWidths[0] is 120; second-row colwidth -> unsupported_size", async () => {
    await withSession(ed => {
      const bs = okBlocks(parseMarkdownForNote(ed, '<table><tr><th colwidth="120">a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>', notes, ORIGIN));
      expect((bs[0]!.content as { columnWidths: unknown[] }).columnWidths[0]).toBe(120);
      expect(parseMarkdownForNote(ed, '<table><tr><th>a</th><th>b</th></tr><tr><td colwidth="120">c</td><td>d</td></tr></table>', notes, ORIGIN)).toEqual(SIZE);
    });
  });
  it.each<[string, unknown[]]>([
    ["G3-table-colspan-partial", [120, "unset", 80]],
    ["G3-table-colored-merged", ["unset", "unset", "unset"]],
  ])("%s: an empty paragraph in a merged cell with no width is stored as undefined (not NaN), and reads back identical after writing back", async (id, expected) => {
    const md = golden(id);
    let blocks: B[] = [];
    await withSession(ed => {
      blocks = okBlocks(parseMarkdownForNote(ed, md, notes, ORIGIN));
    });
    const ws = (blocks[0]!.content as { columnWidths: unknown[] }).columnWidths;
    expect(ws.map(v => (v === undefined ? "unset" : v))).toEqual(expected);
    for (const v of ws) expect(Object.is(v, NaN)).toBe(false);
    expect(await readMd(await docWith(blocks))).toBe(md);
  });
  it("one row with two columns of 1000 paragraphs each -> too_many_blocks (columns and their contents all count); 998 paragraphs per column -> passes (1+2+1996=1999)", async () => {
    const colOf = (n: number) => `<div data-kb-column style="flex:1">\n\n${Array.from({ length: n }, (_, i) => `p${i}`).join("\n\n")}\n\n</div>`;
    const rowOf = (n: number) => `<div data-kb-columns style="display:flex;gap:16px">\n${colOf(n)}\n${colOf(n)}\n</div>\n`;
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, rowOf(1000), notes, ORIGIN)).toEqual({ error: "too_many_blocks" });
      const bs = okBlocks(parseMarkdownForNote(ed, rowOf(998), notes, ORIGIN));
      expect(bs.map(b => b.type)).toEqual(["columnList"]);
      expect(bs[0]!.children!.map(c => c.children!.length)).toEqual([998, 998]);
    });
  });
  it("non-palette color and a display:flex div in the same write -> unsupported_columns (the syntax check runs before color)", async () => {
    await withSession(ed => {
      const md = 'x <span style="color:tomato">r</span>\n\n<div style="display:flex"><div><p>L</p></div><div><p>R</p></div></div>';
      expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("CRLF line breaks with two columns -> passes, same structure as LF (text not compared: core keeps trailing whitespace on CRLF paragraphs)", async () => {
    await withSession(ed => {
      const lf = okBlocks(parseMarkdownForNote(ed, ROW2, notes, ORIGIN));
      const crlf = okBlocks(parseMarkdownForNote(ed, ROW2.replace(/\n/g, "\r\n"), notes, ORIGIN));
      expect(rowShape(crlf)).toEqual(rowShape(lf));
      expect(rowShape(crlf)[0]!.cols).toHaveLength(2);
    });
  });
  it("own-site upload URLs inside a collapsed heading are stored in relative form; same-shaped paths from another site stay as-is; top-level relative URLs as before", async () => {
    const UP = "/api/uploads/00000000-0000-4000-8000-000000000001";
    const toggle = (src: string) => `<details open="" data-is-toggleable="true"><summary><h2>h</h2></summary><figure><img alt="n" src="${src}" width="300"></figure></details>\n`;
    expect(new URL(document.baseURI).origin).toBe(ORIGIN);
    await withSession(ed => {
      const inToggle = (md: string) => okBlocks(parseMarkdownForNote(ed, md, notes, ORIGIN))[0]!.children![0]!.props?.url;
      expect(inToggle(toggle(UP))).toBe(UP);
      expect(inToggle(toggle(`https://evil.example${UP}`))).toBe(`https://evil.example${UP}`);
      const top = okBlocks(parseMarkdownForNote(ed, `<figure><img alt="n" src="${UP}" width="300"></figure>`, notes, ORIGIN));
      expect(top[0]!.props?.url).toBe(UP);
    });
  });
  it("[[...]] and in-site links inside a column both bind to wikilinks, mermaid is restored; a non-palette color inside a column -> unsupported_color", async () => {
    await withSession(ed => {
      const md = ROW2.replace("<figure>", "```mermaid\ngraph TD\n```\n\n<figure>").replace("型號：x", "[[A]] [x](/notes/11111111-1111-4111-8111-111111111111)");
      const r = parseMarkdownForNote(ed, md, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.unbound).toBe(0);
      const cols = (r.blocks as B[])[0]!.children!;
      expect(cols[0]!.children!.map(k => k.type)).toEqual(["mermaid", "image"]);
      const para = cols[1]!.children!.find(k => k.type === "paragraph")!;
      expect((para.content as Array<{ type: string }>).filter(n => n.type === "wikilink")).toHaveLength(2);
      expect(parseMarkdownForNote(ed, ROW2.replace("型號：x", '<span style="color:tomato">r</span>'), notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });
  it("input that makes the core parse throw (editor-internal form data-content-type) -> unsupported_block, not rethrown", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, '<div data-content-type="paragraph">x</div>', notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "editor_internal" });
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockImplementation(() => {
        throw new Error("boom");
      });
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "editor_internal" });
      } finally {
        spy.mockRestore();
      }
    });
  });
  // HTML with event-handler attributes is rejected as a whole (unsupported_block) before the core parse, never entering `tryParseHTMLToBlocks`
  it("<img onerror> inside <details> and inside figure -> unsupported_block, core parse not called", async () => {
    await withSession(ed => {
      const parse = vi.spyOn(ed, "tryParseHTMLToBlocks");
      try {
        for (const md of [
          '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>\n',
          '<figure><img alt="a" src="/api/uploads/00000000-0000-4000-8000-000000000001" width="300" onerror="alert(1)"></figure>\n',
        ]) {
          expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "event_attr" });
        }
        expect(parse).not.toHaveBeenCalled();
        // control: without onerror it is accepted
        expect("error" in parseMarkdownForNote(ed, '<figure><img alt="a" src="/api/uploads/00000000-0000-4000-8000-000000000001" width="300"></figure>\n', notes, ORIGIN)).toBe(false);
      } finally {
        parse.mockRestore();
      }
    });
  });
  // When core starts throwing on legitimate content (e.g. after a BlockNote upgrade), operators need to see it: warn once, with the exception's class
  // name and the stack's call frames. No message (PM error messages can embed content fragments) and no note content.
  it("a parse exception turned into unsupported_block -> console.warn once with name and stack call frames, no message or markdown content; a normal parse doesn't warn", async () => {
    await withSession(ed => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Put a content fragment in the message to simulate PM's `Invalid content for node ...`
      const boom = new RangeError("Invalid content for node paragraph: <SECRET-IN-MESSAGE>");
      const parse = vi.spyOn(ed, "tryParseHTMLToBlocks").mockImplementationOnce(() => {
        throw boom;
      });
      try {
        expect(parseMarkdownForNote(ed, "SECRET-NOTE-TEXT", notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "editor_internal" });
        expect(warn).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(warn.mock.calls[0]);
        expect(logged).toContain("unsupported_block");
        expect(logged).toContain("RangeError");
        const frames = boom.stack!.split("\n").filter(l => /^\s+at /.test(l));
        expect(frames.length).toBeGreaterThan(0);
        expect(warn.mock.calls[0]![1]).toEqual({ name: "RangeError", frames });
        expect(logged).not.toContain("SECRET-IN-MESSAGE");
        expect(logged).not.toContain("SECRET-NOTE-TEXT");
        // A real input (core really throws) warns the same way and likewise carries no content
        expect(parseMarkdownForNote(ed, '<div data-content-type="paragraph">SECRET-NOTE-TEXT</div>', notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "editor_internal" });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(warn.mock.calls[1])).not.toContain("SECRET-NOTE-TEXT");
        // Lines starting with "    at " inside a multi-line message must not be recorded as call frames
        const tricky = new Error("first\n    at SECRET-LINE (x)");
        parse.mockImplementationOnce(() => {
          throw tricky;
        });
        expect(parseMarkdownForNote(ed, "y", notes, ORIGIN)).toEqual({ error: "unsupported_block", detail: "editor_internal" });
        expect(warn).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(warn.mock.calls[2])).not.toContain("SECRET-LINE");
        expect((warn.mock.calls[2]![1] as { frames: string[] }).frames.length).toBeGreaterThan(0);
        // control: no exception -> no warn
        expect("error" in parseMarkdownForNote(ed, "plain", notes, ORIGIN)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(3);
      } finally {
        parse.mockRestore();
        warn.mockRestore();
      }
    });
  });

  // href scheme filtering (issue #153). `parseMarkdownForNote`'s allowlist checks only block types, not inline content, so `link` passes through;
  // the defence against `javascript:`/`data:` is the default `isValidLink` regex of the Tiptap Link extension embedded in `@blocknote/core` (its
  // `parseHTML.getAttrs` returns `false` for an invalid href, so the mark doesn't apply and the text degrades to plain). That is an overridable
  // option, and `packages/shared/src/note-schema-config.ts` adds no extra guard for `link` (unlike `image`/`audio`/`video`/`file`, which are wrapped
  // by `withGuardedExternalHTML`). Upgrading the package or swapping the markdown parser would silently remove it; this case pins it.
  describe("href scheme filtering (the defence is upstream; this guards it)", () => {
    /** Recursively collects the type of every inline content (`{ type, href }` shape, so the positive control can compare values). */
    const inlines = (blocks: unknown[]): Array<{ type: string; href?: unknown }> =>
      (blocks as Array<{ content?: unknown; children?: unknown[] }>).flatMap(b => [
        ...(Array.isArray(b.content) ? (b.content as Array<{ type: string; href?: unknown }>) : []),
        ...(Array.isArray(b.children) ? inlines(b.children) : []),
      ]);

    // A positive control proves the link extraction path is right: without it the two "no link survives" assertions below would stay green
    // even if `inlines()` broke into always returning an empty array. It is placed first only for the reader: vitest's default `bail: 0` means a
    // failing `it` does not stop the others; only assertions inside the same `it` stop at the first failure.
    it("positive control: a valid https link really becomes a link, href unchanged", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(ed, "[x](https://example.com)", notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        const links = inlines(r.blocks).filter(c => c.type === "link");
        expect(links).toHaveLength(1);
        expect(links[0]!.href).toBe("https://example.com");
      });
    });

    it.each([
      ["javascript:", "[x](javascript:alert(1))"],
      ["data:", "[x](data:text/html,evil)"],
    ])("%s href yields no link inline content (degrades to plain text)", async (_scheme, markdown) => {
      await withSession(ed => {
        const r = parseMarkdownForNote(ed, markdown, notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        const content = inlines(r.blocks);
        expect(content.filter(c => c.type === "link")).toEqual([]);
        // The text must still be there (confirms "degrades to plain text" rather than "the whole paragraph was eaten", which would make the
        // assertion above trivially true).
        expect(content.some(c => c.type === "text")).toBe(true);
      });
    });
  });

  // The other half of the same risk model. The editor shows the open-in-new-tab icon only on `http(s)` links (`apps/web/src/index.css`); that is
  // truthful because `@blocknote/core`'s Link extension statically sets `target: "_blank"` in `addOptions().HTMLAttributes` (we don't override it
  // and nothing here restates it). If upstream makes it conditional the icon starts lying; this case catches that.
  it("http(s) links export HTML with target=_blank, which the icon's meaning relies on", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "[abs](https://example.com/p)", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      const html = ed.blocksToHTMLLossy(r.blocks);
      // Confirm an anchor was really produced first: otherwise the next line would be misleading when there is no link at all (same reason as the positive control above).
      expect(html, `沒有變成 link：${html}`).toContain('href="https://example.com/p"');
      expect(html, `連結沒有 target="_blank"，「開新分頁」圖示的標示就不成立：${html}`).toContain(
        'target="_blank"',
      );
    });
  });

  describe("#269 in-site links -> wikilink", () => {
    const wl = (r: ReturnType<typeof parseMarkdownForNote>) => {
      if ("error" in r) throw new Error(r.error);
      return r.blocks;
    };
    it("three forms (/notes/<id>, /n/, /g/), relative and same-origin absolute, with a #b- anchor -> wikilink; label rules; unbound does not count in-site links", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(
          ed,
          `[A](/notes/11111111-1111-4111-8111-111111111111) [自訂](${ORIGIN}/n/alice/a#b-h1) [x](/g/${GID}/plan) [[A]]`,
          notes,
          ORIGIN,
        );
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(0);
        const content = (r.blocks[0] as { content: Array<{ type: string; props?: Record<string, string> }> }).content.filter(n => n.type === "wikilink");
        expect(content.map(n => n.props)).toEqual([
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "A", label: "", anchorBlockId: "" },
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "自訂", label: "自訂", anchorBlockId: "h1" },
          { targetNoteId: "22222222-2222-4222-8222-222222222222", snapshotTitle: "x", label: "x", anchorBlockId: "" },
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "A" },
        ]);
      });
    });

    it("targets the writer can't see, groups they can't see, old slugs, links with a query, #/ fragment, /p/ -> stay ordinary links (not counted as unbound)", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(
          ed,
          [
            "[n](/notes/33333333-3333-4333-8333-333333333333)",
            `[g](/g/88888888-8888-4888-8888-888888888888/plan)`,
            "[old](/n/alice/old-slug)",
            "[q](/n/alice/a?present)",
            "[s](/n/alice/a#/slide)",
            "[p](/p/alice/a)",
          ].join(" "),
          notes,
          ORIGIN,
        );
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(0);
        const types = (r.blocks[0] as { content: Array<{ type: string }> }).content.filter(n => n.type !== "text").map(n => n.type);
        expect(types).toEqual(["link", "link", "link", "link", "link", "link"]);
      });
    });

    it("in-site links and [[...]] inside tables both bind; an unfound [[...]] in a table counts as unbound", async () => {
      await withSession(ed => {
        const blocks = wl(parseMarkdownForNote(ed, "| a | b |\n| --- | --- |\n| [x](/n/alice/a) | [[A]] [[Nope]] |", notes, ORIGIN));
        const table = blocks[0] as { type: string; content: { rows: Array<{ cells: unknown[] }> } };
        expect(table.type).toBe("table");
        const body = JSON.stringify(table.content.rows);
        expect(body).toContain('"type":"wikilink"');
        expect(body.match(/"type":"wikilink"/g)).toHaveLength(2);
        const r = parseMarkdownForNote(ed, "| a |\n| --- |\n| [[Nope]] |", notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(1);
      });
    });
  });
});

// #269: round trip of read (readNoteContentFromDoc -> wikilinksToLinks (no escaping) -> the markdown branch of shared note-markdown-read.ts escapes
// in-site link text with `escapeLinkText`, while the raw HTML branch of colored blocks does not escape -> BlockNote markdown) then write back
// (parseMarkdownForNote). BlockNote's own export doesn't escape text; the real editor measures the round trip here.
describe("#269: wikilink read -> write back keeps the label verbatim (paragraphs and table cells)", () => {
  const ID = notes[0]!.id;
  const wlNode = (label: string) => ({ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "snap", label, anchorBlockId: "" } });
  const labelsOf = (blocks: unknown) => [...JSON.stringify(blocks).matchAll(/"label":("(?:[^"\\]|\\.)*")/g)].map(m => JSON.parse(m[1]!) as string);

  /** read -> write back -> read -> write back: both rounds' labels equal the original, and the second round's markdown is byte-identical to the first (backslashes do not accumulate). */
  const roundTripTwice = async (blocks: unknown[]) => {
    const md1 = await readMd(await docWith(blocks));
    let back1: unknown[] = [];
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, md1, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      back1 = r.blocks;
    });
    const md2 = await readMd(await docWith(back1));
    let back2: unknown[] = [];
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, md2, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      back2 = r.blocks;
    });
    return { md1, md2, labels1: labelsOf(back1), labels2: labelsOf(back2) };
  };
  const SIX = ["[Draft] Plan *v2*", "a]b\\", "a_b_ `c` ~~s~~ x|y", "C:\\path\\", "![img] #h", "foo]bar"];
  const headerRow = { cells: [[{ type: "text", text: "h", styles: {} }]] };

  it.each(SIX)("markdown form (uncolored paragraph + uncolored table cell): %s", async text => {
    const r = await roundTripTwice([
      { type: "paragraph", content: [wlNode(text)] },
      { type: "table", content: { type: "tableContent", rows: [headerRow, { cells: [[wlNode(text)]] }] } },
    ]);
    expect(r.labels1).toEqual([text, text]);
    expect(r.labels2).toEqual([text, text]);
    expect(r.md2).toBe(r.md1);
  });

  // A colored block is read out whole as raw HTML, and its link text must NOT be escaped (HTML write-back doesn't unescape, so a layer of backslashes
  // would be added per round). An uncolored paragraph sits in between: when the doc has colors, uncolored nodes go through the markdown branch of `flush()`, whose escaping is observed here too.
  it.each(SIX)("HTML form (background-color paragraph, text-color paragraph, table with a colored cell) plus an uncolored paragraph in between: %s", async text => {
    const r = await roundTripTwice([
      { type: "paragraph", props: { backgroundColor: "yellow" }, content: [wlNode(text)] },
      { type: "paragraph", content: [wlNode(text)] },
      { type: "paragraph", props: { textColor: "red" }, content: [wlNode(text)] },
      { type: "table", content: { type: "tableContent", rows: [headerRow, { cells: [{ type: "tableCell", props: { backgroundColor: "red" }, content: [wlNode(text)] }] }] } },
    ]);
    expect(r.md1).toContain(`<a href="/notes/${ID}"`); // it really took the HTML branch
    expect(r.md1).toContain(`](/notes/${ID})`); // the uncolored paragraph really took the markdown branch
    expect(r.labels1).toEqual([text, text, text, text]);
    expect(r.labels2).toEqual([text, text, text, text]);
    expect(r.md2).toBe(r.md1);
  });

  // A colored block is read out whole as HTML (shared note-markdown-read.ts `toBlockHTML`): its link is `<a href="/notes/<id>">`, not `[text](...)`;
  // the parenthetical clause of READ_NOTE_LINK_SENTENCE is written accordingly.
  it("a wikilink inside a colored paragraph reads out as an <a href> link to /notes/<id>", async () => {
    const doc = await docWith([{ type: "paragraph", props: { backgroundColor: "yellow" }, content: [wlNode("L")] }]);
    const md = await readMd(doc);
    expect(md).toContain(`<a href="/notes/${ID}"`);
    expect(md).not.toContain(`](/notes/${ID})`);
  });
});
