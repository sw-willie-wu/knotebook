import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "./undo";
import { noteSchema } from "./schema";
import { handleHashTagInput, HASH_TAG_LINE_RE, HASH_TAG_RE, parseHashTagLine, type HashTagHooks, type HashTagHooksRef } from "./hash-tag-input";
import { attachTestElementRenderer } from "@/test/element-renderer";
import { P, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests only touch a few fields of the PM view
type AnyView = any;

const editors: AnyEditor[] = [];

interface Harness {
  editor: AnyEditor;
  doc: Y.Doc;
  hooks: HashTagHooksRef;
  applied: Array<{ names: string[]; restore: () => boolean }>;
  view: AnyView;
}

function mount(opts: { blocks?: PartialBlockLike[]; withHooks?: boolean; doc?: Y.Doc } = {}): Harness {
  const doc = opts.doc ?? new Y.Doc();
  const hooks: HashTagHooksRef = { current: null };
  const applied: Harness["applied"] = [];
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: "u", name: "U", color: "#123456" } },
      _tiptapOptions: {
        editorProps: { handleTextInput: (view: AnyView, from: number, to: number, text: string) => handleHashTagInput(view, from, to, text, hooks) },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  editors.push(editor);
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor);
  if (opts.blocks) editor.replaceBlocks(editor.document, opts.blocks as never);
  if (opts.withHooks !== false) {
    const live: HashTagHooks = {
      applyHash: (input) => void applied.push(input),
      currentTagNames: () => [],
      undoBoundary: () => collabUndoManager(editor)?.stopCapturing(),
      notify: () => undefined,
      active: () => (editor.prosemirrorView ? { editor, view: editor.prosemirrorView } : null),
    };
    hooks.current = live;
  }
  return { editor, doc, hooks, applied, view: editor.prosemirrorView };
}

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, a: number, b: number, c: string) => boolean | void) => f(view, from, to, ch));
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}
const typeString = (view: AnyView, s: string) => [...s].forEach((ch) => typeChar(view, ch));

function textOf(editor: AnyEditor, index = 0): string {
  const content = editor.document[index]?.content;
  return Array.isArray(content) ? content.map((n: { text?: string }) => n.text ?? "").join("") : "";
}

function caretInFirst(editor: AnyEditor): void {
  editor.setTextCursorPosition(editor.document[0]!, "end");
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    try {
      editor.unmount();
    } catch {
      // never mounted
    }
  }
});

describe("tag name patterns", () => {
  it("HASH_TAG_RE takes one name starting with a half- or full-width hash and allows a hash inside it", () => {
    expect(HASH_TAG_RE.exec("#alpha")?.[1]).toBe("alpha");
    expect(HASH_TAG_RE.exec("＃會議")?.[1]).toBe("會議");
    expect(HASH_TAG_RE.exec("#C#")?.[1]).toBe("C#");
    for (const bad of ["#", "##a", "＃＃a", "# a", "#a b", "a#b", "#a　b"]) expect(HASH_TAG_RE.test(bad), bad).toBe(false);
  });

  it("parseHashTagLine reads a whole line of names split by half- or full-width spaces", () => {
    expect(parseHashTagLine("#a   #b")).toEqual(["a", "b"]);
    expect(parseHashTagLine("＃甲　＃乙")).toEqual(["甲", "乙"]);
    expect(parseHashTagLine("  #a  ")).toEqual(["a"]);
  });

  it("parseHashTagLine rejects a line with any word that is not a name, or any invalid name", () => {
    expect(parseHashTagLine("#a b")).toBeNull();
    expect(parseHashTagLine("#a #")).toBeNull();
    expect(parseHashTagLine("# a")).toBeNull();
    expect(parseHashTagLine(`#${"x".repeat(41)}`)).toBeNull();
    expect(parseHashTagLine("#a\u0001b")).toBeNull();
    expect(HASH_TAG_LINE_RE.test("")).toBe(false);
  });
});

