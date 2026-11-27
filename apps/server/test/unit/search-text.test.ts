/** #93: full-text index extractor. Pure functions, no DB. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, sectionize } from "@knotebook/shared";
import {
  SEARCH_EXTRACTOR_VERSION,
  SEARCH_INDEX_NOTE_MAX,
  SEARCH_INDEX_SECTIONS_MAX,
  extractSearchSections,
  searchContentHash,
} from "../../src/notes/search-text.js";
import { frag, searchDoc, type Blk } from "../search-doc.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function editorDoc(blocks: Array<Record<string, unknown>>): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
// golden values captured by running the code before topLevelBlocks was changed
// Hash of the same rows under the previous extractor version: the rows of a document without math did not change, only the version in the hash did.
const GOLDEN_HASH_V2 = "01dbcb87f9d4075de27636b598be9980503470e31176ba28a45069a7cad984d6";
const GOLDEN_HASH = "5a0c067f57ee59e2fdfa470667c22796c45198e12075de3cfefd9fccd2e7d23d";
const colRow = (id: string, cols: Array<Array<Record<string, unknown>>>) => ({
  id,
  type: "columnList",
  children: cols.map((children, i) => ({ id: `${id}c${i}`, type: "column", props: { width: 1 }, children })),
});

const ids = (b: Blk[]) => extractSearchSections(frag(searchDoc(b))).rows.map(r => r.sectionId);
const bodyOf = (b: Blk[], sectionId: string) => extractSearchSections(frag(searchDoc(b))).rows.find(r => r.sectionId === sectionId)?.body;

describe("columns (top-level unit expansion)", () => {
  it("an existing document without columns keeps a byte-identical contentHash (golden)", async () => {
    const doc = await editorDoc([
      { id: "ha", type: "heading", props: { level: 1 }, content: "A" },
      { id: "p1", type: "paragraph", content: "段落一" },
      { id: "li", type: "bulletListItem", content: "清單", children: [{ id: "li2", type: "bulletListItem", content: "子項" }] },
      { id: "tb", type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }, { cells: ["c", "d"] }] } },
      { id: "hb", type: "heading", props: { level: 1 }, content: "B" },
      { id: "p2", type: "paragraph", content: "段落二" },
    ]);
    const ex = extractSearchSections(frag(doc));
    expect(ex.contentHash).toBe(GOLDEN_HASH);
    expect(searchContentHash(2, ex.rows, ex.capped)).toBe(GOLDEN_HASH_V2);
  });

  it("both column texts of a row go into _top's body; a heading inside a column is in the body too, not a separate section", async () => {
    const doc = await editorDoc([
      colRow("r", [
        [{ id: "a", type: "paragraph", content: "左欄字" }],
        [{ id: "h", type: "heading", props: { level: 1 }, content: "欄內標題" }, { id: "b", type: "paragraph", content: "右欄字" }],
      ]),
    ]);
    const { rows } = extractSearchSections(frag(doc));
    expect(rows.map(r => r.sectionId)).toEqual(["_top"]);
    const body = rows[0]!.body;
    expect(body).toContain("左欄字");
    expect(body).toContain("右欄字");
    expect(body).toContain("欄內標題");
  });
});

describe("depth (extractor)", () => {
  // The chain must be built inside one doc.transact: inserting one by one opens a transaction each time and the closing cost grows with depth, so the whole chain is O(n^2)
  // (on CI this stretch alone runs 52-68 s synchronously; past 60 s the worker misses the reply to vitest's onTaskUpdate RPC -> Unhandled Error, exit 1).
  // A single transaction builds the same tree quickly.
  it("a chain 20 000 blockContainers deep -> does not throw; the deepest text appears in the body", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const group = new Y.XmlElement("blockGroup");
      doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
      const top = new Y.XmlElement("blockContainer");
      group.insert(0, [top]);
      top.setAttribute("id", "deep");
      let parent = top;
      for (let i = 0; i < 20_000; i += 1) {
        const child = new Y.XmlElement("blockContainer");
        parent.insert(0, [child]);
        parent = child;
      }
      const leaf = new Y.XmlElement("paragraph");
      parent.insert(0, [leaf]);
      const t = new Y.XmlText();
      leaf.insert(0, [t]);
      t.insert(0, "DEEPEST");
    });
    const ex = extractSearchSections(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(ex.rows).toHaveLength(1);
    expect(ex.rows[0]!.body).toContain("DEEPEST");
  });
});

describe("section mapping", () => {
  const blocks: Blk[] = [
    { id: "p0", text: "foo" },
    { id: "p1", text: "bar" },
    { id: "h1", type: "heading", text: "Alpha" },
    { id: "p2", text: "alpha body" },
    { id: "h2", type: "heading", text: "Beta" },
    { id: "p3", text: "beta body" },
  ];
  it("sectionId/ord match sectionize; each section's body contains only its own text", () => {
    const f = frag(searchDoc(blocks));
    const ex = extractSearchSections(f);
    const outline = sectionize(f);
    expect(ex.rows.map(r => [r.sectionId, r.ord])).toEqual(outline.map((s, k) => [s.sectionId, k]));
    expect(ex.rows.map(r => r.heading)).toEqual(outline.map(s => s.heading));
    expect(bodyOf(blocks, "h1")).toBe("Alpha\nalpha body");
    expect(bodyOf(blocks, "h2")).toBe("Beta\nbeta body");
  });
  it("exactly one separator between adjacent blocks: paragraphs 'foo' and 'bar' do not produce foobar", () => {
    expect(bodyOf(blocks, "_top")).toBe("foo\nbar");
    expect(bodyOf(blocks, "_top")).not.toContain("foobar");
  });
  it("an empty paragraph adds no extra separator; a section with structure but no text is not indexed", () => {
    expect(bodyOf([{ id: "a", text: "x" }, { id: "b" }, { id: "c", text: "y" }], "_top")).toBe("x\ny");
    expect(ids([{ id: "h", type: "heading" }, { id: "p" }])).toEqual([]);
  });
  it("ord counts skipped sections: when _top is empty the first heading section has ord 1", () => {
    expect(extractSearchSections(frag(searchDoc([{ id: "h", type: "heading", text: "H" }]))).rows.map(r => r.ord)).toEqual([1]);
  });
});

describe("traversal rules", () => {
  it("#269: wikilink -> label or snapshotTitle (no brackets; children not expanded; non-string -> empty); inline adds no separator", () => {
    expect(bodyOf([{ id: "p", inline: ["see ", { wikilink: "Roadmap" }, " now"] }], "_top")).toBe("see Roadmap now");
    expect(bodyOf([{ id: "p", inline: ["see ", { wikilink: "Roadmap", label: "the plan" }, " now"] }], "_top")).toBe("see the plan now");
    expect(bodyOf([{ id: "p", inline: ["see ", { wikilink: "Roadmap", label: "" }, " now"] }], "_top")).toBe("see Roadmap now");
    expect(bodyOf([{ id: "p", inline: ["x", { wikilink: 42 }] }], "_top")).toBe("x");
  });
  it("SEARCH_EXTRACTOR_VERSION is 3 (math blocks are indexed, so the startup backfill rebuilds existing indexes)", () => {
    expect(SEARCH_EXTRACTOR_VERSION).toBe(3);
  });
  it("wikilink children (XmlText) are not expanded: only snapshotTitle is output", () => {
    const doc = searchDoc([{ id: "p", inline: ["a", { wikilink: "T" }, "b"] }]);
    const para = ((frag(doc).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const w = para.get(1) as Y.XmlElement;
    expect(w.nodeName).toBe("wikilink");
    const hidden = new Y.XmlText();
    w.insert(0, [hidden]);
    hidden.insert(0, "HIDDEN");
    const body = extractSearchSections(frag(doc)).rows[0]!.body;
    expect(body).not.toContain("HIDDEN");
    expect(body).toBe("aTb");
  });
  it("a math tex property goes into the body", () => {
    const b: Blk[] = [
      { id: "p", text: "before" },
      { id: "t", type: "math", attrs: { tex: "\\frac{MATHX}{2}" } },
      { id: "q", text: "after" },
    ];
    expect(bodyOf(b, "_top")).toBe("before\n\\frac{MATHX}{2}\nafter");
  });
  it("a math block with an empty or non-string tex adds nothing", () => {
    expect(bodyOf([{ id: "p", text: "a" }, { id: "t", type: "math", attrs: { tex: "" } }, { id: "q", text: "b" }], "_top")).toBe("a\nb");
    expect(bodyOf([{ id: "p", text: "a" }, { id: "t", type: "math", attrs: { tex: 5 } }, { id: "q", text: "b" }], "_top")).toBe("a\nb");
  });
  it("a mermaid code property goes into the body; codeBlock text goes in; an image's caption/url do not", () => {
    const b: Blk[] = [
      { id: "p", text: "before" },
      { id: "m", type: "mermaid", attrs: { code: "graph TD; A-->MERMAIDX" } },
      { id: "c", type: "codeBlock", text: "const CODEX = 1;" },
      { id: "i", type: "image", attrs: { url: "https://example.com/URLX.png", caption: "CAPTIONX", name: "NAMEX" } },
    ];
    const body = bodyOf(b, "_top")!;
    expect(body).toBe("before\ngraph TD; A-->MERMAIDX\nconst CODEX = 1;");
    expect(body).not.toMatch(/CAPTIONX|URLX|NAMEX/);
  });
  it("a nested block (child blockGroup) follows its parent block after a separator", () => {
    const doc = searchDoc([{ id: "p", text: "parent" }]);
    const c = frag(doc).get(0) as Y.XmlElement;
    const container = c.get(0) as Y.XmlElement;
    const inner = new Y.XmlElement("blockGroup");
    container.insert(1, [inner]);
    const nc = new Y.XmlElement("blockContainer");
    inner.insert(0, [nc]);
    nc.setAttribute("id", "child");
    const np = new Y.XmlElement("paragraph");
    nc.insert(0, [np]);
    const t = new Y.XmlText();
    np.insert(0, [t]);
    t.insert(0, "child");
    expect(extractSearchSections(frag(doc)).rows[0]!.body).toBe("parent\nchild");
  });
});

describe("hostile ids", () => {
  it("duplicate section ids -> only the first occurrence is indexed (words unique to the second cannot be found)", () => {
    const b: Blk[] = [
      { id: "dup", type: "heading", text: "First" },
      { id: "p1", text: "one" },
      { id: "dup", type: "heading", text: "Second" },
      { id: "p2", text: "UNIQUE2" },
    ];
    expect(ids(b)).toEqual(["dup"]);
    expect(extractSearchSections(frag(searchDoc(b))).rows.map(r => r.body).join("\n")).not.toContain("UNIQUE2");
  });
  it("an id first seen on an **empty section** and reused by a later non-empty one -> the later one is not indexed (read_note_section reads the former)", () => {
    const b: Blk[] = [
      { id: "dup", type: "heading", text: "" },
      { id: "x", type: "heading", text: "Other" },
      { id: "dup", type: "heading", text: "Real" },
      { id: "p", text: "SHOULDNOTINDEX" },
    ];
    expect(ids(b)).toEqual(["x"]);
  });
  it("an over-long id, one containing /, or one containing NUL on a heading -> that section is not indexed; _top still is", () => {
    for (const bad of ["x".repeat(65), "a/b", "a\u0000b"]) {
      expect(ids([{ id: "p", text: "top" }, { id: bad, type: "heading", text: "H" }, { id: "q", text: "body" }]), bad).toEqual(["_top"]);
    }
  });
  it("a heading block whose id is literally _top -> that section is not indexed (_top is the first section)", () => {
    expect(ids([{ id: "p", text: "top" }, { id: "_top", type: "heading", text: "H" }, { id: "q", text: "body" }])).toEqual(["_top"]);
  });
  it("a non-heading container with the same id as a later section's heading -> that section is still indexed (it is not a section id)", () => {
    expect(ids([{ id: "same", text: "para" }, { id: "same", type: "heading", text: "H" }, { id: "q", text: "body" }])).toEqual(["_top", "same"]);
  });
  it("any top-level container whose id is a number, an empty string or missing -> 0 rows for the whole note, capped, indexedUnits 0", () => {
    for (const bad of [123, "", undefined]) {
      const ex = extractSearchSections(frag(searchDoc([{ id: "p", text: "ok" }, { id: bad, text: "x" }])));
      expect(ex, String(bad)).toMatchObject({ rows: [], capped: true, indexedUnits: 0 });
    }
  });
});

describe("sanitising", () => {
  it("NUL and lone surrogates in text, headings and wikilink titles -> U+FFFD; paired surrogates unchanged", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", inline: ["a\u0000b \uD800 \uDC00 😀 ", { wikilink: "w\u0000t" }] },
      { id: "h", type: "heading", text: "H\u0000\uDFFF" },
    ])));
    expect(ex.rows[0]!.body).toBe("a�b � � 😀 w�t");
    expect(ex.rows[1]!.heading).toBe("H��");
    expect(ex.rows[1]!.body).toBe("H��");
  });
});

describe("limits", () => {
  it("body totalling 1 048 577 -> indexedUnits exactly at the limit, capped, later sections not indexed", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", text: "x".repeat(SEARCH_INDEX_NOTE_MAX + 1) },
      { id: "h", type: "heading", text: "after" },
    ])));
    expect(ex.rows.map(r => r.sectionId)).toEqual(["_top"]);
    expect(ex.rows[0]!.body.length).toBe(SEARCH_INDEX_NOTE_MAX);
    expect(ex).toMatchObject({ indexedUnits: SEARCH_INDEX_NOTE_MAX, capped: true });
  });
  it("a cut point inside a surrogate pair backs off one unit; the one unit left after backing off is not given to later sections (later sections are not indexed)", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", text: `${"x".repeat(SEARCH_INDEX_NOTE_MAX - 1)}😀` },
      { id: "h", type: "heading", text: "a" },
    ])));
    expect(ex.rows.map(r => r.sectionId)).toEqual(["_top"]);
    expect(ex.rows[0]!.body.length).toBe(SEARCH_INDEX_NOTE_MAX - 1);
    expect(ex.capped).toBe(true);
  });
  it("a section truncated to 0 (only half a surrogate pair of room left) -> later sections are not indexed either", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", text: "x".repeat(SEARCH_INDEX_NOTE_MAX - 1) },
      { id: "h", type: "heading", text: "😀zz" },
      { id: "k", type: "heading", text: "b" },
    ])));
    expect(ex.rows.map(r => r.sectionId)).toEqual(["_top"]);
    expect(ex).toMatchObject({ indexedUnits: SEARCH_INDEX_NOTE_MAX - 1, capped: true });
  });
  it("2001 non-empty paragraphs -> 2000 rows, capped; exactly 2000 -> 2000 rows, not capped", () => {
    const heads = (n: number): Blk[] => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, type: "heading", text: `h${i}` }));
    const over = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX + 1))));
    expect(over.rows).toHaveLength(SEARCH_INDEX_SECTIONS_MAX);
    expect(over.capped).toBe(true);
    expect(over.rows.at(-1)!.sectionId).toBe(`h${SEARCH_INDEX_SECTIONS_MAX - 1}`);
    const exact = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX))));
    expect(exact.rows).toHaveLength(SEARCH_INDEX_SECTIONS_MAX);
    expect(exact.capped).toBe(false);
  });
  it("heading 1001 -> stored as 1000; a cut point inside a surrogate pair backs off one unit (body is not truncated)", () => {
    const a = extractSearchSections(frag(searchDoc([{ id: "h", type: "heading", text: "h".repeat(1001) }]))).rows[0]!;
    expect(a.heading.length).toBe(1000);
    expect(a.body.length).toBe(1001);
    const b = extractSearchSections(frag(searchDoc([{ id: "h", type: "heading", text: `${"h".repeat(999)}😀` }]))).rows[0]!;
    expect(b.heading).toBe("h".repeat(999));
  });
});

describe("hashing", () => {
  const b: Blk[] = [{ id: "p", text: "same content" }];
  it("same content, same hash; changing one character -> different", () => {
    const h1 = extractSearchSections(frag(searchDoc(b))).contentHash;
    expect(extractSearchSections(frag(searchDoc(b))).contentHash).toBe(h1);
    expect(extractSearchSections(frag(searchDoc([{ id: "p", text: "same contenT" }]))).contentHash).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changing the extractor version -> different; the extractorVersion column equals the constant", () => {
    const ex = extractSearchSections(frag(searchDoc(b)));
    expect(ex.extractorVersion).toBe(SEARCH_EXTRACTOR_VERSION);
    expect(searchContentHash(SEARCH_EXTRACTOR_VERSION, ex.rows, ex.capped)).toBe(ex.contentHash);
    expect(searchContentHash(SEARCH_EXTRACTOR_VERSION + 1, ex.rows, ex.capped)).not.toBe(ex.contentHash);
  });
  it("same rows, only capped differs -> different hash (2000 -> 2001 sections; empty note -> one with an empty-id container)", () => {
    const heads = (n: number): Blk[] => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, type: "heading", text: `h${i}` }));
    const exact = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX))));
    const over = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX + 1))));
    expect(over.rows).toEqual(exact.rows);
    expect([exact.capped, over.capped]).toEqual([false, true]);
    expect(over.contentHash).not.toBe(exact.contentHash);
    const empty = extractSearchSections(frag(searchDoc([{ id: "p" }])));
    const badId = extractSearchSections(frag(searchDoc([{ id: "", text: "x" }])));
    expect([empty.rows, badId.rows]).toEqual([[], []]);
    expect([empty.capped, badId.capped]).toEqual([false, true]);
    expect(badId.contentHash).not.toBe(empty.contentHash);
  }, { timeout: 120_000 });
});
