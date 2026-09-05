import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "./ydoc.js";
import { canonicalizeElements, canonicalizeSection, sectionize, TOP_SECTION_ID, topLevelContainers } from "./note-sections.js";

/** 手工造 BlockNote 結構：fragment > blockGroup > blockContainer(id) > <type …>text */
function makeDoc(blocks: Array<{ id: string; type: "paragraph" | "heading"; text: string; level?: number; nested?: Array<{ id: string; type: "heading"; text: string; level: number }> }>): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
  const group = new Y.XmlElement("blockGroup");
  fragment.insert(0, [group]);
  let i = 0;
  for (const b of blocks) {
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", b.id);
    const content = new Y.XmlElement(b.type);
    if (b.type === "heading") content.setAttribute("level", String(b.level ?? 1));
    const text = new Y.XmlText();
    text.insert(0, b.text);
    content.insert(0, [text]);
    container.insert(0, [content]);
    if (b.nested) {
      const inner = new Y.XmlElement("blockGroup");
      for (const n of b.nested) {
        const c = new Y.XmlElement("blockContainer");
        c.setAttribute("id", n.id);
        const h = new Y.XmlElement("heading");
        h.setAttribute("level", String(n.level));
        const t = new Y.XmlText(); t.insert(0, n.text); h.insert(0, [t]);
        c.insert(0, [h]);
        inner.insert(inner.length, [c]);
      }
      container.insert(1, [inner]);
    }
    group.insert(i++, [container]);
  }
  return doc;
}

describe("sectionize", () => {
  it("無 heading → 只有 _top，含全部 block", () => {
    const doc = makeDoc([{ id: "a", type: "paragraph", text: "x" }, { id: "b", type: "paragraph", text: "y" }]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))).toEqual([{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 2, blockIds: ["a", "b"] }]);
  });

  it("h2→h3→h2：h3 併入 h2 的段；下一個 h2 開新段；chars 累計", () => {
    const doc = makeDoc([
      { id: "p0", type: "paragraph", text: "intro" },
      { id: "h1", type: "heading", level: 2, text: "A" },
      { id: "p1", type: "paragraph", text: "a1" },
      { id: "h2", type: "heading", level: 3, text: "A.1" },
      { id: "p2", type: "paragraph", text: "a2" },
      { id: "h3", type: "heading", level: 2, text: "B" },
      { id: "p3", type: "paragraph", text: "b1" },
    ]);
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s.map(x => [x.sectionId, x.blockIds])).toEqual([[TOP_SECTION_ID, ["p0"]], ["h1", ["h1", "p1", "h2", "p2"]], ["h3", ["h3", "p3"]]]);
    expect(s[1]).toMatchObject({ level: 2, heading: "A", chars: 1 + 2 + 3 + 2 });
  });

  it("連續 heading 各自成段；heading 在末尾是只含自己的段", () => {
    const doc = makeDoc([{ id: "h1", type: "heading", level: 1, text: "A" }, { id: "h2", type: "heading", level: 1, text: "B" }]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT)).map(x => x.blockIds)).toEqual([[], ["h1"], ["h2"]]);
  });

  it("heading 開頭 → outline[0] 是 _top、0 block、chars 0", () => {
    const doc = makeDoc([{ id: "h1", type: "heading", level: 1, text: "A" }]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))[0]).toEqual({ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0, blockIds: [] });
  });

  it("空文件（無 blockGroup）→ 只有空 _top", () => {
    const doc = new Y.Doc();
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))).toEqual([{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0, blockIds: [] }]);
  });

  it("巢狀 blockContainer 內的 heading 不分段", () => {
    const doc = makeDoc([
      { id: "h1", type: "heading", level: 1, text: "A" },
      { id: "p1", type: "paragraph", text: "li", nested: [{ id: "n1", type: "heading", level: 1, text: "inner" }] },
    ]);
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s.map(x => x.sectionId)).toEqual([TOP_SECTION_ID, "h1"]);
    expect(s[1]!.blockIds).toEqual(["h1", "p1"]);
  });

  it("小寫 blockgroup 假結構不成段（nodeName 是 camelCase）", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockgroup");
    const c = new Y.XmlElement("blockcontainer"); c.setAttribute("id", "x");
    group.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    expect(topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))).toEqual([]);
  });

  it("chars 算純文字：heading 文字算，bold 標記不算", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", "a");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText(); t.insert(0, "ab", { bold: true }); t.insert(2, "cd");
    p.insert(0, [t]); c.insert(0, [p]); group.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))[0]!.chars).toBe(4);
  });
});

