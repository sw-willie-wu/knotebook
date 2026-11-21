// Read side of the knowledge comments: a top-level knowledge heading is followed by `<!-- knotebook:knowledge … -->` and a blank line.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { blocksToNoteMarkdown, formatKnowledgeComment, parseKnowledgeComment, type KnowledgeInfo } from "@knotebook/shared";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
type Ed = EditorSession["editor"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
type AnyBlocks = any[];

const withSession = async <T>(fn: (ed: Ed) => T, doc = new Y.Doc()): Promise<T> => {
  const s = await EditorSession.open(rt, doc);
  try {
    return fn(s.editor);
  } finally {
    s.close();
  }
};
const docWith = async (blocks: AnyBlocks): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  await withSession(ed => {
    ed.replaceBlocks(ed.document, blocks);
  }, doc);
  return doc;
};

const K = { knowledgeId: "k_8f3a2c1d", knowledgeWhen: "alice reads this", knowledgeEvidence: "tested" };
const H = (level: number, text: unknown, props: Record<string, unknown> = {}, children: AnyBlocks = []) => ({ type: "heading", props: { level, ...props }, content: text, children });
const P = (text: string) => ({ type: "paragraph", content: text });

const read = async (blocks: AnyBlocks, knowledge = true): Promise<string> => {
  const doc = await docWith(blocks);
  return withSession(ed => blocksToNoteMarkdown(ed, ed.document, { knowledge }), doc);
};
const KNOWLEDGE_PROPS = ["knowledgeId", "knowledgeWhen", "knowledgeConclusion", "knowledgeEvidence", "knowledgeVerified", "knowledgeStatus", "knowledgeSupersededBy"];
const withoutKnowledge = (blocks: AnyBlocks): AnyBlocks =>
  blocks.map(b => {
    const props = { ...b.props };
    for (const n of KNOWLEDGE_PROPS) delete props[n];
    return { ...b, props, children: b.children ? withoutKnowledge(b.children) : b.children };
  });
const stripComments = (md: string): string => md.replace(/\n<!-- knotebook:knowledge[\s\S]*?\n-->/g, "");

const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; blocks: AnyBlocks; markdown: string }>;
};
const golden = (id: string) => goldens.cases.find(c => c.id === id)!;

afterEach(() => vi.restoreAllMocks());

