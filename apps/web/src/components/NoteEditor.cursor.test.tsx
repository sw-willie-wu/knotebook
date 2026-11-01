import { useState, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import type { CursorScroller } from "@/collab/cursor-scroll";
import { ThemeProvider } from "@/theme";
import { setRemote } from "@/components/presence/test-awareness";
import { NoteEditor } from "./NoteEditor";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// #293 §9.4：`NoteEditor` 的 `onCursorScroller` 接線。掛真 `<NoteEditor>`（Host 照 `NoteEditor.layout.test.tsx`）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

function fakeResponse(json: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(json) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(fakeResponse({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** 照 `collab/undo.test.tsx` 的 `collabEditor()`：先用它把內容寫進 Y.Doc，再把同一個 doc 交給 `<NoteEditor>`。 */
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

async function seededDoc(): Promise<Y.Doc> {
  const { doc, editor } = collabEditor();
  const div = document.createElement("div");
  document.body.appendChild(div);
  editor.mount(div);
  editor.replaceBlocks(editor.document, [
    { type: "paragraph", content: "第一段" },
    { type: "paragraph", content: "第二段落文字" },
    { type: "paragraph", content: "第三段" },
  ] as never);
  await waitFor(() => expect(findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字")).not.toBeNull());
  editor.unmount();
  div.remove();
  return doc;
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

const provider = { awareness: null } as never;

function Host({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

describe("NoteEditor：onCursorScroller（#293 §9.4）", () => {
  // jsdom 的 HTMLElement 不一定有 scrollTo；缺就先墊一支，好讓 spy 有東西可蓋。
  let addedScrollTo = false;
  beforeAll(() => {
    if (typeof HTMLElement.prototype.scrollTo !== "function") {
      HTMLElement.prototype.scrollTo = () => {};
      addedScrollTo = true;
    }
  });
  afterAll(() => {
    if (addedScrollTo) delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("NE1：editor 建好後交出一次函式；卸載後最後一次交出 null", async () => {
    const onCursorScroller = vi.fn();
    const doc = new Y.Doc();
    const { unmount } = render(
      <Host>
        <NoteEditor doc={doc} provider={provider} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" onCursorScroller={onCursorScroller} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    expect(onCursorScroller).toHaveBeenCalledTimes(1);
    expect(typeof onCursorScroller.mock.calls[0]![0]).toBe("function");
    unmount();
    expect(onCursorScroller.mock.calls.at(-1)![0]).toBeNull();
    doc.destroy();
  });

  it("NE2：真的 relative position——無預覽時捲動；版本預覽中不捲", async () => {
    const doc = await seededDoc();
    const onCursorScroller = vi.fn();
    const props = { doc, provider, editable: true, user: { id: "u1", name: "Ann" }, noteId: "note-1", onCursorScroller };
    const { rerender } = render(
      <Host>
        <NoteEditor {...props} />
      </Host>,
    );
    await screen.findByText("第二段落文字");
    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字");
    expect(text).not.toBeNull();
    const cursor = { anchor: rel(text!, 0), head: rel(text!, 2) };
    const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {});
    const scroller = onCursorScroller.mock.calls[0]![0] as CursorScroller;

    expect(scroller(cursor)).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender(
      <Host>
        <NoteEditor {...props} previewSlot={<div />} />
      </Host>,
    );
    expect(scroller(cursor)).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    doc.destroy();
  });

  it("NE3：onScrollRoot 照舊收到捲動容器", async () => {
    const onScrollRoot = vi.fn();
    const doc = new Y.Doc();
    render(
      <Host>
        <NoteEditor doc={doc} provider={provider} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" onScrollRoot={onScrollRoot} />
      </Host>,
    );
    const column = await screen.findByTestId("article-column");
    const el = onScrollRoot.mock.calls.find(([arg]) => arg !== null)?.[0] as HTMLElement | undefined;
    expect(el).toBeDefined();
    expect(el).toHaveClass("overflow-y-auto");
    expect(column.parentElement).toBe(el);
    doc.destroy();
  });

  it("NE4：只換 onCursorScroller 的 identity 不重交", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const doc = new Y.Doc();
    const base = { doc, provider, editable: true, user: { id: "u1", name: "Ann" }, noteId: "note-1" };
    const { rerender } = render(
      <Host>
        <NoteEditor {...base} onCursorScroller={first} />
      </Host>,
    );
    await screen.findByTestId("note-editor");
    rerender(
      <Host>
        <NoteEditor {...base} onCursorScroller={second} />
      </Host>,
    );
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    doc.destroy();
  });
});

// #293 T6b：唯讀時本分頁不送游標（spec §4.1 as-built）。真 y-prosemirror cursor plugin＋真 Awareness。
// jsdom 裡 `.ProseMirror` 帶 BlockNote 無條件給的 tabIndex=0，`focus()` 會讓 `view.hasFocus()` 成立——
// 與瀏覽器裡 viewer 點進內文同一條路（T7 r2 P1）。
describe("NoteEditor：唯讀者不送游標（#293 T6b）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(editable: boolean) {
    const doc = await seededDoc();
    const awareness = new Awareness(doc);
    const base = { doc, provider: { awareness } as never, user: { id: "u1", name: "Ann" }, noteId: "note-1" };
    const { rerender } = render(
      <Host>
        <NoteEditor {...base} editable={editable} />
      </Host>,
    );
    await screen.findByText("第二段落文字");
    const setEditable = (next: boolean) =>
      rerender(
        <Host>
          <NoteEditor {...base} editable={next} />
        </Host>,
      );
    return { doc, awareness, setEditable };
  }

  // editable 翻面時 BlockNoteView 會重掛 PM view，每次都重新找。
  function pmDom(): HTMLElement {
    const el = screen.getByTestId("note-editor").querySelector<HTMLElement>(".ProseMirror");
    if (!el) throw new Error("no .ProseMirror");
    return el;
  }

  function focusAndSelect() {
    const dom = pmDom();
    act(() => {
      dom.focus();
    });
    const tiptap = (dom as unknown as { editor: { commands: { setTextSelection(range: { from: number; to: number }): boolean } } }).editor;
    act(() => {
      tiptap.commands.setTextSelection({ from: 3, to: 5 });
    });
    expect(document.activeElement).toBe(dom);
  }

  const localCursor = (awareness: Awareness): unknown => (awareness.getLocalState() as { cursor?: unknown } | null)?.cursor ?? null;

  it("RC1：可編輯——聚焦＋選取後 awareness 有 cursor", async () => {
    const { doc, awareness } = await mount(true);
    focusAndSelect();
    expect(localCursor(awareness)).not.toBeNull();
    awareness.destroy();
    doc.destroy();
  });

  it("RC2：唯讀——編輯區照樣可聚焦，但聚焦＋選取後 awareness 沒有 cursor、也不多送更新；user 照寫；別人的游標照樣畫得出來", async () => {
    const { doc, awareness } = await mount(false);
    expect(pmDom()).toHaveAttribute("contenteditable", "false");
    expect((awareness.getLocalState() as { user?: { name?: string } } | null)?.user?.name).toBe("Ann");
    let updates = 0;
    const onUpdate = () => {
      updates += 1;
    };
    awareness.on("update", onUpdate);
    focusAndSelect();
    awareness.off("update", onUpdate);
    expect(localCursor(awareness)).toBeNull();
    expect(updates).toBe(0);

    const text = findXmlText(doc.getXmlFragment(YDOC_FRAGMENT), "第二段落文字")!;
    act(() => {
      setRemote(awareness, 4242, { user: { name: "Bob", color: "#ff0000" }, cursor: { anchor: rel(text, 0), head: rel(text, 2) } });
    });
    await waitFor(() => expect(screen.getByText("Bob")).toBeInTheDocument());
    awareness.destroy();
    doc.destroy();
  });

  it("RC3：唯讀 → 可編輯——之後聚焦就開始送", async () => {
    const { doc, awareness, setEditable } = await mount(false);
    focusAndSelect();
    expect(localCursor(awareness)).toBeNull();
    setEditable(true);
    focusAndSelect();
    expect(localCursor(awareness)).not.toBeNull();
    awareness.destroy();
    doc.destroy();
  });

  it("RC4：可編輯 → 唯讀——已送出的 cursor 立即清掉，之後再聚焦＋選取也不送", async () => {
    const { doc, awareness, setEditable } = await mount(true);
    focusAndSelect();
    expect(localCursor(awareness)).not.toBeNull();
    setEditable(false);
    expect(localCursor(awareness)).toBeNull();
    focusAndSelect();
    expect(localCursor(awareness)).toBeNull();
    awareness.destroy();
    doc.destroy();
  });
});
