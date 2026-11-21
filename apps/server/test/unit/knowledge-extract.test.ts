import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ANCHOR_RE,
  KNOWLEDGE_CONCLUSION_MAX,
  KNOWLEDGE_ICON_KINDS,
  KNOWLEDGE_ID_RE,
  KNOWLEDGE_WHEN_MAX,
  YDOC_FRAGMENT,
  listKnowledgeInFragment,
  summarizeKnowledgeDescendants,
} from "@knotebook/shared";
import { EMPTY_KNOWLEDGE_EXTRACT, extractKnowledgeForIndex, extractKnowledgeIndex, knowledgeContentHash } from "../../src/knowledge/extract.js";
import { kh, kid, knowledgeDoc, type KBlk } from "../knowledge-helpers.js";

const frag = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT);
const extract = (blocks: KBlk[]) => extractKnowledgeIndex(frag(knowledgeDoc(blocks)));
const NUL = String.fromCodePoint(0);

describe("extractKnowledgeIndex", () => {
  it("lists knowledge headings in document order with ord 0..n-1 and skips plain headings", () => {
    const r = extract([
      { id: "p0", text: "intro" },
      { id: "plain", type: "heading", level: 2, text: "plain heading" },
      kh("h1", kid(1), "First", { level: 1 }),
      { id: "p1", text: "body" },
      kh("h2", kid(2), "Second", { level: 1 }),
    ]);
    expect(r.rows.map((x) => [x.knowledgeId, x.blockId, x.ord, x.heading])).toEqual([
      [kid(1), "h1", 0, "First"],
      [kid(2), "h2", 1, "Second"],
    ]);
    expect(r.capped).toBe(false);
  });

  it("keeps the first of two headings with the same knowledge id and drops the later one", () => {
    const r = extract([kh("a", kid(1), "A"), kh("b", kid(1), "B"), kh("c", kid(2), "C")]);
    expect(r.rows.map((x) => x.blockId)).toEqual(["a", "c"]);
    expect(r.rows.map((x) => x.ord)).toEqual([0, 1]);
  });

  it("drops entries whose knowledge id or block id is malformed, and a nested entry under a dropped parent gets the nearest kept ancestor", () => {
    const r = extract([
      kh("top", kid(1), "Top", { level: 1 }),
      kh("bad", "k_ZZZZ", "Bad", { level: 2 }),
      kh("deep", kid(3), "Deep", { level: 3 }),
      kh("bad id!", kid(4), "BadBlock", { level: 2 }),
    ]);
    expect(r.rows.map((x) => [x.knowledgeId, x.parentKnowledgeId])).toEqual([
      [kid(1), null],
      [kid(3), kid(1)],
    ]);
  });

  it("cuts heading at 200, when and conclusion at their limits in code points, and replaces NUL and lone surrogates with U+FFFD", () => {
    const smile = String.fromCodePoint(0x1f600);
    const r = extract([
      kh("a", kid(1), smile.repeat(300), {
        when: smile.repeat(KNOWLEDGE_WHEN_MAX + 50),
        conclusion: `x${NUL}y\ud800z`.padEnd(KNOWLEDGE_CONCLUSION_MAX + 20, "q"),
      }),
    ]);
    const row = r.rows[0]!;
    expect([...row.heading]).toHaveLength(200);
    expect([...row.when]).toHaveLength(KNOWLEDGE_WHEN_MAX);
    expect([...row.conclusion]).toHaveLength(KNOWLEDGE_CONCLUSION_MAX);
    expect(row.conclusion.startsWith("x�y�z")).toBe(true);
    expect(row.conclusion).not.toContain(NUL);
  });

  it("an invalid verified date is stored as null; evidence and status outside the allowed values read as empty", () => {
    const r = extract([
      kh("a", kid(1), "A", { verified: "2026-02-30", evidence: "guess", status: "stale" }),
      kh("b", kid(2), "B", { verified: "2026-02-28", evidence: "tested", status: "unverified" }),
    ]);
    expect(r.rows.map((x) => [x.verified, x.evidence, x.status])).toEqual([
      [null, "", ""],
      ["2026-02-28", "tested", "unverified"],
    ]);
  });

  it("stores the parsed replaced-by ref: a bare id has supersededNoteId null, an other-note ref keeps the lowercased note id; garbage is null", () => {
    const other = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    const r = extract([
      kh("a", kid(1), "A", { status: "outdated", supersededBy: kid(9) }),
      kh("b", kid(2), "B", { status: "outdated", supersededBy: `${other}#${kid(8)}` }),
      kh("c", kid(3), "C", { status: "outdated", supersededBy: "garbage" }),
    ]);
    expect(r.rows.map((x) => [x.supersededNoteId, x.supersededKnowledgeId])).toEqual([
      [null, kid(9)],
      [other.toLowerCase(), kid(8)],
      [null, null],
    ]);
  });

  it("stores the descendant summary of a parent and zeros for a leaf, counting outdated descendants", () => {
    const r = extract([
      kh("p", kid(1), "Parent", { level: 1, verified: "2026-01-01" }),
      kh("c1", kid(2), "Child1", { level: 2, verified: "2026-01-01" }),
      kh("c2", kid(3), "Child2", { level: 2 }),
      kh("c3", kid(4), "Child3", { level: 2, status: "unverified" }),
      kh("c4", kid(5), "Child4", { level: 2, status: "outdated", supersededBy: kid(1) }),
    ]);
    const [p, ...kids] = r.rows;
    expect([p!.descTotal, p!.descVerified, p!.descNoDate, p!.descNeedsReview, p!.descOutdated]).toEqual([4, 1, 1, 1, 1]);
    for (const k of kids) expect(k.descTotal).toBe(0);
  });

  it("icon follows the inherited outdated rule", () => {
    const r = extract([
      kh("p", kid(1), "Parent", { level: 1, status: "outdated", supersededBy: kid(7), verified: "2026-01-01" }),
      kh("c", kid(2), "Child", { level: 2, verified: "2026-01-01" }),
    ]);
    expect(r.rows.map((x) => x.icon)).toEqual(["outdated", "outdated"]);
  });

  it("stops at 2000 rows and sets capped; 2000 exactly is not capped", () => {
    const make = (n: number): KBlk[] => Array.from({ length: n }, (_, i) => kh(`b${i}`, kid(i + 1), `H${i}`, { level: 1 }));
    const exact = extract(make(2000));
    expect([exact.rows.length, exact.capped]).toEqual([2000, false]);
    const over = extract(make(2001));
    expect([over.rows.length, over.capped]).toEqual([2000, true]);
    expect(over.contentHash).not.toBe(knowledgeContentHash(over.extractorVersion, over.rows, false));
  });

  it("the content hash changes when any stored field changes and stays the same for an identical document; EMPTY_KNOWLEDGE_EXTRACT equals extracting a document without knowledge", () => {
    const base = [kh("a", kid(1), "A", { when: "w", conclusion: "c" })];
    expect(extract(base).contentHash).toBe(extract(base).contentHash);
    for (const changed of [
      [kh("a", kid(1), "A2", { when: "w", conclusion: "c" })],
      [kh("a", kid(1), "A", { when: "w2", conclusion: "c" })],
      [kh("a", kid(1), "A", { when: "w", conclusion: "c2" })],
      [kh("a", kid(1), "A", { when: "w", conclusion: "c", verified: "2026-01-01" })],
      [kh("a", kid(1), "A", { when: "w", conclusion: "c", level: 3 })],
    ]) {
      expect(extract(changed).contentHash).not.toBe(extract(base).contentHash);
    }
    expect(extract([{ id: "p", text: "no knowledge" }])).toEqual(EMPTY_KNOWLEDGE_EXTRACT);
  });

  it("array, number and object values never reach a row: an array knowledge id or block id drops the entry, an array verified is null, an array when is empty", () => {
    const arrId: KBlk = { id: "a1", type: "heading", level: 2, text: "A", knowledge: { knowledgeId: [kid(1)] } };
    const arrBlock: KBlk = { id: ["b1"], type: "heading", level: 2, text: "B", knowledge: { knowledgeId: kid(2) } };
    const arrOthers = kh("c1", kid(3), "C");
    arrOthers.knowledge = {
      ...arrOthers.knowledge,
      knowledgeVerified: ["2026-01-01"],
      knowledgeWhen: ["w"],
      knowledgeConclusion: 42,
      knowledgeEvidence: { a: 1 },
      knowledgeStatus: [],
    };
    const r = extract([arrId, arrBlock, arrOthers]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ knowledgeId: kid(3), verified: null, when: "", conclusion: "", evidence: "", status: "" });
  });

  it("level 0, 7 and 2.5 never produce an out-of-range row", () => {
    const r = extract([
      { id: "a", type: "heading", level: 0, text: "A", knowledge: { knowledgeId: kid(1) } },
      { id: "b", type: "heading", level: 7, text: "B", knowledge: { knowledgeId: kid(2) } },
      { id: "c", type: "heading", level: 2.5, text: "C", knowledge: { knowledgeId: kid(3) } },
    ]);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.level).toBeGreaterThanOrEqual(1);
      expect(row.level).toBeLessThanOrEqual(6);
    }
  });

  it("an icon kind outside KNOWLEDGE_ICON_KINDS drops the entry", async () => {
    vi.resetModules();
    vi.doMock("@knotebook/shared", async (orig) => {
      const real = await orig<typeof import("@knotebook/shared")>();
      return {
        ...real,
        listKnowledgeInFragment: (f: Y.XmlFragment) => real.listKnowledgeInFragment(f).map((e, i) => (i === 0 ? { ...e, icon: "bogus" as never } : e)),
      };
    });
    const mod = await import("../../src/knowledge/extract.js");
    const r = mod.extractKnowledgeIndex(frag(knowledgeDoc([kh("a", kid(1), "A"), kh("b", kid(2), "B")])));
    expect(r.rows.map((x) => x.knowledgeId)).toEqual([kid(2)]);
    vi.doUnmock("@knotebook/shared");
    vi.resetModules();
  });

  it("when listKnowledgeInFragment throws, extraction returns no rows and capped instead of throwing", async () => {
    vi.resetModules();
    vi.doMock("@knotebook/shared", async (orig) => ({
      ...(await orig<typeof import("@knotebook/shared")>()),
      listKnowledgeInFragment: () => {
        throw new RangeError("boom");
      },
    }));
    const mod = await import("../../src/knowledge/extract.js");
    const r = mod.extractKnowledgeIndex(frag(knowledgeDoc([kh("a", kid(1), "A")])));
    expect(r.rows).toEqual([]);
    expect(r.capped).toBe(true);
    vi.doUnmock("@knotebook/shared");
    vi.resetModules();
  });

  it("every row produced from a hostile document satisfies the note_knowledge checks", () => {
    const hostile: KBlk[] = [
      kh("a", kid(1), `${NUL}head\udc00`, { when: NUL, conclusion: "\ud800x", verified: "9999-99-99", evidence: "tested", status: "outdated", supersededBy: "not-a-ref" }),
      kh("b", kid(2), "B", { level: 9, supersededBy: `AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE#${kid(1)}`, status: "outdated" }),
      { id: "c", type: "heading", level: 1, text: "C", knowledge: { knowledgeId: kid(3), knowledgeEvidence: ["tested"], knowledgeStatus: 7 } },
    ];
    const r = extract(hostile);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(KNOWLEDGE_ID_RE.test(row.knowledgeId)).toBe(true);
      expect(BLOCK_ANCHOR_RE.test(row.blockId)).toBe(true);
      expect(row.level).toBeGreaterThanOrEqual(1);
      expect(row.level).toBeLessThanOrEqual(6);
      expect(["", "tested", "docs", "inferred"]).toContain(row.evidence);
      expect(["", "unverified", "outdated"]).toContain(row.status);
      expect(KNOWLEDGE_ICON_KINDS as readonly string[]).toContain(row.icon);
      if (row.supersededNoteId !== null) expect(row.supersededKnowledgeId).not.toBeNull();
      for (const text of [row.heading, row.when, row.conclusion]) expect(text).not.toMatch(/\0|[\ud800-\udfff]/);
    }
  });
});

