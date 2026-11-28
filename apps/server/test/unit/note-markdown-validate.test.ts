// Columns: syntax checks for writes (`checkNoteMarkdownSyntax`, run on the DOM from `markdownToHTML`) and the structure check
// (`findStructureError`, run on blocks). Needs a DOM: reuses `rt.installGlobals()`.
import { readFileSync } from "node:fs";
import { markdownToHTML } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLUMNS_OPEN_TAG, checkNoteMarkdownSyntax, findStructureError, syntaxCheckRoot } from "@knotebook/shared";
import type { MarkdownPlacement } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();

const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; roundTrip: string; markdown: string }> };
const ROW2 = goldens.cases.find(c => c.id === "G1-cols-spec")!.markdown;
const OUTER_LINE = COLUMNS_OPEN_TAG;
const FIRST_COL_LINE = '<div data-kb-column style="flex:1">';

const chk = (md: string, placement: MarkdownPlacement = "top") => checkNoteMarkdownSyntax(md, placement);
const col = (w: string, body: string) => (body === "" ? `<div data-kb-column style="flex:${w}">\n\n</div>` : `<div data-kb-column style="flex:${w}">\n\n${body}\n\n</div>`);
const row = (...cols: string[]) => [OUTER_LINE, ...cols, "</div>"].join("\n") + "\n";
/** Replaces one line of ROW2 verbatim (asserting the original line occurs exactly once). */
const swapLine = (from: string, to: string): string => {
  const lines = ROW2.split("\n");
  expect(lines.filter(l => l === from)).toHaveLength(1);
  return lines.map(l => (l === from ? to : l)).join("\n");
};
const COLS = { ok: false, error: "unsupported_columns" } as const;
const SIZE = { ok: false, error: "unsupported_size" } as const;
const tableMd = (row1: string, row2: string) => `<table><tr>${row1}</tr><tr>${row2}</tr></table>\n`;

describe("media elements", () => {
  it.each([
    ['<embed src="/api/uploads/a" onload="x()">', "embed"],
    ['<video src="/api/uploads/a" onloadstart="x()"></video>', "video"],
    ['<figure><audio src="/api/uploads/a" onplay="x()"></audio><figcaption>c</figcaption></figure>', "audio in a figure"],
  ])("%s (%s) is refused like any other event-handler attribute", md => {
    expect(chk(md)).toEqual({ ok: false, error: "unsupported_block" });
  });

  it("the canonical read forms are accepted", () => {
    for (const md of [
      '<audio src="/api/uploads/a" data-name="a.mp3"></audio>',
      '<figure><video src="/api/uploads/a" data-name="v.mp4" width="320"></video><figcaption>c</figcaption></figure>',
      '<embed src="/api/uploads/a" data-name="a.pdf">',
    ]) expect(chk(md).ok, md).toBe(true);
  });
});