describe("typing #name and a space in the first paragraph", () => {
  it("calls applyHash with the name, empties the paragraph and inserts no space", () => {
    const h = mount();
    typeString(h.view, "#alpha ");
    expect(h.applied.map((a) => a.names)).toEqual([["alpha"]]);
    expect(textOf(h.editor)).toBe("");
  });

  it("handles the full-width mark followed by an ideographic space", () => {
    const h = mount();
    typeString(h.view, "＃會議　");
    expect(h.applied.map((a) => a.names)).toEqual([["會議"]]);
    expect(textOf(h.editor)).toBe("");
  });

  it("lets the next name be typed right away", () => {
    const h = mount();
    typeString(h.view, "#a ");
    typeString(h.view, "#b ");
    expect(h.applied.map((a) => a.names)).toEqual([["a"], ["b"]]);
    expect(textOf(h.editor)).toBe("");
  });

  it("adds the tag 'C#' for #C# and a space", () => {
    const h = mount();
    typeString(h.view, "#C# ");
    expect(h.applied.map((a) => a.names)).toEqual([["C#"]]);
  });

  it("leaves # followed by a space to the heading shortcut", () => {
    for (const space of [" ", "　"]) {
      const h = mount();
      typeString(h.view, `#${space}`);
      expect(h.applied, JSON.stringify(space)).toEqual([]);
    }
    const h = mount();
    typeString(h.view, "# ");
    expect(h.editor.document[0]!.type).toBe("heading");
  });

  it("does not trigger for ##name or ###name", () => {
    for (const text of ["##name ", "###name "]) {
      const h = mount();
      typeString(h.view, text);
      expect(h.applied, text).toEqual([]);
      expect(textOf(h.editor), text).toBe(text);
    }
  });

  it("does not trigger when other text follows the name or the caret is not at the end", () => {
    const h = mount({ blocks: [P("#name more")] });
    caretInFirst(h.editor);
    typeChar(h.view, " ");
    expect(h.applied).toEqual([]);

    const mid = mount({ blocks: [P("#name tail")] });
    const view = mid.view;
    mid.editor.setTextCursorPosition(mid.editor.document[0]!, "start");
    const start = view.state.selection.from;
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(start + 5))));
    typeChar(view, " ");
    expect(mid.applied).toEqual([]);
  });

  it("triggers on the resulting text when one input replaces a range (IME end, autocorrect)", () => {
    const h = mount({ blocks: [P("#al")] });
    caretInFirst(h.editor);
    const view = h.view;
    const to = view.state.selection.to;
    const from = to - 2;
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, from, to)));
    const handled = view.someProp("handleTextInput", (f: (v: AnyView, a: number, b: number, c: string) => boolean) => f(view, from, to, "alpha "));
    expect(handled).toBe(true);
    expect(h.applied.map((a) => a.names)).toEqual([["alpha"]]);
    expect(textOf(h.editor)).toBe("");
  });

  it("does not trigger in a second paragraph, a heading, a list item or a column", () => {
    const cases: PartialBlockLike[][] = [
      [P(""), P("")],
      [{ type: "heading", props: { level: 2 }, content: [] }],
      [{ type: "bulletListItem", content: [] }],
      [row([[P("")], [P("")]])],
    ];
    for (const blocks of cases) {
      const h = mount({ blocks });
      const target = blocks.length === 2 ? h.editor.document[1]! : h.editor.document[0]!;
      if (blocks[0]!.type === "columnList") {
        const inner = (h.editor.document[0] as { children: Array<{ children: unknown[] }> }).children[0]!.children[0];
        h.editor.setTextCursorPosition(inner as never, "end");
      } else {
        h.editor.setTextCursorPosition(target, "end");
      }
      typeString(h.view, "#name ");
      expect(h.applied, shape(h.editor)).toEqual([]);
    }
  });

  it("does not trigger for a nested child of the first block", () => {
    const h = mount({ blocks: [{ type: "paragraph", content: [], children: [P("")] }] });
    const child = (h.editor.document[0] as { children: unknown[] }).children[0];
    h.editor.setTextCursorPosition(child as never, "end");
    typeString(h.view, "#name ");
    expect(h.applied).toEqual([]);
  });

  it("does not trigger for a name of 41 characters or one with a control character", () => {
    const long = mount();
    typeString(long.view, `#${"x".repeat(41)} `);
    expect(long.applied).toEqual([]);
    expect(textOf(long.editor)).toBe(`#${"x".repeat(41)} `);

    const ctl = mount();
    typeChar(ctl.view, "#");
    typeChar(ctl.view, "a");
    ctl.view.dispatch(ctl.view.state.tr.insertText("\u0001"));
    typeChar(ctl.view, " ");
    expect(ctl.applied).toEqual([]);
  });

  it("does nothing without hooks (no right to change tags)", () => {
    const h = mount({ withHooks: false });
    typeString(h.view, "#name ");
    expect(h.applied).toEqual([]);
    expect(textOf(h.editor)).toBe("#name ");
  });

  it("does not trigger while composing", () => {
    const h = mount();
    typeString(h.view, "#name");
    Object.defineProperty(h.view, "composing", { configurable: true, get: () => true });
    typeChar(h.view, " ");
    expect(h.applied).toEqual([]);
    expect(textOf(h.editor)).toBe("#name ");
  });

  it("does not trigger when part of the name is bold or inline code", () => {
    for (const style of ["bold", "code"]) {
      const h = mount({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "#na", styles: {} }, { type: "text", text: "me", styles: { [style]: true } }] }] });
      caretInFirst(h.editor);
      typeChar(h.view, " ");
      expect(h.applied, style).toEqual([]);
    }
  });

  it("does not trigger when a style is armed for the next character", () => {
    const h = mount();
    typeString(h.view, "#name");
    h.editor.toggleStyles({ bold: true });
    typeChar(h.view, " ");
    expect(h.applied).toEqual([]);
  });
});

