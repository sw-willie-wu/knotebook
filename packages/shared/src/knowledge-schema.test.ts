import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createHeadlessNoteSchema } from "./note-schema-config.js";
import { canonicalizeElements, topLevelBlocks } from "./note-sections.js";
import {
  EMPTY_KNOWLEDGE_PROPS,
  hasKnowledgeAttributes,
  isIgnorableKnowledgeDefault,
  KNOWLEDGE_PROP_NAMES,
  KNOWLEDGE_PROP_SCHEMA,
  stripKnowledgeAttributes,
} from "./knowledge-schema.js";

function element(name: string, attrs: Record<string, unknown> = {}, children: Array<Y.XmlElement | Y.XmlText> = []): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string);
  if (children.length > 0) el.insert(0, children);
  return el;
}

function text(value: string): Y.XmlText {
  const t = new Y.XmlText();
  t.insert(0, value);
  return t;
}

function container(id: string, content: Y.XmlElement, nested: Y.XmlElement[] = []): Y.XmlElement {
  const children: Y.XmlElement[] = [content];
  if (nested.length > 0) children.push(element("blockGroup", {}, nested));
  return element("blockContainer", { id }, children);
}

function docOf(containers: Y.XmlElement[]): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("doc");
  fragment.insert(0, [element("blockGroup", {}, containers)]);
  return { doc, fragment };
}

