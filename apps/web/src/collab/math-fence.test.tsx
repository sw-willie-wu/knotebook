import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "./undo";
import { noteSchema } from "./schema";
import { createMathFenceExtension } from "./math-fence";
import { createMermaidFenceExtension } from "./mermaid-fence";
import { consumeMathEdit, peekMathEdit } from "@/components/math/auto-edit";
import { ThemeProvider } from "@/theme";
import { NoteEditorView } from "@/components/NoteEditor";
import { attachTestElementRenderer } from "@/test/element-renderer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror view types can't be imported (see markdown-link.rule.test.tsx)
type AnyView = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;

const editors: AnyEditor[] = [];

function mount(doc: Y.Doc, withExtension = true, mountDom = true): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "#123456" },
      },
      // Both extensions, as in the app: the diagram one must not interfere with the formula one.
      _tiptapOptions: { extensions: withExtension ? [createMermaidFenceExtension(), createMathFenceExtension()] : [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    } as any),
  ) as AnyEditor;
  editors.push(editor);
  if (!mountDom) return editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor);
  return editor;
}

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, a: number, b: number, c: string) => boolean | void) => f(view, from, to, ch));
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}
const typeString = (view: AnyView, s: string) => [...s].forEach((ch) => typeChar(view, ch));
const pressEnter = (view: AnyView) =>
  view.someProp("handleKeyDown", (f: (v: AnyView, e: KeyboardEvent) => boolean | void) => f(view, new KeyboardEvent("keydown", { key: "Enter" })));

const types = (editor: AnyEditor) => editor.document.map((b: { type: string }) => b.type);
const textOf = (b: { content?: unknown }) => (Array.isArray(b.content) ? b.content.map((n: { text?: string }) => n.text ?? "").join("") : "");

function noteWith(block: Record<string, unknown>): { editor: AnyEditor; doc: Y.Doc; view: AnyView } {
  const doc = new Y.Doc();
  const editor = mount(doc);
  editor.replaceBlocks(editor.document, [block as never]);
  editor.setTextCursorPosition(editor.document[0]!, "end");
  return { editor, doc, view: editor.prosemirrorView };
}
const emptyNote = () => noteWith({ type: "paragraph" });

afterEach(() => {
  for (const editor of editors.splice(0)) {
    try {
      editor.unmount();
    } catch {
      // never mounted
    }
  }
  document.body.innerHTML = "";
});

describe("typed math fence", () => {
  it("```math + Enter becomes a math block", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```math");
    pressEnter(view);
    expect(editor.document[0]!.type).toBe("math");
    expect(editor.document[0]!.props).toMatchObject({ tex: "" });
    expect(editor.document.filter((b: { type: string }) => b.type === "codeBlock")).toHaveLength(0);
  });

  it("```math + space becomes a math block", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```math ");
    expect(editor.document[0]!.type).toBe("math");
  });

  it("puts the caret in a new paragraph after the formula, so typing does not replace it", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```math ");
    typeString(view, "abc");
    expect(types(editor)).toEqual(["math", "paragraph"]);
    expect(textOf(editor.document[1]!)).toBe("abc");
  });

  it("does not turn a mermaid fence into a formula, nor a math fence into a diagram", () => {
    const a = emptyNote();
    typeString(a.view, "```mermaid ");
    expect(types(a.editor)[0]).toBe("mermaid");
    const b = emptyNote();
    typeString(b.view, "```math ");
    expect(types(b.editor)[0]).toBe("math");
  });

  it.each(["latex", "tex", "python", "Math", "mathematica", "maths", "katex"])("```%s stays a code block", (language) => {
    const { editor, view } = emptyNote();
    typeString(view, "```" + language + " ");
    expect(editor.document[0]!.type).toBe("codeBlock");
    expect(editor.document.some((b: { type: string }) => b.type === "math")).toBe(false);
  });

  it("a code block switched to math afterwards (language menu path) is left alone", () => {
    const { editor, view } = emptyNote();
    typeString(view, "```js ");
    editor.updateBlock(editor.document[0]!, { props: { language: "math" } });
    typeString(view, "x");
    expect(editor.document[0]!.type).toBe("codeBlock");
  });

  it("a codeBlock(math) created by a peer is not converted", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = mount(docA);
    const b = mount(docB, false);
    b.replaceBlocks(b.document, [{ type: "codeBlock", props: { language: "math" } }]);
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
    expect(a.document.some((x: { type: string }) => x.type === "codeBlock")).toBe(true);
    expect(a.document.some((x: { type: string }) => x.type === "math")).toBe(false);
  });

  it("a peer turning the block under the local caret into an empty math code block is not converted", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = mount(docA);
    a.replaceBlocks(a.document, [{ type: "paragraph" }]);
    const b = mount(docB, false);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    a.setTextCursorPosition(a.document[0]!, "start");
    const view = a.prosemirrorView;
    view.dispatch(view.state.tr.insertText("```math "));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    b.updateBlock(b.document[0]!, { type: "codeBlock", props: { language: "math" }, content: [] });
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
    expect(a.document[0]!.type).toBe("codeBlock");
  });

  it("an existing codeBlock(math) is not converted by typing in it", () => {
    const { editor, view } = noteWith({ type: "codeBlock", props: { language: "math" }, content: "x" });
    typeString(view, "y");
    expect(editor.document[0]!.type).toBe("codeBlock");
  });

  it("with typing and conversion in separate undo steps, one undo restores the typed fence text", () => {
    const { editor, view } = emptyNote();
    const manager = collabUndoManager(editor)!;
    manager.stopCapturing();
    typeString(view, "```math");
    manager.stopCapturing();
    pressEnter(view);
    expect(editor.document[0]!.type).toBe("math");
    manager.undo();
    expect(types(editor)).toEqual(["paragraph"]);
    expect(textOf(editor.document[0]!)).toBe("```math");
  });

  it("keeps nested children and puts the caret in the first one", () => {
    const { editor, view } = noteWith({ type: "paragraph", children: [{ type: "paragraph", content: "child" }] });
    typeString(view, "```math ");
    expect(types(editor)).toEqual(["math"]);
    expect(editor.document[0]!.children.map((x: { content?: unknown }) => textOf(x))).toEqual(["child"]);
    typeString(view, "x");
    expect(textOf(editor.document[0]!.children[0]!)).toBe("xchild");
  });

  describe("request to open the source editor", () => {
    const requested = (editor: AnyEditor) => editor.document.filter((b: { type: string }) => b.type === "math").some((b: { id: string }) => peekMathEdit(b.id));
    const clear = (editor: AnyEditor) => editor.document.forEach((b: { id: string }) => consumeMathEdit(b.id));

    it("is made for the block the typed fence created", () => {
      const { editor, view } = emptyNote();
      typeString(view, "```math");
      pressEnter(view);
      expect(requested(editor)).toBe(true);
      clear(editor);
    });

    it("is not made for a formula that arrives from a peer", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const a = mount(docA);
      const b = mount(docB, false);
      b.replaceBlocks(b.document, [{ type: "math", props: { tex: "E=mc^2" } }]);
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), "remote");
      expect(a.document.some((x: { type: string }) => x.type === "math")).toBe(true);
      expect(requested(a)).toBe(false);
    });

    it("is not made by /math style insertion", () => {
      const { editor } = emptyNote();
      editor.replaceBlocks(editor.document, [{ type: "math", props: { tex: "" } }]);
      expect(requested(editor)).toBe(false);
    });
  });
});

