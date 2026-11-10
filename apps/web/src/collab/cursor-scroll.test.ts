import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "./schema";
import { createCursorScroller, cursorHeadPosition } from "./cursor-scroll";

// 真編輯器＋真 Y.Doc（`collabEditor` 照 `undo.test.tsx`、掛載照 `code-block-caret.test.ts`）：
// 換算吃的是 ySync 的 binding.mapping，只在 view 掛上、Y 內容畫進 PM 之後才有，mock 量不到。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

function collabEditor(): { doc: Y.Doc; editor: AnyEditor } {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  ) as any as AnyEditor;
  return { doc, editor };
}

/** 以 `cursor-scroll.ts` 同一條路讀 ySync binding 的 mapping 大小。 */
function mappingSize(editor: AnyEditor): number {
  const plugin = editor.getExtension("ySync")?.prosemirrorPlugins?.[0];
  const state = plugin?.getState(editor.prosemirrorState) as { binding?: { mapping: Map<unknown, unknown> } | null } | undefined;
  return state?.binding?.mapping.size ?? 0;
}

function findXmlText(node: Y.XmlFragment | Y.XmlElement, text: string): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      if (child.toString() === text) return child;
    } else if (child instanceof Y.XmlElement) {
      const hit = findXmlText(child, text);
      if (hit) return hit;
    }
  }
  return null;
}

const rel = (text: Y.XmlText, index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));

const THREE = [
  { type: "paragraph", content: "第一段" },
  { type: "paragraph", content: "第二段落文字" },
  { type: "paragraph", content: "第三段" },
];