describe("knowledge schema", () => {
  it("every knowledge prop defaults to the empty string", () => {
    expect(Object.values(KNOWLEDGE_PROP_SCHEMA).map((p) => p.default)).toEqual(["", "", "", "", "", "", ""]);
    expect(Object.keys(EMPTY_KNOWLEDGE_PROPS)).toEqual([...KNOWLEDGE_PROP_NAMES]);
  });

  it("the headless schema's heading carries exactly the knowledge props on top of the default heading props", () => {
    const heading = createHeadlessNoteSchema("http://localhost/").blockSchema.heading.propSchema as Record<string, { default: unknown }>;
    expect(Object.keys(heading).filter((k) => k.startsWith("knowledge")).sort()).toEqual([...KNOWLEDGE_PROP_NAMES].sort());
    expect(heading.level!.default).toBe(1);
  });

  it("no other block type gets knowledge props", () => {
    const blocks = createHeadlessNoteSchema("http://localhost/").blockSchema as Record<string, { propSchema: object }>;
    for (const [name, spec] of Object.entries(blocks)) {
      if (name === "heading") continue;
      expect(Object.keys(spec.propSchema).filter((k) => k.startsWith("knowledge")), name).toEqual([]);
    }
  });

  it("only heading knowledge attributes equal to the default are ignorable", () => {
    expect(isIgnorableKnowledgeDefault("heading", "knowledgeWhen", "")).toBe(true);
    expect(isIgnorableKnowledgeDefault("heading", "knowledgeWhen", "x")).toBe(false);
    expect(isIgnorableKnowledgeDefault("paragraph", "knowledgeId", "")).toBe(false);
    expect(isIgnorableKnowledgeDefault("heading", "knowledgeOther", "")).toBe(false);
    expect(isIgnorableKnowledgeDefault("heading", "textColor", "")).toBe(false);
    expect(isIgnorableKnowledgeDefault("heading", "constructor", "")).toBe(false);
    expect(isIgnorableKnowledgeDefault("heading", "toString", "")).toBe(false);
    expect(isIgnorableKnowledgeDefault("heading", "knowledgeWhen", undefined)).toBe(false);
    expect(isIgnorableKnowledgeDefault("heading", "knowledgeWhen", null)).toBe(false);
  });

  it("canonicalizeElements ignores empty knowledge attributes and counts non-empty ones", () => {
    const make = (attrs: Record<string, unknown>) => container("b1", element("heading", { level: 1, ...attrs }, [text("Title")]));
    const before = docOf([make({})]);
    const withEmpty = docOf([make({ knowledgeWhen: "", knowledgeId: "" })]);
    const withValue = docOf([make({ knowledgeWhen: "alice reads this" })]);
    const canon = (d: { fragment: Y.XmlFragment }) => canonicalizeElements(topLevelBlocks(d.fragment));
    expect(canon(withEmpty)).toBe(canon(before));
    expect(canon(withValue)).not.toBe(canon(before));
  });

  it("canonicalizeElements does not ignore an empty value on another attribute or on another node type", () => {
    const base = docOf([container("b1", element("heading", { level: 1 }, [text("T")]))]);
    const emptyColor = docOf([container("b1", element("heading", { level: 1, textColor: "" }, [text("T")]))]);
    const paragraphBase = docOf([container("b1", element("paragraph", {}, [text("T")]))]);
    const paragraphKnowledge = docOf([container("b1", element("paragraph", { knowledgeWhen: "" }, [text("T")]))]);
    const canon = (d: { fragment: Y.XmlFragment }) => canonicalizeElements(topLevelBlocks(d.fragment));
    expect(canon(emptyColor)).not.toBe(canon(base));
    expect(canon(paragraphKnowledge)).not.toBe(canon(paragraphBase));
  });

  describe("Yjs attributes", () => {
    function build() {
      const topHeading = element("heading", { level: 1, textColor: "red", knowledgeId: "k_0123abcd", knowledgeWhen: "alice" }, [text("Top")]);
      const emptyHeading = element("heading", { level: 2, knowledgeId: "" }, [text("Empty")]);
      const inColumn = element("heading", { level: 1, knowledgeStatus: "outdated" }, [text("In column")]);
      const column = element("column", {}, [element("blockGroup", {}, [container("c1", inColumn)])]);
      const columnList = element("columnList", {}, [column]);
      const inList = element("heading", { level: 1, knowledgeConclusion: "x" }, [text("In list")]);
      const listItem = element("bulletListItem", {}, [text("item")]);
      const paragraph = element("paragraph", { knowledgeWhen: "kept on a paragraph" }, [text("p")]);
      return docOf([
        container("h1", topHeading),
        container("h2", emptyHeading),
        element("blockContainer", { id: "cl" }, [columnList]),
        container("li", listItem, [container("nested", inList)]),
        container("p1", paragraph),
      ]);
    }

    it("stripKnowledgeAttributes removes knowledge keys from headings at any depth and nothing else", () => {
      const { doc, fragment } = build();
      let removed = 0;
      doc.transact(() => {
        removed = stripKnowledgeAttributes(fragment);
      });
      expect(removed).toBe(5);
      const headings: Y.XmlElement[] = [];
      const walk = (n: Y.XmlFragment | Y.XmlElement) => {
        for (const c of n.toArray()) {
          if (c instanceof Y.XmlElement) {
            if (c.nodeName === "heading") headings.push(c);
            walk(c);
          }
        }
      };
      walk(fragment);
      expect(headings).toHaveLength(4);
      for (const h of headings) expect(Object.keys(h.getAttributes()).filter((k) => k.startsWith("knowledge"))).toEqual([]);
      expect(headings[0]!.getAttributes()).toEqual({ level: 1, textColor: "red" });
      const paragraph = topLevelBlocks(fragment)[4]!.get(0) as Y.XmlElement;
      expect(paragraph.getAttributes()).toEqual({ knowledgeWhen: "kept on a paragraph" });
    });

    it("hasKnowledgeAttributes is true for any heading with any knowledge key, even an empty one, and false after stripping", () => {
      const { doc, fragment } = build();
      expect(hasKnowledgeAttributes(fragment)).toBe(true);
      const onlyEmpty = docOf([container("h", element("heading", { level: 1, knowledgeId: "" }, [text("T")]))]);
      expect(hasKnowledgeAttributes(onlyEmpty.fragment)).toBe(true);
      const plain = docOf([container("h", element("heading", { level: 1 }, [text("T")]))]);
      expect(hasKnowledgeAttributes(plain.fragment)).toBe(false);
      const paragraphOnly = docOf([container("p", element("paragraph", { knowledgeId: "x" }, [text("T")]))]);
      expect(hasKnowledgeAttributes(paragraphOnly.fragment)).toBe(false);
      doc.transact(() => stripKnowledgeAttributes(fragment));
      expect(hasKnowledgeAttributes(fragment)).toBe(false);
    });

    it("handles a very deep tree without recursion limits", () => {
      // Built top-down on an integrated tree: Yjs itself recurses when integrating a deep detached subtree.
      const { doc, fragment } = docOf([]);
      let group = fragment.get(0) as Y.XmlElement;
      for (let i = 0; i < 2000; i += 1) {
        const next = element("blockGroup");
        group.insert(group.length, [element("blockContainer", { id: `n${i}` }, [element("paragraph"), next])]);
        group = next;
      }
      group.insert(0, [container("deep", element("heading", { knowledgeId: "k_00000000" }, [text("x")]))]);
      expect(hasKnowledgeAttributes(fragment)).toBe(true);
      let removed = 0;
      doc.transact(() => {
        removed = stripKnowledgeAttributes(fragment);
      });
      expect(removed).toBe(1);
    });
  });
});