describe("accepted", () => {
  it("a row as read out -> ok, html is markdownToHTML of the unmarked original", () => {
    expect(ROW2.startsWith(`${OUTER_LINE}\n${FIRST_COL_LINE}\n`)).toBe(true);
    expect(chk(ROW2)).toEqual({ ok: true, html: markdownToHTML(ROW2) });
  });

  it("3 columns and 4 columns (widths 0.1/10/2.25)", () => {
    expect(chk(row(col("0.75", "a"), col("1", "b"), col("1.25", "c"))).ok).toBe(true);
    expect(chk(row(col("0.1", "a"), col("10", "b"), col("2.25", "c"), col("1", "d"))).ok).toBe(true);
  });

  it("empty column", () => {
    expect(chk(row(col("1", "a"), col("1", ""))).ok).toBe(true);
  });

  it("</div> directly after the last paragraph in a column (missing closing blank line)", () => {
    const md = ROW2.replace("型號：x\n\n</div>", "型號：x\n</div>");
    expect(md).not.toBe(ROW2);
    expect(chk(md).ok).toBe(true);
  });

  it("CRLF line breaks", () => {
    const md = ROW2.replace(/\n/g, "\r\n");
    expect(md).toContain(`${OUTER_LINE}\r\n`);
    expect(chk(md).ok).toBe(true);
  });

  it("non-canonical markers inside code blocks and inline code don't count", () => {
    const md = [
      "```html",
      "<div data-kb-columns>",
      '<div style="display:flex">',
      '<img src="/x" width="7">',
      '<p data-node-type="x">',
      "```",
      "",
      "行內 `<div data-kb-column>` 也是",
      "",
    ].join("\n");
    expect(chk(md).ok).toBe(true);
  });

  it.each([
    '<figure><img alt="a" src="/x" width="300"></figure>',
    '<figure><img src="/x" width="32"><figcaption>c</figcaption></figure>',
    '<figure data-background-color="red"><img src="/x" width="4000"></figure>',
  ])("figure image form is accepted: %s", md => {
    expect(chk(`${md}\n`).ok).toBe(true);
  });

  it("images whose attribute values contain a double quote, & or < (read-out of G2-img-escape; both serializations of an escaped or unescaped < in attribute values are accepted)", () => {
    const md = goldens.cases.find(c => c.id === "G2-img-escape")!.markdown;
    expect(md).toContain("<c>");
    expect(chk(md).ok).toBe(true);
    expect(chk(md.replace("<c>", "&lt;c&gt;")).ok).toBe(true);
  });

  it.each([
    tableMd('<th colwidth="120">a</th><th>b</th>', "<td>c</td><td>d</td>"),
    tableMd('<th colspan="2" colwidth="120,200">a</th>', "<td>c</td><td>d</td>"),
    tableMd('<th colspan="2" colwidth="120,">a</th>', "<td>c</td><td>d</td>"),
    tableMd('<th colspan="2" colwidth=",">a</th>', "<td>c</td><td>d</td>"),
    tableMd("<th>a</th><th>b</th>", '<td colspan="2" colwidth=",">c</td>'),
  ])("table colwidth form is accepted: %s", md => {
    expect(chk(md).ok).toBe(true);
  });

  it("div with display:block", () => {
    expect(chk('<div style="display:block">x</div>\n').ok).toBe(true);
  });

  it.each(goldens.cases.filter(c => c.roundTrip !== "skip").map(c => [c.id, c] as const))("read-out of golden %s passes the syntax check as-is (reject cases follow the expected code)", (_id, c) => {
    if (c.roundTrip.startsWith("reject:")) expect(chk(c.markdown)).toEqual({ ok: false, error: c.roundTrip.slice("reject:".length) });
    else expect(chk(c.markdown)).toMatchObject({ ok: true });
  });
});

describe("rejected: column markers must be on their own line and verbatim canonical", () => {
  it.each<[string, string]>([
    ["outer attribute order swapped", swapLine(OUTER_LINE, '<div style="display:flex;gap:16px" data-kb-columns>')],
    ["single quotes", swapLine(OUTER_LINE, "<div data-kb-columns style='display:flex;gap:16px'>")],
    ["an extra class", swapLine(OUTER_LINE, '<div data-kb-columns class="x" style="display:flex;gap:16px">')],
    ["uppercase", swapLine(OUTER_LINE, '<DIV DATA-KB-COLUMNS STYLE="display:flex;gap:16px">')],
    ["gap:8px", swapLine(OUTER_LINE, '<div data-kb-columns style="display:flex;gap:8px">')],
    ["column width flex:10.5", swapLine(FIRST_COL_LINE, '<div data-kb-column style="flex:10.5">')],
    ["one space before the outer line", swapLine(OUTER_LINE, ` ${OUTER_LINE}`)],
    ["x after the outer tag on the same line", swapLine(OUTER_LINE, `${OUTER_LINE}x`)],
    ["outer and first column open tag on the same line", ROW2.replace(`${OUTER_LINE}\n${FIRST_COL_LINE}\n`, `${OUTER_LINE}${FIRST_COL_LINE}\n`)],
    ["span with data-kb-column", "a <span data-kb-column>b</span> c\n"],
    ["forged marker", swapLine(OUTER_LINE, '<div data-kb-columns data-kb-line style="display:flex;gap:16px">')],
    ["forged marker (uppercase)", swapLine(OUTER_LINE, '<div data-kb-columns DATA-KB-LINE style="display:flex;gap:16px">')],
    // An unclosed open tag on the previous line merges with the canonical line into one tag (the marker is "borrowed")
    ["previous-line open div with class merges into the outer line", swapLine(OUTER_LINE, `<div class="x" data-x\n${OUTER_LINE}`)],
    ["previous-line open div with style=display:grid merges into the outer line", swapLine(OUTER_LINE, `<div style="display:grid"\n${OUTER_LINE}`)],
    ["previous-line open div with data-nesting-level merges into the outer line", swapLine(OUTER_LINE, `<div data-nesting-level="1"\n${OUTER_LINE}`)],
    ["previous-line open div with style=flex:5.555 merges into the column line", swapLine(FIRST_COL_LINE, `<div style="flex:5.555"\n${FIRST_COL_LINE}`)],
    ["previous-line open div with data-content-type merges into the column line", swapLine(FIRST_COL_LINE, `<div data-content-type="paragraph"\n${FIRST_COL_LINE}`)],
    // An unquoted attribute value on the previous line swallows the `<div` at the start of the canonical line (the attribute list still has three items)
    ["previous-line div data-kb-columns= merges into the outer line", swapLine(OUTER_LINE, `<div data-kb-columns=\n${OUTER_LINE}`)],
    ["previous-line div data-kb-column= merges into the column line", swapLine(FIRST_COL_LINE, `<div data-kb-column=\n${FIRST_COL_LINE}`)],
    ["previous-line section data-kb-columns= merges into the outer line", swapLine(OUTER_LINE, `<section data-kb-columns=\n${OUTER_LINE}`)],
  ])("%s -> unsupported_columns", (_name, md) => {
    expect(md).not.toBe(ROW2);
    expect(chk(md)).toEqual(COLS);
  });
});

