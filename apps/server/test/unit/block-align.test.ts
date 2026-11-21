import { describe, expect, it } from "vitest";
import {
  ALIGN_MAX_CELLS,
  alignBlocks,
  alignItemOf,
  keptIdRenames,
  type AlignItem,
  type AlignSource,
} from "@knotebook/shared";

const it_ = (type: string, text: string, children: AlignSource[] = []): AlignItem =>
  alignItemOf({ type, content: text, children });
const H = (t: string) => it_("heading", t);
const P = (t: string) => it_("paragraph", t);
const L = (t: string) => it_("bulletListItem", t);

describe("alignBlocks: the nine cases", () => {
  it.each([
    ["identical", [H("T"), P("a"), P("b")], [H("T"), P("a"), P("b")], [[0, 0], [1, 1], [2, 2]]],
    ["one block's text changed", [H("T"), P("a"), P("b"), P("c")], [H("T"), P("a"), P("b2"), P("c")], [[0, 0], [1, 1], [2, 2], [3, 3]]],
    ["block inserted in the middle", [H("T"), P("a"), P("c")], [H("T"), P("a"), P("b"), P("c")], [[0, 0], [1, 1], [2, 3]]],
    ["block deleted", [H("T"), P("a"), P("b"), P("c")], [H("T"), P("a"), P("c")], [[0, 0], [1, 1], [3, 2]]],
    ["one block split into two", [H("T"), P("ab"), P("z")], [H("T"), P("a"), P("b"), P("z")], [[0, 0], [2, 3]]],
    ["two blocks merged into one", [H("T"), P("a"), P("b"), P("z")], [H("T"), P("ab"), P("z")], [[0, 0], [3, 2]]],
    ["type changed", [H("T"), P("a"), P("z")], [H("T"), L("a"), P("z")], [[0, 0], [2, 2]]],
    ["repeated text: the first copy keeps the id", [P("x"), P("y")], [P("x"), P("x"), P("y")], [[0, 0], [1, 2]]],
    ["a stretch moved: only the longest common run keeps ids", [H("T"), P("a"), P("b"), P("c"), P("d")], [H("T"), P("c"), P("d"), P("a"), P("b")], [[0, 0], [3, 1], [4, 2]]],
  ])("%s", (_name, oldItems, newItems, expected) => {
    expect(alignBlocks(oldItems as AlignItem[], newItems as AlignItem[])).toEqual(expected);
  });
});