describe("hostile sizes", () => {
  it("a 100 000-level-deep document (built in one doc.transact) and a 260 000-character heading extract without throwing", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const f = frag(doc);
      const group = new Y.XmlElement("blockGroup");
      f.insert(0, [group]);
      let node: Y.XmlElement = group;
      for (let i = 0; i < 100_000; i += 1) {
        const c = new Y.XmlElement("blockContainer");
        node.insert(0, [c]);
        const g = new Y.XmlElement("blockGroup");
        c.insert(0, [g]);
        node = g;
      }
    });
    expect(() => extractKnowledgeIndex(frag(doc))).not.toThrow();
    const r = extract([kh("a", kid(1), "x".repeat(260_000), { conclusion: "y".repeat(260_000) })]);
    expect(r.rows[0]!.heading).toHaveLength(200);
    expect(r.rows[0]!.conclusion).toHaveLength(KNOWLEDGE_CONCLUSION_MAX);
  });

  it("100 000 knowledge headings nested five deep extract within 3 s, with the same summaries as summarizeKnowledgeDescendants on a 200-heading sample", () => {
    const doc = new Y.Doc();
    // Built in one transaction from detached elements: inserting a hundred thousand blocks one by one is quadratic and would dominate the timing.
    doc.transact(() => {
      const group = new Y.XmlElement("blockGroup");
      const containers = Array.from({ length: 100_000 }, (_, i) => {
        const c = new Y.XmlElement("blockContainer");
        c.setAttribute("id", `b${i}`);
        const h = new Y.XmlElement("heading");
        h.setAttribute("level", String((i % 5) + 1));
        h.setAttribute("knowledgeId", kid(i + 1));
        c.insert(0, [h]);
        return c;
      });
      group.insert(0, containers);
      frag(doc).insert(0, [group]);
    });
    const started = Date.now();
    const r = extractKnowledgeIndex(frag(doc));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.capped).toBe(true);

    const sample = knowledgeDoc(Array.from({ length: 200 }, (_, i) => kh(`b${i}`, kid(i + 1), `H${i}`, { level: (i % 5) + 1 })));
    const entries = listKnowledgeInFragment(frag(sample));
    const out = extractKnowledgeIndex(frag(sample));
    expect(out.rows).toHaveLength(200);
    for (const row of out.rows) {
      const s = summarizeKnowledgeDescendants(entries, row.blockId);
      expect([row.descTotal, row.descVerified, row.descNoDate, row.descNeedsReview, row.descOutdated]).toEqual(
        s ? [s.total, s.verified, s.noVerifiedDate, s.needsReview, s.outdated] : [0, 0, 0, 0, 0],
      );
    }
  });
});

describe("extractKnowledgeForIndex", () => {
  it("bytes without the knowledgeId key skip the walk and return the shared empty result", () => {
    const doc = knowledgeDoc([{ id: "p", text: "plain" }]);
    expect(extractKnowledgeForIndex(doc, Y.encodeStateAsUpdate(doc))).toBe(EMPTY_KNOWLEDGE_EXTRACT);
  });
  it("bytes with the key are walked", () => {
    const doc = knowledgeDoc([kh("a", kid(1), "A")]);
    expect(extractKnowledgeForIndex(doc, Y.encodeStateAsUpdate(doc)).rows).toHaveLength(1);
  });
  it("a document that had knowledge and lost it extracts to the same hash as the shared empty result", () => {
    const doc = knowledgeDoc([kh("a", kid(1), "A")]);
    const group = frag(doc).get(0) as Y.XmlElement;
    const container = group.get(0) as Y.XmlElement;
    (container.get(0) as Y.XmlElement).removeAttribute("knowledgeId");
    expect(extractKnowledgeForIndex(doc, Y.encodeStateAsUpdate(doc)).contentHash).toBe(EMPTY_KNOWLEDGE_EXTRACT.contentHash);
  });
});
