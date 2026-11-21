import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EMPTY_YDOC_UPDATE_B64, KNOWLEDGE_PROP_NAMES, YDOC_FRAGMENT, extractLinkTargets, hasKnowledgeAttributes } from "@knotebook/shared";
import { bytesMayHoldKnowledge, preparePublicDoc } from "../../src/notes/public-doc.js";

const VALUES = {
  knowledgeId: "k_5a5a5a5a",
  knowledgeWhen: "alice-when-7f3e",
  knowledgeConclusion: "bob-conclusion-91c2",
  knowledgeEvidence: "docs",
  knowledgeVerified: "2031-04-05",
  knowledgeStatus: "outdated",
  knowledgeSupersededBy: "11111111-2222-3333-4444-555555555555#k_6b6b6b6b",
};
const UNIQUE_VALUES = [VALUES.knowledgeId, VALUES.knowledgeWhen, VALUES.knowledgeConclusion, VALUES.knowledgeVerified, VALUES.knowledgeSupersededBy, "old-secret-3c9d"];

function el(name: string, attrs: Record<string, string> = {}, children: Array<Y.XmlElement | Y.XmlText> = []): Y.XmlElement {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (children.length > 0) e.insert(0, children);
  return e;
}
function txt(s: string): Y.XmlText {
  const t = new Y.XmlText();
  t.insert(0, s);
  return t;
}
const container = (id: string, content: Y.XmlElement, nested: Y.XmlElement[] = []) =>
  el("blockContainer", { id }, nested.length > 0 ? [content, el("blockGroup", {}, nested)] : [content]);
const headingEl = (text: string, attrs: Record<string, string> = {}) => el("heading", { level: "2", ...attrs }, [txt(text)]);

function fillDoc(doc: Y.Doc, withKnowledge = true): void {
  const f = doc.getXmlFragment(YDOC_FRAGMENT);
  const k = withKnowledge ? VALUES : {};
  f.insert(0, [
    el("blockGroup", {}, [
      container("a", headingEl("Top heading", k)),
      container("b", el("paragraph", {}, [txt("body")])),
      container("c", el("columnList", {}, [el("column", {}, [container("d", headingEl("Column heading", k))])])),
      container("e", el("bulletListItem", {}, [txt("item")]), [container("f", headingEl("Nested heading", k))]),
    ]),
  ]);
}

function contains(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(needle, "utf8"));
}
function expectNoKnowledge(out: Uint8Array): void {
  for (const v of UNIQUE_VALUES) expect(contains(out, v), v).toBe(false);
  for (const name of KNOWLEDGE_PROP_NAMES) expect(contains(out, name), name).toBe(false);
}
const b64Bytes = (b64: string) => Buffer.from(b64, "base64");
const decode = (b64: string): Y.Doc => {
  const d = new Y.Doc();
  Y.applyUpdate(d, b64Bytes(b64));
  return d;
};