describe("cursor-scroll：遠端游標換算與捲動（#293）", () => {
  let editor: AnyEditor;
  let doc: Y.Doc;
  let div: HTMLDivElement;

  async function mountWithThree(): Promise<Y.XmlText> {
    ({ doc, editor } = collabEditor());
    div = document.createElement("div");
    document.body.appendChild(div);
    editor.mount(div);
    editor.replaceBlocks(editor.document, THREE as never);
    await waitFor(() => expect(mappingSize(editor)).toBeGreaterThan(0));
    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字");
    expect(text).not.toBeNull();
    return text!;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    editor?.unmount();
    div?.remove();
    editor = undefined as never;
    div = undefined as never;
  });

  it("CS1：head 換算成本機 PM 位置", async () => {
    const text = await mountWithThree();
    const pos = cursorHeadPosition(editor, { anchor: rel(text, 0), head: rel(text, 2) });
    expect(pos).not.toBeNull();
    // Y 端 index 2＝「第二」之後；PM 端另以走訪定位同一點對照。
    let textStart = -1;
    editor.prosemirrorState.doc.descendants((node, at) => {
      if (node.isText && node.text === "第二段落文字") textStart = at;
    });
    expect(pos).toBe(textStart + 2);
    expect(editor.prosemirrorState.doc.textBetween(pos!, pos! + 2)).toBe("段落");
  });

  it("CS2：位置所在的段落被刪 → 不丟錯，回 null 或落在文件範圍內", async () => {
    const text = await mountWithThree();
    const cursor = { anchor: rel(text, 0), head: rel(text, 2) };
    editor.removeBlocks([editor.document[1]!]);
    let pos: number | null = -1;
    expect(() => {
      pos = cursorHeadPosition(editor, cursor);
    }).not.toThrow();
    if (pos !== null) {
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(editor.prosemirrorState.doc.content.size);
    }
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ['"x"', "x"],
    ["{}", {}],
    ["{ head: null }", { head: null }],
    ['{ head: "x" }', { head: "x" }],
    ['{ head: { type: 1, item: "bad" } }', { head: { type: 1, item: "bad" } }],
  ])("CS3：垃圾值 %s → null、不丟錯", async (_label, cursor) => {
    await mountWithThree();
    let pos: number | null = -1;
    expect(() => {
      pos = cursorHeadPosition(editor, cursor);
    }).not.toThrow();
    expect(pos).toBeNull();
  });

  it("CS4：未掛載的 editor → 換算回 null、scroller 回 false，皆不丟錯", () => {
    const made = collabEditor();
    const other = new Y.Doc();
    const t = other.getXmlFragment(YDOC_FRAGMENT);
    const xml = new Y.XmlText("abc");
    t.insert(0, [xml]);
    const cursor = { anchor: rel(xml, 0), head: rel(xml, 1) };
    const root = document.createElement("div");
    root.scrollTo = vi.fn();
    let pos: number | null = -1;
    let scrolled: boolean | null = null;
    expect(() => {
      pos = cursorHeadPosition(made.editor, cursor);
      scrolled = createCursorScroller({ editor: made.editor, getRoot: () => root })(cursor);
    }).not.toThrow();
    expect(pos).toBeNull();
    expect(scrolled).toBe(false);
    expect(root.scrollTo).not.toHaveBeenCalled();
  });

  it("CS4b：掛過又卸載的 editor（ySync state 還在、view 不在）→ scroller 回 false、不丟錯", async () => {
    const text = await mountWithThree();
    const cursor = { anchor: rel(text, 0), head: rel(text, 2) };
    const unmounted = editor;
    unmounted.unmount();
    editor = undefined as never; // afterEach 不再 unmount 一次
    const root = document.createElement("div");
    root.scrollTo = vi.fn();
    let scrolled: boolean | null = null;
    expect(() => {
      scrolled = createCursorScroller({ editor: unmounted, getRoot: () => root })(cursor);
    }).not.toThrow();
    expect(scrolled).toBe(false);
    expect(root.scrollTo).not.toHaveBeenCalled();
  });

  describe("CS5／CS6：捲動", () => {
    function makeRoot(scrollTop: number): HTMLDivElement & { scrollTo: ReturnType<typeof vi.fn> } {
      const root = document.createElement("div") as HTMLDivElement & { scrollTo: ReturnType<typeof vi.fn> };
      Object.defineProperty(root, "clientHeight", { value: 300 });
      root.scrollTop = scrollTop;
      vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 50, 400, 300));
      root.scrollTo = vi.fn();
      document.body.appendChild(root);
      return root;
    }

    it("CS5：該行捲到容器高度 1/3 處、smooth；不動選取、不搶焦點", async () => {
      const text = await mountWithThree();
      const cursor = { anchor: rel(text, 0), head: rel(text, 2) };
      const expectedPos = cursorHeadPosition(editor, cursor);
      expect(expectedPos).not.toBeNull();
      const root = makeRoot(100);
      const coordsAtPos = vi
        .spyOn(editor.prosemirrorView!, "coordsAtPos")
        .mockReturnValue({ top: 450, bottom: 470, left: 0, right: 0 });

      editor.setTextCursorPosition(editor.document[2]!, "end");
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();
      const before = editor.prosemirrorState.selection;
      expect(document.activeElement).toBe(button);

      expect(createCursorScroller({ editor, getRoot: () => root })(cursor)).toBe(true);
      expect(root.scrollTo).toHaveBeenCalledTimes(1);
      expect(root.scrollTo.mock.calls[0]![0]).toEqual({ top: 400, behavior: "smooth" });
      expect(coordsAtPos).toHaveBeenCalledWith(expectedPos);
      expect(editor.prosemirrorState.selection.eq(before)).toBe(true);
      expect(document.activeElement).toBe(button);
      button.remove();
      root.remove();
    });

    it("CS5：算出負數時夾到 0", async () => {
      const text = await mountWithThree();
      const root = makeRoot(0);
      vi.spyOn(editor.prosemirrorView!, "coordsAtPos").mockReturnValue({ top: 60, bottom: 80, left: 0, right: 0 });
      // 0 + (60 − 50) − 100 = −90
      expect(createCursorScroller({ editor, getRoot: () => root })({ anchor: rel(text, 0), head: rel(text, 2) })).toBe(true);
      expect(root.scrollTo.mock.calls[0]![0]).toEqual({ top: 0, behavior: "smooth" });
      root.remove();
    });

    it("CS6：getRoot 回 null → false、不捲", async () => {
      const text = await mountWithThree();
      const root = makeRoot(100);
      const coordsAtPos = vi.spyOn(editor.prosemirrorView!, "coordsAtPos");
      expect(createCursorScroller({ editor, getRoot: () => null })({ anchor: rel(text, 0), head: rel(text, 2) })).toBe(false);
      expect(root.scrollTo).not.toHaveBeenCalled();
      expect(coordsAtPos).not.toHaveBeenCalled();
      root.remove();
    });
  });
});
