import { describe, expect, it } from "vitest";
import { bigramDice, diffBlocks, markOf, renderDiff, sideBySideMarks, splitRows, type DiffBlock, type DiffEntry, type SplitRow } from "./version-diff";

const p = (id: string, text: string, children: DiffBlock[] = []): DiffBlock => ({
  id,
  type: "paragraph",
  props: { textAlignment: "left" },
  content: [{ type: "text", text, styles: {} }],
  children,
});
const img = (id: string, url: string): DiffBlock => ({ id, type: "image", props: { url }, content: undefined, children: [] });
const math = (id: string, tex: string): DiffBlock => ({ id, type: "math", props: { tex }, content: undefined, children: [] });

const marksOf = (a: DiffBlock[], b: DiffBlock[]) => diffBlocks(a, b).map((e) => [e.key, markOf(e)]);

describe("diffBlocks", () => {
  it("added: only in b's blocks -> added, in b's order", () => {
    expect(marksOf([p("A", "a")], [p("A", "a"), p("B", "b")])).toEqual([
      ["A", "context"],
      ["B", "added"],
    ]);
  });

  it("deleted: inserted after the previous surviving block in a; with none before it, placed first; synthetic id", () => {
    const out = marksOf([p("X", "x"), p("A", "a"), p("D", "d"), p("B", "b")], [p("A", "a"), p("B", "b")]);
    expect(out).toEqual([
      ["diff-del-1", "deleted"],
      ["A", "context"],
      ["diff-del-2", "deleted"],
      ["B", "context"],
    ]);
  });

  it("modified: same id, JSON differs after removing children -> changed; a parent whose only change is in children does not count as changed", () => {
    const a = [p("A", "舊字"), p("P", "同", [p("C", "子一")])];
    const b = [p("A", "新字"), p("P", "同", [p("C", "子二")])];
    const out = diffBlocks(a, b);
    expect(out.map(markOf)).toEqual(["changed", "context"]);
    expect(out[1].children.map(markOf)).toEqual(["changed"]);
  });

  it("moved: only those outside the LIS are marked moved ([A,B,C] -> [C,A,B] marks only C)", () => {
    expect(marksOf([p("A", "a"), p("B", "b"), p("C", "c")], [p("C", "c"), p("A", "a"), p("B", "b")])).toEqual([
      ["C", "moved"],
      ["A", "context"],
      ["B", "context"],
    ]);
  });

  it("moved and modified together: mark is changed, the moved flag is still true", () => {
    const [first] = diffBlocks([p("A", "a"), p("B", "b")], [p("B", "b2"), p("A", "a")]);
    expect(first.key).toBe("B");
    expect(markOf(first)).toBe("changed");
    expect(first.moved).toBe(true);
  });

  it("parent deleted, child promoted: a cross-level move shows as delete + add; with no surviving block before P, the delete goes first; all rendered ids are unique", () => {
    const a = [p("P", "父", [p("C", "子")])];
    const b = [p("C", "子")];
    const entries = diffBlocks(a, b);
    expect(entries.map((e) => [e.key, markOf(e)])).toEqual([
      ["diff-del-1", "deleted"],
      ["C", "added"],
    ]);
    expect(entries[0].children.map((e) => [e.key, markOf(e)])).toEqual([["diff-del-2", "deleted"]]);
    const { blocks } = renderDiff(entries);
    const ids: string[] = [];
    const walk = (bs: DiffBlock[]) => bs.forEach((x) => (ids.push(x.id!), walk(x.children ?? [])));
    walk(blocks);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("non-text block (image): only marked changed, content taken from b, nonText flag", () => {
    const entries = diffBlocks([img("I", "/api/uploads/1")], [img("I", "/api/uploads/2")]);
    const { blocks, marks } = renderDiff(entries);
    expect(marks.get("I")).toEqual({ mark: "changed", moved: false, nonText: true });
    expect(blocks[0].props).toEqual({ url: "/api/uploads/2" });
  });

  it("non-text block (math): a changed tex is marked changed with the nonText flag and content taken from b", () => {
    const { blocks, marks } = renderDiff(diffBlocks([math("M", "a")], [math("M", "b")]));
    expect(marks.get("M")).toEqual({ mark: "changed", moved: false, nonText: true });
    expect(blocks[0].props).toEqual({ tex: "b" });
  });

  it("inline recomposition: equal/added keep b's styles, removed keeps a's styles plus strike and red background, added gets green background", () => {
    const a: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [{ type: "text", text: "舊 字", styles: { bold: true } }], children: [] }];
    const b: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [{ type: "text", text: "新 字", styles: { italic: true } }], children: [] }];
    const { blocks } = renderDiff(diffBlocks(a, b));
    expect(blocks[0].content).toEqual([
      { type: "text", text: "舊", styles: { bold: true, strike: true, backgroundColor: "red" } },
      { type: "text", text: "新", styles: { italic: true, backgroundColor: "green" } },
      { type: "text", text: " 字", styles: { italic: true } },
    ]);
  });

  it("inline recomposition: links keep their shape; a wikilink is shown as text with link appearance (#269)", () => {
    const wl = { type: "wikilink", props: { targetNoteId: "n2", snapshotTitle: "T" } };
    const a: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [wl, { type: "text", text: " 看", styles: {} }], children: [] }];
    const b: DiffBlock[] = [
      { id: "A", type: "paragraph", props: {}, content: [wl, { type: "text", text: " 看 ", styles: {} }, { type: "link", href: "https://x.test", content: [{ type: "text", text: "這", styles: {} }] }], children: [] },
    ];
    const { blocks } = renderDiff(diffBlocks(a, b));
    const content = blocks[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "link", href: "/notes/n2", content: [{ type: "text", text: "T", styles: {} }] });
    expect(content).toContainEqual({ type: "link", href: "https://x.test", content: [{ type: "text", text: "這", styles: { backgroundColor: "green" } }] });
  });

  it("both sides empty -> one empty paragraph (initialContent must not be an empty array)", () => {
    const { blocks, marks } = renderDiff(diffBlocks([], []));
    expect(blocks).toEqual([{ id: "diff-empty", type: "paragraph" }]);
    expect(marks.size).toBe(0);
  });

  it("v1 vs empty document: everything added (descendants too)", () => {
    const entries = diffBlocks([], [p("A", "a", [p("C", "c")])]);
    expect(entries.map(markOf)).toEqual(["added"]);
    expect(entries[0].children.map(markOf)).toEqual(["added"]);
  });

  it("show only differences: consecutive context folds into one synthetic paragraph; context whose subtree has changes is not folded", () => {
    const a = [p("A", "a"), p("B", "b"), p("C", "c"), p("D", "d", [p("E", "e")])];
    const b = [p("A", "a"), p("B", "b"), p("C", "c2"), p("D", "d", [p("E", "e2")])];
    const { blocks, marks } = renderDiff(diffBlocks(a, b), { onlyChanges: true, collapsedText: (n) => `… ${n} …` });
    expect(blocks.map((x) => x.id)).toEqual(["diff-ctx-1", "C", "D"]);
    expect(blocks[0].content).toEqual([{ type: "text", text: "… 2 …", styles: {} }]);
    expect(marks.get("diff-ctx-1")?.mark).toBe("collapsed");
  });

  it("side-by-side marks: left marks deleted / changed, right marks added / changed / moved", () => {
    const { left, right } = sideBySideMarks(diffBlocks([p("A", "a"), p("D", "d"), p("M", "m")], [p("M", "m"), p("A", "a2"), p("N", "n")]));
    expect(Object.fromEntries(left)).toEqual({ A: "changed", D: "deleted" });
    expect(Object.fromEntries(right)).toEqual({ M: "moved", A: "changed", N: "added" });
  });

  it("missing ids and duplicate ids in one level do not throw; a duplicated id within a level is not paired at all (the first occurrence included), and rendered ids are all unique", () => {
    const noId: DiffBlock = { type: "paragraph", props: {}, content: [], children: [] };
    const a = [p("A", "a"), p("A", "a 重複"), noId];
    const b = [p("A", "a"), p("A", "又重複"), { ...noId }];
    const entries = diffBlocks(a, b);
    const { blocks } = renderDiff(entries);
    const ids = blocks.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.filter((e) => markOf(e) === "context")).toHaveLength(0);
    expect(entries.filter((e) => markOf(e) === "added")).toHaveLength(3);
    expect(entries.filter((e) => markOf(e) === "deleted")).toHaveLength(3);
  });

  it("contrast: when an id repeats on one side only, its counterpart on the other side is not paired either (duplicate detection is per side and per level)", () => {
    const entries = diffBlocks([p("A", "a")], [p("A", "a"), p("A", "a2")]);
    expect(entries.map(markOf).sort()).toEqual(["added", "added", "deleted"]);
  });
});