describe("alignBlocks: boundaries", () => {
  it("rule 2 at the sequence start and end", () => {
    expect(alignBlocks([P("a"), P("b")], [P("a2"), P("b")])).toEqual([[0, 0], [1, 1]]);
    expect(alignBlocks([P("a"), P("b")], [P("a"), P("b2")])).toEqual([[0, 0], [1, 1]]);
  });
  it("one old and one new block with no other pair: rule 2 pairs them; different types don't", () => {
    expect(alignBlocks([P("a")], [P("b")])).toEqual([[0, 0]]);
    expect(alignBlocks([P("a")], [L("b")])).toEqual([]);
  });
  it("a changed heading followed by an unchanged block keeps its pairing (rule 2)", () => {
    expect(alignBlocks([H("A"), P("x")], [H("A1"), P("x")])).toEqual([[0, 0], [1, 1]]);
  });
  it("two edited blocks between pairs are not paired", () => {
    expect(alignBlocks([H("T"), P("a"), P("b")], [H("T"), P("x"), P("y")])).toEqual([[0, 0]]);
  });
  it("repeated text between distinct neighbours pairs every copy", () => {
    expect(alignBlocks([P("x"), P("a"), P("x")], [P("x"), P("b"), P("x")])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });
  it("empty sides give no pairs", () => {
    expect(alignBlocks([], [P("a")])).toEqual([]);
    expect(alignBlocks([P("a")], [])).toEqual([]);
  });
  it("over the cell budget the middle gets no LCS pairs, so only the unchanged ends pair", () => {
    const o = [H("T"), P("a"), P("b"), P("c"), P("z")];
    const n = [H("T"), P("x"), P("b"), P("y"), P("z")];
    expect(alignBlocks(o, n)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(alignBlocks(o, n, { maxCells: 15 })).toEqual([[0, 0], [4, 4]]);
  });
  it("20,000 x 20,000 distinct blocks with equal ends: returns the two end pairs in under 1,000 ms", () => {
    const o: AlignItem[] = [];
    const n: AlignItem[] = [];
    for (let i = 0; i < 20_000; i++) {
      o.push(P(i === 0 || i === 19_999 ? `end${i}` : `o${i}`));
      n.push(P(i === 0 || i === 19_999 ? `end${i}` : `n${i}`));
    }
    const t0 = performance.now();
    const pairs = alignBlocks(o, n);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(pairs).toEqual([[0, 0], [19_999, 19_999]]);
  });
  it("a 999 x 999 middle (exactly ALIGN_MAX_CELLS cells), odd positions equal, even positions distinct: every block pairs, under 2,000 ms", () => {
    expect(1000 * 1000).toBe(ALIGN_MAX_CELLS);
    const o: AlignItem[] = [];
    const n: AlignItem[] = [];
    for (let i = 0; i < 999; i++) {
      o.push(P(i % 2 === 1 ? `s${i}` : `o${i}`));
      n.push(P(i % 2 === 1 ? `s${i}` : `n${i}`));
    }
    const t0 = performance.now();
    const pairs = alignBlocks(o, n);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(pairs.length).toBe(999);
    expect(pairs.every(([a, b]) => a === b)).toBe(true);
  });
});

describe("alignItemOf", () => {
  it("ignores inline styles, surrounding whitespace and text-block props; link text counts", () => {
    const a = alignItemOf({
      type: "paragraph",
      content: [
        { type: "text", text: " a", styles: { bold: true } },
        { type: "link", href: "https://x.test/", content: [{ type: "text", text: "b ", styles: {} }] },
      ],
      children: [],
    });
    expect(a.key).toBe(alignItemOf({ type: "paragraph", content: "ab", children: [] }).key);
    const h1 = alignItemOf({ type: "heading", props: { level: 1 }, content: "t", children: [] });
    const h2 = alignItemOf({ type: "heading", props: { level: 2 }, content: "t", children: [] });
    expect(h1.key).toBe(h2.key);
  });
  it("blocks without inline content compare by props: two images with different urls differ, identical dividers are equal", () => {
    const img = (url: string) => alignItemOf({ type: "image", props: { url, caption: "" } });
    expect(img("a").key).not.toBe(img("b").key);
    expect(img("a").key).toBe(img("a").key);
    expect(alignItemOf({ type: "divider", props: {} }).key).toBe(alignItemOf({ type: "divider", props: {} }).key);
    expect(alignItemOf({ type: "image", props: { a: 1, b: 2 } }).key).toBe(alignItemOf({ type: "image", props: { b: 2, a: 1 } }).key);
  });
  it("children are part of the key: a different child text or shape gives a different key; own text is trimmed before children", () => {
    const B = (t: string, children: AlignSource[] = []) => alignItemOf({ type: "bulletListItem", content: t, children });
    const child = (t: string): AlignSource => ({ type: "bulletListItem", content: t, children: [] });
    expect(B("a ", [child("c")]).key).toBe(B("a", [child("c")]).key);
    expect(B("a", [child("c")]).key).not.toBe(B("a", [child("c2")]).key);
    expect(B("a", [child("c")]).key).not.toBe(B("a").key);
  });
  it("a labelled wikilink keys by label, an unlabelled one by target id and anchor, never by snapshotTitle", () => {
    const wl = (props: Record<string, string>) =>
      alignItemOf({ type: "paragraph", content: [{ type: "wikilink", props }], children: [] }).key;
    expect(wl({ targetNoteId: "n1", anchorBlockId: "", label: "", snapshotTitle: "Old" })).toBe(
      wl({ targetNoteId: "n1", anchorBlockId: "", label: "", snapshotTitle: "Renamed" }),
    );
    expect(wl({ targetNoteId: "n1", anchorBlockId: "", label: "", snapshotTitle: "Old" })).not.toBe(
      wl({ targetNoteId: "n2", anchorBlockId: "", label: "", snapshotTitle: "Old" }),
    );
    expect(wl({ targetNoteId: "n1", anchorBlockId: "", label: "shown", snapshotTitle: "x" })).toBe(
      alignItemOf({ type: "paragraph", content: "shown", children: [] }).key,
    );
  });
  it("keys do not collide through the length prefixes", () => {
    const k = (type: string, text: string, children: AlignSource[] = []) => alignItemOf({ type, content: text, children }).key;
    expect(k("a", "1:b")).not.toBe(k("a1", ":b"));
    expect(k("a", "")).not.toBe(k("a", "", [{ type: "a", content: "", children: [] }]));
    const leaf = (t: string): AlignSource => ({ type: "p", content: t, children: [] });
    expect(k("l", "", [leaf("a"), leaf("b")])).not.toBe(k("l", "", [{ type: "p", content: "a", children: [leaf("b")] }]));
    expect(k("l", "x", [leaf("")])).not.toBe(k("l", "", [leaf("x")]));
  });
  const deep = (depth: number, leaf: string, prefix = "d"): AlignSource & { id: string } => {
    let node: AlignSource & { id: string } = { id: `${prefix}${depth}`, type: "bulletListItem", content: leaf, children: [] };
    for (let d = depth - 1; d >= 0; d--) node = { id: `${prefix}${d}`, type: "bulletListItem", content: `lvl${d}`, children: [node] };
    return node;
  };
  it("a 64-deep single-child list has a short key and is fast", () => {
    const t0 = performance.now();
    const { key } = alignItemOf(deep(64, "leaf"));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(key.length).toBeLessThan(10_000);
  });
  it("keptIdRenames on two 64-deep lists with different leaf text pairs only the outer block", () => {
    expect(keptIdRenames([deep(64, "a", "o")], [deep(64, "b", "n")])).toEqual(new Map([["n0", "o0"]]));
  });
  it("equal 64-deep lists map every descendant", () => {
    const m = keptIdRenames([deep(64, "a", "o")], [deep(64, "a", "n")]);
    expect(m.size).toBe(65);
    for (let d = 0; d <= 64; d++) expect(m.get(`n${d}`)).toBe(`o${d}`);
  });
  it("table cells and rows are separated, so different cell splits differ", () => {
    const t = (cells: string[][]) =>
      alignItemOf({ type: "table", content: { type: "tableContent", rows: cells.map((r) => ({ cells: r.map((c) => [{ type: "text", text: c, styles: {} }]) })) } }).key;
    expect(t([["a", "b"]])).not.toBe(t([["ab"]]));
    expect(t([["a"], ["b"]])).not.toBe(t([["a", "b"]]));
  });
});

describe("keptIdRenames", () => {
  const blk = (id: string, type: string, content: string, children: Array<AlignSource & { id: string }> = []) => ({ id, type, content, children });
  it("maps each pair's new id to the old id", () => {
    const before = [blk("o1", "heading", "T"), blk("o2", "paragraph", "a")];
    const inserted = [blk("n1", "heading", "T"), blk("n2", "paragraph", "a2"), blk("n3", "paragraph", "z")];
    expect(keptIdRenames(before, inserted)).toEqual(new Map([["n1", "o1"]]));
  });
  it("a rule-1 pair maps its descendants by position (a column list with two columns of paragraphs)", () => {
    const mk = (p: string) => ({
      id: `${p}cl`,
      type: "columnList",
      props: {},
      children: [
        { id: `${p}c1`, type: "column", props: {}, children: [blk(`${p}p1`, "paragraph", "x")] },
        { id: `${p}c2`, type: "column", props: {}, children: [blk(`${p}p2`, "paragraph", "y")] },
      ],
    });
    expect(keptIdRenames([mk("o")], [mk("n")])).toEqual(
      new Map([["ncl", "ocl"], ["nc1", "oc1"], ["np1", "op1"], ["nc2", "oc2"], ["np2", "op2"]]),
    );
  });
  it("a rule-2 pair (a list item whose child changed) maps only the outer block", () => {
    const before = [blk("li", "bulletListItem", "item", [blk("ch", "bulletListItem", "child")])];
    const inserted = [blk("nli", "bulletListItem", "item", [blk("nch", "bulletListItem", "child2")])];
    expect(keptIdRenames(before, inserted)).toEqual(new Map([["nli", "li"]]));
  });
});
