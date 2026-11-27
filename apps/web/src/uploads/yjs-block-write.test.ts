import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type UploadResponseDto } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { writeUploadedBlock } from "./yjs-block-write";

const editor = BlockNoteEditor.create({ schema: noteSchema });

function docWith(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote PartialBlock generic triple, repo convention
  blocksToYXmlFragment(editor, blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return doc;
}

function containerOf(doc: Y.Doc, blockId: string): Y.XmlElement | undefined {
  const walk = (node: Y.XmlElement | Y.XmlFragment): Y.XmlElement | undefined => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer" && child.getAttribute("id") === blockId) return child;
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(doc.getXmlFragment(YDOC_FRAGMENT));
}

const blocksOf = (doc: Y.Doc) => yXmlFragmentToBlocks(editor, doc.getXmlFragment(YDOC_FRAGMENT)) as unknown as Array<{
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: Array<{ id: string; type: string; props: Record<string, unknown> }>;
}>;

const result = (kind: UploadResponseDto["kind"], mime: string): UploadResponseDto => ({ id: "u1", url: "/api/uploads/u1", mime, kind });

describe("writeUploadedBlock", () => {
  it("same kind: sets url and name only", () => {
    const doc = docWith([{ id: "a1", type: "audio", props: { caption: "talk", backgroundColor: "blue" } }]);
    expect(writeUploadedBlock(doc, "a1", "", result("audio", "audio/mpeg"), "talk.mp3")).toBe("written");
    expect(blocksOf(doc)[0]).toMatchObject({
      id: "a1",
      type: "audio",
      props: { url: "/api/uploads/u1", name: "talk.mp3", caption: "talk", backgroundColor: "blue" },
    });
  });

  it("kind file for a block created as video with a previewWidth: the content becomes file, the container id stays, only file props remain", () => {
    const doc = docWith([
      { id: "v1", type: "video", props: { previewWidth: 320, showPreview: false, textAlignment: "center", caption: "c", backgroundColor: "red" } },
    ]);
    const container = containerOf(doc, "v1")!;
    expect(writeUploadedBlock(doc, "v1", "", result("file", "text/plain; charset=utf-8"), "clip.ts")).toBe("written");

    expect(containerOf(doc, "v1")).toBe(container);
    const content = container.get(0) as Y.XmlElement;
    expect(content.nodeName).toBe("file");
    expect(content.getAttributes()).toEqual({ backgroundColor: "red", name: "clip.ts", url: "/api/uploads/u1", caption: "c" });
    expect(blocksOf(doc)[0]).toMatchObject({ id: "v1", type: "file", props: { url: "/api/uploads/u1", name: "clip.ts", caption: "c" } });
  });

  it("kind video for a block created as file: video props the file lacked get their defaults", () => {
    const doc = docWith([{ id: "f1", type: "file", props: { caption: "c" } }]);
    expect(writeUploadedBlock(doc, "f1", "", result("video", "video/mp4"), "a.mp4")).toBe("written");
    const content = containerOf(doc, "f1")!.get(0) as Y.XmlElement;
    expect(content.nodeName).toBe("video");
    expect(content.getAttributes()).toEqual({
      textAlignment: "left",
      backgroundColor: "default",
      name: "a.mp4",
      url: "/api/uploads/u1",
      caption: "c",
      showPreview: true,
    });
  });

  it("a nested block (in a list item's children) is found and written", () => {
    const doc = docWith([{ id: "li", type: "bulletListItem", content: "x", children: [{ id: "f2", type: "file", props: {} }] }]);
    expect(writeUploadedBlock(doc, "f2", "", result("file", "application/pdf"), "a.pdf")).toBe("written");
    expect(blocksOf(doc)[0]!.children[0]).toMatchObject({ id: "f2", type: "file", props: { url: "/api/uploads/u1", name: "a.pdf" } });
  });

  it("no block with that id -> missing, nothing written", () => {
    const doc = docWith([{ id: "p1", type: "paragraph", content: "x" }]);
    const before = Y.encodeStateVector(doc);
    expect(writeUploadedBlock(doc, "gone", "", result("file", "application/pdf"), "a.pdf")).toBe("missing");
    expect(Array.from(Y.encodeStateVector(doc))).toEqual(Array.from(before));
  });

  it("url differs from the expected one -> changed, nothing written", () => {
    const doc = docWith([{ id: "f1", type: "file", props: { url: "https://example.com/x.pdf" } }]);
    expect(writeUploadedBlock(doc, "f1", "", result("file", "application/pdf"), "a.pdf")).toBe("changed");
    expect(blocksOf(doc)[0]!.props.url).toBe("https://example.com/x.pdf");
  });

  it("replace flow: the expected old url matches -> written over it", () => {
    const doc = docWith([{ id: "f1", type: "file", props: { url: "/api/uploads/old", name: "old.pdf" } }]);
    expect(writeUploadedBlock(doc, "f1", "/api/uploads/old", result("file", "application/pdf"), "new.pdf")).toBe("written");
    expect(blocksOf(doc)[0]!.props).toMatchObject({ url: "/api/uploads/u1", name: "new.pdf" });
  });

  it("the block was turned into a paragraph meanwhile -> changed", () => {
    const doc = docWith([{ id: "x1", type: "paragraph", content: "text" }]);
    expect(writeUploadedBlock(doc, "x1", "", result("file", "application/pdf"), "a.pdf")).toBe("changed");
    expect(blocksOf(doc)[0]!.type).toBe("paragraph");
  });

  it("the conversion is one transaction (one update for peers)", () => {
    const doc = docWith([{ id: "v1", type: "video", props: {} }]);
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    writeUploadedBlock(doc, "v1", "", result("audio", "audio/mpeg"), "a.mp3");
    expect(updates).toBe(1);
  });
});
