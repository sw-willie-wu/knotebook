import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor, defaultProps } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { EMPTY_KNOWLEDGE_PROPS, YDOC_FRAGMENT, createHeadlessNoteSchema, topLevelBlocks } from "@knotebook/shared";
import { fingerprintOf, outlineOf } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom } from "../../src/notes/editing/session.js";
import {
  DEFAULT_PROPS_BY_TYPE, PARAGRAPH_DEFAULT_PROPS, VACUUM_VERSION_FINGERPRINT, buildDefaultPropsByType, versionFingerprint,
} from "../../src/notes/version-fingerprint.js";

// same as editing-session.test.ts: set the rebuild threshold so high it cannot trigger, so the global window is not swapped midway.
const rt = new EditingRuntime({ baseUrl: "http://localhost/", rebuildEvery: 1_000_000, heapGrowthLimit: Number.MAX_SAFE_INTEGER });
rt.installGlobals();
const F = (d: Y.Doc) => d.getXmlFragment(YDOC_FRAGMENT);
const vfp = (d: Y.Doc) => versionFingerprint(F(d));

async function make(blocks: unknown[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
/** The XmlText under the content node of the i-th top-level block; created if missing (a freshly created empty paragraph has no XmlText). */
function textOfBlock(doc: Y.Doc, i: number): Y.XmlText {
  const content = topLevelBlocks(F(doc))[i]!.get(0) as Y.XmlElement;
  const t = content.get(0);
  if (t instanceof Y.XmlText) return t;
  const created = new Y.XmlText();
  doc.transact(() => content.insert(0, [created]));
  return created;
}
/** Hand-built paragraph document (not via BlockNote): pathological structures (missing id, odd attributes) can only be built this way. An id of null = no id set. */
function rawDoc(paras: Array<{ id: string | null; text: string; attrs?: Record<string, unknown> }>): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  F(doc).insert(0, [g]);
  const texts: Array<[Y.XmlText, string]> = [];
  g.insert(0, paras.map(p => {
    const c = new Y.XmlElement("blockContainer");
    if (p.id !== null) c.setAttribute("id", p.id);
    const e = new Y.XmlElement("paragraph");
    for (const [k, v] of Object.entries(p.attrs ?? {})) e.setAttribute(k, v as string);
    const t = new Y.XmlText();
    e.insert(0, [t]);
    c.insert(0, [e]);
    texts.push([t, p.text]);
    return c;
  }));
  for (const [t, s] of texts) if (s) t.insert(0, s);
  return doc;
}
/** Hand-builds a single block: blockGroup > blockContainer(id) > <type>(attrs) > [XmlText(text), inline elements...]. Values are written to Yjs in their original types (numbers/booleans are not stringified). */
function blockDoc(type: string, attrs: Record<string, unknown>, text = "x", inline: Array<{ type: string; attrs: Record<string, unknown> }> = []): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  F(doc).insert(0, [g]);
  const c = new Y.XmlElement("blockContainer");
  c.setAttribute("id", "only");
  const e = new Y.XmlElement(type);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  const t = new Y.XmlText();
  e.insert(0, [t, ...inline.map(i => {
    const ie = new Y.XmlElement(i.type);
    for (const [k, v] of Object.entries(i.attrs)) ie.setAttribute(k, v as string);
    return ie;
  })]);
  c.insert(0, [e]);
  g.insert(0, [c]);
  t.insert(0, text);
  return doc;
}
const bfp = (...a: Parameters<typeof blockDoc>) => vfp(blockDoc(...a));
function deepDoc(depth: number): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  F(doc).insert(0, [g]);
  let parent: Y.XmlElement = g;
  for (let i = 0; i < depth; i += 1) {
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", `d${i}`);
    const inner = new Y.XmlElement("blockGroup");
    c.insert(0, [new Y.XmlElement("paragraph"), inner]);
    parent.insert(0, [c]);
    parent = inner;
  }
  return doc;
}

