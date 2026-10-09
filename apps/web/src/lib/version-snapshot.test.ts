import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { forkLiveBlocks, ydocBytesToBlocks } from "./version-snapshot";

function docWith(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  const writer = BlockNoteEditor.create({ schema: noteSchema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote PartialBlock 泛型三元組，repo 慣例
  blocksToYXmlFragment(writer, blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return doc;
}

const BLOCKS = [
  { id: "h1", type: "heading", props: { level: 2 }, content: "標題" },
  {
    id: "p1",
    type: "paragraph",
    content: [{ type: "text", text: "看 ", styles: {} }, { type: "wikilink", props: { targetNoteId: "note-2", snapshotTitle: "別篇" } }],
  },
];

describe("version-snapshot（spec §8.4：不 mount 讀快照）", () => {
  it("ydocBytesToBlocks：快照 bytes → blocks，id、型別、wikilink 的 targetNoteId 全保留", () => {
    const bytes = Y.encodeStateAsUpdate(docWith(BLOCKS));
    const blocks = ydocBytesToBlocks(bytes);
    expect(blocks.map((b) => [b.id, b.type])).toEqual([
      ["h1", "heading"],
      ["p1", "paragraph"],
    ]);
    const inline = blocks[1].content as Array<{ type: string; props?: { targetNoteId?: string } }>;
    expect(inline.find((x) => x.type === "wikilink")?.props?.targetNoteId).toBe("note-2");
  });

  it("真空文件（fragment 沒有任何節點）→ []", () => {
    expect(ydocBytesToBlocks(Y.encodeStateAsUpdate(new Y.Doc()))).toEqual([]);
  });

  it("forkLiveBlocks：讀得到活文件內容，且活文件零寫入（沒有任何 update 事件、state vector 不變）", () => {
    const live = docWith(BLOCKS);
    const sv = Y.encodeStateVector(live);
    let updates = 0;
    live.on("update", () => {
      updates += 1;
    });
    const blocks = forkLiveBlocks(live);
    expect(blocks.map((b) => b.id)).toEqual(["h1", "p1"]);
    expect(updates).toBe(0);
    expect(Array.from(Y.encodeStateVector(live))).toEqual(Array.from(sv));
  });

  it("forkLiveBlocks：活文件含 schema 不認得的節點時，讀取不會把刪除寫回活文件（fork 承重）", () => {
    const live = docWith(BLOCKS);
    const group = live.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
    const bogus = new Y.XmlElement("kbNoSuchNode");
    group.insert(group.length, [bogus]);
    const svBefore = Array.from(Y.encodeStateVector(live));
    let updates = 0;
    live.on("update", () => {
      updates += 1;
    });
    const blocks = forkLiveBlocks(live);
    expect(blocks.map((b) => b.id)).toEqual(["h1", "p1"]);
    expect(updates).toBe(0);
    expect(Array.from(Y.encodeStateVector(live))).toEqual(svBefore);
    expect(group.toArray()).toContain(bogus);
  });

  it("forkLiveBlocks 讀的是當下快照：先前讀出的結果不隨活文件改動，再讀才看到新狀態", () => {
    const live = docWith(BLOCKS);
    const before = forkLiveBlocks(live);
    live.getXmlFragment(YDOC_FRAGMENT).delete(0, 1);
    expect(before.map((b) => b.id)).toEqual(["h1", "p1"]);
    // 頂層唯一子節點是整個 blockGroup，delete(0,1) 等於清空文件
    expect(forkLiveBlocks(live)).toEqual([]);
  });
});