describe("preparePublicDoc", () => {
  it("strips every knowledge attribute from top-level, column and nested headings", () => {
    const doc = new Y.Doc();
    fillDoc(doc);
    const stored = Y.encodeStateAsUpdate(doc);
    expect(UNIQUE_VALUES.slice(0, 5).every((v) => contains(stored, v))).toBe(true);

    const out = preparePublicDoc(stored);
    expectNoKnowledge(b64Bytes(out.ydocB64));
    const fragment = decode(out.ydocB64).getXmlFragment(YDOC_FRAGMENT);
    expect(hasKnowledgeAttributes(fragment)).toBe(false);
    const xml = fragment.toString();
    for (const t of ["Top heading", "Column heading", "Nested heading", 'level="2"']) expect(xml).toContain(t);
    expect(out.doc).not.toBeNull();
    expect(hasKnowledgeAttributes(out.doc!.getXmlFragment(YDOC_FRAGMENT))).toBe(false);
  });

  it("a value overwritten before storage is in neither the old nor the new form in the output", () => {
    const doc = new Y.Doc({ gc: false });
    const h = headingEl("Overwritten");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [el("blockGroup", {}, [container("a", h)])]);
    h.setAttribute("knowledgeWhen", "old-secret-3c9d");
    h.setAttribute("knowledgeWhen", VALUES.knowledgeWhen);
    const stored = Y.encodeStateAsUpdate(doc);
    expect(contains(stored, "old-secret-3c9d")).toBe(true);
    expectNoKnowledge(b64Bytes(preparePublicDoc(stored).ydocB64));
  });

  it("a document whose knowledge attributes were all removed is still re-encoded", () => {
    const doc = new Y.Doc({ gc: false });
    const h = headingEl("Cleared");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [el("blockGroup", {}, [container("a", h)])]);
    h.setAttribute("knowledgeWhen", "old-secret-3c9d");
    h.removeAttribute("knowledgeWhen");
    const stored = Y.encodeStateAsUpdate(doc);
    expect(hasKnowledgeAttributes(doc.getXmlFragment(YDOC_FRAGMENT))).toBe(false);
    const out = preparePublicDoc(stored);
    expect(hasKnowledgeAttributes(decode(out.ydocB64).getXmlFragment(YDOC_FRAGMENT))).toBe(false);
    expectNoKnowledge(b64Bytes(out.ydocB64));
  });

  it("headings whose whole block was deleted leave nothing behind", () => {
    const doc = new Y.Doc({ gc: false });
    fillDoc(doc);
    const group = doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
    group.delete(0, 1);
    group.delete(group.length - 1, 1);
    const stored = Y.encodeStateAsUpdate(doc);
    expect(contains(stored, "alice-when-7f3e")).toBe(true);
    expectNoKnowledge(b64Bytes(preparePublicDoc(stored).ydocB64));
  });

  it("a document without any knowledge attribute is returned byte for byte, with its decoded doc", () => {
    const doc = new Y.Doc();
    fillDoc(doc, false);
    const link = el("wikilink", { targetNoteId: "00000000-0000-4000-8000-000000000001" });
    (doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).insert(0, [container("w", el("paragraph", {}, [link]))]);
    const stored = Y.encodeStateAsUpdate(doc);
    const out = preparePublicDoc(stored);
    expect(out.ydocB64).toBe(Buffer.from(stored).toString("base64"));
    expect(out.doc).not.toBeNull();
    expect(extractLinkTargets(out.doc!)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("keeps wikilinks readable from the returned doc after stripping", () => {
    const doc = new Y.Doc();
    fillDoc(doc);
    const link = el("wikilink", { targetNoteId: "00000000-0000-4000-8000-000000000002" });
    (doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).insert(0, [container("w", el("paragraph", {}, [link]))]);
    const out = preparePublicDoc(Y.encodeStateAsUpdate(doc));
    expect(extractLinkTargets(out.doc!)).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });

  it("no stored state is the empty document", () => {
    expect(preparePublicDoc(null)).toEqual({ ydocB64: EMPTY_YDOC_UPDATE_B64, doc: null });
  });

  it("undecodable bytes become an empty payload the client cannot decode", () => {
    expect(preparePublicDoc(Buffer.from([1, 2, 3, 4, 5]))).toEqual({ ydocB64: "", doc: null });
  });

  it("an update with missing dependencies counts as undecodable", () => {
    const doc = new Y.Doc();
    const group = el("blockGroup", {}, [container("a", headingEl("First", VALUES))]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    const sv = Y.encodeStateVector(doc);
    group.insert(1, [container("b", headingEl("Second", VALUES))]);
    const out = preparePublicDoc(Y.encodeStateAsUpdate(doc, sv));
    expect(out).toEqual({ ydocB64: "", doc: null });
  });

  it("does not modify the bytes it was given", () => {
    const doc = new Y.Doc();
    fillDoc(doc);
    const stored = Y.encodeStateAsUpdate(doc);
    const copy = Uint8Array.from(stored);
    preparePublicDoc(stored);
    expect(Buffer.from(stored).equals(Buffer.from(copy))).toBe(true);
  });
});

describe("preparePublicDoc hardening", () => {
  const docWith = (build: (group: Y.XmlElement) => void): Uint8Array => {
    const doc = new Y.Doc();
    const group = el("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    build(group);
    return Y.encodeStateAsUpdate(doc);
  };

  it("removes knowledge-named attributes from elements that are not headings, in any letter case", () => {
    const stored = docWith((group) => {
      group.insert(0, [
        container("a", el("paragraph", { knowledgeWhen: "alice-when-7f3e", KnowledgeConclusion: "bob-conclusion-91c2", KNOWLEDGEID: "k_5a5a5a5a", textColor: "red" }, [txt("body")])),
        container("b", el("heading", { level: "1", knowledgeverified: "2031-04-05" }, [txt("Head")])),
      ]);
    });
    const out = preparePublicDoc(stored);
    const bytes = b64Bytes(out.ydocB64);
    for (const v of ["alice-when-7f3e", "bob-conclusion-91c2", "k_5a5a5a5a", "2031-04-05"]) expect(contains(bytes, v), v).toBe(false);
    expect(/knowledge/i.test(bytes.toString("latin1"))).toBe(false);
    const xml = decode(out.ydocB64).getXmlFragment(YDOC_FRAGMENT).toString();
    expect(xml).toContain('textColor="red"');
    expect(xml).toContain("body");
    expect(xml).toContain("Head");
  });

  it("leaves a note whose text merely mentions the word unchanged in content", () => {
    const stored = docWith((group) => group.insert(0, [container("a", el("paragraph", { textColor: "red" }, [txt("Knowledge base and knowledgeWhen are just words here")]))]));
    const out = preparePublicDoc(stored);
    expect(out.doc).not.toBeNull();
    const before = new Y.Doc();
    Y.applyUpdate(before, stored);
    expect(decode(out.ydocB64).getXmlFragment(YDOC_FRAGMENT).toString()).toBe(before.getXmlFragment(YDOC_FRAGMENT).toString());
    expect(decode(out.ydocB64).getXmlFragment(YDOC_FRAGMENT).toString()).toContain("Knowledge base and knowledgeWhen are just words here");
  });
});

describe("bytesMayHoldKnowledge", () => {
  it("finds each knowledge attribute name and nothing in a plain document", () => {
    for (const name of KNOWLEDGE_PROP_NAMES) expect(bytesMayHoldKnowledge(Buffer.from(`xx${name}yy`))).toBe(true);
    expect(bytesMayHoldKnowledge(Buffer.from("xxKNOWLEDGEyy"))).toBe(true);
    const plain = new Y.Doc();
    fillDoc(plain, false);
    expect(bytesMayHoldKnowledge(Y.encodeStateAsUpdate(plain))).toBe(false);
  });
});
