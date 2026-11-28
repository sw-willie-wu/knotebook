// #222: text/background colors in MCP/REST note reads and writes.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { COLUMNS_OPEN_TAG, PALETTE_COLORS, blocksToNoteMarkdown, columnOpenTag, normalizeNoteColors, DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";
const notes = [{ id: "11111111-1111-4111-8111-111111111111", title: "A", slug: "a", groupId: null, ownerHandle: "alice" }];
type Ed = EditorSession["editor"];

// Same as editing-markdown.test.ts: every open is `try/finally close()` (lease invariant).
const withSession = async <T>(fn: (ed: Ed) => T, doc = new Y.Doc()): Promise<T> => {
  const s = await EditorSession.open(rt, doc);
  try {
    return fn(s.editor);
  } finally {
    s.close();
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
type AnyBlocks = any[];
/** Writes blocks into a fresh Y.Doc (normalized through the real editor) and returns that doc. */
const docWith = async (blocks: AnyBlocks): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  await withSession(ed => {
    ed.replaceBlocks(ed.document, blocks);
  }, doc);
  return doc;
};
/** Read-path export (the same markdown as MCP read_note_section / the whole-note form of REST /content). */
const readMd = async (doc: Y.Doc): Promise<string> => {
  const r = await readNoteContentFromDoc(rt, doc, undefined, new Map(), undefined, DEFAULT_KNOWLEDGE_FIELD_VIEW);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
};
/** Block JSON without ids (for comparing structure and colors). */
const shape = (blocks: unknown): string => JSON.stringify(blocks, (k, v) => (k === "id" ? undefined : v));
const parse = (ed: Ed, md: string) => {
  const r = parseMarkdownForNote(ed, md, notes, ORIGIN);
  if ("error" in r) throw new Error(r.error);
  return r.blocks;
};

describe("PALETTE_COLORS", () => {
  it("is exactly the editor's 10 built-in color names", () => {
    expect([...PALETTE_COLORS]).toEqual(["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"]);
  });
});

describe("write: parseMarkdownForNote accepts only built-in color names and hex colors", () => {
  it.each(PALETTE_COLORS.filter(c => c !== "default"))("%s: inline text/background color, whole block, and table cells are all accepted", async c => {
    await withSession(ed => {
      const md =
        `a <span style="color:${c}">t</span> <span style="background-color:${c}">b</span>\n\n` +
        `<p data-background-color="${c}" data-text-color="${c}">para</p>\n\n` +
        `<table><tr><td data-background-color="${c}" data-text-color="${c}">cell</td></tr></table>`;
      const blocks = parse(ed, md);
      const json = shape(blocks);
      expect(json).toContain(`"textColor":"${c}"`);
      expect(json).toContain(`"backgroundColor":"${c}"`);
      expect(blocks.map(b => b.type)).toEqual(["paragraph", "paragraph", "table"]);
    });
  });

  // The rows of the writing table in docs/ai-editing.md: headings, list items, quotes and <th> take the same data-* set.
  it("data-* on headings/list items/quotes/<th> become block/cell colors", async () => {
    await withSession(ed => {
      const blocks = parse(
        ed,
        `<h3 data-text-color="red">h</h3>\n\n<ul><li data-background-color="blue">u</li></ul>\n\n<ol><li data-text-color="green">o</li></ol>\n\n` +
          `<blockquote data-text-color="pink">q</blockquote>\n\n<table><tr><th data-background-color="gray">t</th></tr><tr><td>d</td></tr></table>`
      );
      expect(blocks.map(b => [b.type, (b.props as Record<string, unknown>).textColor, (b.props as Record<string, unknown>).backgroundColor])).toEqual([
        ["heading", "red", "default"],
        ["bulletListItem", "default", "blue"],
        ["numberedListItem", "green", "default"],
        ["quote", "pink", "default"],
        ["table", "default", undefined],
      ]);
      expect(shape(blocks[4])).toContain(`"backgroundColor":"gray"`);
    });
  });

  // The hex rows of the same table: one `#ff6600` data-* per element type (same elements as the previous case), accepted and stored as "#ff6600".
  it.each([
    ["p", `<p data-text-color="#ff6600">x</p>`, "paragraph", "textColor"],
    ["h3", `<h3 data-text-color="#ff6600">x</h3>`, "heading", "textColor"],
    ["ul > li", `<ul><li data-background-color="#ff6600">x</li></ul>`, "bulletListItem", "backgroundColor"],
    ["ol > li", `<ol><li data-text-color="#ff6600">x</li></ol>`, "numberedListItem", "textColor"],
    ["blockquote", `<blockquote data-text-color="#ff6600">x</blockquote>`, "quote", "textColor"],
  ])("hex row of the writing table: data-* #ff6600 on %s is stored as #ff6600", async (_name, md, type, prop) => {
    await withSession(ed => {
      const blocks = parse(ed, md);
      expect(blocks[0]!.type).toBe(type);
      expect((blocks[0]!.props as Record<string, unknown>)[prop]).toBe("#ff6600");
    });
  });

  it.each([
    ["td", `<table><tr><td data-background-color="#ff6600">c</td></tr></table>`],
    ["th", `<table><tr><th data-background-color="#ff6600">t</th></tr><tr><td>d</td></tr></table>`],
  ])("hex row of the writing table: data-* #ff6600 on table %s is stored as #ff6600", async (_name, md) => {
    await withSession(ed => {
      expect(shape(parse(ed, md))).toContain(`"backgroundColor":"#ff6600"`);
    });
  });

  it("default is accepted too (data-* default = no color)", async () => {
    await withSession(ed => {
      expect(() => parse(ed, `<p data-background-color="default" data-text-color="default">x</p>`)).not.toThrow();
    });
  });

  it("CSS color names are lowercased by the DOM: `color:RED` is stored as red", async () => {
    await withSession(ed => {
      expect(shape(parse(ed, `<p><span style="color:RED">x</span></p>`))).toContain(`"textColor":"red"`);
    });
  });

  it.each([
    ["inline #hex", `a <span style="color:#ff6600">x</span>`, `"textColor":"#ff6600"`],
    ["inline rgb()", `a <span style="color:rgb(255, 0, 0)">x</span>`, `"textColor":"#ff0000"`],
    ["whole-block style background #hex", `<p style="background-color:#ffeeaa">x</p>`, `"backgroundColor":"#ffeeaa"`],
    ["table cell data-* (short #f00 normalized)", `<table><tr><td data-background-color="#f00">c</td></tr></table>`, `"backgroundColor":"#ff0000"`],
    ["inline color inside a table cell", `<table><tr><td><span style="color:rgb(1,2,3)">c</span></td></tr></table>`, `"textColor":"#010203"`],
    ["inline color on link text", `[<span style="color:#123456">x</span>](https://example.com)`, `"textColor":"#123456"`],
    ["deep in a nested list", `- a\n  - b\n    - <span style="color:#abcdef">c</span>`, `"textColor":"#abcdef"`],
  ])("%s -> accepted and normalized to lowercase #rrggbb", async (_name, md, expected) => {
    await withSession(ed => {
      expect(shape(parse(ed, md))).toContain(expected);
    });
  });

  it.each([
    ["inline CSS name that is valid but not in the palette", `a <span style="background-color:chartreuse">x</span>`],
    ["whole-block data-* unknown name", `<p data-text-color="crimson">x</p>`],
    ["whole-block data-* wrong case (data-* is not normalized)", `<p data-background-color="Red">x</p>`],
    ["inline CSS color name", `a <span style="color:tomato">x</span>`],
    ["whole-block style background transparent", `<p style="background-color:transparent">x</p>`],
    ["table cell data-* color name", `<table><tr><td data-background-color="tomato">c</td></tr></table>`],
    ["inline color with alpha inside a table cell", `<table><tr><td><span style="color:rgb(0 0 0 / 50%)">c</span></td></tr></table>`],
    ["semi-transparent hex on link text", `[<span style="color:#ff660080">x</span>](https://example.com)`],
    ["var() deep in a nested list", `- a\n  - b\n    - <span style="color:var(--x)">c</span>`],
  ])("%s -> unsupported_color (whole write rejected)", async (_name, md) => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });

  // docs/ai-editing.md "Colors" claims verbatim: these two forms are accepted but the color is silently dropped (the upstream parser
  // doesn't recognize them). If upstream starts recognizing them this case goes red and that doc sentence must change.
  it("inline <span data-text-color> and <mark> are not colors: the text stays, the color is silently dropped (no error)", async () => {
    await withSession(ed => {
      const json = shape(parse(ed, `a <span data-text-color="red">x</span> <mark>y</mark> <span data-background-color="blue">z</span>`));
      expect(json).toContain(`"content":[{"type":"text","text":"a x y z","styles":{}}]`);
      expect(json).not.toMatch(/"(textColor|backgroundColor)":"(?!default)/);
    });
  });

  it("one bad color value rejects the whole write (even if the others are valid)", async () => {
    await withSession(ed => {
      const md = `ok <span style="color:red">r</span>\n\n<p data-text-color="blue">b</p>\n\nbad <span style="color:#ff660080">x</span>`;
      expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });

  // End to end parse -> normalize: the style form is rewritten through CSSOM, the data-* form is the raw string; both must end as lowercase #rrggbb or reject the whole write.
  it.each([
    ["#ff6600ff", "#ff6600"],
    ["rgba(1, 2, 3, 1)", "#010203"],
    ["hsla(0,100%,50%,1)", "#ff0000"],
    ["rgb(0 0 0 / 100%)", "#000000"],
    ["hwb(0 0% 0%)", "#ff0000"],
    ["#ff6600 !important", "#ff6600"],
    ["hsl(30, 50%, 33%)", "#7e542a"],
  ])("style form color:%s is stored as %s", async (input, stored) => {
    await withSession(ed => {
      expect(shape(parse(ed, `<p><span style="color:${input}">x</span></p>`))).toContain(`"textColor":"${stored}"`);
    });
  });

  it.each(["#ff660080", "rgb(0 0 0 / 50%)", "tomato", "oklch(0.7 0.1 30)", "color(srgb 1 0 0)"])("style form color:%s -> unsupported_color", async input => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, `<p><span style="color:${input}">x</span></p>`, notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });

  it("short hex and uppercase hex in the data-* form are stored as lowercase #rrggbb", async () => {
    await withSession(ed => {
      expect(shape(parse(ed, `<p data-text-color="#F60">x</p>`))).toContain(`"textColor":"#ff6600"`);
      expect(shape(parse(ed, `<p data-background-color="#FFEEAA">x</p>`))).toContain(`"backgroundColor":"#ffeeaa"`);
    });
  });
});

describe("normalizeNoteColors: walks iteratively, no recursion", () => {
  it("all valid returns null, an invalid one returns that value", () => {
    expect(normalizeNoteColors([{ type: "paragraph", props: { textColor: "red" }, content: [{ type: "text", text: "x", styles: { backgroundColor: "blue" } }], children: [] }])).toBeNull();
    expect(normalizeNoteColors([{ type: "paragraph", props: {}, content: [{ type: "text", text: "x", styles: { textColor: "tomato" } }], children: [] }])).toBe("tomato");
  });

  it("a valid hex color becomes lowercase #rrggbb in place", () => {
    const blocks = [{ type: "paragraph", props: {}, content: [{ type: "text", text: "x", styles: { textColor: "#fff" } }], children: [] }];
    expect(normalizeNoteColors(blocks)).toBeNull();
    expect(blocks[0]!.content[0]!.styles.textColor).toBe("#ffffff");
  });

  it("a non-string color value (wrong type) is invalid too", () => {
    expect(normalizeNoteColors([{ type: "paragraph", props: { backgroundColor: 3 }, content: [], children: [] }])).toBe("3");
  });

  it("100k levels of nesting do not overflow the stack, and the deepest bad value is found", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- synthetic test data
    const root: any = { type: "paragraph", props: {}, content: [], children: [] };
    let cur = root;
    for (let i = 0; i < 100_000; i++) {
      const next = { type: "paragraph", props: {}, content: [], children: [] };
      cur.children.push(next);
      cur = next;
    }
    cur.content = [{ type: "text", text: "deep", styles: { textColor: "rgb(0, 0, 0)" } }];
    expect(normalizeNoteColors([root])).toBeNull();
    expect(cur.content[0].styles.textColor).toBe("#000000");
    cur.content[0].styles.textColor = "tomato";
    expect(normalizeNoteColors([root])).toBe("tomato");
  });

  it("table: both cell props and inline styles inside cells are checked", () => {
    const table = (cell: unknown) => [{ type: "table", props: { textColor: "default" }, content: { type: "tableContent", rows: [{ cells: [cell] }] }, children: [] }];
    expect(normalizeNoteColors(table({ type: "tableCell", props: { backgroundColor: "nope" }, content: [] }))).toBe("nope");
    expect(normalizeNoteColors(table({ type: "tableCell", props: {}, content: [{ type: "text", text: "c", styles: { textColor: "#1" } }] }))).toBe("#1");
    expect(normalizeNoteColors(table([{ type: "text", text: "c", styles: { backgroundColor: "tomato" } }]))).toBe("tomato"); // legacy shape: the cell is a bare inline array
    expect(normalizeNoteColors(table({ type: "tableCell", props: { backgroundColor: "red" }, content: [] }))).toBeNull();
  });

  it("columns: a bad color value in a paragraph inside a column is found too", () => {
    const row = (styles: Record<string, unknown>) => [{ type: "columnList", props: {}, content: undefined, children: [
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", props: {}, content: [{ type: "text", text: "a", styles: {} }], children: [] }] },
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", props: {}, content: [{ type: "text", text: "b", styles }], children: [] }] },
    ] }];
    expect(normalizeNoteColors(row({ textColor: "tomato" }))).toBe("tomato");
    expect(normalizeNoteColors(row({ textColor: "red" }))).toBeNull();
    const ok = row({ textColor: "#F00" });
    expect(normalizeNoteColors(ok)).toBeNull();
    expect(JSON.stringify(ok)).toContain(`"textColor":"#ff0000"`);
  });
});

describe("read: blocksToNoteMarkdown", () => {
  it("no colors at all -> byte-identical to blocksToMarkdownLossy", async () => {
    const doc = await docWith([
      { type: "heading", props: { level: 2 }, content: "T" },
      { type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, { type: "text", text: "b", styles: { bold: true } }] },
      { type: "bulletListItem", content: "x", children: [{ type: "bulletListItem", content: "y" }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["1", "2"] }] } },
      { type: "codeBlock", props: { language: "js" }, content: "a\n\nb" },
    ]);
    await withSession(ed => {
      expect(blocksToNoteMarkdown(ed, ed.document)).toBe(ed.blocksToMarkdownLossy(ed.document));
    }, doc);
  });

  it("inline text color -> a color span inside a markdown paragraph (the paragraph itself stays markdown)", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, { type: "text", text: "red", styles: { textColor: "red" } }, { type: "text", text: " b", styles: {} }] }]);
    expect(await readMd(doc)).toBe(`a <span style="color:red">red</span> b\n`);
  });

  it("inline text color + background color merge into one span", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "red", backgroundColor: "yellow" } }] }]);
    expect(await readMd(doc)).toBe(`<span style="color:red;background-color:yellow">x</span>\n`);
  });

  it("background color only -> a background-color span", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { backgroundColor: "green" } }] }]);
    expect(await readMd(doc)).toBe(`<span style="background-color:green">x</span>\n`);
  });

  it("whole-block color -> data-* attributes (no rgb style)", async () => {
    const doc = await docWith([{ type: "paragraph", props: { textColor: "red", backgroundColor: "blue" }, content: "x" }]);
    expect(await readMd(doc)).toBe(`<p data-background-color="blue" data-text-color="red">x</p>\n`);
  });

  it("hex colors stored as lowercase #rrggbb read back as-is (inline span, whole-block data-*, cell data-*, text + background combined)", async () => {
    const inline = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "#ff6600" } }] }]);
    expect(await readMd(inline)).toBe(`<span style="color:#ff6600">x</span>\n`);
    const block = await docWith([{ type: "paragraph", props: { textColor: "#ff6600" }, content: "x" }]);
    expect(await readMd(block)).toBe(`<p data-text-color="#ff6600">x</p>\n`);
    const cell = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: "a", props: { backgroundColor: "#ff6600" } }, "b"] }] } }]);
    expect(await readMd(cell)).toBe(`<table><tr><td data-background-color="#ff6600">a</td><td>b</td></tr></table>\n`);
    const both = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "#ff6600", backgroundColor: "#00ff00" } }] }]);
    expect(await readMd(both)).toBe(`<span style="color:#ff6600;background-color:#00ff00">x</span>\n`);
  });

  it("the markdown read out for hex colors parses back unchanged, reads the same, and the hex colors stay", async () => {
    const doc = await docWith([
      { type: "paragraph", content: [{ type: "text", text: "a", styles: { textColor: "#ff6600", backgroundColor: "#00ff00" } }] },
      { type: "paragraph", props: { backgroundColor: "#123456" }, content: "b" },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: "c", props: { textColor: "#abcdef" } }, "d"] }] } },
    ]);
    const md1 = await readMd(doc);
    const blocks = await withSession(ed => parse(ed, md1));
    for (const c of ["#ff6600", "#00ff00", "#123456", "#abcdef"]) expect(shape(blocks)).toContain(`"${c}"`);
    expect(await readMd(await docWith(blocks))).toBe(md1);
  });

  it("mixed: uncolored paragraphs stay markdown, colored ones are HTML, separated by a blank line", async () => {
    const doc = await docWith([
      { type: "heading", props: { level: 1 }, content: "T" },
      { type: "paragraph", props: { backgroundColor: "yellow" }, content: "hi" },
      { type: "paragraph", content: [{ type: "text", text: "plain ", styles: {} }, { type: "text", text: "b", styles: { bold: true } }] },
    ]);
    expect(await readMd(doc)).toBe(`# T\n\n<p data-background-color="yellow">hi</p>\n\nplain **b**\n`);
  });

  it("table: uncolored stays GFM; if any cell is colored -> HTML <table> with data-* on cells", async () => {
    const plain = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }] } }]);
    expect(await readMd(plain)).toContain("| ---");
    const colored = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: "a", props: { backgroundColor: "red" } }, "b"] }] } }]);
    const md = await readMd(colored);
    expect(md).not.toContain("| ---");
    expect(md).toMatch(/^<table>/);
    expect(md).toBe(`<table><tr><td data-background-color="red">a</td><td>b</td></tr></table>\n`); // no tbody, no <p> inside cells, no colspan=1 noise
  });

  it("no editor-internal noise (class, rgb style, data-editable, target)", async () => {
    const doc = await docWith([
      { type: "bulletListItem", props: { textColor: "red" }, content: [{ type: "link", href: "https://e.com", content: [{ type: "text", text: "l", styles: { textColor: "blue" } }] }] },
    ]);
    const md = await readMd(doc);
    expect(md).not.toMatch(/class|rgb\(|data-editable|data-style-type|target=|classname/);
    expect(md).toContain(`<a href="https://e.com">`);
  });

  it("text inside an inline span (<, &, emoji surrogate pairs) round-trips unchanged", async () => {
    const text = "a < b & c 😀";
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: { textColor: "red" } }] }]);
    const md = await readMd(doc);
    expect(md).toBe(`<span style="color:red">${text}</span>\n`);
    expect(shape(await withSession(ed => parse(ed, md)))).toContain(`"text":"${text}","styles":{"textColor":"red"}`);
  });

  it("escaping: <, & inside a whole-block HTML (block color) use character references (an HTML block decodes them)", async () => {
    const doc = await docWith([{ type: "paragraph", props: { textColor: "red" }, content: "a<b&c" }]);
    const md = await readMd(doc);
    expect(md).toBe(`<p data-text-color="red">a&lt;b&amp;c</p>\n`);
    expect(shape(await withSession(ed => parse(ed, md)))).toContain(`"text":"a<b&c"`);
  });

  it("an existing non-palette color value (written before #222; the editor never displayed it) reads as no color, and writing back is not rejected", async () => {
    const doc = await docWith([
      { type: "paragraph", props: { textColor: "#FF6600" }, content: [{ type: "text", text: "x", styles: { backgroundColor: "rgb(1, 2, 3)" } }] },
      { type: "paragraph", props: { backgroundColor: "chartreuse", textColor: "red" }, content: [{ type: "text", text: "y", styles: { textColor: "nope", backgroundColor: "blue" } }] },
    ]);
    const md = await readMd(doc);
    expect(md).toBe(`x\n\n<p data-text-color="red"><span style="background-color:blue">y</span></p>\n`);
    await withSession(ed => expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).not.toHaveProperty("error"));
  });

  it("a file block's background color is not emitted (it is exported as a link anyway, and HTML can't restore a file block)", async () => {
    const doc = await docWith([{ type: "file", props: { url: "http://localhost/api/uploads/x.pdf", backgroundColor: "red", name: "f" } }]);
    await withSession(ed => expect(blocksToNoteMarkdown(ed, ed.document)).toBe(ed.blocksToMarkdownLossy(ed.document)), doc);
  });

  it("inline colors inside list items, headings, and uncolored table cells stay in markdown", async () => {
    const doc = await docWith([
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "h ", styles: {} }, { type: "text", text: "red", styles: { textColor: "red" } }] },
      { type: "bulletListItem", content: "a" },
      { type: "bulletListItem", content: [{ type: "text", text: "b ", styles: {} }, { type: "text", text: "late", styles: { textColor: "red" } }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["x", { type: "tableCell", content: [{ type: "text", text: "hi", styles: { backgroundColor: "yellow" } }] }] }] } },
    ]);
    const md = await readMd(doc);
    expect(md).toContain(`## h <span style="color:red">red</span>\n`);
    expect(md).toContain(`* a\n* b <span style="color:red">late</span>\n`);
    expect(md).toMatch(/\| x +\| <span style="background-color:yellow">hi<\/span> *\|/);
    expect(md).not.toMatch(/<(p|ul|li|table|h2)[ >]/);
  });

  it("bold/link wrapping or mixed with colored text: the span goes outside the emphasis/link, and emphasis delimiters never touch the span from inside", async () => {
    const doc = await docWith([
      { type: "paragraph", content: [{ type: "text", text: "x ", styles: {} }, { type: "text", text: "a", styles: { bold: true } }, { type: "text", text: "b", styles: { bold: true, textColor: "red" } }, { type: "text", text: "c", styles: {} }, { type: "link", href: "https://e.com", content: [{ type: "text", text: "l", styles: { textColor: "blue" } }] }, { type: "text", text: " ", styles: {} }, { type: "text", text: "plain", styles: { bold: true } }] },
    ]);
    expect(await readMd(doc)).toBe(`x **a**<span style="color:red">**b**</span>c<span style="color:blue">[l](https://e.com)</span> **plain**\n`);
  });

  // Text inside a span goes through the same conversion as uncolored text: BlockNote's HTML -> markdown doesn't escape literal text that looks
  // like markdown (`**x**`), while a `<` that could open a tag gets a backslash on the read side (`\<` writes back as a literal `<`, #379). This case pins that colored text is escaped the same as uncolored text.
  it("literal markdown-looking text inside colored text gives the same output as in an uncolored paragraph (same escaping)", async () => {
    const text = "*no* [y](z) <x>";
    const colored = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: { textColor: "red" } }] }]);
    const plain = await docWith([{ type: "paragraph", content: text }]);
    expect(await readMd(colored)).toBe(`<span style="color:red">${(await readMd(plain)).trimEnd()}</span>\n`);
  });

  // Color markers quoted as literal text: `<` gets a backslash on read and writing back still gives literal text, never a real color (#379).
  it("color markers in literal text are escaped on read: #hex and palette names both stay literal text when written back", async () => {
    const hexMd = await readMd(await docWith([{ type: "paragraph", content: `quote <span style="color:#ff0000">x</span>` }]));
    expect(hexMd).toBe(`quote \\<span style="color:#ff0000">x\\</span>\n`);
    const hex = shape(await withSession(ed => parse(ed, hexMd)));
    expect(hex).not.toContain('"textColor":"#ff0000"');
    expect(hex).toContain(`quote <span style=\\"color:#ff0000\\">x</span>`);
    const namedMd = await readMd(await docWith([{ type: "paragraph", content: `quote <span style="color:red">x</span>` }]));
    const named = shape(await withSession(ed => parse(ed, namedMd)));
    expect(named).not.toContain(`"textColor":"red"`);
    expect(named).toContain(`quote <span style=\\"color:red\\">x</span>`);
  });

  it("document already containing the placeholder characters falls back to whole-block HTML and still round-trips", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "⸀0⸁ ", styles: {} }, { type: "text", text: "r", styles: { textColor: "red" } }] }]);
    const md = await readMd(doc);
    expect(md).toBe(`<p>⸀0⸁ <span style="color:red">r</span></p>\n`);
    const doc2 = await docWith(await withSession(ed => parse(ed, md)));
    expect(await readMd(doc2)).toBe(md);
  });

  it("colored blocks without text (empty paragraph, empty list item) count as no color: the read output equals blocksToMarkdownLossy", async () => {
    const doc = await docWith([
      { type: "paragraph", content: "a" },
      { type: "paragraph", props: { backgroundColor: "red" } },
      { type: "bulletListItem", props: { backgroundColor: "blue" } },
      { type: "bulletListItem", content: "b" },
      { type: "paragraph", content: "c" },
    ]);
    const md1 = await readMd(doc);
    // Before #222 the output was blocksToMarkdownLossy (an empty colored block never exposed its color).
    expect(md1).toBe(await withSession(ed => ed.blocksToMarkdownLossy(ed.document), doc));
    expect(md1).not.toContain("data-");
    // This one's round trip is itself inconsistent (the empty paragraph is dropped on write back), but that is existing markdown behavior: an uncolored empty paragraph does the same.
  });

  // #222: an empty cell differs from an empty paragraph: the parser keeps `<td data-background-color="red"></td>`, so its color is emitted.
  it("empty colored table cell keeps its color and round-trips consistently", async () => {
    const doc = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [], props: { backgroundColor: "red" } }, "b"] }] } }]);
    const md1 = await readMd(doc);
    expect(md1).toBe(`<table><tr><td data-background-color="red"></td><td>b</td></tr></table>\n`);
    const blocks = await withSession(ed => parse(ed, md1));
    expect(shape(blocks)).toContain(`"backgroundColor":"red"`);
    expect(await readMd(await docWith(blocks))).toBe(md1);
  });

  // #222: a media block without text (image without caption) has content, so its background color is emitted.
  it("colored image without caption keeps its background color and round-trips consistently", async () => {
    const doc = await docWith([{ type: "image", props: { url: "http://localhost/api/uploads/x.png", backgroundColor: "red" } }]);
    const md1 = await readMd(doc);
    expect(md1).toContain(`data-background-color="red"`);
    expect(await readMd(await docWith(await withSession(ed => parse(ed, md1))))).toBe(md1);
  });

  it("an empty list item inside a colored list gets no color attribute (it would be dropped on write back, breaking the round trip)", async () => {
    const doc = await docWith([
      { type: "bulletListItem", props: { backgroundColor: "blue" }, content: "x" },
      { type: "bulletListItem", props: { backgroundColor: "red" } },
    ]);
    const md1 = await readMd(doc);
    expect(md1).not.toContain(`data-background-color="red"`);
    const doc2 = await docWith(await withSession(ed => parse(ed, md1)));
    expect(await readMd(doc2)).toBe(md1);
  });

  it("no blank lines inside a colored HTML block (a blank line truncates a markdown HTML block)", async () => {
    const doc = await docWith([
      { type: "toggleListItem", props: { textColor: "red" }, content: "t", children: [{ type: "codeBlock", props: { language: "js" }, content: "a\n\nb" }] },
    ]);
    const md = await readMd(doc);
    expect(md.trimEnd()).not.toMatch(/\n\s*\n/);
  });
});

