// Server side of knowledge writes: duplicate ids after a write, pending ids, and the error messages.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { KNOWLEDGE_ID_RE, KNOWLEDGE_PENDING_ID_PREFIX, YDOC_FRAGMENT, renewKnowledgeId, type KnowledgeCommentProblem, type KnowledgeProblem } from "@knotebook/shared";
import { knowledgeProblemMessage } from "../../src/notes/editing/knowledge-messages.js";
import {
  assertNoPendingKnowledgeIds,
  emptyKnowledgeReport,
  isEmptyKnowledgeReport,
  knowledgeIdsByBlock,
  knowledgeInfoById,
  mergeKnowledgeReports,
  renewDuplicateKnowledgeIds,
} from "../../src/notes/editing/knowledge-write.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, withForkEditor } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
type AnyBlocks = any[];
const H = (id: string, text: string, knowledgeId = "", extra: Record<string, unknown> = {}) => ({
  id,
  type: "heading",
  props: { level: 2, ...(knowledgeId === "" ? {} : { knowledgeId, knowledgeWhen: "alice reads this" }), ...extra },
  content: text,
});
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });

async function docWith(blocks: AnyBlocks): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks);
  } finally {
    s.close();
  }
  return doc;
}
const fragmentOf = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT);
const idsOf = (doc: Y.Doc) => [...knowledgeIdsByBlock(fragmentOf(doc))].map(([block, id]) => `${block}:${id}`);

function setKnowledgeId(doc: Y.Doc, blockId: string, knowledgeId: string): void {
  const group = fragmentOf(doc).get(0) as Y.XmlElement;
  doc.transact(() => {
    for (const container of group.toArray()) {
      if (container instanceof Y.XmlElement && container.getAttribute("id") === blockId) (container.get(0) as Y.XmlElement).setAttribute("knowledgeId", knowledgeId);
    }
  });
}

describe("renewDuplicateKnowledgeIds", () => {
  it("renews the inserted copy, not the block that held the id before, with renewKnowledgeId's value", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001"), P("p1", "x")]);
    const before = knowledgeIdsByBlock(fragmentOf(doc));
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.insertBlocks([H("hNew", "Copy", "k_00000001")], "p1", "after");
    } finally {
      s.close();
    }
    const out = renewDuplicateKnowledgeIds(doc, before);
    const expected = renewKnowledgeId("hNew", "k_00000001", new Set(["k_00000001"]));
    expect(out).toEqual([{ id: expected, heading: "Copy", from: "k_00000001" }]);
    expect(idsOf(doc)).toEqual(["hA:k_00000001", `hNew:${expected}`]);
    expect(expected).toMatch(KNOWLEDGE_ID_RE);
  });

  it("a rewritten heading that got its old block id back but now carries another heading's id counts as inserted, and the original keeps its id", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001"), H("hB", "B", "k_00000002")]);
    const before = knowledgeIdsByBlock(fragmentOf(doc));
    setKnowledgeId(doc, "hB", "k_00000001");
    const out = renewDuplicateKnowledgeIds(doc, before);
    expect(out.map(r => [r.heading, r.from])).toEqual([["B", "k_00000001"]]);
    const ids = knowledgeIdsByBlock(fragmentOf(doc));
    expect(ids.get("hA")).toBe("k_00000001");
    expect(ids.get("hB")).not.toBe("k_00000001");
    expect(ids.get("hB")).toMatch(KNOWLEDGE_ID_RE);
  });

  it("two inserted copies fall back to document order: the first keeps the id", async () => {
    const doc = await docWith([P("p0", "x"), H("h1", "One", "k_00000005"), H("h2", "Two", "k_00000005")]);
    const out = renewDuplicateKnowledgeIds(doc, new Map());
    expect(out.map(r => r.heading)).toEqual(["Two"]);
    expect(knowledgeIdsByBlock(fragmentOf(doc)).get("h1")).toBe("k_00000005");
  });

  it("ids that were already duplicated before the write and that this write didn't touch are left alone", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001"), H("hB", "B", "k_00000001"), H("hC", "C", "k_00000003")]);
    const before = knowledgeIdsByBlock(fragmentOf(doc));
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.insertBlocks([H("hNew", "New", "k_00000009")], "hC", "after");
    } finally {
      s.close();
    }
    expect(renewDuplicateKnowledgeIds(doc, before)).toEqual([]);
    expect(knowledgeIdsByBlock(fragmentOf(doc)).get("hB")).toBe("k_00000001");
  });

  it("an id that was already on two headings stays on both when a third copy is inserted: only the new one is renewed", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001"), H("hB", "B", "k_00000001"), P("p1", "x")]);
    const before = knowledgeIdsByBlock(fragmentOf(doc));
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.insertBlocks([H("hC", "C", "k_00000001")], "p1", "after");
    } finally {
      s.close();
    }
    const out = renewDuplicateKnowledgeIds(doc, before);
    expect(out.map(x => [x.heading, x.from])).toEqual([["C", "k_00000001"]]);
    const ids = knowledgeIdsByBlock(fragmentOf(doc));
    expect(ids.get("hA")).toBe("k_00000001");
    expect(ids.get("hB")).toBe("k_00000001");
  });

  it("nothing changes and no update is written when there are no duplicates", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001"), H("hB", "B", "k_00000002"), P("p", "x")]);
    const sv = Y.encodeStateVector(doc);
    const state = Y.encodeStateAsUpdate(doc);
    expect(renewDuplicateKnowledgeIds(doc, new Map())).toEqual([]);
    expect(Y.encodeStateVector(doc)).toEqual(sv);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });

  it("a note without knowledge headings is not touched", async () => {
    const doc = await docWith([H("hA", "A"), P("p", "x")]);
    expect(renewDuplicateKnowledgeIds(doc, new Map())).toEqual([]);
  });
});