describe("rejected: stray content, column counts, nested rows, layout divs", () => {
  it.each<[string, string]>([
    ["column open tag directly followed by ## H on the next line", row(`<div data-kb-column style="flex:1">\n## H\n\n</div>`, col("1", "b"))],
    ["only column lines, no outer line", `${col("1", "a")}\n${col("1", "b")}\n`],
    ["a stray paragraph between two columns", [OUTER_LINE, col("1", "a"), "", "stray", "", col("1", "b"), "</div>"].join("\n") + "\n"],
    ["a line with &nbsp; between the outer line and the column line (NBSP is not whitespace)", swapLine(OUTER_LINE, `${OUTER_LINE}\n&nbsp;`)],
    ["one column", row(col("1", "a"))],
    ["five columns", row(col("1", "a"), col("1", "b"), col("1", "c"), col("1", "d"), col("1", "e"))],
    ["a row placed inside column 2", row(col("1", "a"), col("1", ROW2.trimEnd()))],
    ["quote wrapping the row", ROW2.trimEnd().split("\n").map(l => (l === "" ? ">" : `> ${l}`)).join("\n") + "\n"],
    ["<details> wrapping the row", `<details>\n<summary>s</summary>\n\n${ROW2}\n</details>\n`],
    ["div with display:flex", '<div style="display:flex">\n\nx\n\n</div>\n'],
    ["DISPLAY: Grid", '<div style="DISPLAY: Grid">\n\nx\n\n</div>\n'],
  ])("%s -> unsupported_columns", (_name, md) => {
    expect(chk(md)).toEqual(COLS);
  });
});

describe("rejected: image width", () => {
  it.each<[string, string]>([
    ["bare img in a paragraph", 'x <img src="/x" width="300"> y\n'],
    ["width=300.5", '<figure><img src="/x" width="300.5"></figure>\n'],
    ["width=31", '<figure><img src="/x" width="31"></figure>\n'],
    ["width=4001", '<figure><img src="/x" width="4001"></figure>\n'],
    ["width=0300", '<figure><img src="/x" width="0300"></figure>\n'],
    ['width=""', '<figure><img src="/x" width=""></figure>\n'],
    ["src before alt", '<figure><img src="/x" alt="a" width="300"></figure>\n'],
    ["img with an extra data-name", '<figure><img alt="a" src="/x" width="300" data-name="n"></figure>\n'],
    ["figure with an extra class", '<figure class="c"><img src="/x" width="300"></figure>\n'],
    ["img with width inside a table cell", tableMd('<th><img src="/x" width="160"></th><th>b</th>', "<td>c</td><td>d</td>")],
    ["two imgs in a figure", '<figure><img src="/x" width="300"><img src="/y" width="300"></figure>\n'],
  ])("%s -> unsupported_size", (_name, md) => {
    expect(chk(md)).toEqual(SIZE);
  });
});

