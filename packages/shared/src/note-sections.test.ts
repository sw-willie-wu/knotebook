import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "./ydoc.js";
import { canonicalizeElements, canonicalizeSection, sectionize, TOP_SECTION_ID, topLevelBlocks, topLevelIdsOf } from "./note-sections.js";

function makeDoc(blocks: Array<{ id: string; type: "paragraph" | "heading"; text: string; level?: number; nested?: Array<{ id: string; type: "heading"; text: string; level: number }> }>): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const group = new Y.XmlElement("blockGroup");
  fragment.insert(0, [group]);
  let i = 0;
  for (const b of blocks) {
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", b.id);
    const content = new Y.XmlElement(b.type);
    if (b.type === "heading") content.setAttribute("level", String(b.level ?? 1));
    const text = new Y.XmlText();
    text.insert(0, b.text);
    content.insert(0, [text]);
    container.insert(0, [content]);
    if (b.nested) {
      const inner = new Y.XmlElement("blockGroup");
      for (const n of b.nested) {
        const c = new Y.XmlElement("blockContainer");
        c.setAttribute("id", n.id);
        const h = new Y.XmlElement("heading");
        h.setAttribute("level", String(n.level));
        const t = new Y.XmlText(); t.insert(0, n.text); h.insert(0, [t]);
        c.insert(0, [h]);
        inner.insert(inner.length, [c]);
      }
      container.insert(1, [inner]);
    }
    group.insert(i++, [container]);
  }
  return doc;
}

describe("sectionize", () => {
  it("no heading -> only _top, containing all blocks", () => {
    const doc = makeDoc([{ id: "a", type: "paragraph", text: "x" }, { id: "b", type: "paragraph", text: "y" }]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))).toEqual([{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 2, blockIds: ["a", "b"] }]);
  });

  it("h2 -> h3 -> h2: h3 folds into h2's section; the next h2 opens a new section; chars accumulate", () => {
    const doc = makeDoc([
      { id: "p0", type: "paragraph", text: "intro" },
      { id: "h1", type: "heading", level: 2, text: "A" },
      { id: "p1", type: "paragraph", text: "a1" },
      { id: "h2", type: "heading", level: 3, text: "A.1" },
      { id: "p2", type: "paragraph", text: "a2" },
      { id: "h3", type: "heading", level: 2, text: "B" },
      { id: "p3", type: "paragraph", text: "b1" },
    ]);
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s.map(x => [x.sectionId, x.blockIds])).toEqual([[TOP_SECTION_ID, ["p0"]], ["h1", ["h1", "p1", "h2", "p2"]], ["h3", ["h3", "p3"]]]);
    expect(s[1]).toMatchObject({ level: 2, heading: "A", chars: 1 + 2 + 3 + 2 });
  });

  it("consecutive headings each form a section; a heading at the end is a section containing only itself", () => {
    const doc = makeDoc([{ id: "h1", type: "heading", level: 1, text: "A" }, { id: "h2", type: "heading", level: 1, text: "B" }]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT)).map(x => x.blockIds)).toEqual([[], ["h1"], ["h2"]]);
  });

  it("heading first -> outline[0] is _top, 0 blocks, chars 0", () => {
    const doc = makeDoc([{ id: "h1", type: "heading", level: 1, text: "A" }]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))[0]).toEqual({ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0, blockIds: [] });
  });

  it("empty document (no blockGroup) -> only an empty _top", () => {
    const doc = new Y.Doc();
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))).toEqual([{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0, blockIds: [] }]);
  });

  it("a heading inside a nested blockContainer does not start a section", () => {
    const doc = makeDoc([
      { id: "h1", type: "heading", level: 1, text: "A" },
      { id: "p1", type: "paragraph", text: "li", nested: [{ id: "n1", type: "heading", level: 1, text: "inner" }] },
    ]);
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s.map(x => x.sectionId)).toEqual([TOP_SECTION_ID, "h1"]);
    expect(s[1]!.blockIds).toEqual(["h1", "p1"]);
  });

  it("a lower-case blockgroup fake structure does not form a section (nodeName is camelCase)", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockgroup");
    const c = new Y.XmlElement("blockcontainer"); c.setAttribute("id", "x");
    group.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    expect(topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))).toEqual([]);
  });

  it("chars counts plain text: heading text counts, bold marks do not", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", "a");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText(); t.insert(0, "ab", { bold: true }); t.insert(2, "cd");
    p.insert(0, [t]); c.insert(0, [p]); group.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))[0]!.chars).toBe(4);
  });
});

