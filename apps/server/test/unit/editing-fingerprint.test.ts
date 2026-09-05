import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { YDOC_FRAGMENT, createHeadlessNoteSchema, topLevelContainers } from "@knotebook/shared";
import { EMPTY_SECTION_FINGERPRINT, fingerprintForIds, fingerprintOf, outlineOf } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function docWith(blocks: Array<Record<string, unknown>>): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  s.editor.replaceBlocks(s.editor.document, blocks as never);
  s.close();
  return doc;
}

describe("fingerprint", () => {
  it("16 hex；空正規字串有固定值；空 _top 用它且計入整篇", async () => {
    expect(fingerprintOf("")).toMatch(/^[0-9a-f]{16}$/);
    expect(EMPTY_SECTION_FINGERPRINT).toBe(fingerprintOf(""));
    const doc = await docWith([{ type: "heading", props: { level: 1 }, content: "A" }]);
    const { outline, whole } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(outline[0]).toMatchObject({ sectionId: "_top", fingerprint: EMPTY_SECTION_FINGERPRINT, chars: 0 });
    expect(whole).toBe(fingerprintOf(outline.map(o => o.fingerprint).join("")));
  });

  it("整篇對段序敏感；同內容不同 id 相同", async () => {
    const a = await docWith([{ type: "heading", props: { level: 1 }, content: "A" }, { type: "heading", props: { level: 1 }, content: "B" }]);
    const b = await docWith([{ type: "heading", props: { level: 1 }, content: "B" }, { type: "heading", props: { level: 1 }, content: "A" }]);
    const c = await docWith([{ type: "heading", props: { level: 1 }, content: "A" }, { type: "heading", props: { level: 1 }, content: "B" }]);
    expect(outlineOf(a.getXmlFragment(YDOC_FRAGMENT)).whole).not.toBe(outlineOf(b.getXmlFragment(YDOC_FRAGMENT)).whole);
    expect(outlineOf(a.getXmlFragment(YDOC_FRAGMENT)).whole).toBe(outlineOf(c.getXmlFragment(YDOC_FRAGMENT)).whole);
  });

  it("fingerprintForIds：順序改變或缺 id → null；空 → EMPTY_SECTION_FINGERPRINT", async () => {
    const doc = await docWith([{ type: "paragraph", content: "1" }, { type: "paragraph", content: "2" }]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    const [a, b] = topLevelContainers(f).map(c => c.getAttribute("id")!);
    expect(fingerprintForIds(f, [a, b])).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintForIds(f, [b, a])).toBeNull();
    expect(fingerprintForIds(f, [a, "zzz"])).toBeNull();
    expect(fingerprintForIds(f, [])).toBe(EMPTY_SECTION_FINGERPRINT);
  });

  it("釘住 blockContainer 的屬性集恰為 {id}（BlockNote 升版會紅）", () => {
    const editor = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/") });
    expect(Object.keys(editor.pmSchema.nodes.blockContainer!.spec.attrs ?? {}).sort()).toEqual(["id"]);
  });

  it("段落指紋 ≡ fingerprintForIds(該段 blockIds)：多 block 段落依文件順序", async () => {
    const doc = await docWith([
      { id: "c-h", type: "heading", props: { level: 1 }, content: "H" },
      { id: "b-x", type: "paragraph", content: "X" },
      { id: "a-y", type: "paragraph", content: "Y" },
    ]);
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    expect(topLevelContainers(f).map(c => c.getAttribute("id"))).toEqual(["c-h", "b-x", "a-y"]);
    const { outline } = doc.transact(() => outlineOf(f));
    const sec = outline[1]!;
    expect(sec.blockIds).toEqual(["c-h", "b-x", "a-y"]);
    expect(sec.fingerprint).toBe(fingerprintForIds(f, sec.blockIds));
    expect(fingerprintForIds(f, [...sec.blockIds].reverse())).toBeNull();
  });

  it("outlineOf：頂層 blockContainer 缺 id 屬性 → throw", () => {
    const doc = new Y.Doc();
    const f = doc.getXmlFragment(YDOC_FRAGMENT);
    const group = new Y.XmlElement("blockGroup");
    const container = new Y.XmlElement("blockContainer");
    group.insert(0, [container]);
    f.insert(0, [group]);
    expect(() => outlineOf(f)).toThrow(/缺 id 屬性/);
  });
});