describe("canonicalize", () => {
  const withId = (id: string, text: string, attrs: Record<string, string> = {}) => {
    const doc = makeDoc([{ id, type: "paragraph", text }]);
    const el = topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[0]!;
    for (const [k, v] of Object.entries(attrs)) (el.get(0) as Y.XmlElement).setAttribute(k, v);
    return el;
  };
  const mk = (fn: (t: Y.XmlText) => void) => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup"); const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", "a");
    const p = new Y.XmlElement("paragraph"); const t = new Y.XmlText(); fn(t); p.insert(0, [t]); c.insert(0, [p]); g.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    return topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))[0]!;
  };

  it("同內容不同 id → 相同；改一字 → 不同", () => {
    expect(canonicalizeElements([withId("a", "hi")])).toBe(canonicalizeElements([withId("b", "hi")]));
    expect(canonicalizeElements([withId("a", "hi")])).not.toBe(canonicalizeElements([withId("a", "ho")]));
  });

  it("屬性鍵序無關", () => {
    const x = withId("a", "t", { textAlignment: "left", backgroundColor: "default" });
    const y = withId("a", "t", { backgroundColor: "default", textAlignment: "left" });
    expect(canonicalizeElements([x])).toBe(canonicalizeElements([y]));
  });

  it("bold mark 有影響；link href 有影響、mark 屬性物件鍵序無關；mark 物件內的 null 值有影響", () => {
    const plain = mk(t => t.insert(0, "x"));
    const bold = mk(t => t.insert(0, "x", { bold: {} }));
    expect(canonicalizeElements([plain])).not.toBe(canonicalizeElements([bold]));
    const l1 = mk(t => t.insert(0, "x", { link: { href: "https://a", target: "_blank" } }));
    const l2 = mk(t => t.insert(0, "x", { link: { target: "_blank", href: "https://a" } }));
    const l3 = mk(t => t.insert(0, "x", { link: { href: "https://b", target: "_blank" } }));
    expect(canonicalizeElements([l1])).toBe(canonicalizeElements([l2]));
    expect(canonicalizeElements([l1])).not.toBe(canonicalizeElements([l3]));
    // yjs 13.6.32 對頂層 `{ link: null }` 會整個略過（insertAttributes 的 equalAttrs(null,null)），所以 null 只能測在 mark 物件內
    const nestedNull = mk(t => t.insert(0, "x", { link: { href: "https://a", target: null } }));
    const noTarget = mk(t => t.insert(0, "x", { link: { href: "https://a" } }));
    expect(canonicalizeElements([nestedNull])).not.toBe(canonicalizeElements([noTarget]));
  });

  it("canonicalizeSection：id 不在頂層或順序改變 → null；空 → \"\"", () => {
    const doc = makeDoc([{ id: "a", type: "paragraph", text: "1" }, { id: "b", type: "paragraph", text: "2" }]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(canonicalizeSection(f, ["a", "b"])).toBeTypeOf("string");
    expect(canonicalizeSection(f, ["b", "a"])).toBeNull();
    expect(canonicalizeSection(f, ["a", "zzz"])).toBeNull();
    expect(canonicalizeSection(f, [])).toBe("");
  });
});