/** Deterministic random words (lowercase letters): the same seed gives the same string; bigrams of different seeds barely overlap (Dice far below 0.5). */
const gibberish = (seed: number, len = 40): string => {
  // mulberry32: the sequences of different seeds are independent (different seeds of a linear congruential generator are the same sequence shifted, which would occasionally produce similar strings).
  let x = seed >>> 0;
  let s = "";
  for (let i = 0; i < len; i += 1) {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    s += "abcdefghijklmnopqrstuvwxyz"[((t ^ (t >>> 14)) >>> 0) % 26];
  }
  return s;
};
/** n 5-letter words separated by spaces: token bigrams need separate words, while one long string is a single token with no bigram. */
const words = (seed: number, n = 8): string => (gibberish(seed, 5 * n).match(/.{5}/g) ?? []).join(" ");
const h =(id: string, text: string): DiffBlock => ({ id, type: "heading", props: { level: 1 }, content: [{ type: "text", text, styles: {} }], children: [] });

describe("diffBlocks content fallback pairing (passes 1a/1b/1c)", () => {
  it("1a yield + 1b: pressing Enter at the start of a block (the old id stays on the new empty block, the original text gets a new id) -> only the new block is added, the original text is context, nothing deleted", () => {
    const entries = diffBlocks([p("id1", "first"), p("id2", "hello")], [p("id1", "first"), p("id2", "new"), p("id3", "hello")]);
    expect(entries.map((e) => [e.key, markOf(e)])).toEqual([
      ["id1", "context"],
      ["id2", "added"],
      ["id3", "context"],
    ]);
    expect(entries[2].before?.id).toBe("id2");
  });

  it("1b: pasting the whole note (every id replaced, text unchanged) -> all unchanged, none moved", () => {
    const texts = ["one", "two", "three", "four", "five"];
    const entries = diffBlocks(
      texts.map((t, i) => p(`id${i + 1}`, t)),
      texts.map((t, i) => p(`id${i + 6}`, t)),
    );
    expect(entries.map((e) => [e.key, e.status, e.moved])).toEqual(texts.map((_, i) => [`id${i + 6}`, "unchanged", false]));
  });

  it("1b + LIS: pasting the whole note with the 2nd and 3rd swapped -> exactly one moved, the rest context", () => {
    const texts = ["one", "two", "three", "four", "five"];
    const swapped = [texts[0], texts[2], texts[1], texts[3], texts[4]];
    const entries = diffBlocks(
      texts.map((t, i) => p(`id${i + 1}`, t)),
      swapped.map((t, i) => p(`id${i + 6}`, t)),
    );
    expect(entries.every((e) => e.status === "unchanged")).toBe(true);
    expect(entries.map(markOf).filter((m) => m === "moved")).toHaveLength(1);
    expect(entries.map(markOf).filter((m) => m === "context")).toHaveLength(4);
  });

  it("1c: pasting the whole note with one word changed in the 3rd block (similarity > 0.5) -> that block changed with inline removed/added fragments, the rest context", () => {
    const texts = ["Alpha beta gamma delta", "Lorem ipsum dolor sit amet", "The quick brown fox jumps over the lazy dog", "Pack my box with five dozen", "Sphinx of black quartz judge"];
    const after = [...texts];
    after[2] = "The quick brown cat jumps over the lazy dog";
    const entries = diffBlocks(
      texts.map((t, i) => p(`id${i + 1}`, t)),
      after.map((t, i) => p(`id${i + 6}`, t)),
    );
    expect(entries.map(markOf)).toEqual(["context", "context", "changed", "context", "context"]);
    expect(entries[2].before?.id).toBe("id3");
    const { blocks } = renderDiff(entries);
    const inline = blocks[2].content as Array<{ text: string; styles: Record<string, unknown> }>;
    expect(inline).toContainEqual({ type: "text", text: "fox", styles: { strike: true, backgroundColor: "red" } });
    expect(inline).toContainEqual({ type: "text", text: "cat", styles: { backgroundColor: "green" } });
  });

  it("1c threshold: same type but similarity below 0.5 -> not paired (delete + add)", () => {
    expect(marksOf([p("id1", "完全不同的內容")], [p("id2", "another thing entirely different here")])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  // The next two paragraphs come from docs/known-limitations.md: same topic and similar wording but about two different things. Character bigram
  // Dice is 0.603 (the old definition mispaired them), token bigram Dice is 0.415 (guards the threshold and tokenization).
  const SIGNIN_SERVICE =
    "Turning a sign-in service off doesn't sign anyone out. People who signed in through it keep their session until it expires, and their API tokens and connected apps keep working (a token created without an expiry keeps working until it's revoked). Deleting the service doesn't change that either. To cut someone off right away, disable their account in Site admin → Users — that stops their sessions and tokens too.";
  const SIGNIN_PASSWORD =
    "Turning password sign-in off doesn't sign anyone out. Existing sessions, API tokens, connected apps and MCP clients keep working. To cut someone off right away, disable their account in Site admin → Users.";

  it("1c threshold (token bigram): delete a paragraph and write an unrelated one on the same topic in English in its place -> not paired (delete + add)", () => {
    expect(bigramDice(SIGNIN_SERVICE, SIGNIN_PASSWORD)).toBeGreaterThan(0.4);
    expect(bigramDice(SIGNIN_SERVICE, SIGNIN_PASSWORD)).toBeLessThan(0.5);
    expect(marksOf([p("k0", "Kept first paragraph stays here"), p("k1", SIGNIN_SERVICE), p("k2", "Kept last paragraph stays here")], [p("k0", "Kept first paragraph stays here"), p("n1", SIGNIN_PASSWORD), p("k2", "Kept last paragraph stays here")])).toEqual([
      ["k0", "context"],
      ["diff-del-1", "deleted"],
      ["n1", "added"],
      ["k2", "context"],
    ]);
  });

  it("1c threshold (token bigram): pasting the whole note and changing one word of the same paragraph -> still paired (changed)", () => {
    const edited = SIGNIN_SERVICE.replace("connected apps", "connected tools");
    expect(bigramDice(SIGNIN_SERVICE, edited)).toBeGreaterThanOrEqual(0.5);
    const entries = diffBlocks([p("id1", SIGNIN_SERVICE)], [p("id2", edited)]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([["id2", "changed", "id1"]]);
  });

  it("1c compares only blocks with >= 4 tokens: a short 3-word paragraph with one word changed -> not paired (only exact equality in 1b can pair it)", () => {
    expect(marksOf([p("id1", "alpha beta gamma")], [p("id2", "alpha beta delta")])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  it("non-text blocks pair only exactly: image props equal -> unchanged; url different -> delete + add (does not go through 1c)", () => {
    expect(marksOf([img("id1", "/api/uploads/1")], [img("id2", "/api/uploads/1")])).toEqual([["id2", "context"]]);
    expect(marksOf([img("id1", "/api/uploads/1")], [img("id2", "/api/uploads/2")])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  it("1b: identical content repeated in one level pairs one-to-one in order of appearance (id3<->id1, id4<->id2)", () => {
    const entries = diffBlocks([p("id1", "x"), p("id2", "x")], [p("id3", "x"), p("id4", "x")]);
    expect(entries.map((e) => [e.key, e.status, e.before?.id])).toEqual([
      ["id3", "unchanged", "id1"],
      ["id4", "unchanged", "id2"],
    ]);
  });

  it("1c candidate band: 5 deleted before in a, 40 new blocks inserted before in b, then 100 blocks with new ids each with the tail changed -> all 100 still pair (changed)", () => {
    const a = [...Array.from({ length: 5 }, (_, i) => p(`gone${i}`, words(1000 + i))), ...Array.from({ length: 100 }, (_, i) => p(`a${i}`, words(i)))];
    const b = [
      ...Array.from({ length: 40 }, (_, i) => p(`new${i}`, words(2000 + i))),
      ...Array.from({ length: 100 }, (_, i) => p(`b${i}`, `${words(i).slice(0, -5)}xyzzy`)), // replaces the last word: Dice 6/7
    ];
    const entries = diffBlocks(a, b);
    const paired = entries.filter((e) => e.status === "changed");
    expect(paired.map((e) => [e.key, e.before?.id, e.moved])).toEqual(Array.from({ length: 100 }, (_, i) => [`b${i}`, `a${i}`, false]));
    expect(entries.filter((e) => e.status === "added")).toHaveLength(40);
    expect(entries.filter((e) => e.status === "deleted")).toHaveLength(5);
  });

  it("1a does not yield: a same-id pair with different content, but the other side has no unpaired block with equal content -> still this pair changed", () => {
    const entries = diffBlocks([p("id1", "abc")], [p("id1", "abd")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([["id1", "changed", "id1"]]);
  });

  it("unchanged: two blocks with the same id and text on side b, and a block without id with the same text -> equal text is still not paired", () => {
    const dup = diffBlocks([p("id1", "same text")], [p("id9", "same text"), p("id9", "same text")]);
    expect(dup.map(markOf).sort()).toEqual(["added", "added", "deleted"]);
    const noId: DiffBlock = { type: "paragraph", props: { textAlignment: "left" }, content: [{ type: "text", text: "same text", styles: {} }], children: [] };
    const missing = diffBlocks([p("id1", "same text")], [noId]);
    expect(missing.map(markOf).sort()).toEqual(["added", "deleted"]);
    const missingA = diffBlocks([{ ...noId }], [p("id1", "same text")]);
    expect(missingA.map(markOf).sort()).toEqual(["added", "deleted"]);
  });

  it("type guard: paragraph and heading with the same text -> neither 1b (shallow form includes type) nor 1c (type must match) pairs them -> delete + add", () => {
    // Text has >= 4 tokens so 1c really compares (if type were ignored, Dice = 1 would pair them).
    const text = "The quick brown fox jumps over the lazy dog";
    expect(marksOf([p("id1", text)], [h("id2", text)])).toEqual([
      ["diff-del-1", "deleted"],
      ["id2", "added"],
    ]);
  });

  it("1a yield (b-side direction): the new content of an id pair has an identical block among a's unpaired blocks -> yield, b pairs with that block, and a's old one is deleted", () => {
    const entries = diffBlocks([p("id1", "t"), p("id5", "t2")], [p("id1", "t2")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([
      ["diff-del-1", "deleted", "id1"],
      ["id1", "context", "id5"],
    ]);
  });

  it("1a yield chain: content released after the later pair yields is what lets the earlier pair yield (rerun until no new yield)", () => {
    // id2 (w->x): its old content w is in the b pool (id3) -> yield, adding x to the b pool; second round: id1 (x->y) has old content x in the b pool only now -> yield.
    const entries = diffBlocks([p("id1", "x"), p("id2", "w")], [p("id1", "y"), p("id2", "x"), p("id3", "w")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([
      ["id1", "added", undefined],
      ["id2", "context", "id1"],
      ["id3", "context", "id2"],
    ]);
  });

  it("1a yield counts occurrences: duplicate content in one level, and this side has another block that can take it -> no yield -> no crossed pairing, no false moved", () => {
    const entries = diffBlocks([p("id1", "hello world"), p("id5", "hello world")], [p("id1", "hello world!"), p("id6", "hello world")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["id1", "changed", false, "id1"],
      ["id6", "unchanged", false, "id5"],
    ]);
  });

  it("empty text blocks pair as usual but are not marked moved: delete one empty line + add an empty line elsewhere -> the two empty lines pair as unchanged, moved=false", () => {
    const entries = diffBlocks([p("id1", ""), p("id2", "alpha"), p("id3", "beta")], [p("id2", "alpha"), p("id3", "beta"), p("id9", "")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["id2", "unchanged", false, "id2"],
      ["id3", "unchanged", false, "id3"],
      ["id9", "unchanged", false, "id1"],
    ]);
  });

  it("typing in the empty paragraph at the end of the note (BlockNote adds a new empty paragraph) -> new text added, the empty paragraph unchanged and not moved, nothing deleted", () => {
    const entries = diffBlocks([p("id1", "hello"), p("id2", "")], [p("id1", "hello"), p("id2", "new text"), p("id3", "")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["id1", "unchanged", false, "id1"],
      ["id2", "added", false, undefined],
      ["id3", "unchanged", false, "id2"],
    ]);
  });

  it("empty-line pairs are excluded before computing the LIS: moving an empty line to the front does not push the only non-empty pair out of the LIS and mark it moved", () => {
    // If the empty lines also entered the LIS (a-index sequence [1, 2, 0]), the LIS would be the two empty lines and x would be marked moved; with them excluded x alone forms the LIS.
    const entries = diffBlocks([p("x", "keep me"), p("e", ""), p("f", "")], [p("e2", ""), p("f2", ""), p("x", "keep me")]);
    expect(entries.map((e) => [e.key, e.status, e.moved, e.before?.id])).toEqual([
      ["e2", "unchanged", false, "e"],
      ["f2", "unchanged", false, "f"],
      ["x", "unchanged", false, "x"],
    ]);
  });

  it("the deletion anchor skips empty lines paired by content: deleting 'empty line + next paragraph' and adding an empty line elsewhere -> the deleted paragraph stays in place (after Title), not at the end", () => {
    const a = [p("h", "Title"), p("e1", ""), p("d", "This paragraph gets deleted"), p("k1", "keep one"), p("k2", "keep two"), p("t", "")];
    const b = [p("h", "Title"), p("k1", "keep one"), p("k2", "keep two"), p("n", ""), p("t", "")];
    expect(diffBlocks(a, b).map((e) => [e.key, e.status, e.before?.id])).toEqual([
      ["h", "unchanged", "h"],
      ["diff-del-1", "deleted", "d"],
      ["k1", "unchanged", "k1"],
      ["k2", "unchanged", "k2"],
      ["n", "unchanged", "e1"],
      ["t", "unchanged", "t"],
    ]);
  });

  it("real Enter at the start of a block (the old-id block becomes an empty line) -> empty line added, original text context", () => {
    const entries = diffBlocks([p("id1", "first"), p("id2", "hello")], [p("id1", "first"), p("id2", ""), p("id3", "hello")]);
    expect(entries.map((e) => [e.key, markOf(e), e.before?.id])).toEqual([
      ["id1", "context", "id1"],
      ["id2", "added", undefined],
      ["id3", "context", "id2"],
    ]);
  });

  it("bigramDice: token bigram (Latin letters/digits form one token, other characters one each, whitespace and punctuation separate), multiset intersection", () => {
    expect(bigramDice("a b c d", "a b c e")).toBeCloseTo(4 / 6);
    expect(bigramDice("x x x", "x x")).toBeCloseTo(2 / 3);
    expect(bigramDice("hello, world!", "hello world")).toBe(1);
    expect(bigramDice("abc def", "abc deg")).toBe(0); // Latin letters form one token: def != deg
    expect(bigramDice("中文字", "中文字")).toBe(1);
    expect(bigramDice("v2 release", "v3 release")).toBe(0);
    expect(bigramDice("abcd", "abcd")).toBe(0); // only one token -> no bigram
  });

  it("bigramDice cuts by code point: a surrogate-pair emoji is one token (cutting by UTF-16 code unit would give 0.5)", () => {
    expect(bigramDice("a😀", "a😁")).toBe(0);
    expect(bigramDice("a😀", "a😀")).toBe(1);
  });

  it("performance (the time is printed, not asserted): 2000 vs 2000 blocks, all new ids, distinct unrelated text -> all deleted + added", () => {
    const a = Array.from({ length: 2000 }, (_, i) => p(`a${i}`, words(i)));
    const b = Array.from({ length: 2000 }, (_, i) => p(`b${i}`, words(10000 + i)));
    const t0 = performance.now();
    const entries = diffBlocks(a, b);
    const ms = performance.now() - t0;
    console.log(`[version-diff 案 12] diffBlocks 2000×2000 全不相似：${ms.toFixed(1)} ms`);
    expect(entries.filter((e) => e.status === "added")).toHaveLength(2000);
    expect(entries.filter((e) => e.status === "deleted")).toHaveLength(2000);
  });
});

describe("splitRows (side-by-side block alignment)", () => {
  const rowsOf = (a: DiffBlock[], b: DiffBlock[]) => splitRows(a, b, diffBlocks(a, b));
  const textOfP = (blk: DiffBlock) => (blk.content as Array<{ text: string }>)[0].text;
  /** Invariant: left / right are each strictly increasing (ignoring null), and every index of a and b appears exactly once. */
  const checkInvariants = (a: DiffBlock[], b: DiffBlock[], rows: SplitRow[]) => {
    const ls = rows.map((r) => r.left).filter((x): x is number => x !== null);
    const rs = rows.map((r) => r.right).filter((x): x is number => x !== null);
    expect(ls).toEqual(a.map((_, i) => i));
    expect(rs).toEqual(b.map((_, i) => i));
    expect(rows.every((r) => r.left !== null || r.right !== null)).toBe(true);
  };

  it("insert in the middle: a=[p1,p2], b=[p1,new,p2] -> left 2 and right 3 on the same row", () => {
    const a = [p("A", "one"), p("B", "two")];
    const b = [p("A", "one"), p("N", "new"), p("B", "two")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: null, right: 1 },
      { left: 1, right: 2 },
    ]);
  });

  it("deleted: a left-only row", () => {
    const a = [p("A", "one"), p("D", "gone"), p("B", "two")];
    const b = [p("A", "one"), p("B", "two")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: null },
      { left: 2, right: 1 },
    ]);
  });

  it("modified: changed stays on the same row", () => {
    const a = [p("A", "one"), p("B", "two")];
    const b = [p("A", "one changed"), p("B", "two")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 1 },
    ]);
  });

  it("moved pairs are not aligned: left and right take a row each, not the same row", () => {
    const a = [p("A", "a"), p("B", "b"), p("C", "c")];
    const b = [p("C", "c"), p("A", "a"), p("B", "b")];
    expect(diffBlocks(a, b).find((e) => e.key === "C")?.moved).toBe(true);
    const rows = rowsOf(a, b);
    expect(rows).toEqual([
      { left: null, right: 0 },
      { left: 0, right: 1 },
      { left: 1, right: 2 },
      { left: 2, right: null },
    ]);
    checkInvariants(a, b, rows);
  });

  it("interleaved delete and add: a deletes 2, b adds 3 -> two rows with both sides, one row with the right side only", () => {
    const a = [p("A", "head"), p("D1", "x"), p("D2", "y"), p("B", "tail")];
    const b = [p("A", "head"), p("N1", "p"), p("N2", "q"), p("N3", "r"), p("B", "tail")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 1 },
      { left: 2, right: 2 },
      { left: null, right: 3 },
      { left: 3, right: 4 },
    ]);
  });

  it("anchor row crossing downgrade: a pair that is empty text on both sides has moved=false but a's index goes backwards -> treated as unaligned on both sides", () => {
    const a = [p("e1", ""), p("X", "x")];
    const b = [p("X", "x"), p("e2", "")];
    const entries = diffBlocks(a, b);
    // Precondition: the empty-line pair really paired and moved is false (otherwise this case could not tell the difference).
    const blank = entries.find((e) => e.before === a[0]);
    expect(blank?.after).toBe(b[1]);
    expect(blank?.moved).toBe(false);
    const rows = splitRows(a, b, entries);
    expect(rows).toEqual([
      { left: 0, right: null },
      { left: 1, right: 0 },
      { left: null, right: 1 },
    ]);
    checkInvariants(a, b, rows);
  });

  it("Enter at the start of the first paragraph + typing in the trailing empty paragraph -> an empty-line pair paired from far away does not take the anchor row, alpha / beta / gamma each stay on the same row left and right", () => {
    // a = at save time: three paragraphs + a trailing empty paragraph T; b = now: Enter at the start of the first paragraph (old id 1 stays on the empty paragraph, alpha gets a new id X), typing in T, and one more empty paragraph M.
    const a = [p("1", "alpha"), p("2", "beta"), p("3", "gamma"), p("T", "")];
    const b = [p("1", ""), p("X", "alpha"), p("2", "beta"), p("3", "gamma"), p("T", "tail"), p("M", "")];
    const entries = diffBlocks(a, b);
    // Precondition (real diffBlocks): a's empty paragraph T pairs with the empty paragraph at b's start with moved=false and comes first in entries.
    expect(entries[0].before).toBe(a[3]);
    expect(entries[0].after).toBe(b[0]);
    expect(entries[0].moved).toBe(false);
    const rows = splitRows(a, b, entries);
    for (const [ai, bi] of [
      [0, 1],
      [1, 2],
      [2, 3],
    ]) {
      expect(rows, `a[${ai}] 與 b[${bi}] 同列`).toContainEqual({ left: ai, right: bi });
    }
    expect(rows).toEqual([
      { left: null, right: 0 },
      { left: 0, right: 1 },
      { left: 1, right: 2 },
      { left: 2, right: 3 },
      { left: 3, right: 4 },
      { left: null, right: 5 },
    ]);
    checkInvariants(a, b, rows);
  });

  it("an empty-line pair between two adjacent anchor rows -> promoted to an anchor row (same row)", () => {
    // a has an extra D on the left only: without promotion, the downgraded one-by-one side-by-side would put D on the same row as b's empty line, and both the empty-line pair and Y end up misaligned.
    const a = [p("X", "x"), p("D", "gone"), p("e1", ""), p("Y", "y")];
    const b = [p("X", "x"), p("e2", ""), p("Y", "y")];
    const entries = diffBlocks(a, b);
    expect(entries.some((e) => e.before === a[2] && e.after === b[1])).toBe(true);
    expect(splitRows(a, b, entries)).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: null },
      { left: 2, right: 1 },
      { left: 3, right: 2 },
    ]);
  });

  it("empty side: a empty -> all right-only rows; b empty -> all left-only rows", () => {
    const b = [p("A", "a"), p("B", "b")];
    expect(rowsOf([], b)).toEqual([
      { left: null, right: 0 },
      { left: null, right: 1 },
    ]);
    expect(rowsOf(b, [])).toEqual([
      { left: 0, right: null },
      { left: 1, right: null },
    ]);
  });

  it("nested child blocks do not form their own rows: only the top level counts", () => {
    const a = [p("A", "a", [p("A1", "child")])];
    const b = [p("A", "a", [p("A1", "child"), p("A2", "new child")]), p("B", "b")];
    expect(rowsOf(a, b)).toEqual([
      { left: 0, right: 0 },
      { left: null, right: 1 },
    ]);
  });

  it("invariant: random edits (delete, add, modify, move, empty line, new id) - each row's indices on both sides are strictly increasing, and every a / b index appears exactly once", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const words = ["alpha", "beta", "gamma", "delta", "", "", "epsilon zeta eta theta", "iota kappa lambda mu nu"];
    for (let round = 0; round < 200; round += 1) {
      const n = Math.floor(rnd() * 8);
      const a = Array.from({ length: n }, (_, i) => p(`a${i}`, words[Math.floor(rnd() * words.length)]));
      let b = a.filter(() => rnd() > 0.25).map((blk) => (rnd() < 0.2 ? p(rnd() < 0.5 ? blk.id! : `r${round}-${blk.id}`, `${textOfP(blk)} more`) : blk));
      const adds = Math.floor(rnd() * 4);
      for (let k = 0; k < adds; k += 1) b.splice(Math.floor(rnd() * (b.length + 1)), 0, p(`n${round}-${k}`, words[Math.floor(rnd() * words.length)]));
      if (rnd() < 0.3 && b.length > 1) b = [...b.slice(1), b[0]];
      checkInvariants(a, b, splitRows(a, b, diffBlocks(a, b)));
    }
  });
});

describe("#269 wikilink diff", () => {
  const ID1 = "11111111-1111-4111-8111-111111111111";
  const ID2 = "22222222-2222-4222-8222-222222222222";
  const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { targetNoteId: ID1, snapshotTitle: "", label: "", anchorBlockId: "", ...props } });
  const lnk = (href: string, text: string) => ({ type: "link", href, content: [{ type: "text", text, styles: {} }] });
  const para = (id: string, ...content: unknown[]): DiffBlock => ({ id, type: "paragraph", props: {}, content, children: [] });
  const DEL = { strike: true, backgroundColor: "red" };
  const ADD = { backgroundColor: "green" };
  const contentOf = (a: DiffBlock[], b: DiffBlock[], titleOf?: (id: string) => string | undefined) =>
    renderDiff(diffBlocks(a, b), { titleOf }).blocks[0]!.content as unknown[];

  it("label changed: old label deleted + new label added (one link node each)", () => {
    expect(contentOf([para("A", wl({ label: "A" }))], [para("A", wl({ label: "B" }))])).toEqual([
      { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: "A", styles: DEL }] },
      { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: "B", styles: ADD }] },
    ]);
  });

  it("target changed (same text): exactly two nodes - deleted Foo, added Foo", () => {
    const c = contentOf([para("A", wl({ snapshotTitle: "Foo" }))], [para("A", wl({ targetNoteId: ID2, snapshotTitle: "Foo" }))]);
    expect(c).toEqual([
      { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: "Foo", styles: DEL }] },
      { type: "link", href: `/notes/${ID2}`, content: [{ type: "text", text: "Foo", styles: ADD }] },
    ]);
  });

  it("anchor changed: different href => delete + add", () => {
    const c = contentOf([para("A", wl({ label: "X", anchorBlockId: "a1" }))], [para("A", wl({ label: "X", anchorBlockId: "a2" }))]);
    expect(c.map((n) => (n as { href: string }).href)).toEqual([`/notes/${ID1}#b-a1`, `/notes/${ID1}#b-a2`]);
  });

  it("plain link -> wikilink (conversion where the text equals the title): exactly two nodes; the reverse wikilink -> plain link /notes/B is not merged either", () => {
    const titleOf = (id: string) => (id === ID1 ? "Foo" : undefined);
    expect(contentOf([para("A", lnk(`/notes/${ID1}`, "Foo"))], [para("A", wl({ snapshotTitle: "Foo" }))], titleOf)).toEqual([
      { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: "Foo", styles: DEL }] },
      { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: "Foo", styles: ADD }] },
    ]);
    expect(contentOf([para("A", wl({ snapshotTitle: "Foo" }))], [para("A", lnk(`/notes/${ID1}`, "Foo"))], titleOf)).toHaveLength(2);
  });

  it("partially overlapping label edit: after the common prefix, exactly one deleted node + one added node (Chapter 3->4 and its Chinese counterpart)", () => {
    for (const [from, to] of [["Chapter 3", "Chapter 4"], ["第3章", "第4章"]]) {
      const c = contentOf([para("A", { type: "text", text: "see ", styles: {} }, wl({ label: from }))], [para("A", { type: "text", text: "see ", styles: {} }, wl({ label: to }))]);
      expect(c).toEqual([
        { type: "text", text: "see ", styles: {} },
        { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: from, styles: DEL }] },
        { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: to, styles: ADD }] },
      ]);
    }
  });

  it("empty display text (label, title and snapshot all empty): shown as wikilinkHref; a changed target is visible; a paragraph containing only it is not judged blank", () => {
    const c = contentOf([para("A", wl({}))], [para("A", wl({ targetNoteId: ID2 }))]);
    expect(c).toEqual([
      { type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: `/notes/${ID1}`, styles: DEL }] },
      { type: "link", href: `/notes/${ID2}`, content: [{ type: "text", text: `/notes/${ID2}`, styles: ADD }] },
    ]);
    expect(diffBlocks([para("A", wl({}))], [para("A", wl({ targetNoteId: ID2 }))])[0]!.status).toBe("changed");
  });

  it("wikilink inside a changed block with only snapshotTitle different (titleOf gives the same current title): one node without diff styling as usual (the verbatim key does not include snapshotTitle)", () => {
    const titleOf = () => "Live";
    const c = contentOf(
      [para("A", wl({ snapshotTitle: "Old" }), { type: "text", text: " x", styles: {} })],
      [para("A", wl({ snapshotTitle: "New" }), { type: "text", text: " y", styles: {} })],
      titleOf,
    );
    expect(c[0]).toEqual({ type: "link", href: `/notes/${ID1}`, content: [{ type: "text", text: "Live", styles: {} }] });
  });

  it("block level: only snapshotTitle changed => unchanged, and neither marks nor side-by-side marks have it (without a label the snapshot is stale; with a label, after a round trip snapshot != label)", () => {
    for (const [before, after] of [
      [wl({ snapshotTitle: "Old" }), wl({ snapshotTitle: "New" })],
      [wl({ label: "L", snapshotTitle: "Target" }), wl({ label: "L", snapshotTitle: "L" })],
    ]) {
      const a = [para("A", before)];
      const b = [para("A", after)];
      const entries = diffBlocks(a, b);
      expect(entries[0]!.status).toBe("unchanged");
      expect(renderDiff(entries).marks.has("A")).toBe(false);
      const sides = sideBySideMarks(entries);
      expect(sides.left.has("A") || sides.right.has("A")).toBe(false);
    }
  });

  it("diffBlocks / renderDiff do not modify their input (deep equality); for a document with wikilinks splitRows keeps the anchor rows", () => {
    const a = [para("A", wl({ label: "A" })), para("B", { type: "text", text: "keep", styles: {} })];
    const b = [para("A", wl({ label: "B" })), para("B", { type: "text", text: "keep", styles: {} })];
    const before = JSON.parse(JSON.stringify([a, b]));
    const entries = diffBlocks(a, b);
    renderDiff(entries, { titleOf: () => "T" });
    expect([a, b]).toEqual(before);
    expect(splitRows(a, b, entries)).toEqual([{ left: 0, right: 0 }, { left: 1, right: 1 }]);
  });
});