describe("canonicalize", () => {
  const withId = (id: string, text: string, attrs: Record<string, string> = {}) => {
    const doc = makeDoc([{ id, type: "paragraph", text }]);
    const el = topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))[0]!;
    for (const [k, v] of Object.entries(attrs)) (el.get(0) as Y.XmlElement).setAttribute(k, v);
    return el;
  };
  const mk = (fn: (t: Y.XmlText) => void) => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup"); const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", "a");
    const p = new Y.XmlElement("paragraph"); const t = new Y.XmlText(); fn(t); p.insert(0, [t]); c.insert(0, [p]); g.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    return topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))[0]!;
  };

  it("same content, different ids -> equal; changing one character -> different", () => {
    expect(canonicalizeElements([withId("a", "hi")])).toBe(canonicalizeElements([withId("b", "hi")]));
    expect(canonicalizeElements([withId("a", "hi")])).not.toBe(canonicalizeElements([withId("a", "ho")]));
  });

  it("attribute key order does not matter", () => {
    const x = withId("a", "t", { textAlignment: "left", backgroundColor: "default" });
    const y = withId("a", "t", { backgroundColor: "default", textAlignment: "left" });
    expect(canonicalizeElements([x])).toBe(canonicalizeElements([y]));
  });

  it("a bold mark matters; a link href matters, the key order of a mark's attribute object does not; a null value inside a mark object matters", () => {
    const plain = mk(t => t.insert(0, "x"));
    const bold = mk(t => t.insert(0, "x", { bold: {} }));
    expect(canonicalizeElements([plain])).not.toBe(canonicalizeElements([bold]));
    const l1 = mk(t => t.insert(0, "x", { link: { href: "https://a", target: "_blank" } }));
    const l2 = mk(t => t.insert(0, "x", { link: { target: "_blank", href: "https://a" } }));
    const l3 = mk(t => t.insert(0, "x", { link: { href: "https://b", target: "_blank" } }));
    expect(canonicalizeElements([l1])).toBe(canonicalizeElements([l2]));
    expect(canonicalizeElements([l1])).not.toBe(canonicalizeElements([l3]));
    // yjs 13.6.32 skips a top-level `{ link: null }` entirely (insertAttributes' equalAttrs(null, null)), so null can only be tested inside the mark object
    const nestedNull = mk(t => t.insert(0, "x", { link: { href: "https://a", target: null } }));
    const noTarget = mk(t => t.insert(0, "x", { link: { href: "https://a" } }));
    expect(canonicalizeElements([nestedNull])).not.toBe(canonicalizeElements([noTarget]));
  });

  it("canonicalizeSection: an id not at top level or reordered -> null; empty -> \"\"", () => {
    const doc = makeDoc([{ id: "a", type: "paragraph", text: "1" }, { id: "b", type: "paragraph", text: "2" }]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(canonicalizeSection(f, ["a", "b"])).toBeTypeOf("string");
    expect(canonicalizeSection(f, ["b", "a"])).toBeNull();
    expect(canonicalizeSection(f, ["a", "zzz"])).toBeNull();
    expect(canonicalizeSection(f, [])).toBe("");
  });
});

/** Recursive reference implementation of textOf (the version before it was made iterative), kept verbatim as the control for the equivalence tests. */
function refTextOf(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as Array<{ insert: unknown }>).map(d => (typeof d.insert === "string" ? d.insert : "")).join("");
  }
  let s = "";
  for (let i = 0; i < node.length; i += 1) {
    const c = node.get(i);
    if (c instanceof Y.XmlText || c instanceof Y.XmlElement) s += refTextOf(c);
  }
  return s;
}

/** Reference sectionize (the version before textOf was made iterative), only switched to call refTextOf; behaves like `sectionize` in note-sections.ts (helpers inlined, blockIds omitted). */
function refSectionize(fragment: Y.XmlFragment): Array<{ sectionId: string; heading: string; chars: number }> {
  const out: Array<{ sectionId: string; level: number; heading: string; chars: number }> = [{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0 }];
  let current = out[0]!;
  for (const c of topLevelBlocks(fragment)) {
    const first = c.get(0);
    const content = first instanceof Y.XmlElement && first.nodeName !== "blockGroup" ? first : null;
    const level = content && content.nodeName === "heading" ? (Number.isFinite(Number(content.getAttribute("level") ?? "1")) ? Number(content.getAttribute("level") ?? "1") : 1) : null;
    const id = (c.getAttribute("id") ?? "") as string;
    if (level !== null && (current.level === 0 || level <= current.level)) {
      current = { sectionId: id, level, heading: refTextOf(content!), chars: 0 };
      out.push(current);
    }
    current.chars += refTextOf(c).length;
  }
  return out.map(({ sectionId, heading, chars }) => ({ sectionId, heading, chars }));
}

