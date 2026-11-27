import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { CommentsProvider, useCommentsController } from "@/lib/comments-context";
import { stubLayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { COMMENT_NOTE, comment, createLiveSource, json, page } from "@/test/comment-fixtures";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";

const POST_URL = `/api/notes/${COMMENT_NOTE}/comments`;

function stubFetch() {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      if (url === `${POST_URL}/unread-count`) return Promise.resolve(json({ count: 0 }));
      if (url === `${POST_URL}?limit=50`) return Promise.resolve(json(page([])));
      if (url === `${POST_URL}/read` && method === "POST") return Promise.resolve(json(null, 204));
      if (url === POST_URL && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { body: string; anchor: { blockId: string; quote: string } };
        posts.push(body);
        return Promise.resolve(json(comment(1, { body: body.body, anchor: body.anchor }), 201));
      }
      if (url.startsWith(`/api/knowledge/fields`)) return Promise.resolve(json({ fields: [] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return posts;
}

function seededDoc(): Y.Doc {
  const doc = new Y.Doc();
  blocksToYXmlFragment(
    BlockNoteEditor.create({ schema: noteSchema }),
    [
      { id: "p1", type: "paragraph", content: "First paragraph of the note." },
      { id: "li1", type: "bulletListItem", content: "a list item", children: [{ id: "li2", type: "bulletListItem", content: "the nested passage" }] },
    ] as never,
    doc.getXmlFragment(YDOC_FRAGMENT),
  );
  return doc;
}

function Host({ doc, editable }: { doc: Y.Doc; editable: boolean }) {
  const comments = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: createLiveSource() });
  return (
    <CommentsProvider value={comments}>
      <NoteEditor doc={doc} provider={{ awareness: null } as never} editable={editable} user={{ id: "u-bob", name: "Bob" }} noteId={COMMENT_NOTE} />
    </CommentsProvider>
  );
}

async function renderEditor({ editable = false } = {}) {
  stubLayoutTier("docked");
  const doc = seededDoc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={doc} editable={editable} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("the nested passage");
  return doc;
}

function selectText(text: string, start: number, end: number): void {
  const node = screen.getByText(text).firstChild;
  if (!(node instanceof Text)) throw new Error(`no text node for ${text}`);
  act(() => {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

describe("NoteEditor passage comments for readers", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
  });

  it("Comment opens the panel with the passage attached and the composer focused; sending posts the nested block's id and the quote", async () => {
    const posts = stubFetch();
    const doc = await renderEditor();
    selectText("the nested passage", 4, 18);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const panel = await screen.findByTestId("comments-panel");
    const box = await within(panel).findByRole("textbox", { name: "Comment" });
    expect(within(panel).getByTestId("composer-anchor")).toHaveTextContent("nested passage");
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.change(box, { target: { value: "Is this still true?" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toEqual([{ body: "Is this still true?", anchor: { blockId: "li2", quote: "nested passage" } }]));
    doc.destroy();
  });

  it("picking another passage while the panel is open moves the chip and focus back to the composer", async () => {
    stubFetch();
    const doc = await renderEditor();
    selectText("First paragraph of the note.", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const panel = await screen.findByTestId("comments-panel");
    const box = await within(panel).findByRole("textbox", { name: "Comment" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    act(() => box.blur());
    selectText("a list item", 2, 6);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    await waitFor(() => expect(within(panel).getByTestId("composer-anchor")).toHaveTextContent("list"));
    await waitFor(() => expect(document.activeElement).toBe(box));
    doc.destroy();
  });

  it("an editable note mounts no reader toolbar", async () => {
    stubFetch();
    const doc = await renderEditor({ editable: true });
    selectText("First paragraph of the note.", 0, 5);
    await act(async () => {});
    expect(document.querySelector("[data-kb-viewer-comment-toolbar]")).toBeNull();
    doc.destroy();
  });
});