describe("typed math fence in a later block", () => {
  it("the edit request goes to the new block, not to the first block of the note", () => {
    const { editor, view } = noteWith({ type: "paragraph", content: "first" });
    editor.insertBlocks([{ type: "paragraph" }], editor.document[0]!, "after");
    editor.setTextCursorPosition(editor.document[1]!, "end");
    const firstId = editor.document[0]!.id;
    const secondId = editor.document[1]!.id;
    typeString(view, "```math");
    pressEnter(view);
    expect(editor.document.map((b: { type: string }) => b.type).slice(0, 2)).toEqual(["paragraph", "math"]);
    expect(peekMathEdit(firstId)).toBe(false);
    expect(peekMathEdit(secondId)).toBe(true);
    consumeMathEdit(secondId);
  });
});

describe("MathBlock opens its source editor", () => {
  const getItems = async () => [];
  function mountView(strict: boolean): AnyEditor {
    const editor = mount(new Y.Doc(), true, false);
    const tree = (
      <ThemeProvider>
        <NoteEditorView editor={editor} editable theme="light" noteId="n1" getItems={getItems} getSlashItems={getItems} />
      </ThemeProvider>
    );
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    return editor;
  }

  const triggers: Array<[string, (view: AnyView) => void]> = [
    [
      "```math + Enter",
      (view) => {
        typeString(view, "```math");
        pressEnter(view);
      },
    ],
    ["```math + space", (view) => typeString(view, "```math ")],
  ];

  for (const [name, trigger] of triggers) for (const strict of [false, true]) {
    it(`focuses the textarea after ${name}${strict ? " (StrictMode)" : ""}, and Esc commits and hands focus back to the note`, async () => {
      const editor = mountView(strict);
      act(() => {
        editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
        editor.setTextCursorPosition(editor.document[0]!, "start");
      });
      const view = editor.prosemirrorView;
      act(() => trigger(view));
      await waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
      const area = document.querySelector("textarea")!;
      expect(document.activeElement).toBe(area);
      fireEvent.change(area, { target: { value: "E=mc^2" } });
      fireEvent.keyDown(area, { key: "Escape" });
      expect(editor.document[0]!.props).toMatchObject({ tex: "E=mc^2" });
      expect(document.querySelector("textarea")).toBeNull();
      expect(view.dom.contains(document.activeElement)).toBe(true);
    });
  }

  it("after the auto-opened editor closes by blur, a later manual open does not hand focus back on Esc", async () => {
    const editor = mountView(false);
    act(() => {
      editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
      editor.setTextCursorPosition(editor.document[0]!, "start");
    });
    const view = editor.prosemirrorView;
    act(() => typeString(view, "```math "));
    await waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
    fireEvent.blur(document.querySelector("textarea")!);
    expect(document.querySelector("textarea")).toBeNull();
    fireEvent.click(document.querySelector("button[aria-label]")!);
    const area = await waitFor(() => {
      const found = document.querySelector("textarea");
      expect(found).not.toBeNull();
      return found!;
    });
    area.focus();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(view.dom.contains(document.activeElement)).toBe(false);
  });

  it("a formula that is already there (inserted, pasted or imported) does not open", () => {
    const editor = mountView(false);
    act(() => {
      editor.replaceBlocks(editor.document, [{ type: "math", props: { tex: "E=mc^2" } }]);
    });
    expect(document.querySelector("textarea")).toBeNull();
  });
});
