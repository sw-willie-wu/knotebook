import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  knowledgeHeadingText,
  listKnowledge,
  listKnowledgeInBlocks,
  listKnowledgeInFragment,
  summarizeAllKnowledgeDescendants,
  summarizeKnowledgeDescendants,
  type KnowledgeBlockLike,
  type KnowledgeTopLevelItem,
} from "./knowledge-list.js";

const K = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ knowledgeId: id, ...over });

function H(blockId: string, level: number, text: string, props: Record<string, unknown> = {}): KnowledgeTopLevelItem {
  return { blockId, heading: { level, text, props } };
}
const P = (blockId: string): KnowledgeTopLevelItem => ({ blockId, heading: null });

const ids = (entries: Array<{ blockId: string }>): string[] => entries.map((e) => e.blockId);

describe("listKnowledge", () => {
  it("only top-level headings with a knowledge id are listed; headings in columns or as children are not", () => {
    const entries = listKnowledge([P("p"), H("plain", 1, "Plain"), H("h", 1, "H", K("k_00000001")), P("col")]);
    expect(ids(entries)).toEqual(["h"]);
    // Headings below the top level never reach listKnowledge; the adapters drop them.
    const blocks: KnowledgeBlockLike[] = [
      { id: "col", type: "columnList", props: {} },
      { id: "h", type: "heading", props: { level: 1, ...K("k_00000001") }, content: [{ type: "text", text: "H", styles: {} }] },
      { id: "para", type: "paragraph", props: { ...K("k_00000002") } },
    ];
    expect(ids(listKnowledgeInBlocks(blocks))).toEqual(["h"]);
  });

  it("range runs to the next heading of the same or higher level, knowledge or not", () => {
    const entries = listKnowledge([
      H("a", 1, "A", K("k_00000001")), P("p1"), H("b", 2, "B"), P("p2"), H("c", 2, "C", K("k_00000002")), P("p3"), H("d", 1, "D"), P("p4"),
    ]);
    expect(entries.find((e) => e.blockId === "a")!.rangeBlockIds).toEqual(["a", "p1", "b", "p2", "c", "p3"]);
    expect(entries.find((e) => e.blockId === "c")!.rangeBlockIds).toEqual(["c", "p3"]);
  });

  it("a plain heading of the same level ends a knowledge range", () => {
    const entries = listKnowledge([H("a", 2, "A", K("k_00000001")), P("p1"), H("b", 2, "B"), P("p2")]);
    expect(entries[0]!.rangeBlockIds).toEqual(["a", "p1"]);
  });

  it("nesting: a lower heading inside a knowledge range gets that knowledge as parent, and ancestors outermost first", () => {
    const entries = listKnowledge([
      H("a", 1, "A", K("k_00000001")),
      H("plain", 2, "skipped"),
      H("b", 3, "B", K("k_00000002")),
      H("c", 4, "C", K("k_00000003")),
      H("d", 2, "D", K("k_00000004")),
      H("e", 1, "E", K("k_00000005")),
    ]);
    const by = Object.fromEntries(entries.map((e) => [e.blockId, e]));
    expect(by.a!.parentBlockId).toBeNull();
    expect(by.a!.ancestorBlockIds).toEqual([]);
    expect(by.b!.parentBlockId).toBe("a");
    expect(by.c!.parentBlockId).toBe("b");
    expect(by.c!.ancestorBlockIds).toEqual(["a", "b"]);
    expect(by.d!.parentBlockId).toBe("a");
    expect(by.e!.parentBlockId).toBeNull();
  });

  it("icon: inherited outdated wins over needs review, then no verified date, then verified", () => {
    const entries = listKnowledge([
      H("a", 1, "A", K("k_00000001", { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" })),
      H("b", 2, "B", K("k_00000002", { knowledgeStatus: "unverified", knowledgeVerified: "2026-01-01" })),
      H("c", 1, "C", K("k_00000003", { knowledgeStatus: "unverified" })),
      H("d", 2, "D", K("k_00000004")),
      H("e", 2, "E", K("k_00000005", { knowledgeVerified: "2026-01-01" })),
    ]);
    const by = Object.fromEntries(entries.map((e) => [e.blockId, e]));
    expect(by.a!.icon).toBe("outdated");
    expect(by.b!.icon).toBe("outdated");
    expect(by.b!.outdated).toBe(true);
    expect(by.b!.info.status).toBe("unverified");
    expect(by.c!.icon).toBe("needsReview");
    expect(by.d!.icon).toBe("noVerifiedDate");
    expect(by.d!.outdated).toBe(false);
    expect(by.e!.icon).toBe("verified");
  });

  it("outdated passes through a middle level to the deepest descendant", () => {
    const entries = listKnowledge([
      H("a", 1, "A", K("k_00000001", { knowledgeStatus: "outdated" })),
      H("b", 2, "B", K("k_00000002")),
      H("c", 3, "C", K("k_00000003", { knowledgeVerified: "2026-01-01" })),
    ]);
    expect(entries.map((e) => e.icon)).toEqual(["outdated", "outdated", "outdated"]);
  });
});

describe("heading levels", () => {
  it("only integer levels 1 to 6 are read; anything else is 1", () => {
    for (const bad of [7, 0, 1.5, 1e9, -2, "abc", "7", "", NaN, Infinity, [2], null, {}]) {
      const [e] = listKnowledgeInBlocks([{ id: "h", type: "heading", props: { level: bad, knowledgeId: "k_00000001" } }]);
      expect(e!.level, String(bad)).toBe(1);
    }
    for (const good of [1, 2, 6, "3"]) {
      const [e] = listKnowledgeInBlocks([{ id: "h", type: "heading", props: { level: good, knowledgeId: "k_00000001" } }]);
      expect(e!.level).toBe(Number(good));
    }
  });

  it("20,000 headings with ever-increasing levels nest at most five ancestors deep", () => {
    const blocks: KnowledgeBlockLike[] = Array.from({ length: 20_000 }, (_, i) => ({
      id: `h${i}`, type: "heading", props: { level: i + 1, knowledgeId: `k_${i.toString(16).padStart(8, "0")}` },
    }));
    const entries = listKnowledgeInBlocks(blocks);
    expect(entries).toHaveLength(20_000);
    expect(Math.max(...entries.map((e) => e.ancestorBlockIds.length))).toBeLessThanOrEqual(5);
  });
});

describe("summaries", () => {
  const entries = listKnowledge([
    H("a", 1, "A", K("k_00000001", { knowledgeVerified: "2026-01-01" })),
    H("b", 2, "B", K("k_00000002", { knowledgeVerified: "2026-01-01" })),
    H("c", 3, "C", K("k_00000003")),
    H("d", 3, "D", K("k_00000004", { knowledgeStatus: "unverified" })),
    H("e", 2, "E", K("k_00000005", { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" })),
    H("f", 3, "F", K("k_00000006")),
    H("g", 1, "G", K("k_00000007")),
  ]);

  it("counts every knowledge descendant by its icon and is null without descendants", () => {
    expect(summarizeKnowledgeDescendants(entries, "a")).toEqual({ total: 5, verified: 1, noVerifiedDate: 1, needsReview: 1, outdated: 2 });
    expect(summarizeKnowledgeDescendants(entries, "b")).toEqual({ total: 2, verified: 0, noVerifiedDate: 1, needsReview: 1, outdated: 0 });
    expect(summarizeKnowledgeDescendants(entries, "c")).toBeNull();
    expect(summarizeKnowledgeDescendants(entries, "g")).toBeNull();
    expect(summarizeKnowledgeDescendants(entries, "missing")).toBeNull();
  });

  it("summarizeAllKnowledgeDescendants gives every entry the same summary as summarizeKnowledgeDescendants", () => {
    const all = summarizeAllKnowledgeDescendants(entries);
    for (const e of entries) {
      expect(all.get(e.blockId) ?? null, e.blockId).toEqual(summarizeKnowledgeDescendants(entries, e.blockId));
    }
    expect([...all.keys()].sort()).toEqual(["a", "b", "e"]);
  });

  it("summarizeAllKnowledgeDescendants handles 5,000 children of one parent", () => {
    const items = [H("root", 1, "R", K("k_00000000"))];
    for (let i = 0; i < 5000; i += 1) items.push(H(`c${i}`, 2, `C${i}`, K(`k_${i.toString(16).padStart(8, "0").replace(/^0/, "1")}`)));
    const list = listKnowledge(items);
    expect(summarizeAllKnowledgeDescendants(list).get("root")!.total).toBe(5000);
    expect(summarizeKnowledgeDescendants(list, "root")!.total).toBe(5000);
  });
});

function xml(name: string, attrs: Record<string, unknown> = {}): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string);
  return el;
}

function yText(value: string): Y.XmlText {
  const t = new Y.XmlText();
  t.insert(0, value);
  return t;
}

function yDoc(): { doc: Y.Doc; fragment: Y.XmlFragment; group: Y.XmlElement } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("doc");
  const group = xml("blockGroup");
  fragment.insert(0, [group]);
  return { doc, fragment, group };
}

function yContainer(id: string, content: Y.XmlElement): Y.XmlElement {
  const c = xml("blockContainer", { id });
  c.insert(0, [content]);
  return c;
}

describe("listKnowledgeInFragment", () => {
  it("returns the same entries as listKnowledgeInBlocks for the same note", () => {
    const nested = { knowledgeId: "k_0000000b", knowledgeWhen: "when b", knowledgeVerified: "2026-01-01" };
    const blocks: KnowledgeBlockLike[] = [
      { id: "p0", type: "paragraph", props: {}, content: [{ type: "text", text: "intro", styles: {} }] },
      {
        id: "a", type: "heading", props: { level: 1, knowledgeId: "k_0000000a", knowledgeStatus: "outdated", knowledgeSupersededBy: "k_0000000c" },
        content: [{ type: "text", text: "Alpha ", styles: {} }, { type: "wikilink", props: { targetNoteId: "n", snapshotTitle: "Snap", label: "" } }],
      },
      { id: "cols", type: "columnList", props: {} },
      { id: "b", type: "heading", props: { level: 2, ...nested }, content: [{ type: "link", href: "x", content: [{ type: "text", text: "Beta", styles: {} }] }] },
      { id: "plain", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "plain", styles: {} }] },
    ];
    const { fragment, group } = yDoc();
    const a = xml("heading", { level: 1, knowledgeId: "k_0000000a", knowledgeStatus: "outdated", knowledgeSupersededBy: "k_0000000c" });
    a.insert(0, [yText("Alpha "), xml("wikilink", { targetNoteId: "n", snapshotTitle: "Snap", label: "" })]);
    const b = xml("heading", { level: 2, ...nested });
    b.insert(0, [yText("Beta")]);
    const plain = xml("heading", { level: 2 });
    plain.insert(0, [yText("plain")]);
    const p0 = xml("paragraph");
    p0.insert(0, [yText("intro")]);
    group.insert(0, [yContainer("p0", p0), yContainer("a", a), xml("columnList", { id: "cols" }), yContainer("b", b), yContainer("plain", plain)]);
    const fromBlocks = listKnowledgeInBlocks(blocks);
    expect(fromBlocks.map((e) => e.blockId)).toEqual(["a", "b"]);
    expect(fromBlocks[0]!.heading).toBe("Alpha Snap");
    expect(listKnowledgeInFragment(fragment)).toEqual(fromBlocks);
  });

  it("headings nested inside a column list or a block's children are not listed", () => {
    const { fragment, group } = yDoc();
    const inner = xml("heading", { level: 1, knowledgeId: "k_00000001" });
    const col = xml("column");
    const colGroup = xml("blockGroup");
    col.insert(0, [colGroup]);
    const list = xml("columnList", { id: "cols" });
    list.insert(0, [col]);
    group.insert(0, [list]);
    colGroup.insert(0, [yContainer("in", inner)]);
    const para = xml("paragraph");
    const parent = yContainer("par", para);
    const kids = xml("blockGroup");
    parent.insert(1, [kids]);
    group.insert(1, [parent]);
    kids.insert(0, [yContainer("kid", xml("heading", { level: 1, knowledgeId: "k_00000002" }))]);
    expect(listKnowledgeInFragment(fragment)).toEqual([]);
  });

  it("non-string heading attributes in the Y.Doc read as empty and a non-numeric level reads as 1, without throwing", () => {
    const { fragment, group } = yDoc();
    const h = xml("heading");
    h.setAttribute("knowledgeId", ["x"] as unknown as string);
    h.setAttribute("level", "abc");
    h.setAttribute("knowledgeWhen", 7 as unknown as string);
    group.insert(0, [yContainer("bad", h)]);
    const ok = xml("heading", { level: "abc", knowledgeId: "k_00000001" });
    ok.setAttribute("knowledgeWhen", 7 as unknown as string);
    ok.setAttribute("knowledgeConclusion", ["z"] as unknown as string);
    group.insert(1, [yContainer("ok", ok)]);
    const entries = listKnowledgeInFragment(fragment);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe(1);
    expect(entries[0]!.info.when).toBe("");
    expect(entries[0]!.info.conclusion).toBe("");
  });

  it("blocks without a string id are skipped, so they cannot merge into one summary key", () => {
    const { fragment, group } = yDoc();
    const mk = (id: unknown, kid: string, level: number): Y.XmlElement => {
      const c = xml("blockContainer");
      if (id !== undefined) c.setAttribute("id", id as string);
      c.insert(0, [xml("heading", { level, knowledgeId: kid })]);
      return c;
    };
    group.insert(0, [yContainer("root", xml("heading", { level: 1, knowledgeId: "k_00000001" })), mk(5, "k_00000002", 2), mk(undefined, "k_00000003", 2), mk(["x"], "k_00000004", 2)]);
    expect(listKnowledgeInFragment(fragment).map((e) => e.blockId)).toEqual(["root"]);
    const blocks = [
      { id: "root", type: "heading", props: { level: 1, knowledgeId: "k_00000001" } },
      { id: 5 as unknown as string, type: "heading", props: { level: 2, knowledgeId: "k_00000002" } },
      { id: undefined as unknown as string, type: "heading", props: { level: 2, knowledgeId: "k_00000003" } },
    ];
    expect(listKnowledgeInBlocks(blocks).map((e) => e.blockId)).toEqual(["root"]);
  });

  it("a hard break in a heading reads as a space in both representations", () => {
    const { fragment, group } = yDoc();
    const h = xml("heading", { level: 1, knowledgeId: "k_00000001" });
    group.insert(0, [yContainer("h", h)]);
    h.insert(0, [yText("line1"), xml("hardBreak"), yText("line2")]);
    expect(listKnowledgeInFragment(fragment)[0]!.heading).toBe("line1 line2");
  });
});

describe("knowledgeHeadingText", () => {
  it("joins text, link text and wikilink label (falling back to the snapshot title) and collapses whitespace", () => {
    expect(
      knowledgeHeadingText([
        { type: "text", text: "  a\n b", styles: {} },
        { type: "link", href: "x", content: [{ type: "text", text: " c", styles: {} }] },
        { type: "wikilink", props: { label: "L", snapshotTitle: "S" } },
        { type: "wikilink", props: { label: "", snapshotTitle: "S" } },
        { type: "wikilink", props: { label: 3, snapshotTitle: ["x"] } },
      ]),
    ).toBe("a b cLS");
    expect(knowledgeHeadingText(undefined)).toBe("");
    expect(knowledgeHeadingText("  plain  text ")).toBe("plain text");
  });

  it("heading text 100,000 levels deep is read without overflowing the stack", () => {
    const depth = 100_000;
    const root: { type: string; href: string; content: unknown[] } = { type: "link", href: "x", content: [] };
    let cur = root;
    for (let i = 0; i < depth; i += 1) {
      const next = { type: "link", href: "x", content: [] as unknown[] };
      cur.content.push(next);
      cur = next;
    }
    cur.content.push({ type: "text", text: "deep", styles: {} });
    expect(knowledgeHeadingText([root])).toBe("deep");

    // Built top-down in one transaction: Yjs itself recurses when integrating a deep detached subtree.
    const { doc, fragment, group } = yDoc();
    doc.transact(() => {
      const heading = xml("heading", { level: 1, knowledgeId: "k_00000001" });
      group.insert(0, [yContainer("deep", heading)]);
      let parent = heading;
      for (let i = 0; i < depth; i += 1) {
        const child = xml("link");
        parent.insert(0, [child]);
        parent = child;
      }
      const t = new Y.XmlText();
      parent.insert(0, [t]);
      t.insert(0, "deep");
    });
    const entries = listKnowledgeInFragment(fragment);
    expect(entries.map((e) => e.heading)).toEqual(["deep"]);
    expect(
      listKnowledgeInBlocks([{ id: "deep", type: "heading", props: { level: 1, knowledgeId: "k_00000001" }, content: [root] }])[0]!.heading,
    ).toBe("deep");
  });
});