describe("rejected: table column widths", () => {
  it.each<[string, string]>([
    ["colwidth on a cell in the second row", tableMd('<th colwidth="120">a</th><th>b</th>', '<td colwidth="120">c</td><td>d</td>')],
    ["merged cell in the second row with a non-empty colwidth segment", tableMd("<th>a</th><th>b</th>", '<td colspan="2" colwidth="120,">c</td>')],
    ["120,abc", tableMd('<th colspan="2" colwidth="120,abc">a</th>', "<td>c</td><td>d</td>")],
    ["20", tableMd('<th colwidth="20">a</th><th>b</th>', "<td>c</td><td>d</td>")],
    ["colspan=2 with a single segment", tableMd('<th colspan="2" colwidth="120">a</th>', "<td>c</td><td>d</td>")],
    ["colspan=1 with two segments", tableMd('<th colspan="1" colwidth=",">a</th><th>b</th>', "<td>c</td><td>d</td>")],
    ["trailing whitespace", tableMd('<th colwidth="120 ">a</th><th>b</th>', "<td>c</td><td>d</td>")],
  ])("%s -> unsupported_size", (_name, md) => {
    expect(chk(md)).toEqual(SIZE);
  });
});

// The check and BlockNote's parse must build the tree in the same fragment context. In a `<template>` context a leading `<col>` drops every following token,
// and a leading `<caption>`/`<td>`/`<th>` swallows the row into a cell; BlockNote (a div from createHTMLDocument) still parses the rest normally.
// With a leading `<frameset>`, parsing a whole document (the `DOMParser` body) lets the frameset replace the body so the row isn't visible, while the div fragment context works as usual.
const FLEX_DIV = '<div style="display:flex">\n\nx\n\n</div>\n';
const ROW3_FIG = row(col("1", "a"), col("2.5", "b"), col("1", "c")) + '\n<figure><img src="/x" width="300"></figure>\n';
const LEADS = ["col", "caption", "td", "th", "frameset"] as const;

