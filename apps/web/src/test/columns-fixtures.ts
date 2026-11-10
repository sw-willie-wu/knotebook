import * as Y from "yjs";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment, withCollaboration } from "@blocknote/core/yjs";
import { COLUMN_LIST_TYPE, COLUMN_TYPE, YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";

/**
 * 並排排版的 web 測試共用工具。`shape`／`cursorOf`／`integrity`
 * 的格式固定，期望值可以直接從 `shape()` 等函式的輸出抄。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
export type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
export type PartialBlockLike = PartialBlock<any, any, any>;

const inline = (text: string) => (text ? [{ type: "text" as const, text, styles: {} }] : []);
const withId = (id: string | undefined) => (id === undefined ? {} : { id });

export const P = (text: string, id?: string): PartialBlockLike => ({ ...withId(id), type: "paragraph", content: inline(text) });
export const H = (text: string, id: string): PartialBlockLike => ({ id, type: "heading", props: { level: 1 }, content: inline(text) });
export const IMG = (id: string, previewWidth?: number): PartialBlockLike => ({
  id,
  type: "image",
  props: { url: `/api/uploads/x${id}`, name: id, ...(previewWidth ? { previewWidth } : {}) },
});
export const CB = (id: string, text?: string): PartialBlockLike => ({ id, type: "codeBlock", content: inline(text ?? "") });
export const withChildren = (b: PartialBlockLike, children: PartialBlockLike[]): PartialBlockLike => ({ ...b, children });

/** 一列；給 `id` 時欄 id＝`${id}c${i}`，不給則列與欄都不帶 id（交給 UniqueID）。`widths` 缺項為 1。 */
export const row = (cols: PartialBlockLike[][], id?: string, widths?: number[]): PartialBlockLike => ({
  ...withId(id),
  type: COLUMN_LIST_TYPE,
  children: cols.map((children, i) => ({
    ...withId(id === undefined ? undefined : `${id}c${i}`),
    type: COLUMN_TYPE,
    props: { width: widths?.[i] ?? 1 },
    children,
  })),
});

type BlockLike = { type: string; content?: unknown; children?: BlockLike[] };
function shapeOf(b: BlockLike): string {
  if (b.type === COLUMN_LIST_TYPE) return `ROW[${(b.children ?? []).map(shapeOf).join(" | ")}]`;
  if (b.type === COLUMN_TYPE) return `COL(${(b.children ?? []).map(shapeOf).join(",")})`;
  const text = Array.isArray(b.content) && b.content.length ? ":" + b.content.map((c: { text?: string }) => c.text).join("") : "";
  const kids = b.children && b.children.length ? "{" + b.children.map(shapeOf).join(",") + "}" : "";
  return `${b.type}${text}${kids}`;
}

/** `paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z`。 */
export function shape(editor: AnyEditor): string {
  return (editor.document as BlockLike[]).map(shapeOf).join("  ");
}

/** `${游標所在 block 的文字 || 型別}@${parentOffset}`。 */
export function cursorOf(editor: AnyEditor): string {
  const $from = editor.prosemirrorView!.state.selection.$from;
  const block = editor.getTextCursorPosition().block as BlockLike;
  const text = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text).join("") : "";
  return `${text || block.type}@${$from.parentOffset}`;
}

/** 真 keydown（不用 `commands.keyboardShortcut()`）；回傳是否有 handler 接手。 */
export function pressKey(
  editor: AnyEditor,
  key: string,
  mods?: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; altKey?: boolean },
): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  return !!view.someProp("handleKeyDown", (f) => f(view, event));
}

/** 文字節點恰為 `word` 的那段（最後一個符合者）內第 `offset` 字的位置。 */
export function textPos(editor: AnyEditor, word: string, offset: number): number {
  let pos: number | undefined;
  editor.prosemirrorView!.state.doc.descendants((node, p) => {
    if (node.isText && node.text === word) pos = p + offset;
  });
  if (pos === undefined) throw new Error(`textPos: 找不到文字節點「${word}」`);
  return pos;
}

const BN_BLOCK_NODES = new Set(["blockContainer", COLUMN_TYPE, COLUMN_LIST_TYPE]);

/** `doc.check()`、bnBlock id 重複／缺、深度 > 1 的 columnList。 */
export function integrity(editor: AnyEditor): { dupIds: number; nullIds: number; nestedRows: number; valid: boolean } {
  const doc = editor.prosemirrorView!.state.doc;
  const seen = new Set<string>();
  let dupIds = 0;
  let nullIds = 0;
  let nestedRows = 0;
  doc.descendants((node, pos) => {
    if (BN_BLOCK_NODES.has(node.type.name)) {
      const id = node.attrs.id as string | null | undefined;
      if (!id) nullIds += 1;
      else if (seen.has(id)) dupIds += 1;
      else seen.add(id);
    }
    if (node.type.name === COLUMN_LIST_TYPE && doc.resolve(pos).depth > 1) nestedRows += 1;
  });
  let valid = true;
  try {
    doc.check();
  } catch {
    valid = false;
  }
  return { dupIds, nullIds, nestedRows, valid };
}

/**
 * 以 `noteSchema` 建編輯器並掛到 `document.body` 下的容器。`extensions` 給函式時會拿到 `editorRef`，
 * 編輯器建好、mount 之前 `editorRef.current` 就已設好。`collab: true`：自己的 Y.Doc、awareness undefined
 * （同 `collab/undo.test.tsx`），內容先寫進 fragment 再 mount，所以初始內容不在撤銷堆疊裡。
 */
export function mountEditor(
  content: PartialBlockLike[],
  opts?: { extensions?: unknown[] | ((editorRef: EditorRef) => unknown[]); collab?: boolean },
): { editor: AnyEditor; container: HTMLElement; editorRef: EditorRef; destroy(): void } {
  const editorRef: EditorRef = { current: null };
  const extensions = typeof opts?.extensions === "function" ? opts.extensions(editorRef) : (opts?.extensions ?? []);
  const tiptap = { _tiptapOptions: { extensions } };
  let doc: Y.Doc | undefined;
  let editor: AnyEditor;
  if (opts?.collab) {
    doc = new Y.Doc();
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const seed = BlockNoteEditor.create({ schema: noteSchema, initialContent: content }) as AnyEditor;
    blocksToYXmlFragment(seed, seed.document, fragment);
    editor = BlockNoteEditor.create(
      withCollaboration({
        schema: noteSchema,
        collaboration: {
          provider: { awareness: undefined },
          fragment,
          user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
        },
        ...tiptap,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    ) as any as AnyEditor;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `_tiptapOptions.extensions` 的元素型別是 tiptap 的 Extension
    editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content, ...(tiptap as any) }) as AnyEditor;
  }
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return {
    editor,
    container,
    editorRef,
    destroy() {
      editor.unmount();
      container.remove();
      doc?.destroy();
    },
  };
}
