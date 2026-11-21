import { describe, expect, it } from "vitest";
import { alignInlineText } from "./block-align.js";
import { KNOWLEDGE_ID_RE, type KnowledgeInfo } from "./knowledge.js";
import { KNOWLEDGE_PENDING_ID_PREFIX } from "./knowledge-html.js";
import { knowledgePairs, knowledgeRefsIn, knowledgeWriteProblem, normalizeKnowledgeRefs, resolveKnowledgeForWrite, type KnowledgeBlockShape } from "./knowledge-rewrite.js";

const NOTE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let seq = 0;
const H = (level: number, content: unknown, props: Record<string, unknown> = {}): KnowledgeBlockShape => ({ id: `b${(seq += 1)}`, type: "heading", props: { level, ...props }, content });
const P = (text: string): KnowledgeBlockShape => ({ id: `b${(seq += 1)}`, type: "paragraph", props: {}, content: text });
const K = (id: string, extra: Record<string, string> = {}) => ({ knowledgeId: id, knowledgeWhen: "alice reads this", ...extra });
const pending = (n = 0) => `${KNOWLEDGE_PENDING_ID_PREFIX}${n}`;
const propsOf = (b: KnowledgeBlockShape) => b.props as Record<string, unknown>;

describe("alignInlineText", () => {
  it("is block-align's inlineText: text, link text, wikilink label or [[id#anchor]]", () => {
    expect(alignInlineText([{ type: "text", text: "a" }, { type: "link", href: "x", content: [{ type: "text", text: "b" }] }])).toBe("ab");
    expect(alignInlineText([{ type: "wikilink", props: { label: "Label", targetNoteId: NOTE, anchorBlockId: "x" } }])).toBe("Label");
    expect(alignInlineText([{ type: "wikilink", props: { targetNoteId: NOTE, anchorBlockId: "x" } }])).toBe(`[[${NOTE}#x]]`);
    expect(alignInlineText("not an array")).toBe("");
  });
});

