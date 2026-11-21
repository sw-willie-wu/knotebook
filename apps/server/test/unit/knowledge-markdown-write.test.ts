// Write side of the knowledge comments: only a comment right under a top-level heading can set knowledge on it.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToHTML } from "@blocknote/core";
import {
  KNOWLEDGE_PENDING_ID_PREFIX,
  applyKnowledgeComments,
  checkNoteMarkdownSyntax,
  findStrayKnowledgeProps,
  formatKnowledgeComment,
  syntaxCheckRoot,
  type KnowledgeInfo,
} from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote, type ParsedMarkdown, type ParseFailure } from "../../src/notes/editing/markdown.js";
import { createParserEditor, runParse } from "../../src/notes/editing/parse-core.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const editor = createParserEditor("http://localhost/");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
type AnyBlock = any;
const parse = (md: string): ParsedMarkdown | ParseFailure => runParse(editor, { markdown: md, candidates: [], siteOrigin: "http://localhost" });
const ok = (md: string): ParsedMarkdown => {
  const r = parse(md);
  if (!("blocks" in r)) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  return r;
};
const KNOWLEDGE_KEYS = ["knowledgeId", "knowledgeWhen", "knowledgeConclusion", "knowledgeEvidence", "knowledgeVerified", "knowledgeStatus", "knowledgeSupersededBy"];
const knowledgeOf = (b: AnyBlock): Record<string, string> => Object.fromEntries(KNOWLEDGE_KEYS.filter(k => (b.props?.[k] ?? "") !== "").map(k => [k, b.props[k] as string]));
const anyKnowledge = (blocks: AnyBlock[]): boolean => blocks.some(b => Object.keys(knowledgeOf(b)).length > 0 || anyKnowledge(b.children ?? []));
const COMMENT = (id = "k_8f3a2c1d", when = "alice reads this") => `<!-- knotebook:knowledge\nid: ${id}\nwhen: ${when}\n-->`;

describe("BlockNote facts this relies on", () => {
  it("a line right after an HTML comment, with no blank line, stays raw text: markdownToHTML keeps **b** literal", async () => {
    expect(await markdownToHTML("### A\n<!-- c\n-->\n**b**")).toContain("**b**");
    expect(await markdownToHTML("### A\n<!-- c\n-->\n\n**b**")).toContain("<strong>b</strong>");
  });
  it("tryParseHTMLToBlocks drops comment nodes", () => {
    expect(editor.tryParseHTMLToBlocks("<h3>A</h3><!-- x --><p>b</p>").map((b: AnyBlock) => b.type)).toEqual(["heading", "paragraph"]);
  });
  it("data-knowledge attributes on an <h3> parse into heading props", () => {
    const [h] = editor.tryParseHTMLToBlocks('<h3 data-knowledge-id="k_8f3a2c1d" data-knowledge-superseded-by="k_00000001">A</h3>') as AnyBlock[];
    expect(knowledgeOf(h)).toEqual({ knowledgeId: "k_8f3a2c1d", knowledgeSupersededBy: "k_00000001" });
  });
  it("a <!-- knotebook:knowledge in a code block is text, not a comment", () => {
    const r = ok(`## A\n\n\`\`\`\n${COMMENT()}\n\`\`\`\n`);
    expect(r.ignoredKnowledgeComments).toBe(0);
    expect(anyKnowledge(r.blocks)).toBe(false);
    expect(r.blocks.map((b: AnyBlock) => b.type)).toEqual(["heading", "codeBlock"]);
  });
});