describe("side-by-side diff: rows pair by row, columns pair by column id, column level does not collapse", () => {
  const P = (text: string, id: string): DiffBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
  const col = (id: string, kids: DiffBlock[], width = 1): DiffBlock => ({ id, type: "column", props: { width }, children: kids });
  const row = (id: string, cols: DiffBlock[]): DiffBlock => ({ id, type: "columnList", props: {}, children: cols });
  const show = (es: DiffEntry[], d = 0): string[] =>
    es.flatMap((e) => [`${"  ".repeat(d)}${e.key} ${e.status}${e.moved ? "/moved" : ""} ${(e.after ?? e.before)!.type}`, ...show(e.children, d + 1)]);
  const base = () => [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")])]), P("z", "z9")];

  it("show changes only, only one column in the row changed -> the row's direct children are all columns (column level does not collapse); c0 collapses into one placeholder paragraph, c1 holds the changed b1", () => {
    const b = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b2", "b1")])]), P("z", "z9")];
    const { blocks, marks } = renderDiff(diffBlocks(base(), b), { onlyChanges: true });
    const r = blocks.find((x) => x.type === "columnList")!;
    expect(r.children!.map((c) => c.type)).toEqual(["column", "column"]);
    const [c0, c1] = r.children!;
    expect(c0.id).toBe("c0");
    expect(c0.children).toHaveLength(1);
    expect(c0.children![0].type).toBe("paragraph");
    expect(marks.get(c0.children![0].id!)?.mark).toBe("collapsed");
    expect(c1.id).toBe("c1");
    expect(c1.children!.map((k) => k.id)).toEqual(["b1"]);
    expect(marks.get("b1")?.mark).toBe("changed");
  });

  it("column width 1->2, content unchanged -> c1 changed, b1 unchanged, the row is not changed; c1 in marks is changed", () => {
    const b = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")], 2)]), P("z", "z9")];
    const entries = diffBlocks(base(), b);
    expect(show(entries)).toEqual([
      "x0 unchanged paragraph",
      "r unchanged columnList",
      "  c0 unchanged column",
      "    a1 unchanged paragraph",
      "  c1 changed column",
      "    b1 unchanged paragraph",
      "z9 unchanged paragraph",
    ]);
    const { blocks, marks } = renderDiff(entries);
    expect(marks.get("c1")).toEqual({ mark: "changed", moved: false, nonText: false });
    expect(marks.has("r")).toBe(false);
    // A column has no inline content: rendering does no inline diff and content stays as is (undefined).
    expect(blocks[1].children![1].content).toBeUndefined();
  });

  it("show changes only, the whole row unchanged -> the row and the unchanged z after it collapse into one placeholder paragraph at the top level (a top-level placeholder is valid)", () => {
    const b = [P("x2", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")])]), P("z", "z9")];
    const { blocks, marks } = renderDiff(diffBlocks(base(), b), { onlyChanges: true });
    expect(blocks.map((x) => x.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks[0].id).toBe("x0");
    expect(marks.get(blocks[1].id!)?.mark).toBe("collapsed");
    expect(blocks[1].content).toEqual([{ type: "text", text: "… 2 …", styles: {} }]);
  });

  it("delete c1, add c2 (same width) -> not paired as the same column: c0 unchanged, the deleted column deleted, c2 added; the merged render row has 3 columns", () => {
    const b = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c2", [P("n", "n1")])]), P("z", "z9")];
    const entries = diffBlocks(base(), b);
    expect(show(entries)).toEqual([
      "x0 unchanged paragraph",
      "r unchanged columnList",
      "  c0 unchanged column",
      "    a1 unchanged paragraph",
      "  diff-del-1 deleted column",
      "    diff-del-2 deleted paragraph",
      "  c2 added column",
      "    n1 added paragraph",
      "z9 unchanged paragraph",
    ]);
    const r = renderDiff(entries).blocks.find((x) => x.type === "columnList")!;
    expect(r.children!.map((c) => [c.id, c.type])).toEqual([
      ["c0", "column"],
      ["diff-del-1", "column"],
      ["c2", "column"],
    ]);
  });

  it("a1 moves from c0 to c1 -> across columns = delete + add (the next one under c0 deleted, a1 added under c1)", () => {
    const a = [P("x", "x0"), row("r", [col("c0", [P("a", "a1"), P("k", "k1")]), col("c1", [P("b", "b1")])]), P("z", "z9")];
    const b = [P("x", "x0"), row("r", [col("c0", [P("k", "k1")]), col("c1", [P("b", "b1"), P("a", "a1")])]), P("z", "z9")];
    expect(show(diffBlocks(a, b))).toEqual([
      "x0 unchanged paragraph",
      "r unchanged columnList",
      "  c0 unchanged column",
      "    diff-del-1 deleted paragraph",
      "    k1 unchanged paragraph",
      "  c1 unchanged column",
      "    b1 unchanged paragraph",
      "    a1 added paragraph",
      "z9 unchanged paragraph",
    ]);
  });

  it("delete a row, add a row elsewhere (all-new column ids) -> not paired as the same row: the deleted row deleted, z9 unchanged (not moved), r2 added", () => {
    const a = [P("x", "x0"), row("r1", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")])]), P("z", "z9")];
    const b = [P("x", "x0"), P("z", "z9"), row("r2", [col("d0", [P("p", "p1")]), col("d1", [P("q", "q1")])])];
    expect(show(diffBlocks(a, b))).toEqual([
      "x0 unchanged paragraph",
      "diff-del-1 deleted columnList",
      "  diff-del-2 deleted column",
      "    diff-del-3 deleted paragraph",
      "  diff-del-4 deleted column",
      "    diff-del-5 deleted paragraph",
      "z9 unchanged paragraph",
      "r2 added columnList",
      "  d0 added column",
      "    p1 added paragraph",
      "  d1 added column",
      "    q1 added paragraph",
    ]);
  });

  it("two columns with different widths swap order -> c1 unchanged/moved, c0 unchanged (columns do not become changed)", () => {
    const a = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")], 1), col("c1", [P("b", "b1")], 2)]), P("z", "z9")];
    const b = [P("x", "x0"), row("r", [col("c1", [P("b", "b1")], 2), col("c0", [P("a", "a1")], 1)]), P("z", "z9")];
    expect(show(diffBlocks(a, b))).toEqual([
      "x0 unchanged paragraph",
      "r unchanged columnList",
      "  c1 unchanged/moved column",
      "    b1 unchanged paragraph",
      "  c0 unchanged column",
      "    a1 unchanged paragraph",
      "z9 unchanged paragraph",
    ]);
  });
});