describe("knowledgePairs and resolveKnowledgeForWrite", () => {
  const resolve = (before: KnowledgeBlockShape[], after: KnowledgeBlockShape[], keep = true, taken: string[] = []) => resolveKnowledgeForWrite({ before, after, keep, taken: new Set(taken) });

  it("a heading with the same level and text and no comment gets the old seven props, id included, when keep is true; nothing when keep is false", () => {
    const old = H(2, "A", { ...K("k_00000001", { knowledgeConclusion: "c", knowledgeEvidence: "tested", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified", knowledgeSupersededBy: "k_00000002" }) });
    const before = [P("intro"), old, P("x")];
    const after = [P("intro"), H(2, "A"), P("x2")];
    const kept = resolve(before, after);
    expect(KNOWLEDGE_PROP_NAMES_OF(kept.blocks[1]!)).toEqual({
      knowledgeId: "k_00000001", knowledgeWhen: "alice reads this", knowledgeConclusion: "c", knowledgeEvidence: "tested", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified", knowledgeSupersededBy: "k_00000002",
    });
    expect(kept.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(kept.created).toEqual([]);
    expect(propsOf(kept.blocks[1]!).level).toBe(2);
    const dropped = resolve(before, after, false);
    expect(dropped.blocks[1]).toBe(after[1]);
    expect(dropped.kept).toEqual([]);
  });

  it("a changed text or level keeps nothing, even where alignBlocks pairs the two as one edited block", () => {
    const before = [H(2, "A", K("k_00000001"))];
    expect(knowledgePairs(before, [H(2, "B")])).toEqual([]);
    expect(resolve(before, [H(2, "B")]).kept).toEqual([]);
    expect(knowledgePairs(before, [H(3, "A")])).toEqual([]);
    expect(resolve(before, [H(3, "A")]).kept).toEqual([]);
    expect(knowledgePairs(before, [H(2, "A")])).toEqual([[0, 0]]);
  });

  it("bold or a link around the same text still pairs", () => {
    const before = [H(2, "A B", K("k_00000001"))];
    const after = [H(2, [{ type: "text", text: "A ", styles: { bold: true } }, { type: "link", href: "https://example.com", content: [{ type: "text", text: "B", styles: {} }] }])];
    expect(resolve(before, after).kept).toEqual([{ id: "k_00000001", heading: "A B" }]);
  });

  it("two old knowledge headings with the same text pair as alignBlocks pairs them", () => {
    const before = [H(2, "A", K("k_00000001")), P("x"), H(2, "A", K("k_00000002"))];
    const after = [H(2, "A"), P("x"), H(2, "A")];
    const r = resolve(before, after);
    expect(r.blocks.map(b => propsOf(b).knowledgeId)).toEqual(["k_00000001", undefined, "k_00000002"]);
    expect(r.kept.map(k => k.id)).toEqual(["k_00000001", "k_00000002"]);
  });

  it("a comment naming the id of a heading that is still there does not take its knowledge: the paired heading keeps it and the repeat gets a new id", () => {
    const before = [H(2, "A", K("k_00000001", { knowledgeConclusion: "orig" }))];
    const moved = H(2, "Z", K("k_00000001", { knowledgeWhen: "moved" }));
    const after = [H(2, "A"), moved];
    const r = resolve(before, after);
    expect(propsOf(r.blocks[0]!)).toMatchObject({ knowledgeId: "k_00000001", knowledgeConclusion: "orig" });
    const fresh = propsOf(r.blocks[1]!);
    expect(fresh).toMatchObject({ knowledgeWhen: "moved" });
    expect(fresh.knowledgeId).toMatch(KNOWLEDGE_ID_RE);
    expect(fresh.knowledgeId).not.toBe("k_00000001");
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(r.renewed).toEqual([{ id: fresh.knowledgeId, heading: "Z", from: "k_00000001" }]);
    expect(r.created).toEqual([]);
  });

  it("the heading that was there first keeps the id wherever the repeat sits, also when the repeat comes first", () => {
    const before = [H(2, "A", K("k_00000001")), H(2, "B")];
    const after = [H(2, "B"), H(2, "X", K("k_00000001", { knowledgeWhen: "moved" })), H(2, "A")];
    const r = resolve(before, after);
    expect(propsOf(r.blocks[2]!).knowledgeId).toBe("k_00000001");
    expect(propsOf(r.blocks[1]!).knowledgeId).not.toBe("k_00000001");
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(r.renewed).toEqual([{ id: propsOf(r.blocks[1]!).knowledgeId, heading: "X", from: "k_00000001" }]);
  });

  it("a renamed copy of a section that still has its original below it: the original keeps the id, the copy is renewed", () => {
    const before = [H(2, "A", K("k_00000001")), P("body")];
    const after = [H(2, "A2", K("k_00000001")), P("body"), H(2, "A"), P("new part")];
    const r = resolve(before, after);
    expect(propsOf(r.blocks[2]!).knowledgeId).toBe("k_00000001");
    expect(propsOf(r.blocks[0]!).knowledgeId).not.toBe("k_00000001");
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }]);
    expect(r.renewed).toHaveLength(1);
    expect(r.renewed[0]).toMatchObject({ heading: "A2", from: "k_00000001" });
  });

  it("without a keep (file write) a plain heading holds nothing, so the heading that wrote the id keeps it", () => {
    const before = [H(2, "A", K("k_00000001"))];
    const after = [H(2, "A2", K("k_00000001")), H(2, "A")];
    const r = resolve(before, after, false);
    expect(propsOf(r.blocks[0]!).knowledgeId).toBe("k_00000001");
    expect(r.renewed).toEqual([]);
  });

  it("with no heading holding the id through pairing, the written id stays with the heading paired to the old one, else the first", () => {
    const before = [H(2, "A", K("k_00000001"))];
    const pairedLast = [H(2, "X", K("k_00000001")), H(2, "A", K("k_00000001"))];
    const a = resolve(before, pairedLast);
    expect(propsOf(a.blocks[1]!).knowledgeId).toBe("k_00000001");
    expect(propsOf(a.blocks[0]!).knowledgeId).not.toBe("k_00000001");
    expect(a.renewed).toEqual([{ id: propsOf(a.blocks[0]!).knowledgeId, heading: "X", from: "k_00000001" }]);
    const nonePaired = [H(2, "X", K("k_00000001")), H(2, "Y", K("k_00000001")), H(2, "Z", K("k_00000001"))];
    const b = resolve(before, nonePaired);
    expect(propsOf(b.blocks[0]!).knowledgeId).toBe("k_00000001");
    const renewedIds = b.renewed.map(x => x.id);
    expect(b.blocks.slice(1).map(x => propsOf(x).knowledgeId)).toEqual(renewedIds);
    expect(new Set([...renewedIds, "k_00000001"]).size).toBe(3);
    expect(b.renewed.map(x => x.heading)).toEqual(["Y", "Z"]);
  });

  it("a heading renamed with its comment kept carries the knowledge to the new name and takes nothing from the old one", () => {
    const before = [H(2, "A", K("k_00000001", { knowledgeConclusion: "orig" }))];
    const renamed = H(2, "A renamed", K("k_00000001", { knowledgeConclusion: "orig" }));
    const r = resolve(before, [renamed]);
    expect(r.blocks[0]).toBe(renamed);
    expect(r.kept).toEqual([]);
    expect(r.created).toEqual([]);
  });

  it("headings that swapped places while their text is repeated are not paired by text, so neither keeps knowledge", () => {
    const before = [H(2, "A", K("k_00000001")), P("a"), H(2, "A", K("k_00000002")), P("b"), H(2, "B", K("k_00000003")), P("c")];
    const after = [H(2, "B"), P("c"), H(2, "A"), P("b"), H(2, "A"), P("a")];
    expect(knowledgePairs(before, after)).toEqual([[4, 0]]);
    const r = resolve(before, after);
    expect(r.kept.map(k => k.id)).toEqual(["k_00000003"]);
  });

  it("a comment that names another id on a paired heading wins over the old knowledge", () => {
    const before = [H(2, "A", K("k_00000001"))];
    const after = [H(2, "A", K("k_00000009", { knowledgeWhen: "new" }))];
    const r = resolve(before, after);
    expect(r.blocks[0]).toBe(after[0]);
    expect(r.kept).toEqual([]);
  });

  it("a comment without an id line on a paired heading takes the old id; on an unpaired heading it gets a new id listed in created", () => {
    const before = [H(2, "A", K("k_00000001")), H(2, "B")];
    const after = [H(2, "A", { knowledgeId: pending(0), knowledgeWhen: "edited" }), H(2, "Brand new", { knowledgeId: pending(1), knowledgeWhen: "fresh" })];
    for (const keep of [true, false]) {
      const r = resolve(before, after, keep, ["k_00000001", "k_00000003"]);
      expect(propsOf(r.blocks[0]!)).toMatchObject({ knowledgeId: "k_00000001", knowledgeWhen: "edited" });
      const made = propsOf(r.blocks[1]!).knowledgeId as string;
      expect(made).toMatch(KNOWLEDGE_ID_RE);
      expect(["k_00000001", "k_00000003"]).not.toContain(made);
      expect(r.created).toEqual([{ id: made, heading: "Brand new" }]);
      expect(r.kept).toEqual([]);
    }
  });

  it("two pending ids get two different new ids", () => {
    const after = [H(2, "A", { knowledgeId: pending(0), knowledgeWhen: "a" }), H(2, "B", { knowledgeId: pending(1), knowledgeWhen: "b" })];
    const r = resolve([], after);
    const ids = r.blocks.map(b => propsOf(b).knowledgeId as string);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(KNOWLEDGE_ID_RE);
  });

  it("an old note that held one id twice gets both headings back as they were", () => {
    const before = [H(2, "A", K("k_00000001", { knowledgeConclusion: "first" })), P("x"), H(2, "A", K("k_00000001", { knowledgeConclusion: "second" }))];
    const after = [H(2, "A"), P("x"), H(2, "A")];
    const r = resolve(before, after);
    expect(r.blocks.map(b => propsOf(b).knowledgeId)).toEqual(["k_00000001", undefined, "k_00000001"]);
    expect(r.blocks.map(b => propsOf(b).knowledgeConclusion)).toEqual(["first", undefined, "second"]);
    expect(r.kept).toEqual([{ id: "k_00000001", heading: "A" }, { id: "k_00000001", heading: "A" }]);
  });

  it("two knowledge headings swapped without comments both keep theirs", () => {
    const before = [H(2, "A", K("k_00000001")), P("a"), H(2, "B", K("k_00000002")), P("b")];
    const after = [H(2, "B"), P("b"), H(2, "A"), P("a")];
    expect(knowledgePairs(before, after).sort()).toEqual([[0, 2], [2, 0]]);
    const r = resolve(before, after);
    expect(r.blocks.map(b => propsOf(b).knowledgeId)).toEqual(["k_00000002", undefined, "k_00000001", undefined]);
    expect(r.kept.map(k => k.id).sort()).toEqual(["k_00000001", "k_00000002"]);
  });

  it("a heading whose level changed is not paired by the swap pass either", () => {
    const before = [H(2, "A", K("k_00000001")), H(2, "B", K("k_00000002"))];
    expect(knowledgePairs(before, [H(2, "B"), H(3, "A")])).toEqual([[1, 0]]);
  });

  it("blocks that need no change keep their identity", () => {
    const before = [P("a"), H(2, "A", K("k_00000001"))];
    const after = [P("a"), H(2, "Other"), P("b")];
    const r = resolve(before, after);
    r.blocks.forEach((b, i) => expect(b).toBe(after[i]));
    const plain = resolve([], after);
    plain.blocks.forEach((b, i) => expect(b).toBe(after[i]));
  });
});

function KNOWLEDGE_PROP_NAMES_OF(b: KnowledgeBlockShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(propsOf(b))) if (k.startsWith("knowledge")) out[k] = v;
  return out;
}

describe("knowledgeWriteProblem", () => {
  const info = (over: Partial<KnowledgeInfo> = {}): KnowledgeInfo => ({ id: "k_00000001", when: "w", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "", ...over });
  const problem = (props: Record<string, unknown>, current: KnowledgeInfo[] = [], noteId: string | null = NOTE) =>
    knowledgeWriteProblem([H(2, "D1", { knowledgeId: "k_00000001", ...props })], new Map(current.map(i => [i.id, i])), noteId);

  it("outdated without superseded_by is superseded_required unless it equals the stored knowledge with that id", () => {
    expect(problem({ knowledgeWhen: "w", knowledgeStatus: "outdated" })).toEqual({ problem: "superseded_required", key: "superseded_by", heading: "D1" });
    expect(problem({ knowledgeWhen: "w", knowledgeStatus: "outdated" }, [info({ status: "outdated" })])).toBeNull();
    expect(problem({ knowledgeWhen: "w", knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000002" })).toBeNull();
  });

  it("a knowledge with no field set is empty; superseded_by naming itself is superseded_self", () => {
    expect(problem({})).toEqual({ problem: "empty", heading: "D1" });
    expect(problem({ knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000001" })).toMatchObject({ problem: "superseded_self", key: "superseded_by" });
    expect(problem({ knowledgeStatus: "outdated", knowledgeSupersededBy: `${NOTE}#k_00000001` })).toMatchObject({ problem: "superseded_self" });
    expect(problem({ knowledgeStatus: "outdated", knowledgeSupersededBy: `${OTHER}#k_00000001` })).toBeNull();
    expect(problem({ knowledgeStatus: "outdated", knowledgeSupersededBy: `${NOTE}#k_00000001` }, [], null)).toBeNull();
  });

  it("value checks: bad id, evidence guess, status current, 2026-02-30, x#k_1, 201 code points in when, 301 in conclusion", () => {
    expect(knowledgeWriteProblem([H(2, "D1", { knowledgeId: "k_zz", knowledgeWhen: "w" })], new Map(), NOTE)).toMatchObject({ problem: "bad_id", key: "id" });
    expect(problem({ knowledgeWhen: "w", knowledgeEvidence: "guess" })).toMatchObject({ problem: "bad_evidence", key: "evidence" });
    expect(problem({ knowledgeWhen: "w", knowledgeStatus: "current" })).toMatchObject({ problem: "bad_status", key: "status" });
    expect(problem({ knowledgeWhen: "w", knowledgeVerified: "2026-02-30" })).toMatchObject({ problem: "bad_date", key: "verified" });
    expect(problem({ knowledgeWhen: "w", knowledgeSupersededBy: "x#k_1" })).toMatchObject({ problem: "bad_ref", key: "superseded_by" });
    expect(problem({ knowledgeWhen: "w".repeat(201) })).toMatchObject({ problem: "too_long", key: "when" });
    expect(problem({ knowledgeConclusion: "c".repeat(301) })).toMatchObject({ problem: "too_long", key: "conclusion" });
    expect(problem({ knowledgeWhen: "w", knowledgeEvidence: "tested", knowledgeStatus: "unverified", knowledgeVerified: "2026-02-28", knowledgeSupersededBy: `${OTHER}#k_00000002` })).toBeNull();
  });

  it("a line break (CR, LF, U+0085, U+2028, U+2029) in when or conclusion is line_break with the key", () => {
    for (const code of [0x0d, 0x0a, 0x85, 0x2028, 0x2029]) {
      const text = `a${String.fromCharCode(code)}b`;
      expect(problem({ knowledgeWhen: text })).toMatchObject({ problem: "line_break", key: "when" });
      expect(problem({ knowledgeWhen: "w", knowledgeConclusion: text })).toMatchObject({ problem: "line_break", key: "conclusion" });
    }
    expect(problem({ knowledgeWhen: "a\tb" })).toBeNull();
  });

  it("a stored knowledge with a line break, an over-long when or an unreadable evidence is accepted when written back unchanged", () => {
    const long = "w".repeat(250);
    const stored = [info({ when: "x\r\ny", conclusion: "c d" }), info({ when: long })];
    expect(problem({ knowledgeWhen: "x\r\ny", knowledgeConclusion: "c d" }, [stored[0]!])).toBeNull();
    expect(problem({ knowledgeWhen: long }, [stored[1]!])).toBeNull();
    // Changing any one field brings the checks back.
    expect(problem({ knowledgeWhen: long, knowledgeConclusion: "now" }, [stored[1]!])).toMatchObject({ problem: "too_long", key: "when" });
    // Evidence the reader drops (stored as something unknown) comes back as empty, which equals what is stored once read.
    expect(problem({ knowledgeWhen: "w", knowledgeEvidence: "" }, [info({ evidence: "" })])).toBeNull();
  });

  it("200 CJK characters with an emoji fit when; 300 fit conclusion", () => {
    expect(problem({ knowledgeWhen: `${"測".repeat(199)}😀` })).toBeNull();
    expect(problem({ knowledgeWhen: `${"測".repeat(200)}😀` })).toMatchObject({ problem: "too_long" });
    expect(problem({ knowledgeConclusion: "結".repeat(300) })).toBeNull();
    expect(problem({ knowledgeConclusion: `${"結".repeat(299)}😀` })).toBeNull();
  });

  it("reports the first problem in document order and checks only top-level knowledge headings", () => {
    const blocks = [P("x"), H(2, "Fine", { knowledgeId: "k_00000001", knowledgeWhen: "w" }), H(2, "Broken", { knowledgeId: "k_00000002", knowledgeEvidence: "guess", knowledgeWhen: "w" }), H(2, "Plain")];
    expect(knowledgeWriteProblem(blocks, new Map(), NOTE)).toMatchObject({ problem: "bad_evidence", heading: "Broken" });
    expect(knowledgeWriteProblem([H(2, "Plain")], new Map(), NOTE)).toBeNull();
  });
});

describe("normalizeKnowledgeRefs", () => {
  it("turns <this note>#k_x into k_x and leaves other notes' refs alone", () => {
    const own = H(2, "A", K("k_00000001", { knowledgeSupersededBy: `${NOTE.toUpperCase()}#k_00000002` }));
    const other = H(2, "B", K("k_00000003", { knowledgeSupersededBy: `${OTHER}#k_00000004` }));
    const bare = H(2, "C", K("k_00000005", { knowledgeSupersededBy: "k_00000006" }));
    const plain = P("p");
    const out = normalizeKnowledgeRefs([own, other, bare, plain], NOTE);
    expect(propsOf(out[0]!).knowledgeSupersededBy).toBe("k_00000002");
    expect(out[1]).toBe(other);
    expect(out[2]).toBe(bare);
    expect(out[3]).toBe(plain);
  });
});

describe("knowledgeRefsIn", () => {
  it("lists top-level knowledge headings in document order", () => {
    expect(knowledgeRefsIn([P("x"), H(2, "A", K("k_00000001")), H(3, "Plain"), H(1, [{ type: "text", text: "B" }], K("k_00000002"))])).toEqual([
      { id: "k_00000001", heading: "A" },
      { id: "k_00000002", heading: "B" },
    ]);
  });
});