describe("parseMarkdownForNote with knowledge comments", () => {
  it("a comment right after a heading sets its props; evidence unconfirmed is empty", () => {
    const r = ok(`## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: alice reads this\nconclusion: use B\nevidence: unconfirmed\nverified: 2026-10-20\nstatus: unverified\nsuperseded_by: k_00000001\n-->\n\nbody\n`);
    expect(r.blocks.map((b: AnyBlock) => b.type)).toEqual(["heading", "paragraph"]);
    expect(knowledgeOf(r.blocks[0])).toEqual({
      knowledgeId: "k_8f3a2c1d", knowledgeWhen: "alice reads this", knowledgeConclusion: "use B", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified", knowledgeSupersededBy: "k_00000001",
    });
    expect(r.ignoredKnowledgeComments).toBe(0);
  });

  it("blank lines between the heading and the comment are fine", () => {
    const r = ok(`## D1\n\n\n${COMMENT()}\n\nbody\n`);
    expect(knowledgeOf(r.blocks[0])).toMatchObject({ knowledgeId: "k_8f3a2c1d" });
  });

  it("a comment sets knowledge on a heading of any level, and each heading gets its own", () => {
    const r = ok(`# A\n${COMMENT("k_00000001", "a")}\n\n### B\n${COMMENT("k_00000002", "b")}\n\n## C\n\nplain\n`);
    expect(r.blocks.map(knowledgeOf)).toEqual([{ knowledgeId: "k_00000001", knowledgeWhen: "a" }, { knowledgeId: "k_00000002", knowledgeWhen: "b" }, {}, {}]);
  });

  it("a comment without id gets a pending id with KNOWLEDGE_PENDING_ID_PREFIX, different for two such headings", () => {
    const noId = "<!-- knotebook:knowledge\nwhen: w\n-->";
    const r = ok(`## A\n${noId}\n\n## B\n${noId}\n`);
    const [a, b] = r.blocks.map((x: AnyBlock) => x.props.knowledgeId as string);
    expect(a!.startsWith(KNOWLEDGE_PENDING_ID_PREFIX)).toBe(true);
    expect(b!.startsWith(KNOWLEDGE_PENDING_ID_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("raw HTML <h2 data-knowledge-id=… data-knowledge-status=outdated>, upper-case attribute names and an editor-internal heading div get no knowledge props", () => {
    const attempts = [
      '<h2 data-knowledge-id="k_00000009" data-knowledge-status="bogus">X</h2>',
      '<H2 DATA-KNOWLEDGE-ID="k_00000009" Data-Knowledge-Status="outdated">X</H2>',
      '<h2 data-knowledge-id="k_00000009" data-knowledge-superseded-by="k_00000001" data-knowledge-when="w">X</h2>\n\nbody',
      '<div data-content-type="heading" data-knowledge-id="k_00000009">X</div>',
    ];
    for (const md of attempts) {
      const r = parse(md);
      if ("blocks" in r) expect(anyKnowledge(r.blocks), md).toBe(false);
      else expect(r, md).toMatchObject({ error: "unsupported_block" });
    }
    const first = ok(attempts[0]!);
    expect(first.blocks[0].type).toBe("heading");
  });

  it("raw HTML knowledge attributes cannot sit next to a real comment: only the comment counts", () => {
    const r = ok(`<h2 data-knowledge-id="k_00000009" data-knowledge-status="outdated">X</h2>\n${COMMENT("k_8f3a2c1d", "w")}\n\nbody\n`);
    expect(knowledgeOf(r.blocks[0])).toEqual({ knowledgeId: "k_8f3a2c1d", knowledgeWhen: "w" });
  });

  it("comments after a paragraph, inside a column, a list item or a quote, and inline in a heading are ignored and counted", () => {
    const md = [
      `para\n\n${COMMENT("k_00000001")}\n`,
      `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n## In column\n${COMMENT("k_00000002")}\n\ntext\n\n</div>\n<div data-kb-column style="flex:1">\n\nb\n\n</div>\n</div>\n`,
      `- item\n\n  ## inner\n  ${COMMENT("k_00000003").replace(/\n/g, "\n  ")}\n`,
      `> ## quoted\n> ${COMMENT("k_00000004").replace(/\n/g, "\n> ")}\n`,
      "## Inline <!-- knotebook:knowledge id: k_00000005 -->\n",
    ].join("\n");
    const r = ok(md);
    expect(anyKnowledge(r.blocks)).toBe(false);
    expect(r.ignoredKnowledgeComments).toBe(5);
  });

  it("a comment that is not a knowledge comment is left alone and not counted", () => {
    const r = ok("## D1\n<!-- a note to self -->\n\nbody\n");
    expect(r.ignoredKnowledgeComments).toBe(0);
    expect(anyKnowledge(r.blocks)).toBe(false);
  });

  it("a malformed comment under a heading fails the parse with invalid_knowledge naming the heading", () => {
    expect(parse("## D1\n<!-- knotebook:knowledge\nwhen: a\nwhen: b\n-->\n\nbody\n")).toEqual({
      error: "invalid_knowledge",
      knowledge: { problem: "duplicate_key", key: "when", heading: "D1" },
    });
    expect(parse("## D1\n<!-- knotebook:knowledge\nsome line\n-->\n\nbody\n")).toMatchObject({ error: "invalid_knowledge", knowledge: { problem: "bad_line", heading: "D1" } });
    expect(parse('## D1\n<!-- knotebook:knowledge\nwhen: "a\\u0000b"\n-->\n\nbody\n')).toMatchObject({ knowledge: { problem: "unstorable", key: "when" } });
    expect(parse("## D1\n<!-- knotebook:knowledge id: k_8f3a2c1d -->\n\nbody\n")).toMatchObject({ knowledge: { problem: "not_multiline" } });
  });

  it("the heading in the problem is its plain text, uncut", () => {
    const long = "x".repeat(300);
    const r = parse(`## **${long}**\n<!-- knotebook:knowledge\nwhen: a\nwhen: b\n-->\n\nbody\n`);
    expect(r).toMatchObject({ error: "invalid_knowledge", knowledge: { heading: long } });
  });

  it("values are not checked at parse time: evidence guess and a 300-character when go into the props as written", () => {
    const when = "w".repeat(300);
    const r = ok(`## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: ${when}\nevidence: guess\nstatus: current\nverified: 2026-02-30\n-->\n\nbody\n`);
    expect(knowledgeOf(r.blocks[0])).toEqual({ knowledgeId: "k_8f3a2c1d", knowledgeWhen: when, knowledgeEvidence: "guess", knowledgeStatus: "current", knowledgeVerified: "2026-02-30" });
  });

  it("text right below the comment with no blank line is blank_line_missing", () => {
    expect(parse(`## D1\n${COMMENT()}\n**b**\n`)).toMatchObject({ error: "invalid_knowledge", knowledge: { problem: "blank_line_missing", heading: "D1" } });
    expect(parse(`## D1\n${COMMENT()}\nplain\n`)).toMatchObject({ error: "invalid_knowledge", knowledge: { problem: "blank_line_missing" } });
  });

  it("two comments under one heading are two_comments", () => {
    expect(parse(`## D1\n${COMMENT("k_00000001")}\n${COMMENT("k_00000002")}\n\nbody\n`)).toMatchObject({ error: "invalid_knowledge", knowledge: { problem: "two_comments", heading: "D1" } });
    expect(parse(`## D1\n${COMMENT("k_00000001")}\n\n${COMMENT("k_00000002")}\n\nbody\n`)).toMatchObject({ knowledge: { problem: "two_comments" } });
  });

  it("an unclosed knowledge comment under a heading is invalid_knowledge, not empty_content", () => {
    expect(parse("## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\nwhen: w")).toMatchObject({ error: "invalid_knowledge", knowledge: { problem: "unclosed", heading: "D1" } });
    expect(parse("## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\n\nbody\n")).toMatchObject({ error: "invalid_knowledge" });
  });

  it("a comment closed with --!> or an abrupt close is still closed", () => {
    const r = ok("## D1\n<!-- knotebook:knowledge\nid: k_8f3a2c1d\n--!>\n\nbody\n");
    expect(knowledgeOf(r.blocks[0])).toEqual({ knowledgeId: "k_8f3a2c1d" });
  });

  it("every tricky value read out as a comment comes back as the same props", () => {
    const values = ["a --> b", "a --!> b", "x\ny", "x\r\ny", " lead", "trail ", '"quoted" start', "C:\\Users\\alice", "key: value: more", "中文 與 emoji 😀", "a\u2028b", "a\u0085b", "p | q", "<!-- inner", "<b>x</b> & &amp;", "a -> b"];
    for (const v of values) {
      const info: KnowledgeInfo = { id: "k_8f3a2c1d", when: v, conclusion: v, evidence: "docs", verified: "2026-10-20", status: "unverified", supersededBy: "k_00000001" };
      const r = ok(`## D1\n${formatKnowledgeComment(info)}\n\nbody\n`);
      expect(knowledgeOf(r.blocks[0]), JSON.stringify(v)).toEqual({
        knowledgeId: info.id, knowledgeWhen: v, knowledgeConclusion: v, knowledgeEvidence: "docs", knowledgeVerified: "2026-10-20", knowledgeStatus: "unverified", knowledgeSupersededBy: "k_00000001",
      });
      expect(r.blocks.length).toBe(2);
    }
  });

  it("values at the length limits and made of CJK and emoji survive", () => {
    const when = `${"測".repeat(199)}😀`;
    const conclusion = "結".repeat(300);
    const r = ok(`## D1\n${formatKnowledgeComment({ id: "k_8f3a2c1d", when, conclusion, evidence: "", verified: "", status: "", supersededBy: "" })}\n\nbody\n`);
    expect(knowledgeOf(r.blocks[0])).toMatchObject({ knowledgeWhen: when, knowledgeConclusion: conclusion });
  });

  it("markdown without knowledge comments parses to exactly the same blocks as before", async () => {
    const withoutOutcome = (md: string) => {
      const syntax = checkNoteMarkdownSyntax(md, "top");
      if (!syntax.ok) return null;
      return syntax.html;
    };
    for (const md of ["# Title\n\n**b** *i*\n\n* a\n  * a1\n\n1. n1\n\n| h | i |\n| - | - |\n| a | b |\n", "## H\n<!-- plain comment -->\n\ntext\n", "> quote\n>\n> more\n\n```\ncode\n```\n"]) {
      const s = await EditorSession.open(rt, new Y.Doc());
      try {
        const expected = s.editor.tryParseHTMLToBlocks(withoutOutcome(md)!);
        const r = ok(md);
        expect(JSON.stringify(r.blocks, (k, v) => (k === "id" ? undefined : v))).toBe(JSON.stringify(expected, (k, v) => (k === "id" ? undefined : v)));
        expect(r.ignoredKnowledgeComments).toBe(0);
      } finally {
        s.close();
      }
    }
  });

  it("with <plaintext>, knowledge comments are ignored, and raw data-knowledge attributes before it are 400 unsupported_block knowledge_attr", () => {
    const r = ok(`## D1\n${COMMENT()}\n\n<plaintext>\nrest`);
    expect(anyKnowledge(r.blocks)).toBe(false);
    expect(parse(`<h2 data-knowledge-id="k_00000009">X</h2>\n\n<plaintext>\nrest`)).toEqual({ error: "unsupported_block", detail: "knowledge_attr" });
    expect(parse(`<plaintext>\n<h2 data-knowledge-id="k_00000009">X</h2>`)).toEqual({ error: "unsupported_block", detail: "knowledge_attr" });
  });
});

describe("applyKnowledgeComments", () => {
  const rootOf = (html: string): Element => syntaxCheckRoot(html);
  it("returns unchanged without touching the DOM when neither a knowledge attribute nor a mark is in the html", () => {
    const html = "<h2>A</h2><!-- other --><p>b</p>";
    expect(applyKnowledgeComments(rootOf(html), "top", html)).toEqual({ changed: false, ignored: 0, assigned: new Set(), props: [] });
  });
  it("nested placement ignores every comment", () => {
    const html = `<h2>A</h2><!-- knotebook:knowledge\nid: k_8f3a2c1d\n-->`;
    const root = rootOf(html);
    expect(applyKnowledgeComments(root, "nested", html)).toMatchObject({ ignored: 1 });
    expect(root.querySelector("h2")!.attributes.length).toBe(0);
  });
  it("strips data-knowledge attributes even when the name is upper case", () => {
    const root = rootOf('<h2>A</h2><p data-knowledge-id="x">p</p>');
    root.querySelector("p")!.setAttribute("DATA-KNOWLEDGE-WHEN", "y");
    expect(applyKnowledgeComments(root, "top")).toMatchObject({ changed: true });
    expect(root.querySelector("p")!.getAttributeNames()).toEqual([]);
  });
  it("reports the ids it set, pending ones included", () => {
    const html = `<h2>A</h2><!-- knotebook:knowledge\nid: k_8f3a2c1d\n--><h2>B</h2><!-- knotebook:knowledge\nwhen: w\n-->`;
    const r = applyKnowledgeComments(rootOf(html), "top", html);
    expect(r).toMatchObject({ changed: true, ignored: 0 });
    expect([...(r as { assigned: ReadonlySet<string> }).assigned]).toEqual(["k_8f3a2c1d", `${KNOWLEDGE_PENDING_ID_PREFIX}1`]);
  });
});

describe("findStrayKnowledgeProps", () => {
  const h = (props: Record<string, string>, children: unknown[] = []) => ({ type: "heading", props, children });
  const allowed = new Set(["k_8f3a2c1d"]);
  it("accepts a top-level heading whose id a comment set, and plain blocks", () => {
    expect(findStrayKnowledgeProps([h({ knowledgeId: "k_8f3a2c1d", knowledgeWhen: "w" }), { type: "paragraph", props: { knowledgeWhen: "" } }], allowed)).toBe(false);
    expect(findStrayKnowledgeProps([], allowed)).toBe(false);
  });
  it("rejects knowledge props on a nested heading, on a paragraph, or with an id no comment set", () => {
    expect(findStrayKnowledgeProps([{ type: "paragraph", children: [h({ knowledgeId: "k_8f3a2c1d" })] }], allowed)).toBe(true);
    expect(findStrayKnowledgeProps([{ type: "paragraph", props: { knowledgeWhen: "w" } }], allowed)).toBe(true);
    expect(findStrayKnowledgeProps([h({ knowledgeId: "k_00000001" })], allowed)).toBe(true);
    expect(findStrayKnowledgeProps([h({ knowledgeWhen: "w" })], allowed)).toBe(true);
    expect(findStrayKnowledgeProps([{ type: "columnList", children: [{ type: "column", children: [h({ knowledgeId: "k_8f3a2c1d" })] }] }], allowed)).toBe(true);
  });
  it("walks a deep tree without recursion", () => {
    let node: unknown = h({ knowledgeStatus: "outdated" });
    for (let i = 0; i < 50_000; i += 1) node = { type: "paragraph", children: [node] };
    expect(findStrayKnowledgeProps([node], allowed)).toBe(true);
  });
});

// parseMarkdownForNote called directly (the worker path is covered by parse-pool tests)
describe("parseMarkdownForNote directly", () => {
  it("returns the same outcome as the runParse wrapper", async () => {
    const s = await EditorSession.open(rt, new Y.Doc());
    try {
      expect(parseMarkdownForNote(s.editor, `## D1\n${COMMENT()}\n\nbody\n`, [], "http://localhost")).toMatchObject({ ignoredKnowledgeComments: 0 });
    } finally {
      s.close();
    }
  });
});
