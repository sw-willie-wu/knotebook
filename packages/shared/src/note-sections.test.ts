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

// ─────────── #93 T1／T2：textOf 迭代化（spec §4.1） ───────────
/** 改動前的遞迴版 textOf，逐字保留當參考實作（T1 等價性的對照組）。 */
function refTextOf(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as Array<{ insert: unknown }>).map(d => (typeof d.insert === "string" ? d.insert : "")).join("");
  }
  let s = "";
  for (let i = 0; i < node.length; i += 1) {
    const c = node.get(i);
    if (c instanceof Y.XmlText || c instanceof Y.XmlElement) s += refTextOf(c);
  }
  return s;
}

/** 改動前的 sectionize，只換成呼叫 refTextOf；與 note-sections.ts 的 `sectionize` 行為等價（helper 內聯、省略 blockIds）。 */
function refSectionize(fragment: Y.XmlFragment): Array<{ sectionId: string; heading: string; chars: number }> {
  const out: Array<{ sectionId: string; level: number; heading: string; chars: number }> = [{ sectionId: TOP_SECTION_ID, level: 0, heading: "", chars: 0 }];
  let current = out[0]!;
  for (const c of topLevelContainers(fragment)) {
    const first = c.get(0);
    const content = first instanceof Y.XmlElement && first.nodeName !== "blockGroup" ? first : null;
    const level = content && content.nodeName === "heading" ? (Number.isFinite(Number(content.getAttribute("level") ?? "1")) ? Number(content.getAttribute("level") ?? "1") : 1) : null;
    const id = (c.getAttribute("id") ?? "") as string;
    if (level !== null && (current.level === 0 || level <= current.level)) {
      current = { sectionId: id, level, heading: refTextOf(content!), chars: 0 };
      out.push(current);
    }
    current.chars += refTextOf(c).length;
  }
  return out.map(({ sectionId, heading, chars }) => ({ sectionId, heading, chars }));
}

/** 決定性 PRNG（LCG），讓隨機文件可重現。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 往 el 尾端塞 1–4 個子節點：XmlText、wikilink（content:"none"）、XmlHook、或巢狀元素（含 mermaid）。 */
function fillInline(el: Y.XmlElement, r: () => number, depth: number): void {
  const k = 1 + Math.floor(r() * 4);
  for (let j = 0; j < k; j += 1) {
    const roll = r();
    if (roll < 0.45) {
      const t = new Y.XmlText();
      el.insert(el.length, [t]);
      t.insert(0, `t${Math.floor(r() * 1000)} `);
    } else if (roll < 0.6) {
      const w = new Y.XmlElement("wikilink");
      el.insert(el.length, [w]);
      w.setAttribute("snapshotTitle", "Linked");
    } else if (roll < 0.7) {
      el.insert(el.length, [new Y.XmlHook("hook") as unknown as Y.XmlElement]);
    } else if (depth < 3) {
      const sub = new Y.XmlElement(roll < 0.85 ? "bold" : "mermaid");
      el.insert(el.length, [sub]);
      if (sub.nodeName === "mermaid") sub.setAttribute("code", "graph TD");
      fillInline(sub, r, depth + 1);
    }
  }
}

function randomDoc(seed: number): Y.Doc {
  const r = lcg(seed);
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  const n = 3 + Math.floor(r() * 8);
  for (let i = 0; i < n; i += 1) {
    const c = new Y.XmlElement("blockContainer");
    group.insert(i, [c]);
    c.setAttribute("id", `b${seed}x${i}`);
    const heading = r() < 0.4;
    const content = new Y.XmlElement(heading ? "heading" : "paragraph");
    c.insert(0, [content]);
    if (heading) content.setAttribute("level", String(1 + Math.floor(r() * 3)));
    fillInline(content, r, 0);
    if (r() < 0.4) {
      const inner = new Y.XmlElement("blockGroup");
      c.insert(1, [inner]);
      const nc = new Y.XmlElement("blockContainer");
      inner.insert(0, [nc]);
      nc.setAttribute("id", `n${seed}x${i}`);
      const np = new Y.XmlElement("paragraph");
      nc.insert(0, [np]);
      fillInline(np, r, 0);
    }
  }
  return doc;
}

describe("#93 textOf 迭代化（spec §4.1）", () => {
  // 建鏈必須包在單一 doc.transact 裡：逐筆 insert 每次各開一個 transaction、收尾成本隨深度長，整條鏈是 O(n²)
  // （CI 上單這段同步跑 40–48 s；同步卡住 worker 超過 60 s 會讓 vitest 的 onTaskUpdate RPC 逾時 → Unhandled Error、exit 1）。
  // 單一 transaction 下 20 000 層本機實測約 20 ms，樹的形狀相同。
  it("T2：20 000 層 blockContainer 鏈 → sectionize 不拋，最深處的字算進 chars", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const group = new Y.XmlElement("blockGroup");
      doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
      const top = new Y.XmlElement("blockContainer");
      group.insert(0, [top]);
      top.setAttribute("id", "deep");
      let parent = top;
      for (let i = 0; i < 20_000; i += 1) {
        const child = new Y.XmlElement("blockContainer");
        parent.insert(0, [child]);
        parent = child;
      }
      const leaf = new Y.XmlElement("paragraph");
      parent.insert(0, [leaf]);
      const t = new Y.XmlText();
      leaf.insert(0, [t]);
      t.insert(0, "DEEPEST");
    });
    const s = sectionize(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(s).toHaveLength(1);
    expect(s[0]!.chars).toBe("DEEPEST".length);
  });

  it("T1：子節點順序——heading 由三個子節點組成時串接順序與文件順序相同", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
    const c = new Y.XmlElement("blockContainer");
    group.insert(0, [c]);
    c.setAttribute("id", "h");
    const h = new Y.XmlElement("heading");
    c.insert(0, [h]);
    h.setAttribute("level", "1");
    const a = new Y.XmlText();
    h.insert(0, [a]);
    a.insert(0, "ab");
    const bold = new Y.XmlElement("bold");
    h.insert(1, [bold]);
    const b = new Y.XmlText();
    bold.insert(0, [b]);
    b.insert(0, "cd");
    const e = new Y.XmlText();
    h.insert(2, [e]);
    e.insert(0, "ef");
    expect(sectionize(doc.getXmlFragment(YDOC_FRAGMENT))[1]).toMatchObject({ heading: "abcdef", chars: 6 });
  });

  it("T1：200 份隨機巢狀文件（含 wikilink、mermaid、XmlHook）的 heading／chars 與遞迴參考實作逐一相等", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const f = randomDoc(seed).getXmlFragment(YDOC_FRAGMENT);
      const got = sectionize(f).map(({ sectionId, heading, chars }) => ({ sectionId, heading, chars }));
      expect(got, `seed ${seed}`).toEqual(refSectionize(f));
    }
  });

  it("T1：既有 fixture（makeDoc，含巢狀 heading）與參考實作相等", () => {
    const doc = makeDoc([
      { id: "p0", type: "paragraph", text: "intro" },
      { id: "h1", type: "heading", level: 2, text: "A" },
      { id: "p1", type: "paragraph", text: "li", nested: [{ id: "n1", type: "heading", level: 1, text: "inner" }] },
    ]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(sectionize(f).map(({ sectionId, heading, chars }) => ({ sectionId, heading, chars }))).toEqual(refSectionize(f));
  });
});