describe("withForkEditor", () => {
  it("renews a duplicate the callback inserted, and reports it", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001"), P("p1", "x")]);
    const sv = Y.encodeStateVector(doc);
    const w = await withForkEditor(rt, doc, sv, ed => {
      ed.insertBlocks([H("hNew", "Copy", "k_00000001")], "p1", "after");
    });
    expect(w.renewed).toHaveLength(1);
    expect(knowledgeIdsByBlock(fragmentOf(doc)).get("hA")).toBe("k_00000001");
  });

  it("throws before taking the diff when a pending id is left, so nothing is written", async () => {
    const doc = await docWith([P("p1", "x")]);
    const sv = Y.encodeStateVector(doc);
    await expect(
      withForkEditor(rt, doc, sv, ed => {
        ed.insertBlocks([H("hNew", "Copy", `${KNOWLEDGE_PENDING_ID_PREFIX}0`)], "p1", "after");
      }),
    ).rejects.toThrow(/pending knowledge id/);
  });

  it("a note with no knowledge renews nothing", async () => {
    const doc = await docWith([H("hA", "A"), P("p1", "x")]);
    const sv = Y.encodeStateVector(doc);
    const w = await withForkEditor(rt, doc, sv, ed => {
      ed.insertBlocks([P("p2", "y")], "p1", "after");
    });
    expect(w.renewed).toEqual([]);
  });
});

describe("assertNoPendingKnowledgeIds", () => {
  it("throws on a k_new: id the write added and accepts real ids", async () => {
    const ok = await docWith([H("hA", "A", "k_00000001")]);
    expect(() => assertNoPendingKnowledgeIds(fragmentOf(ok), new Map())).not.toThrow();
    const bad = await docWith([H("hA", "A", `${KNOWLEDGE_PENDING_ID_PREFIX}3`)]);
    expect(() => assertNoPendingKnowledgeIds(fragmentOf(bad), new Map())).toThrow();
  });

  it("a k_new: id that was already stored on the same block before the write is not checked", async () => {
    const stored = await docWith([H("hA", "A", `${KNOWLEDGE_PENDING_ID_PREFIX}0`), P("p1", "x")]);
    const sv = Y.encodeStateVector(stored);
    const w = await withForkEditor(rt, stored, sv, ed => {
      ed.insertBlocks([P("p2", "y")], "p1", "after");
    });
    expect(w.renewed).toEqual([]);
    const moved = await docWith([H("hA", "A", `${KNOWLEDGE_PENDING_ID_PREFIX}0`)]);
    expect(() => assertNoPendingKnowledgeIds(fragmentOf(moved), new Map([["hA", `${KNOWLEDGE_PENDING_ID_PREFIX}1`]]))).toThrow();
  });
});

