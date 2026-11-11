import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { IMG, P, integrity, mountEditor, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { removeBlocksKeepColumns, replaceBlocksKeepColumns } from "./keep-columns";

// 我們發動的移除／取代不收欄。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  return m.editor;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/** 兩顆共編編輯器，各自一份 Y.Doc，經 `Y.applyUpdate` 互傳（同 `probe-collab/collab.mjs`）。 */
async function collabPair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const make = (doc: Y.Doc, n: number): AnyEditor => {
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: noteSchema,
        collaboration: {
          provider: { awareness: undefined },
          fragment: doc.getXmlFragment(YDOC_FRAGMENT),
          user: { id: `u${n}`, name: `User ${n}`, color: "hsl(0 65% 45%)" },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    ) as any as AnyEditor;
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    cleanups.push(() => {
      editor.unmount();
      el.remove();
      doc.destroy();
    });
    return editor;
  };
  const a = make(d1, 1);
  await tick();
  a.replaceBlocks(a.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const b = make(d2, 2);
  await tick();
  const sync = () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
  };
  return { a, b, sync };
}

const allText = (editor: AnyEditor) => {
  let s = "";
  editor.prosemirrorView!.state.doc.descendants((n) => {
    if (n.isText) s += n.text;
  });
  return s;
};

describe("removeBlocksKeepColumns／replaceBlocksKeepColumns", () => {
  it("K1：移掉欄內唯一的圖 → 列與兩欄都在、該欄補空段落；core 的 removeBlocks 則攤平（事實釘）", () => {
    const content = () => [P("x", "x"), row([[P("a", "a")], [IMG("img")]], "r"), P("z", "z")];
    const editor = mount(content());
    const removed = removeBlocksKeepColumns(editor, ["img"]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    expect(removed.map((b) => b.id)).toEqual(["img"]);
    expect(integrity(editor).valid).toBe(true);

    const core = mount(content());
    core.removeBlocks(["img"]);
    expect(shape(core)).toBe("paragraph:x  paragraph:a  paragraph:z");
  });

  it("K2：三欄移掉中間欄的唯一 block → 仍三欄、中間空", () => {
    const editor = mount([row([[P("a", "a")], [P("b", "b")], [P("c", "c")]], "r")]);
    removeBlocksKeepColumns(editor, ["b"]);
    expect(shape(editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph:c)]");
  });

  it("K3：取代欄內唯一 block → 新 block 在原欄；回傳 insertedBlocks／removedBlocks", () => {
    const editor = mount([row([[P("a", "a")], [P("b", "b")]], "r")]);
    const out = replaceBlocksKeepColumns(editor, ["b"], [P("n", "n")]);
    expect(shape(editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:n)]");
    expect((out.insertedBlocks[0]!.content as { text: string }[])[0]!.text).toBe("n");
    expect(out.removedBlocks[0]!.id).toBe("b");
  });

  it("K4（共編）：B 刪同列另一欄的圖、A 同時在第 1 欄打字 → 合併後兩邊都有 A 的字、列仍兩欄", async () => {
    const { a, b, sync } = await collabPair([P("x", "x"), row([[P("text", "t")], [IMG("img")]], "r"), P("z", "z")]);
    a.setTextCursorPosition("t", "end");
    const view = a.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("XYZ"));
    removeBlocksKeepColumns(b, ["img"]);
    await tick();
    sync();
    await tick();
    const expected = "paragraph:x  ROW[COL(paragraph:textXYZ) | COL(paragraph)]  paragraph:z";
    expect(shape(a)).toBe(expected);
    expect(shape(b)).toBe(expected);
    expect(allText(a)).toContain("XYZ");
    expect(allText(b)).toContain("XYZ");
  });
});