describe("undo and restore", () => {
  it("Ctrl+Z after the trigger brings back only the #name text and keeps text typed just before", () => {
    const h = mount({ blocks: [P(""), P("")] });
    h.editor.setTextCursorPosition(h.editor.document[1]!, "end");
    typeString(h.view, "abc");
    h.editor.setTextCursorPosition(h.editor.document[0]!, "end");
    typeString(h.view, "#name ");
    expect(textOf(h.editor, 0)).toBe("");
    h.editor.undo();
    expect(textOf(h.editor, 0)).toBe("#name");
    expect(textOf(h.editor, 1)).toBe("abc");
  });

  it("restore puts #name back into the still-empty first paragraph", () => {
    const h = mount();
    typeString(h.view, "#name ");
    expect(h.applied[0]!.restore()).toBe(true);
    expect(textOf(h.editor)).toBe("#name");
    expect(h.editor.document).toHaveLength(1);
  });

  it("restore adds a new first paragraph when the first one has text by now", () => {
    const h = mount();
    typeString(h.view, "#name ");
    typeString(h.view, "later");
    expect(h.applied[0]!.restore()).toBe(true);
    expect(shape(h.editor)).toBe("paragraph:#name  paragraph:later");
  });

  it("restore does not duplicate the text when Ctrl+Z already brought it back", () => {
    const h = mount();
    typeString(h.view, "#todo ");
    h.editor.undo();
    expect(textOf(h.editor)).toBe("#todo");
    expect(h.applied[0]!.restore()).toBe(true);
    expect(h.editor.document.map((_: unknown, i: number) => textOf(h.editor, i))).toEqual(["#todo"]);
  });

  it("restore does not duplicate the text when Ctrl+Z ran before a failed request answered", () => {
    const h = mount({ blocks: [P("")] });
    typeString(h.view, "#todo ");
    const input = h.applied[0]!;
    h.editor.undo();
    // a later failure path calls restore once more, after the undo
    expect(input.restore()).toBe(true);
    expect(input.restore()).toBe(true);
    expect(h.editor.document.map((_: unknown, i: number) => textOf(h.editor, i))).toEqual(["#todo"]);
  });

  it("restore still adds a paragraph in front when the first line only starts with the same text", () => {
    const h = mount();
    typeString(h.view, "#todo ");
    typeString(h.view, "#todomore");
    expect(h.applied[0]!.restore()).toBe(true);
    expect(shape(h.editor)).toBe("paragraph:#todo  paragraph:#todomore");
  });

  it("restore returns false and changes nothing when the editor was replaced or destroyed", () => {
    const h = mount();
    typeString(h.view, "#name ");
    const original = h.hooks.current!;
    h.hooks.current = { ...original, active: () => ({ editor: {}, view: h.view }) };
    expect(h.applied[0]!.restore()).toBe(false);
    h.hooks.current = { ...original, active: () => ({ editor: h.editor, view: { isDestroyed: true } }) };
    expect(h.applied[0]!.restore()).toBe(false);
    h.hooks.current = { ...original, active: () => null };
    expect(h.applied[0]!.restore()).toBe(false);
    expect(textOf(h.editor)).toBe("");
  });

  it("cuts the undo stack before and after the deletion", () => {
    const boundary = vi.fn();
    const h = mount();
    h.hooks.current = { ...h.hooks.current!, undoBoundary: boundary };
    typeString(h.view, "#name ");
    expect(boundary).toHaveBeenCalledTimes(2);
  });
});

describe("collaboration", () => {
  function sync(a: Y.Doc, b: Y.Doc): void {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  }

  it("keeps text a collaborator typed into the same paragraph while the trigger ran", () => {
    const a = mount();
    typeString(a.view, "#name");
    const b = mount({ doc: new Y.Doc() });
    sync(a.doc, b.doc);
    expect(textOf(b.editor)).toBe("#name");
    // the collaborator's edit has not reached A when A types the space
    b.editor.setTextCursorPosition(b.editor.document[0]!, "end");
    typeString(b.view, "Z");
    caretInFirst(a.editor);
    typeChar(a.view, " ");
    expect(a.applied.map((x) => x.names)).toEqual([["name"]]);
    sync(a.doc, b.doc);
    expect(textOf(a.editor)).toBe("Z");
    expect(textOf(b.editor)).toBe("Z");
  });

  it("never triggers for text that arrives from a collaborator", () => {
    const a = mount();
    const b = mount({ doc: new Y.Doc() });
    b.hooks.current = null;
    typeString(b.view, "#name ");
    sync(a.doc, b.doc);
    expect(a.applied).toEqual([]);
    expect(textOf(a.editor)).toBe("#name ");
  });
});