describe("knowledgeInfoById", () => {
  it("lists top-level knowledge by id and lets the first heading win a repeated id", async () => {
    const doc = await docWith([H("hA", "A", "k_00000001", { knowledgeConclusion: "first" }), H("hB", "B", "k_00000001", { knowledgeConclusion: "second" }), H("hC", "C")]);
    const info = knowledgeInfoById(fragmentOf(doc));
    expect([...info.keys()]).toEqual(["k_00000001"]);
    expect(info.get("k_00000001")!.conclusion).toBe("first");
  });
});

describe("KnowledgeWriteReport helpers", () => {
  it("an empty report is empty, any entry or ignored comment makes it not, and merging adds", () => {
    expect(isEmptyKnowledgeReport(emptyKnowledgeReport())).toBe(true);
    const a = { ...emptyKnowledgeReport(), ignoredComments: 1 };
    expect(isEmptyKnowledgeReport(a)).toBe(false);
    const b = { ...emptyKnowledgeReport(), kept: [{ id: "k_00000001", heading: "A" }] };
    const m = mergeKnowledgeReports([a, b, a]);
    expect(m.ignoredComments).toBe(2);
    expect(m.kept).toHaveLength(1);
  });
});

const ALL_PROBLEMS: KnowledgeCommentProblem[] = [
  "not_multiline", "bad_line", "duplicate_key", "bad_value", "unstorable", "blank_line_missing", "two_comments", "unclosed",
  "too_long", "line_break", "bad_id", "bad_evidence", "bad_status", "bad_date", "bad_ref", "empty", "superseded_required", "superseded_self",
];

describe("knowledgeProblemMessage", () => {
  it("cuts the heading at 80 code points and quotes it", () => {
    const kept = "字".repeat(79) + "😀";
    const msg = knowledgeProblemMessage({ problem: "bad_id", key: "id", heading: kept + "尾".repeat(30) });
    expect(msg).toContain(JSON.stringify(`${kept}…`));
    expect(msg).not.toContain("尾");
    expect(knowledgeProblemMessage({ problem: "bad_id", key: "id", heading: kept })).toContain(JSON.stringify(kept));
    expect(knowledgeProblemMessage({ problem: "bad_id", key: "id", heading: 'say "hi"' })).toContain('the heading "say \\"hi\\""');
  });

  it("names an empty heading", () => {
    expect(knowledgeProblemMessage({ problem: "empty", heading: "" })).toBe(
      "The knowledge comment under an empty heading sets none of when, conclusion, evidence, verified, status and superseded_by. Nothing was written.",
    );
  });

  it("every problem has its own reason, in English, and the message ends by saying nothing was written", () => {
    const messages = new Set<string>();
    for (const problem of ALL_PROBLEMS) {
      const p: KnowledgeProblem = { problem, key: problem === "too_long" ? "conclusion" : "when", heading: "D1" };
      const msg = knowledgeProblemMessage(p);
      expect(msg).toMatch(/^The knowledge comment under the heading "D1" [\x20-\x7e]+\. Nothing was written\.$/);
      messages.add(msg);
    }
    expect(messages.size).toBe(ALL_PROBLEMS.length);
  });

  it("states the limit that was crossed", () => {
    expect(knowledgeProblemMessage({ problem: "too_long", key: "when", heading: "D" })).toContain("`when` longer than 200 characters");
    expect(knowledgeProblemMessage({ problem: "too_long", key: "conclusion", heading: "D" })).toContain("`conclusion` longer than 300 characters");
  });
});