describe("knowledge comments on read", () => {
  it("a top-level knowledge heading is followed by its comment and a blank line", async () => {
    expect(await read([H(2, "D1", K), P("body")])).toBe(
      "## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nevidence: tested\n-->\n\nbody\n",
    );
  });

  it("a knowledge heading at the end ends with --> and one newline", async () => {
    expect(await read([P("body"), H(2, "D1", K)])).toBe("body\n\n## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nevidence: tested\n-->\n");
  });

  it("each knowledge heading gets its own comment, plain headings none", async () => {
    const md = await read([H(1, "A", K), H(2, "B"), H(2, "C", { knowledgeId: "k_00000002", knowledgeConclusion: "c" }), P("x")]);
    expect(md).toBe(
      "# A\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nevidence: tested\n-->\n\n## B\n\n## C\n<!-- knotebook:knowledge\nid: k_00000002\nconclusion: c\n-->\n\nx\n",
    );
  });

  it("a note without knowledge info reads byte-for-byte as before", async () => {
    for (const c of goldens.cases.filter(g => !g.id.startsWith("G1-cols-5"))) {
      const doc = await docWith(c.blocks);
      const [plain, withOption] = await withSession(ed => [blocksToNoteMarkdown(ed, ed.document), blocksToNoteMarkdown(ed, ed.document, { knowledge: true })], doc);
      expect(withOption, c.id).toBe(plain);
      expect(withOption, c.id).toBe(c.markdown);
    }
  });

  const MIXED = (): AnyBlocks => [
    ...golden("G0-plain").blocks,
    { type: "paragraph", content: "" },
    { type: "paragraph", content: "" },
    ...golden("G0-colors").blocks,
    ...golden("G1-cols-3").blocks,
    ...golden("G3-table-colwidth").blocks,
    H(2, [{ type: "text", text: "bold", styles: { bold: true } }, { type: "text", text: " and ", styles: {} }, { type: "link", href: "https://example.com", content: "link" }], K, [P("kid")]),
    H(3, "", { knowledgeId: "k_00000003", knowledgeStatus: "unverified" }),
    H(2, "Toggle", { isToggleable: true, knowledgeId: "k_00000004", knowledgeWhen: "w" }, [P("inside")]),
    H(2, "Colored", { backgroundColor: "yellow", knowledgeId: "k_00000005", knowledgeWhen: "w" }),
    P("tail"),
  ];

  it("removing the comments gives exactly the output of the same blocks without knowledge props", async () => {
    const withK = await read(MIXED());
    const without = await read(withoutKnowledge(MIXED()), false);
    expect(withK).toContain("<!-- knotebook:knowledge");
    expect(withK).not.toContain("data-knowledge");
    expect(stripComments(withK)).toBe(without);
  });

  it("a colored knowledge heading reads as HTML without any data-knowledge attribute, followed by its comment", async () => {
    const md = await read([H(2, "Colored", { backgroundColor: "yellow", ...K }), P("after")]);
    expect(md).toBe('<h2 data-background-color="yellow">Colored</h2>\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nevidence: tested\n-->\n\nafter\n');
  });

  it("a toggleable knowledge heading has its comment right after the heading line, before its children", async () => {
    const md = await read([H(2, "T", { isToggleable: true, ...K }, [P("kid")])]);
    expect(md).not.toContain("data-knowledge");
    expect(md).toContain("<!-- knotebook:knowledge");
    expect(md.indexOf("</summary>")).toBeLessThan(md.indexOf("<!-- knotebook:knowledge"));
    expect(md.indexOf("<!-- knotebook:knowledge")).toBeLessThan(md.indexOf("kid"));
  });

  it("a heading in a column with knowledge props reads without a comment and without data-knowledge", async () => {
    const columns = structuredClone(golden("G1-cols-3").blocks);
    columns[0].children[0].children = [H(2, "In column", K)];
    const md = await read(columns);
    expect(md).not.toContain("data-knowledge");
    expect(md).not.toContain("knotebook:knowledge");
  });

  it("an id-less heading with other knowledge props reads without a comment", async () => {
    const md = await read([H(2, "D1", { knowledgeWhen: "w" })]);
    expect(md).toBe("## D1\n");
  });

  it("knowledge: false emits no comment and still drops data-knowledge attributes", async () => {
    const doc = await docWith([H(2, "D1", K), P("body")]);
    const md = await withSession(ed => {
      const html = ed.blocksToHTMLLossy(ed.document).replace("<h2", '<h2 data-knowledge-id="k_8f3a2c1d"');
      expect(html).toContain("data-knowledge-id");
      return blocksToNoteMarkdown({ blocksToHTMLLossy: () => html, document: ed.document } as unknown as Ed, ed.document, { knowledge: false });
    }, doc);
    expect(md).toBe("## D1\n\nbody\n");
  });

  it("the read output contains no data-knowledge even when the external HTML carries knowledge attributes", async () => {
    const doc = await docWith([H(2, "D1", K), H(2, "Colored", { backgroundColor: "yellow", knowledgeId: "k_00000002", knowledgeWhen: "w" }), P("body")]);
    const md = await withSession(ed => {
      const leaky = {
        document: ed.document,
        // The schema normally keeps the props out of the HTML; this stands in for a schema that stops doing so.
        blocksToHTMLLossy: (blocks: AnyBlocks) =>
          ed.blocksToHTMLLossy(blocks).replace(/<h2/g, '<h2 data-knowledge-id="k_zz" DATA-KNOWLEDGE-STATUS="outdated"'),
      } as unknown as Ed;
      return blocksToNoteMarkdown(leaky, ed.document, { knowledge: true });
    }, doc);
    expect(md).not.toMatch(/data-knowledge/i);
    expect(md).toContain("id: k_8f3a2c1d");
    expect(md).toContain("id: k_00000002");
  });

  it("values holding the color placeholder, the line-break placeholder character and U+E000 come out unchanged in the comment, and colored text and <br> in the same note still read as before", async () => {
    const tricky = "a \u2E00" + "0" + "\u2E01 b \uE000 c \uF8FF d";
    const base: AnyBlocks = [
      { type: "paragraph", content: [{ type: "text", text: "red", styles: { textColor: "red" } }, { type: "text", text: " plain", styles: {} }] },
      { type: "paragraph", content: "line1\nline2 - x" },
    ];
    const blocks = [H(2, "D1", { knowledgeId: "k_8f3a2c1d", knowledgeWhen: tricky, knowledgeConclusion: "\u2E000\u2E01" }), ...base];
    const md = await read(blocks);
    const baseline = await read([H(2, "D1"), ...base], false);
    expect(stripComments(md)).toBe(baseline);
    const data = /<!--([\s\S]*?)-->/.exec(md)![1]!;
    expect(parseKnowledgeComment(data)).toMatchObject({ ok: true, fields: { when: tricky, conclusion: "\u2E000\u2E01" } });
  });

  it("a colored toggleable heading reads without its comment and without the placeholder, and the warning is logged once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const md = await read([H(2, "Colored toggle", { isToggleable: true, backgroundColor: "yellow", ...K }, [P("kid")]), P("after")]);
    const baseline = await read([H(2, "Colored toggle", { isToggleable: true, backgroundColor: "yellow" }, [P("kid")]), P("after")], false);
    expect(md).toBe(baseline);
    expect(md).not.toMatch(/[\uE000-\uF8FF]/);
    await read([H(2, "Colored toggle", { isToggleable: true, backgroundColor: "yellow", ...K }, [P("kid")]), H(2, "Another", { isToggleable: true, textColor: "red", ...K }, [P("kid")])]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain("Colored toggle");
  });

  it("round-trips every tricky value through the comment on read", async () => {
    const values = ["a --> b", "x\ny", "\"q\"", "C:\\Users\\alice", " pad ", "中文 😀", "a\u2028b", "a\u0085b", "p | q"];
    for (const v of values) {
      const info: KnowledgeInfo = { id: "k_8f3a2c1d", when: v, conclusion: v, evidence: "docs", verified: "2026-10-20", status: "unverified", supersededBy: "" };
      const md = await read([H(2, "D1", { knowledgeId: info.id, knowledgeWhen: v, knowledgeConclusion: v, knowledgeEvidence: "docs", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified" })]);
      expect(md).toContain(formatKnowledgeComment(info));
      expect(md.match(/-->/g)).toHaveLength(1);
    }
  });
});
