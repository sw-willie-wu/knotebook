import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor, defaultProps } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema, topLevelContainers } from "@knotebook/shared";
import { outlineOf } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom } from "../../src/notes/editing/session.js";
import { PARAGRAPH_DEFAULT_PROPS, VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../../src/notes/version-fingerprint.js";

// 同 editing-session.test.ts：重建門檻調到不可能觸發，避免中途換掉全域 window。
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
/** 第 i 顆頂層區塊的內容節點底下的 XmlText；沒有就建一顆（新建空段落沒有 XmlText——r1 實跑）。 */
function textOfBlock(doc: Y.Doc, i: number): Y.XmlText {
  const content = topLevelContainers(F(doc))[i]!.get(0) as Y.XmlElement;
  const t = content.get(0);
  if (t instanceof Y.XmlText) return t;
  const created = new Y.XmlText();
  doc.transact(() => content.insert(0, [created]));
  return created;
}
/** 手造的段落文件（不經 BlockNote）：病態結構（缺 id、怪屬性）只能這樣造。id 為 null＝不設 id。 */
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

describe("真空（A14 (2)）", () => {
  it("r1 探針向量：舊指紋把真空與一顆空段落分成兩個值，版本指紋視為同一個", async () => {
    const vacuum = new Y.Doc();
    const one = await make([{ type: "paragraph" }]);
    expect(outlineOf(F(vacuum)).whole).toBe("8e2d0c61b0acc423"); // r1 實跑值（對照組：舊指紋不變）
    expect(outlineOf(F(one)).whole).toBe("7bcfba7c4d4cd39c");
    expect(vfp(vacuum)).toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(one)).toBe(VACUUM_VERSION_FINGERPRINT);
  });

  it("打一字再刪光（T[]）、多顆預設空段落、屬性缺席的空段落 → 真空", async () => {
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

  it("置中的空段落、空 heading、只有一個空白的段落、多一個不認得的屬性 → 不是真空", async () => {
    expect(vfp(await make([{ type: "paragraph", props: { textAlignment: "center" } }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(await make([{ type: "heading", props: { level: 1 } }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(rawDoc([{ id: "a", text: " " }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
    expect(vfp(rawDoc([{ id: "a", text: "", attrs: { weird: "1" } }]))).not.toBe(VACUUM_VERSION_FINGERPRINT);
  });

  it("PARAGRAPH_DEFAULT_PROPS 與 BlockNote 0.52 的 defaultProps 一致（升版會紅）", () => {
    expect(PARAGRAPH_DEFAULT_PROPS).toEqual(
      Object.fromEntries(Object.entries(defaultProps).map(([k, v]) => [k, (v as { default: unknown }).default])),
    );
  });
});

describe("空 XmlText 視同不存在（A14 (1)）", () => {
  it("r2 探針 A：非真空文件裡，打字後刪光的段落與新建空段落同值（舊指紋不同值）", async () => {
    const typed = await make([{ type: "paragraph", content: "x" }, { type: "paragraph", content: "a" }]);
    const t = textOfBlock(typed, 1);
    typed.transact(() => t.delete(0, t.length));
    const fresh = await make([{ type: "paragraph", content: "x" }, { type: "paragraph" }]);
    expect(vfp(typed)).toBe(vfp(fresh));
    expect(outlineOf(F(typed)).whole).not.toBe(outlineOf(F(fresh)).whole); // 對照：A14 (1) 承重
  });

  it("套用往返相等：快照 blocks 以 replace_all 寫進別的活文件後版本指紋相同（舊指紋不同）", async () => {
    const snap = await make([
      { type: "heading", props: { level: 2 }, content: "標題" },
      { type: "paragraph", content: [{ type: "text", text: "粗", styles: { bold: true } }, { type: "text", text: "普通", styles: {} }] },
      { type: "bulletListItem", content: "項目", children: [{ type: "paragraph", content: "子" }] },
      { type: "paragraph" },
      { type: "paragraph", content: "尾", props: { textColor: "red" } },
    ]);
    const z = textOfBlock(snap, 3);
    snap.transact(() => z.insert(0, "z"));
    snap.transact(() => z.delete(0, 1)); // 快照裡留一顆 T[] 段落
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
    expect(outlineOf(F(live)).whole).not.toBe(outlineOf(F(snap)).whole); // r1 ED2：舊指紋會判成「有改」
  });
});

describe("內容與歷史（r1、r4 探針向量）", () => {
  it("內容相同歷史不同 → 相等（粗體再取消、刪了重打）；區塊 id 不計", async () => {
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

  it("r4 探針：fork、note_states 往返重載與原文件相等；改字、新區塊、只改屬性、只改 mark 都不等；打一字再刪相等", () => {
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
    expect(variant(d => (topLevelContainers(F(d))[1]!.get(0) as Y.XmlElement).setAttribute("textAlignment", "center"))).not.toBe(w0);
    expect(variant(d => textOfBlock(d, 1).format(0, 2, { bold: true }))).not.toBe(w0);
    expect(variant(d => {
      const t = textOfBlock(d, 1);
      t.insert(0, "X");
      t.delete(0, 1);
    })).toBe(w0);
  });
});

describe("不丟例外（A14 (3)）", () => {
  it("5000 層巢狀：舊指紋 RangeError（對照），版本指紋算得出 16 hex", () => {
    const deep = deepDoc(5000);
    expect(() => outlineOf(F(deep))).toThrow(RangeError);
    expect(versionFingerprint(F(deep))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("缺 id 的兩顆不撞鍵：[A,B] ≠ [B,B]（舊指紋直接丟例外）", () => {
    const ab = rawDoc([{ id: null, text: "AAA" }, { id: null, text: "BBB" }]);
    const bb = rawDoc([{ id: null, text: "BBB" }, { id: null, text: "BBB" }]);
    expect(() => outlineOf(F(ab))).toThrow();
    expect(vfp(ab)).not.toBe(vfp(bb));
  });

  it("名稱含分隔字元不撞串：單一屬性名含 =、; 的文件 ≠ 兩個普通屬性的文件", () => {
    const one = rawDoc([{ id: "a", text: "x", attrs: { 'a="v";b': "1" } }]);
    const two = rawDoc([{ id: "a", text: "x", attrs: { a: "v", b: "1" } }]);
    expect(vfp(one)).toMatch(/^[0-9a-f]{16}$/);
    expect(vfp(one)).not.toBe(vfp(two));
  });

  it("非字串屬性（數字、100 層巢狀物件、本地 bigint）照樣算得出值", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i += 1) nested = { n: nested };
    const doc = rawDoc([{ id: "a", text: "x", attrs: { level: 2, weird: nested, big: BigInt(7) } }]);
    expect(vfp(doc)).toMatch(/^[0-9a-f]{16}$/);
    expect(vfp(rawDoc([{ id: "a", text: "x", attrs: { level: 3, weird: nested, big: BigInt(7) } }]))).not.toBe(vfp(doc));
  });
});
