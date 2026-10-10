import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { blocksFromSnapshot } from "../../src/notes/editing/apply-version.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const BASE = "http://localhost/";
const OTHER = "11111111-1111-4111-8111-111111111111";

describe("blocksFromSnapshot（spec §7-2b：不 mount、不取 lease、同一個同步區段）", () => {
  it("runtime 剛重建過全域之後照樣讀得到；wikilink 的 targetNoteId 保留；區塊 id 與快照相同；不 mount、不佔 lease", async () => {
    const rt = new EditingRuntime({ baseUrl: BASE, rebuildEvery: 1 }); // 第一次 mount 就排定重建、release 時換掉全域
    rt.installGlobals();
    const src = new Y.Doc();
    const s = await EditorSession.open(rt, src);
    try {
      s.editor.replaceBlocks(s.editor.document, [
        { type: "heading", props: { level: 1 }, content: "標題" },
        { type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: OTHER, snapshotTitle: "Other" } }, { type: "text", text: " tail", styles: {} }] },
      ] as never);
    } finally {
      s.close();
    }
    expect(rt.rebuilds).toBe(1);
    const mountsBefore = rt.mounts;
    const blocks = blocksFromSnapshot(BASE, Y.encodeStateAsUpdate(src));
    expect(blocks.map(b => b.type)).toEqual(["heading", "paragraph"]);
    expect(JSON.stringify(blocks[1])).toContain(OTHER);
    expect(blocks.map(b => b.id)).toEqual(topLevelContainers(src.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id")));
    expect(rt.mounts).toBe(mountsBefore);
    expect(rt.inFlight).toBe(0);
  });

  it("真空快照 → []（§7-4：交給 replace_all 留一顆空段落）", () => {
    expect(blocksFromSnapshot(BASE, Y.encodeStateAsUpdate(new Y.Doc()))).toEqual([]);
  });

  it("量測（§13-5 的 server 側；回報、不斷言上限）：2000 區塊快照轉 blocks", () => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    const texts: Y.XmlText[] = [];
    g.insert(0, Array.from({ length: 2000 }, (_, i) => {
      const c = new Y.XmlElement("blockContainer");
      c.setAttribute("id", `b${i}`);
      const p = new Y.XmlElement("paragraph");
      const t = new Y.XmlText();
      p.insert(0, [t]);
      c.insert(0, [p]);
      texts.push(t);
      return c;
    }));
    texts.forEach((t, i) => t.insert(0, `第 ${i} 段的一些文字內容`));
    const t0 = performance.now();
    const blocks = blocksFromSnapshot(BASE, Y.encodeStateAsUpdate(doc));
    const ms = Math.round(performance.now() - t0);
    console.log(`MEASURE blocksFromSnapshot 2000 blocks: ${ms} ms`);
    expect(blocks).toHaveLength(2000);
  });
});