describe("truly empty", () => {
  it("reference vector: the old fingerprint gives a truly empty document and one empty paragraph two values, the version fingerprint treats them as the same", async () => {
    const vacuum = new Y.Doc();
    const one = await make([{ type: "paragraph" }]);
    expect(outlineOf(F(vacuum)).whole).toBe("8e2d0c61b0acc423"); // reference value (control: the old fingerprint is unchanged)
    expect(outlineOf(F(one)).whole).toBe("7bcfba7c4d4cd39c");
    expect(vfp(vacuum)).toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(one)).toBe(VACUUM_VERSION_FINGERPRINT);
  });

  it("typed then fully deleted (T[]), several default empty paragraphs, an empty paragraph with attributes absent -> truly empty", async () => {
    const typed = await make([{ type: "paragraph" }]);
    const t = textOfBlock(typed, 0);
    typed.transact(() => t.insert(0, "x"));
    typed.transact(() => t.delete(0, 1));
    expect(vfp(typed)).toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(rawDoc([
      { id: "a", text: "", attrs: { backgroundColor: "default", textColor: "default", textAlignment: "left" } },
      { id: "b", text: "" },
    ]))).toBe(VACUUM_VERSION_FINGERPRINT);
  });

  it("a centred empty paragraph, an empty heading, a paragraph with a single space, an extra unknown attribute -> not truly empty", async () => {
    expect(vfp(await make([{ type: "paragraph", props: { textAlignment: "center" } }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(await make([{ type: "heading", props: { level: 1 } }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(rawDoc([{ id: "a", text: " " }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(rawDoc([{ id: "a", text: "", attrs: { weird: "1" } }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
  });

  it("PARAGRAPH_DEFAULT_PROPS matches BlockNote 0.52's defaultProps (goes red on upgrade)", () => {
    expect(PARAGRAPH_DEFAULT_PROPS).toEqual(
      Object.fromEntries(Object.entries(defaultProps).map(([k, v]) => [k, (v as { default: unknown }).default])),
    );
  });
});

describe("an empty XmlText counts as absent", () => {
  it("control A: in a non-empty document, a paragraph typed into and fully deleted has the same value as a freshly created empty paragraph (the old fingerprint differs)", async () => {
    const typed = await make([{ type: "paragraph", content: "x" }, { type: "paragraph", content: "a" }]);
    const t = textOfBlock(typed, 1);
    typed.transact(() => t.delete(0, t.length));
    const fresh = await make([{ type: "paragraph", content: "x" }, { type: "paragraph" }]);
    expect(vfp(typed)).toBe(vfp(fresh));
    expect(outlineOf(F(typed)).whole).not.toBe(outlineOf(F(fresh)).whole); // contrast: load-bearing
  });

  it("round trip on apply: after the snapshot's blocks are written into another live document with replace_all the version fingerprints are equal (the old fingerprint differs)", async () => {
    const snap = await make([
      { type: "heading", props: { level: 2 }, content: "標題" },
      { type: "paragraph", content: [{ type: "text", text: "粗", styles: { bold: true } }, { type: "text", text: "普通", styles: {} }] },
      { type: "bulletListItem", content: "項目", children: [{ type: "paragraph", content: "子" }] },
      { type: "paragraph" },
      { type: "paragraph", content: "尾", props: { textColor: "red" } },
    ]);
    const z = textOfBlock(snap, 3);
    snap.transact(() => z.insert(0, "z"));
    snap.transact(() => z.delete(0, 1)); // leave one T[] paragraph in the snapshot
    const live = await make([{ type: "paragraph", content: "活文件" }]);
    const blocks = yXmlFragmentToBlocks(BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/") }), F(snap));
    const { fork, sv } = forkFrom(live);
    const s = await EditorSession.open(rt, fork);
    let diff: Uint8Array;
    try {
      s.editor.replaceBlocks(s.editor.document.map(b => b.id), blocks as never);
      diff = s.diffSince(sv);
    } finally {
      s.close();
    }
    Y.applyUpdate(live, diff!);
    expect(vfp(live)).toBe(vfp(snap));
    expect(outlineOf(F(live)).whole).not.toBe(outlineOf(F(snap)).whole); // the old fingerprint would judge it as changed
  });
});

describe("content and history (reference vectors)", () => {
  it("same content, different history -> equal (bold then un-bold, delete and retype); block ids do not count", async () => {
    const plain = await make([{ type: "paragraph", content: "abc" }]);
    const bold = await make([{ type: "paragraph", content: "abc" }]);
    const tb = textOfBlock(bold, 0);
    bold.transact(() => tb.format(0, 3, { bold: true }));
    bold.transact(() => tb.format(0, 3, { bold: null }));
    const retyped = await make([{ type: "paragraph", content: "abc" }]);
    const tr = textOfBlock(retyped, 0);
    retyped.transact(() => tr.delete(0, 3));
    retyped.transact(() => tr.insert(0, "abc"));
    expect(vfp(bold)).toBe(vfp(plain));
    expect(vfp(retyped)).toBe(vfp(plain));
  });

  it("contrast: a fork and a note_states round-trip reload equal the original document; changed text, a new block, only attributes changed, only marks changed are all unequal; typing a character then deleting it is equal", () => {
    const live = rawDoc([{ id: "a", text: "Title", attrs: { textColor: "default" } }, { id: "b", text: "hello world", attrs: { textAlignment: "left" } }]);
    const w0 = vfp(live);
    const reload = new Y.Doc();
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(forkFrom(live).fork));
    expect(vfp(forkFrom(live).fork)).toBe(w0);
    expect(vfp(reload)).toBe(w0);
    const variant = (mutate: (d: Y.Doc) => void): string => {
      const d = forkFrom(live).fork;
      mutate(d);
      return vfp(d);
    };
    expect(variant(d => textOfBlock(d, 1).insert(0, "X"))).not.toBe(w0);
    expect(variant(d => {
      const c = new Y.XmlElement("blockContainer");
      c.setAttribute("id", "n");
      c.insert(0, [new Y.XmlElement("paragraph")]);
      (F(d).get(0) as Y.XmlElement).insert(1, [c]);
      textOfBlock(d, 1).insert(0, "new");
    })).not.toBe(w0);
    expect(variant(d => (topLevelBlocks(F(d))[1]!.get(0) as Y.XmlElement).setAttribute("textAlignment", "center"))).not.toBe(w0);
    expect(variant(d => textOfBlock(d, 1).format(0, 2, { bold: true }))).not.toBe(w0);
    expect(variant(d => {
      const t = textOfBlock(d, 1);
      t.insert(0, "X");
      t.delete(0, 1);
    })).toBe(w0);
  });
});

describe("does not throw", () => {
  it("5000 levels of nesting: the old fingerprint throws RangeError (contrast), the version fingerprint computes 16 hex", () => {
    const deep = deepDoc(5000);
    expect(() => outlineOf(F(deep))).toThrow(RangeError);
    expect(versionFingerprint(F(deep))).toMatch(/^[0-9a-f]{16}$/);
    // Building a 5000-level document is itself quadratic (about 2 s when idle, over 5 s when the machine is busy); the depth at which the old fingerprint throws RangeError varies with stack and execution context, and 5000 levels leaves headroom, so the timeout is relaxed instead of lowering the depth.
  }, 60_000);

  it("two blocks missing ids do not collide: [A,B] != [B,B] (the old fingerprint threw)", () => {
    const ab = rawDoc([{ id: null, text: "AAA" }, { id: null, text: "BBB" }]);
    const bb = rawDoc([{ id: null, text: "BBB" }, { id: null, text: "BBB" }]);
    expect(() => outlineOf(F(ab))).toThrow();
    expect(vfp(ab)).not.toBe(vfp(bb));
  });

  it("names containing separator characters do not collide as strings: a document with a single attribute name containing = and ; != a document with two ordinary attributes", () => {
    const one = rawDoc([{ id: "a", text: "x", attrs: { 'a="v";b': "1" } }]);
    const two = rawDoc([{ id: "a", text: "x", attrs: { a: "v", b: "1" } }]);
    expect(vfp(one)).toMatch(/^[0-9a-f]{16}$/);
    expect(vfp(one)).not.toBe(vfp(two));
  });

  it("non-string attributes (numbers, 100 levels of nested objects, a local bigint) still compute", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i += 1) nested = { n: nested };
    const doc = rawDoc([{ id: "a", text: "x", attrs: { level: 2, weird: nested, big: BigInt(7) } }]);
    expect(vfp(doc)).toMatch(/^[0-9a-f]{16}$/);
    expect(vfp(rawDoc([{ id: "a", text: "x", attrs: { level: 3, weird: nested, big: BigInt(7) } }]))).not.toBe(vfp(doc));
  });
});

describe("column widths in columns", () => {
  /** Hand-builds a row: columnList > column(width?) > blockContainer > paragraph. width undefined = the attribute is absent. */
  function rowDoc(width: number | undefined): Y.Doc {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    F(doc).insert(0, [g]);
    const list = new Y.XmlElement("columnList");
    list.setAttribute("id", "r");
    g.insert(0, [list]);
    const cols = [0, 1].map(i => {
      const col = new Y.XmlElement("column");
      col.setAttribute("id", `rc${i}`);
      if (i === 0 && width !== undefined) col.setAttribute("width", width as never);
      const c = new Y.XmlElement("blockContainer");
      c.setAttribute("id", `rp${i}`);
      const e = new Y.XmlElement("paragraph");
      const t = new Y.XmlText();
      e.insert(0, [t]);
      c.insert(0, [e]);
      col.insert(0, [c]);
      t.insert(0, `欄${i}`);
      return col;
    });
    list.insert(0, cols);
    return doc;
  }

  it("a column without a width attribute == width:1 (the default); width:2 differs", () => {
    expect(vfp(rowDoc(undefined))).toBe(vfp(rowDoc(1)));
    expect(vfp(rowDoc(2))).not.toBe(vfp(rowDoc(1)));
  });
});

describe("attribute values equal to the schema default count as absent", () => {
  const HEADING_FULL = { level: 2, isToggleable: false, backgroundColor: "default", textColor: "default", textAlignment: "left" };
  const PARA_FULL = { backgroundColor: "default", textAlignment: "left", textColor: "default" };

  it("heading{level:2} equals a heading with the four default attributes filled in (notes from an old schema had defaults written back by y-prosemirror)", () => {
    expect(bfp("heading", { level: 2 })).toBe(bfp("heading", HEADING_FULL));
    expect(bfp("heading", { level: 2 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it("paragraph{} equals a paragraph with the three default attributes filled in; textAlignment:center differs", () => {
    expect(bfp("paragraph", {})).toBe(bfp("paragraph", PARA_FULL));
    expect(bfp("paragraph", { textAlignment: "center" })).not.toBe(bfp("paragraph", {}));
    expect(bfp("paragraph", { ...PARA_FULL, textAlignment: "center" })).toBe(bfp("paragraph", { textAlignment: "center" }));
  });

  it("non-default values still count: level 2 != 3, checked true != absent; level:1 (the default) = absent", () => {
    expect(bfp("heading", { level: 2 })).not.toBe(bfp("heading", { level: 3 }));
    expect(bfp("checkListItem", { checked: true })).not.toBe(bfp("checkListItem", {}));
    expect(bfp("checkListItem", { checked: false })).toBe(bfp("checkListItem", {}));
    expect(bfp("heading", { level: 1 })).toBe(bfp("heading", {}));
  });

  it("an undefined value counts as absent (numberedListItem.start defaults to undefined and is not in the table); start:3 differs", () => {
    expect(DEFAULT_PROPS_BY_TYPE.numberedListItem).not.toHaveProperty("start");
    const withUndef = blockDoc("numberedListItem", { start: undefined });
    const li = topLevelBlocks(F(withUndef))[0]!.get(0) as Y.XmlElement;
    expect(Object.hasOwn(li.getAttributes(), "start")).toBe(true); // really written into Yjs (not dropped by setAttribute)
    expect(vfp(withUndef)).toBe(bfp("numberedListItem", {}));
    expect(bfp("numberedListItem", { start: 3 })).not.toBe(bfp("numberedListItem", {}));
  });

  it("values compare with strict equality: a different type is unequal (level:\"1\" != absent although \"1\" == 1)", () => {
    expect(bfp("heading", { level: "1" })).not.toBe(bfp("heading", {}));
    expect(bfp("heading", { level: "1" })).not.toBe(bfp("heading", { level: 1 }));
  });

  it("unknown block types, unknown attributes, non-id attributes of blockContainer: still counted as before (when the default cannot be looked up it must not be dropped)", () => {
    expect(bfp("fancyBlock", { backgroundColor: "default" })).not.toBe(bfp("fancyBlock", {}));
    expect(bfp("paragraph", { weird: "default" })).not.toBe(bfp("paragraph", {}));
    expect(bfp("paragraph", { constructor: "default" })).not.toBe(bfp("paragraph", {}));
    expect(bfp("constructor", { level: 1 })).not.toBe(bfp("constructor", {}));
  });

  it("inline elements (wikilink) follow the same rule: default values equal absent, non-default values count", () => {
    const wl = (attrs: Record<string, unknown>) => bfp("paragraph", {}, "x", [{ type: "wikilink", attrs }]);
    expect(wl({ targetNoteId: "n1", snapshotTitle: "" })).toBe(wl({ targetNoteId: "n1" }));
    expect(wl({ targetNoteId: "n1" })).not.toBe(wl({ targetNoteId: "n2" }));
  });

  it("the prefix is V2:: the truly-empty constant and the full serialisation of one paragraph are pinned (a paragraph with all-default attributes and one with none give the same string)", () => {
    expect(VACUUM_VERSION_FINGERPRINT).toBe(fingerprintOf("V2:vacuum"));
    const pinned = fingerprintOf('V2:F[E"blockGroup"()[E"blockContainer"()[E"paragraph"()[T[{"attributes":{},"insert":"x"}]]]]]');
    expect(bfp("paragraph", {})).toBe(pinned);
    expect(bfp("paragraph", PARA_FULL)).toBe(pinned);
  });

  it("setting a knowledge attribute to a non-empty value changes the version fingerprint, setting it to \"\" does not", () => {
    const plain = bfp("heading", { level: 1 }, "Title");
    expect(bfp("heading", { level: 1, knowledgeWhen: "" }, "Title")).toBe(plain);
    expect(bfp("heading", { level: 1, knowledgeId: "", knowledgeStatus: "" }, "Title")).toBe(plain);
    expect(bfp("heading", { level: 1, knowledgeWhen: "alice reads this" }, "Title")).not.toBe(plain);
    expect(bfp("heading", { level: 1, knowledgeId: "k_0123abcd" }, "Title")).not.toBe(plain);
  });

  it("the default-value table is derived from the shared schema (not hand-written): the set of types, the values of heading/paragraph/codeBlock/mermaid/math/wikilink; style is not in the table", () => {
    expect(Object.keys(DEFAULT_PROPS_BY_TYPE).sort()).toEqual([
      "audio", "bulletListItem", "checkListItem", "codeBlock", "column", "file", "heading", "image", "math", "mermaid", "numberedListItem", "paragraph",
      "quote", "table", "toggleListItem", "video", "wikilink",
    ]);
    expect(DEFAULT_PROPS_BY_TYPE.heading).toEqual({
      backgroundColor: "default", textColor: "default", textAlignment: "left", level: 1, isToggleable: false,
      ...EMPTY_KNOWLEDGE_PROPS,
    });
    expect(DEFAULT_PROPS_BY_TYPE.heading!.knowledgeCustom).toBe("");
    expect(DEFAULT_PROPS_BY_TYPE.paragraph).toEqual(PARAGRAPH_DEFAULT_PROPS);
    expect(DEFAULT_PROPS_BY_TYPE.checkListItem!.checked).toBe(false);
    expect(DEFAULT_PROPS_BY_TYPE.codeBlock).toEqual({ language: "text" });
    expect(DEFAULT_PROPS_BY_TYPE.mermaid).toEqual({ code: "" });
    expect(DEFAULT_PROPS_BY_TYPE.math).toEqual({ tex: "" });
    expect(DEFAULT_PROPS_BY_TYPE.column).toEqual({ width: 1 });
    expect(DEFAULT_PROPS_BY_TYPE.wikilink).toEqual({ targetNoteId: "", snapshotTitle: "", label: "", anchorBlockId: "" });
  });

  it("schema load failure: falls back to an empty table, warn(obj, msg) exactly once, no throw", () => {
    const warns: Array<[object, string]> = [];
    const table = buildDefaultPropsByType(() => {
      throw new Error("boom");
    }, (o, m) => warns.push([o, m]));
    expect(table).toEqual({});
    expect(warns).toHaveLength(1);
    expect(typeof warns[0]![0]).toBe("object");
    expect(warns[0]![1]).toMatch(/預設值表/);
  });
});