/** Deterministic PRNG (LCG) so random documents are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function fillInline(el: Y.XmlElement, r: () => number, depth: number): void {
  const k = 1 + Math.floor(r() * 4);
  for (let j = 0; j < k; j += 1) {
    const roll = r();
    if (roll < 0.45) {
      const t = new Y.XmlText();
      el.insert(el.length, [t]);
      t.insert(0, `t${Math.floor(r() * 1000)} `);
    } else if (roll < 0.6) {
      const w = new Y.XmlElement("wikilink");
      el.insert(el.length, [w]);
      w.setAttribute("snapshotTitle", "Linked");
    } else if (roll < 0.7) {
      el.insert(el.length, [new Y.XmlHook("hook") as unknown as Y.XmlElement]);
    } else if (depth < 3) {
      const sub = new Y.XmlElement(roll < 0.85 ? "bold" : "mermaid");
      el.insert(el.length, [sub]);
      if (sub.nodeName === "mermaid") sub.setAttribute("code", "graph TD");
      fillInline(sub, r, depth + 1);
    }
  }
}

function randomDoc(seed: number): Y.Doc {
  const r = lcg(seed);
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  const n = 3 + Math.floor(r() * 8);
  for (let i = 0; i < n; i += 1) {
    const c = new Y.XmlElement("blockContainer");
    group.insert(i, [c]);
    c.setAttribute("id", `b${seed}x${i}`);
    const heading = r() < 0.4;
    const content = new Y.XmlElement(heading ? "heading" : "paragraph");
    c.insert(0, [content]);
    if (heading) content.setAttribute("level", String(1 + Math.floor(r() * 3)));
    fillInline(content, r, 0);
    if (r() < 0.4) {
      const inner = new Y.XmlElement("blockGroup");
      c.insert(1, [inner]);
      const nc = new Y.XmlElement("blockContainer");
      inner.insert(0, [nc]);
      nc.setAttribute("id", `n${seed}x${i}`);
      const np = new Y.XmlElement("paragraph");
      nc.insert(0, [np]);
      fillInline(np, r, 0);
    }
  }
  return doc;
}

describe("#93 iterative textOf", () => {
  // The chain must be built inside one doc.transact: inserting one by one opens a transaction each time and the closing cost grows with depth, so the whole chain is O(n^2)
  // (on CI this stretch alone runs 40-48 s synchronously; blocking the worker for over 60 s makes vitest's onTaskUpdate RPC time out -> Unhandled Error, exit 1).
  // A single transaction builds the same tree quickly.
  it("20 000 levels of blockContainer chain -> sectionize does not throw, and the deepest text counts in chars", () => {
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
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s).toHaveLength(1);
    expect(s[0]!.chars).toBe("DEEPEST".length);
  });

  it("child order: when a heading consists of three child nodes the concatenation order equals the document order", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    const c = new Y.XmlElement("blockContainer");
    group.insert(0, [c]);
    c.setAttribute("id", "h");
    const h = new Y.XmlElement("heading");
    c.insert(0, [h]);
    h.setAttribute("level", "1");
    const a = new Y.XmlText();
    h.insert(0, [a]);
    a.insert(0, "ab");
    const bold = new Y.XmlElement("bold");
    h.insert(1, [bold]);
    const b = new Y.XmlText();
    bold.insert(0, [b]);
    b.insert(0, "cd");
    const e = new Y.XmlText();
    h.insert(2, [e]);
    e.insert(0, "ef");
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))[1]).toMatchObject({ heading: "abcdef", chars: 6 });
  });

  it("200 random nested documents (with wikilink, mermaid, XmlHook): heading/chars equal the recursive reference implementation one by one", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const f = randomDoc(seed).getXmlFragment(YDOC_FRAGMENT);
      const got = sectionize(f).map(({ sectionId, heading, chars }) => ({ sectionId, heading, chars }));
      expect(got, `seed ${seed}`).toEqual(refSectionize(f));
    }
  });

  it("the existing fixture (makeDoc, with a nested heading) equals the reference implementation", () => {
    const doc = makeDoc([
      { id: "p0", type: "paragraph", text: "intro" },
      { id: "h1", type: "heading", level: 2, text: "A" },
      { id: "p1", type: "paragraph", text: "li", nested: [{ id: "n1", type: "heading", level: 1, text: "inner" }] },
    ]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(sectionize(f).map(({ sectionId, heading, chars }) => ({ sectionId, heading, chars }))).toEqual(refSectionize(f));
  });
});

type RowSpec = { kind: "row"; id: string; cols: Array<Array<{ type: "paragraph" | "heading"; id: string; text: string }>> };
function makeRowDoc(top: Array<{ kind: "p" | "h"; id: string; text: string; level?: number } | RowSpec>): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  const leaf = (id: string, type: string, text: string, level?: number): Y.XmlElement => {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", id);
    const e = new Y.XmlElement(type);
    if (type === "heading") e.setAttribute("level", String(level ?? 1));
    const t = new Y.XmlText();
    e.insert(0, [t]);
    c.insert(0, [e]);
    t.insert(0, text);
    return c;
  };
  top.forEach((b, i) => {
    if (b.kind === "row") {
      const list = new Y.XmlElement("columnList");
      list.setAttribute("id", b.id);
      group.insert(i, [list]);
      b.cols.forEach((col, ci) => {
        const column = new Y.XmlElement("column");
        column.setAttribute("id", `${b.id}c${ci}`);
        list.insert(ci, [column]);
        column.insert(0, col.map(x => leaf(x.id, x.type, x.text)));
      });
    } else {
      group.insert(i, [leaf(b.id, b.kind === "h" ? "heading" : "paragraph", b.text, b.level)]);
    }
  });
  return doc;
}

describe("a columns row is a top-level unit", () => {
  const row: RowSpec = { kind: "row", id: "r", cols: [[{ type: "paragraph", id: "a1", text: "甲乙" }], [{ type: "heading", id: "h", text: "欄內" }]] };

  it("topLevelBlocks collects blockContainer and columnList in order; does not flatten inside columns", () => {
    const doc = makeRowDoc([{ kind: "p", id: "p1", text: "x" }, row, { kind: "h", id: "H2", text: "B" }, { kind: "p", id: "p2", text: "y" }]);
    const tops = topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(tops.map(c => c.nodeName)).toEqual(["blockContainer", "columnList", "blockContainer", "blockContainer"]);
    expect(tops.map(c => c.getAttribute("id"))).toEqual(["p1", "r", "H2", "p2"]);
  });

  it("sectionize treats a row as a non-heading unit (chars include all text inside the columns); a heading inside a column does not open a section", () => {
    const doc = makeRowDoc([{ kind: "p", id: "p1", text: "x" }, row, { kind: "h", id: "H2", text: "B" }, { kind: "p", id: "p2", text: "y" }]);
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s[0]).toMatchObject({ sectionId: TOP_SECTION_ID, blockIds: ["p1", "r"], chars: 1 + 2 + 2 });
    expect(s.map(x => x.heading)).toEqual(["", "B"]);
    expect(s.some(x => x.heading.includes("欄內"))).toBe(false);
    // the same when the first block of the row's first column is a heading
    const doc2 = makeRowDoc([{ kind: "row", id: "r", cols: [[{ type: "heading", id: "h0", text: "欄首" }], [{ type: "paragraph", id: "b", text: "z" }]] }]);
    const s2 = sectionize(doc2.getXmlFragment(YDOC_FRAGMENT));
    expect(s2).toHaveLength(1);
    expect(s2[0]).toMatchObject({ blockIds: ["r"], chars: 3 });
  });

  it("canonicalizeSection recognises the row's id; wrong order -> null", () => {
    const doc = makeRowDoc([{ kind: "p", id: "p1", text: "x" }, row]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(canonicalizeSection(f, ["p1", "r"])).toContain("EcolumnList(");
    expect(canonicalizeSection(f, ["r", "p1"])).toBeNull();
  });
});

describe("topLevelIdsOf", () => {
  it("maps nested list items and column children to the top-level block or row holding them; ids not in the document are absent", () => {
    const nested = makeDoc([
      { id: "p", type: "paragraph", text: "x" },
      { id: "outer", type: "paragraph", text: "y", nested: [{ id: "inner", type: "heading", text: "z", level: 2 }] },
    ]);
    expect(topLevelIdsOf(nested.getXmlFragment(YDOC_FRAGMENT), new Set(["inner", "p", "gone"]))).toEqual(new Map([["p", "p"], ["inner", "outer"]]));

    const row: RowSpec = { kind: "row", id: "r", cols: [[{ type: "paragraph", id: "a1", text: "甲" }], [{ type: "heading", id: "h", text: "欄內" }]] };
    const cols = makeRowDoc([{ kind: "p", id: "p1", text: "x" }, row]);
    expect(topLevelIdsOf(cols.getXmlFragment(YDOC_FRAGMENT), new Set(["h", "rc1", "r"]))).toEqual(new Map([["r", "r"], ["rc1", "r"], ["h", "r"]]));
    expect(topLevelIdsOf(cols.getXmlFragment(YDOC_FRAGMENT), new Set())).toEqual(new Map());
  });
});
