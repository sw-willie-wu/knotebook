import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { selectedImageOf } from "./selected-image";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- editor ref 泛型三元組，repo 慣例
let current: any;

function Host() {
  const editor = useCreateBlockNote({
    schema: noteSchema,
    initialContent: [
      { type: "paragraph", content: "hello" },
      { type: "paragraph", content: "parent", children: [{ type: "image", props: { url: "/api/uploads/kid.png", name: "kid.png" } }] },
      {
        type: "image",
        props: { url: "/api/uploads/outer.png", name: "outer.png" },
        children: [{ type: "image", props: { url: "/api/uploads/inner.png", name: "inner.png" } }],
      },
    ],
    resolveFileUrl: (url: string) => Promise.resolve(url),
  });
  current = editor;
  return <BlockNoteView editor={editor} />;
}

describe("selectedImageOf", () => {
  it("外層 image block 設成 NodeSelection → 回外層那張圖，不是巢狀子 block 的", async () => {
    const { container } = render(<Host />);
    await waitFor(() => expect(container.querySelectorAll("img.bn-visual-media")).toHaveLength(3));
    const view = current.prosemirrorView;
    let pos = -1;
    view.state.doc.descendants((node: { type: { name: string }; attrs: { url?: string } }, p: number) => {
      if (pos < 0 && node.type.name === "image" && node.attrs.url?.includes("outer.png")) pos = p;
      return pos < 0;
    });
    current._tiptapEditor.commands.setNodeSelection(pos);
    expect(view.state.selection.toJSON().type).toBe("node");
    const img = selectedImageOf(view);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("outer.png");
  });

  it("選的是帶巢狀圖片的段落 → null（不往子 block 找）", async () => {
    const { container } = render(<Host />);
    await waitFor(() => expect(container.querySelectorAll("img.bn-visual-media")).toHaveLength(3));
    const view = current.prosemirrorView;
    let pos = -1;
    view.state.doc.descendants((node: { type: { name: string }; textContent: string }, p: number) => {
      if (pos < 0 && node.type.name === "paragraph" && node.textContent === "parent") pos = p;
      return pos < 0;
    });
    current._tiptapEditor.commands.setNodeSelection(pos);
    expect(view.state.selection.toJSON().type).toBe("node");
    expect(selectedImageOf(view)).toBeNull();
  });

  it("文字游標 → null", async () => {
    const { container } = render(<Host />);
    await waitFor(() => expect(container.querySelectorAll("img.bn-visual-media")).toHaveLength(3));
    const view = current.prosemirrorView;
    current._tiptapEditor.commands.setTextSelection(3);
    expect(selectedImageOf(view)).toBeNull();
  });

  it("view 為 undefined → null", () => {
    expect(selectedImageOf(undefined)).toBeNull();
  });
});