describe("read -> write back as-is -> read: consistent, no color lost", () => {
  const fixture = [
    { type: "heading", props: { level: 2, textColor: "blue" }, content: "H" },
    { type: "paragraph", content: [{ type: "text", text: "plain & ", styles: {} }, { type: "text", text: "b", styles: { bold: true, textColor: "red" } }, { type: "text", text: "u", styles: { underline: true, backgroundColor: "pink" } }, { type: "link", href: "https://e.com", content: [{ type: "text", text: "lnk", styles: { textColor: "purple" } }] }, { type: "text", text: " 😀 a<b&c", styles: { textColor: "gray", backgroundColor: "orange" } }] },
    { type: "paragraph", props: { textColor: "brown", backgroundColor: "yellow", textAlignment: "center" }, content: "**lit** <x> line1\nline2" },
    { type: "bulletListItem", content: "u1" },
    { type: "bulletListItem", props: { backgroundColor: "green" }, content: "u2", children: [{ type: "numberedListItem", props: { textColor: "red" }, content: "n" }] },
    { type: "bulletListItem", content: "u3" },
    { type: "numberedListItem", props: { start: 3, textColor: "green" }, content: "three" },
    { type: "checkListItem", props: { checked: true, backgroundColor: "blue" }, content: "c" },
    { type: "quote", props: { textColor: "red" }, content: "q" },
    { type: "heading", props: { level: 3, isToggleable: true, backgroundColor: "orange" }, content: "tog", children: [{ type: "paragraph", content: "kid" }] },
    { type: "paragraph", props: { textColor: "red" }, content: "parent", children: [{ type: "paragraph", content: "flattened child" }] },
    { type: "table", props: { textColor: "blue" }, content: { type: "tableContent", headerRows: 1, rows: [{ cells: ["h1", "h2"] }, { cells: [{ type: "tableCell", content: [{ type: "text", text: "r", styles: { textColor: "red" } }] }, { type: "tableCell", content: "t", props: { textColor: "green", backgroundColor: "gray" } }] }] } },
    { type: "table", content: { type: "tableContent", rows: [{ cells: ["plain", "table"] }] } },
    { type: "image", props: { url: "http://localhost/api/uploads/x.png", backgroundColor: "red", caption: "cap" } },
    { type: "codeBlock", props: { language: "javascript" }, content: "a\n\nb" },
    { type: "bulletListItem", content: [{ type: "text", text: "b ", styles: {} }, { type: "text", text: "late", styles: { textColor: "red" } }, { type: "text", text: " *x* [a](b)", styles: {} }] },
    { type: "paragraph", content: [{ type: "text", text: "a", styles: { bold: true } }, { type: "text", text: "b*_", styles: { bold: true, italic: true, textColor: "red" } }, { type: "text", text: "c", styles: { bold: true } }, { type: "text", text: "d", styles: {} }] },
    { type: "table", content: { type: "tableContent", rows: [{ cells: ["x", { type: "tableCell", content: [{ type: "text", text: "hi", styles: { backgroundColor: "yellow" } }] }] }] } },
    { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "h ", styles: {} }, { type: "text", text: "red", styles: { textColor: "red" } }] },
    { type: "paragraph", content: "end" },
  ];

  it("read1 === read2, and the second document's colors match what the first write-back produced", async () => {
    const doc1 = await docWith(fixture);
    const md1 = await readMd(doc1);
    const blocks1 = await withSession(ed => parse(ed, md1));
    const doc2 = await docWith(blocks1);
    const md2 = await readMd(doc2);
    expect(md2).toBe(md1);
    // the colors were really written (not both sides losing everything and so being equal)
    for (const c of ["blue", "red", "pink", "purple", "gray", "orange", "brown", "yellow", "green"]) expect(shape(blocks1)).toContain(`"${c}"`);
    // the structure after the first write-back equals the second (colors not lost or drifting)
    const blocks2 = await withSession(ed => parse(ed, md2));
    expect(shape(blocks2)).toBe(shape(blocks1));
  });

  it("every color of the original document is in the document after read1 is written back (minus known lossy: nested child paragraphs are flattened)", async () => {
    const doc1 = await docWith(fixture);
    const orig = await withSession(ed => ed.document, doc1);
    const back = await withSession(ed => parse(ed, md1Of(ed)), doc1);
    const colorsOf = (bs: unknown) => (shape(bs).match(/"(textColor|backgroundColor)":"(?!default)[a-z]+"/g) ?? []).sort();
    expect(colorsOf(back)).toEqual(colorsOf(orig));
  });
});

const md1Of = (ed: Ed) => blocksToNoteMarkdown(ed, ed.document);

describe("columns", () => {
  // The verbatim form is pinned by note-markdown-goldens; here only that reading gives the div form with each column's text in one place.
  it("blocks containing a row read as the div form for columns", async () => {
    const md = await withSession(ed => {
      const blocks = [{
        id: "r", type: "columnList", children: [
          { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "ra", type: "paragraph", content: "左" }] },
          { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "rb", type: "paragraph", content: "右" }] },
        ],
      }];
      ed.replaceBlocks(ed.document, blocks as never);
      return blocksToNoteMarkdown(ed, ed.document);
    });
    expect(md.split("\n")[0]).toBe(COLUMNS_OPEN_TAG);
    expect(md.split(columnOpenTag(1)).length - 1).toBe(2);
    expect(md.split("左").length - 1).toBe(1);
    expect(md.split("右").length - 1).toBe(1);
  });
});
