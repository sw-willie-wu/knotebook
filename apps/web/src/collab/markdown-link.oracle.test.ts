import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";
import { createMarkdownLinkExtension } from "./markdown-link";
import type { EditorRef } from "@/components/wikilink/menu";

/**
 * oracle 比對測試（INV-1 的守衛）：比照 `paste.subset.test.ts` 拿 BlockNote 自己當
 * oracle 的既有招數——對同一組輸入，比對「逐字元打完的終態」與「`pasteMarkdown` 的
 * 終態」，整份文件相等。
 *
 * ⚠ **輸入集合明文枚舉，每一條各附一句「為什麼收／為什麼排除」，不用開放判準篩選**
 * （spec §8.2 的明文要求）。反例：`![a](…) [b](…)` 的尾端還原逐字相等（依「還原不回
 * 原字面就排除」這條開放判準會被留在集合內），但剖析器那側把 inline 圖片**整個靜默
 * 丟掉**、手打那側只換尾端 ⇒ 假紅。**判準只看尾端，終態卻由整段決定**——下面
 * `EXCLUDED` 那組就是這一族與 §9.2 title/scheme 家族的具名成員。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror EditorView，理由同 markdown-link.rule.test.tsx
type AnyView = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, f: number, t: number, c: string) => boolean | void) =>
    f(view, from, to, ch),
  );
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}

function typeString(view: AnyView, s: string): void {
  for (const ch of s) typeChar(view, ch);
}

function mountedEditor(): { editor: AnyEditor; container: HTMLElement } {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    _tiptapOptions: { extensions: [createMarkdownLinkExtension({ editorRef })] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNoteEditorOptions 的完整型別要求完整 schema 三元組
  } as any) as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

/** 逐字元打完 `input` 之後的第一個 block 的 `content`。 */
function typedContent(input: string): unknown {
  const { editor, container } = mountedEditor();
  try {
    typeString(editor._tiptapEditor.view, input);
    return editor.document[0]!.content;
  } finally {
    editor.unmount();
    container.remove();
  }
}

/** `pasteMarkdown(input)` 之後的第一個 block 的 `content`。 */
function pastedContent(input: string): unknown {
  const { editor, container } = mountedEditor();
  try {
    editor.pasteMarkdown(input);
    return editor.document[0]!.content;
  } finally {
    editor.unmount();
    container.remove();
  }
}

/** INV-1 適用集合：手打終態與貼上終態逐字相等。每條都附一句「為什麼收」。 */
const MATCHING: Array<[string, string]> = [
  ["基本案：純一個連結", "[a](https://x.com)"],
  ["href 含成對括號：剖析器兩側都完整保留括號", "[水星](https://zh.wikipedia.org/wiki/水星_(行星))"],
  ["連結前有一般文字前綴，前綴不含任何 markdown 顯著字元，兩側都原樣保留", "前面有字 [a](https://x.com)"],
  ["同一段落兩個連結，兩側都各自轉成獨立 link node（夾一段純文字）", "[a](https://x.com) 然後 [b](https://y.com)"],
  ["§9.1：網址內未跳脫的 )，兩側都在第一個 ) 收尾成短連結＋純文字殘留", "[a](https://x.com/foo)bar)"],
  ["相對路徑 href，兩側都原樣保留（不套用 safeMediaUrl 那套判準）", "[區域](/n/my-note)"],
  ["mailto scheme，兩側都放行（本規格刻意不收窄 scheme，見 spec D1）", "[寄信](mailto:me@example.com)"],
];

/**
 * 明知會不相等而**刻意排除**的成員（不進上面的相等斷言）。每條都附一句「為什麼排除」，
 * 且用一條「兩側確實不同」的斷言釘住排除理由不是憑空想像——避免這份清單本身跟著
 * 事實漂移卻沒有東西發現。
 */
describe("markdown-link oracle：INV-1 適用集合（整份文件終態相等）", () => {
  it.each(MATCHING)("%s：%s", (_reason, input) => {
    expect(typedContent(input)).toEqual(pastedContent(input));
  });
});

describe("markdown-link oracle：刻意排除的成員（兩側確實不同，理由如註解）", () => {
  it("![a](https://x.com/i.png) [b](https://y.com)：尾端還原逐字相等，但剖析器把 inline 圖片整個靜默丟掉、手打側只換尾端 ⇒ 前綴不同", () => {
    const typed = typedContent("![a](https://x.com/i.png) [b](https://y.com)");
    const pasted = pastedContent("![a](https://x.com/i.png) [b](https://y.com)");
    expect(typed).not.toEqual(pasted);
  });

  it('[a](https://x.com "標題")：貼上側 title 被剖析器丟棄但仍轉成 link，手打側因還原比對不相等（recon 不含 title）永不觸發，停在純文字', () => {
    const typed = typedContent('[a](https://x.com "標題")');
    const pasted = pastedContent('[a](https://x.com "標題")');
    expect(typed).not.toEqual(pasted);
  });

  it("[壞](javascript:alert(1))：貼上側危險 scheme 被剖析器整段吃掉退化成純文字「壞」，手打側裁決函式回 null、規則從未觸發，文字原封不動保留整串", () => {
    const typed = typedContent("[壞](javascript:alert(1))");
    const pasted = pastedContent("[壞](javascript:alert(1))");
    expect(typed).not.toEqual(pasted);
  });
});