describe("fragment context: the DOM the check sees matches the parse", () => {
  it("leading <col> followed by a display:flex div -> unsupported_columns", () => {
    expect(chk(`<col>\n\n${FLEX_DIV}`)).toEqual(COLS);
  });

  it("leading <col> followed by a row with a non-canonical outer style -> unsupported_columns", () => {
    expect(chk(`<col>\n\n${swapLine(OUTER_LINE, '<div data-kb-columns style="display:grid">')}`)).toEqual(COLS);
  });

  it("leading <col> followed by a bare img with width inside a paragraph -> unsupported_size", () => {
    expect(chk('<col>\n\nx <img src="/x" width="300"> y\n')).toEqual(SIZE);
  });

  it.each(["caption", "td", "th"])("leading <%s> followed by a canonical row -> accepted (not wrongly rejected)", t => {
    expect(chk(`<${t}>\n\n${ROW2}`)).toMatchObject({ ok: true });
  });

  // Comparison: the top-level rows the check sees in its root (columns per row) and the number of images with width must equal the top-level columnList
  // (columns per row) and the number of images with previewWidth that BlockNote really parsed. If BlockNote changes how it builds the tree, this goes red first.
  it.each(LEADS.flatMap(t => [[t, "ROW2", ROW2], [t, "ROW3_FIG", ROW3_FIG]] as const))("leading <%s> followed by %s -> what the check sees equals what the parse produces", async (t, _name, body) => {
    const html = markdownToHTML(`<${t}>\n\n${body}`);
    const root = syntaxCheckRoot(html);
    const seen = {
      rows: Array.from(root.children).filter(el => el.tagName === "DIV" && el.hasAttribute("data-kb-columns")).map(r => Array.from(r.children).filter(c => c.hasAttribute("data-kb-column")).length),
      sized: root.querySelectorAll("img[width]").length,
    };
    const s = await EditorSession.open(rt, new Y.Doc());
    try {
      const blocks = s.editor.tryParseHTMLToBlocks(html) as B[];
      const sizedImages = (bs: B[]): number => bs.reduce((n, b) => n + (b.type === "image" && b.props?.previewWidth !== undefined ? 1 : 0) + sizedImages(b.children ?? []), 0);
      const parsed = {
        rows: blocks.filter(b => b.type === "columnList").map(b => b.children.length),
        sized: sizedImages(blocks),
      };
      expect(seen).toEqual(parsed);
      expect(parsed.rows.length).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("rejected: editor-internal markup, placement and order", () => {
  it("paragraph with data-node-type", () => {
    expect(chk('<p data-node-type="x">y</p>\n')).toEqual(COLS);
  });

  it("in-editor form of columnList", () => {
    const md =
      '<div data-node-type="columnList"><div data-node-type="column" data-width="1"><p>a</p></div><div data-node-type="column" data-width="1"><p>b</p></div></div>\n';
    expect(chk(md)).toEqual(COLS);
  });

  it("a row in a nested position -> unsupported_columns", () => {
    expect(chk(ROW2)).toMatchObject({ ok: true });
    expect(chk(ROW2, "nested")).toEqual(COLS);
  });

  it("a figure image in a nested position is accepted", () => {
    expect(chk('<figure><img src="/x" width="300"></figure>', "nested").ok).toBe(true);
  });

  it("precedence: a div with a layout violation and a bad width in the same write -> unsupported_columns", () => {
    const md = '<figure><img src="/x" width="31"></figure>\n\n<div style="display:flex">\n\nx\n\n</div>\n';
    expect(chk(md)).toEqual(COLS);
  });
});

// HTML with event-handler attributes (`onerror` etc.) -> `unsupported_block`, before the columns and size checks.
// The code is unsupported_block because the unsupported_columns message is "layout or editor-internal HTML", which an event-handler attribute is neither.
describe("event-handler attributes", () => {
  const BLOCK = { ok: false, error: "unsupported_block" } as const;
  it.each([
    ["img onerror in a paragraph", '<img src="x" onerror="alert(1)">\n'],
    ["img onerror inside <details>", '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>\n'],
    ["img onerror inside a figure (the rest in canonical form)", '<figure><img alt="a" src="/x" width="300" onerror="alert(1)"></figure>\n'],
    ["p onclick", '<p onclick="x()">t</p>\n'],
    ["svg onload", '<svg onload="x()"></svg>\n'],
    ["uppercase ONERROR", '<IMG SRC="x" ONERROR="x()">\n'],
    ["onmouseover inside a column", row(col("1", '<p onmouseover="x()">a</p>'), col("1", "b"))],
    ["a write that also contains a layout div (event-handler attributes are judged first)", '<div style="display:flex"><img src="x" onerror="x()"></div>\n'],
    // Only the name counts: self-made attributes starting with on are rejected too (the read-out form doesn't produce them), so server and browser reject the same set
    ["self-made attribute names starting with on (only, one)", '<span only="1" one="2">x</span>\n'],
    // In jsdom the following three shapes have no matching IDL member (the old `n in el` accepted them on the server)
    ["p onanimationstart", '<p onanimationstart="x()">t</p>\n'],
    ["math onclick", '<math onclick="x()"><mi>x</mi></math>\n'],
    ["svg animate onbegin", '<svg><animate onbegin="x()"></animate></svg>\n'],
  ])("%s -> unsupported_block", (_name, md) => {
    expect(chk(md)).toEqual(BLOCK);
    expect(chk(md, "nested")).toEqual(BLOCK);
  });
  it.each([
    ["<details open>", "<details open><summary>s</summary><p>x</p></details>\n"],
    ["only= and onerror= inside text", "only=1 and onerror=alert(1) as text\n"],
    ["img onerror inside a code block and inline code", '```\n<img src="x" onerror="x()">\n```\n\n`<img onerror="x()">`\n'],
    ["?onload= in a URL (an attribute value, not an attribute name)", '![x](/a.png?onload=1)\n\n[l](/x?onload=1)\n\n<a href="/x?onload=1">l</a>\n\n<figure><img alt="a" src="/x?onload=1" width="300"></figure>\n'],
    ["only= and onerror= inside an attribute value", '<span title="only=1 onerror=x">t</span>\n'],
  ])("%s -> ok", (_name, md) => {
    expect(chk(md).ok).toBe(true);
  });
  it("no golden's markdown is blocked by this check", () => {
    const hits = goldens.cases.filter(c => {
      const r = chk(c.markdown);
      return !r.ok && r.error === "unsupported_block";
    });
    expect(hits.map(c => c.id)).toEqual([]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built Block JSON
type B = any;
const P = (text = "p", children: B[] = []): B => ({ type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children });
const C = (width: number, children: B[] = [P()]): B => ({ type: "column", props: { width }, content: undefined, children });
const L = (...cols: B[]): B => ({ type: "columnList", props: {}, content: undefined, children: cols });
const IMG = (previewWidth: number | undefined): B => ({ type: "image", props: { url: "/x", name: "", previewWidth }, children: [] });
const T = (columnWidths: Array<number | undefined | null>): B => ({ type: "table", props: {}, content: { type: "tableContent", columnWidths, rows: [] }, children: [] });

describe("structure check findStructureError", () => {
  it("a columnList inside a paragraph's children -> columns", () => {
    expect(findStructureError([P("p", [L(C(1), C(1))])], "top")).toBe("unsupported_columns");
  });

  it("columnList with one column or five columns -> columns", () => {
    expect(findStructureError([L(C(1))], "top")).toBe("unsupported_columns");
    expect(findStructureError([L(C(1), C(1), C(1), C(1), C(1))], "top")).toBe("unsupported_columns");
  });

  it("columnList whose children include a non-column -> columns", () => {
    expect(findStructureError([L(C(1), P())], "top")).toBe("unsupported_columns");
  });

  it("a top-level orphan column -> columns", () => {
    expect(findStructureError([C(1)], "top")).toBe("unsupported_columns");
  });

  it.each([0.05, 11])("column width %s -> columns", w => {
    expect(findStructureError([L(C(1), C(w))], "top")).toBe("unsupported_columns");
  });

  it("a columnList inside a column -> columns", () => {
    expect(findStructureError([L(C(1, [L(C(1), C(1))]), C(1))], "top")).toBe("unsupported_columns");
  });

  it("a top-level columnList with placement nested -> columns", () => {
    expect(findStructureError([L(C(1), C(1))], "top")).toBeNull();
    expect(findStructureError([L(C(1), C(1))], "nested")).toBe("unsupported_columns");
  });

  it.each([31, 4001, 300.5])("image previewWidth %s -> size", w => {
    expect(findStructureError([IMG(w)], "top")).toBe("unsupported_size");
  });

  it.each([31, 4001, 300.5])("video previewWidth %s -> size, same rule as an image", w => {
    expect(findStructureError([{ type: "video", props: { url: "/x", previewWidth: w } }], "top")).toBe("unsupported_size");
  });

  it("video previewWidth 300 or none -> null", () => {
    expect(findStructureError([{ type: "video", props: { url: "/x", previewWidth: 300 } }, { type: "video", props: { url: "/x" } }], "top")).toBeNull();
  });

  it("table columnWidths [10] -> size", () => {
    expect(findStructureError([T([10])], "top")).toBe("unsupported_size");
  });

  it("table columnWidths [NaN] (not normalized first) -> size", () => {
    expect(findStructureError([T([NaN])], "top")).toBe("unsupported_size");
  });

  it("precedence: both columns and size violated -> columns (even if size is reached first)", () => {
    expect(findStructureError([L(C(1)), IMG(31)], "top")).toBe("unsupported_columns");
  });

  it("valid: a two-column row, image 300, table [120, undefined] -> null", () => {
    expect(findStructureError([L(C(1, [IMG(300)]), C(1.5, [T([120, undefined])])), IMG(undefined), T([null, 4000])], "top")).toBeNull();
  });

  it("a children chain 100,000 levels deep -> null, no exception", () => {
    const root = P();
    let cur = root;
    for (let i = 0; i < 100_000; i++) {
      const next = P();
      cur.children.push(next);
      cur = next;
    }
    expect(findStructureError([root], "top")).toBeNull();
  });
});
