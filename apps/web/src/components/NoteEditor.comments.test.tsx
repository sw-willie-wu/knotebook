import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { CommentsProvider, useCommentsController } from "@/lib/comments-context";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { COMMENT_NOTE, createLiveSource, page } from "@/test/comment-fixtures";
import { ThemeProvider } from "@/theme";
import { __resetCornerStackForTests } from "./corner-stack-state";
import { NoteEditor } from "./NoteEditor";

function json(body: unknown, status = 200): Response {
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      if (url === `/api/notes/${COMMENT_NOTE}/comments/unread-count`) return Promise.resolve(json({ count: 0 }));
      if (url === `/api/notes/${COMMENT_NOTE}/comments?limit=50`) return Promise.resolve(json(page([1])));
      if (url === `/api/notes/${COMMENT_NOTE}/comments/read` && method === "POST") return Promise.resolve(json(null, 204));
      if (url.startsWith(`/api/knowledge/fields`)) return Promise.resolve(json({ fields: [] }));
      if (url === `/api/notes/${COMMENT_NOTE}/versions?limit=50`) {
        return Promise.resolve(json({ versions: [], current: { baseSeq: null, base: null, dirty: true, nextSeq: 1, autoEnabled: true }, nextBefore: null }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function Host({ doc, canEdit }: { doc: Y.Doc; canEdit: boolean }) {
  // Wired as NotePage does: each controller closes the other before it opens.
  const comments = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: createLiveSource(), onOpen: () => versionsClose() });
  const versions = useVersionsController({ noteId: COMMENT_NOTE, enabled: canEdit, onOpen: comments.close });
  const versionsClose = versions.close;
  return (
    <VersionsProvider value={versions}>
      <CommentsProvider value={comments}>
        <button type="button" onClick={() => comments.open()}>host-open-comments</button>
        <button type="button" onClick={() => comments.open({ draftAnchor: { blockId: "b1", quote: "the passage" } })}>host-open-passage</button>
        <NoteEditor doc={doc} provider={{ awareness: null } as never} editable={canEdit} user={{ id: "u-alice", name: "Alice" }} noteId={COMMENT_NOTE} />
      </CommentsProvider>
    </VersionsProvider>
  );
}

async function renderAt(tier: LayoutTier, canEdit = true) {
  stubLayoutTier(tier);
  const doc = new Y.Doc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={doc} canEdit={canEdit} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByTestId("note-editor");
  return doc;
}

describe("NoteEditor comments panel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    __resetCornerStackForTests();
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens in its own `display: contents` slot in the row container, which also carries the shared width variable; the bubbles stay while it is open", async () => {
    window.localStorage.setItem("versions.panelWidth", "400");
    const doc = await renderAt("docked");
    expect(await screen.findByTestId("comments-bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByText("host-open-comments"));
    const panel = await screen.findByTestId("comments-panel");
    const slot = panel.parentElement!;
    expect(slot).toHaveAttribute("data-comments-panel-slot");
    expect(slot).toHaveClass("contents");
    expect(slot.parentElement!.style.getPropertyValue("--versions-panel-width")).toBe("400px");
    expect(within(panel).getByRole("separator", { name: "Resize comments panel" })).toHaveAttribute("aria-valuenow", "400");
    expect(screen.getByTestId("comments-bubble")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector("[data-versions-panel-slot]")).toBeNull();
    doc.destroy();
  });

  it("floating tier: Esc inside the panel closes it and focus returns to the comments bubble; Esc in a composer with text keeps it", async () => {
    const doc = await renderAt("overlay");
    fireEvent.click(screen.getByText("host-open-comments"));
    const panel = await screen.findByTestId("comments-panel");
    const box = await within(panel).findByRole("textbox", { name: "Comment" });
    fireEvent.change(box, { target: { value: "draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("comments-panel")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("comments-bubble")));
    doc.destroy();
  });

  it("floating tier: pressing on the note doesn't close the comments panel (a passage can be selected while writing)", async () => {
    const doc = await renderAt("overlay");
    fireEvent.click(screen.getByText("host-open-comments"));
    await screen.findByTestId("comments-panel");
    fireEvent.pointerDown(screen.getByTestId("note-editor"));
    expect(screen.getByTestId("comments-panel")).toBeInTheDocument();
    doc.destroy();
  });

  it("a viewer (no version history) still gets the comments bubble", async () => {
    const doc = await renderAt("docked", false);
    await screen.findByTestId("corner-stack");
    expect(Array.from(screen.getByTestId("corner-bubbles").children).map((el) => el.getAttribute("data-testid"))).toEqual(["comments-bubble"]);
    doc.destroy();
  });

  const click = (el: HTMLElement) => {
    fireEvent.pointerDown(el);
    fireEvent.click(el);
  };

  it.each(["overlay", "docked"] as const)("%s: the bubbles switch between the panels both ways, focus goes into the new panel, and the unsent comment and its passage come back", async (tier) => {
    const doc = await renderAt(tier);
    fireEvent.click(screen.getByText("host-open-passage"));
    const box = await within(await screen.findByTestId("comments-panel")).findByRole("textbox", { name: "Comment" });
    fireEvent.change(box, { target: { value: "half a thought" } });

    click(screen.getByTestId("versions-bubble"));
    const versionsPanel = await screen.findByTestId("versions-panel");
    expect(screen.queryByTestId("comments-panel")).toBeNull();
    await waitFor(() => expect(versionsPanel).toHaveFocus());
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");

    click(screen.getByTestId("comments-bubble"));
    const panel = await screen.findByTestId("comments-panel");
    expect(screen.queryByTestId("versions-panel")).toBeNull();
    const again = within(panel).getByRole("textbox", { name: "Comment" });
    expect(again).toHaveValue("half a thought");
    expect(within(panel).getByTestId("composer-anchor")).toHaveTextContent("the passage");
    await waitFor(() => expect(again).toHaveFocus());

    // Pressed, the open panel's bubble closes it; the draft is still there the next time.
    screen.getByTestId("comments-bubble").focus();
    click(screen.getByTestId("comments-bubble"));
    expect(screen.queryByTestId("comments-panel")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("comments-bubble")).toHaveFocus());
    click(screen.getByTestId("comments-bubble"));
    expect(within(await screen.findByTestId("comments-panel")).getByRole("textbox", { name: "Comment" })).toHaveValue("half a thought");
    doc.destroy();
  });

  it("overlay: ✕ with the stack collapsed gives the focus to the toggle", async () => {
    const doc = await renderAt("overlay");
    click(await screen.findByTestId("comments-bubble"));
    const panel = await screen.findByTestId("comments-panel");
    click(screen.getByTestId("corner-toggle"));
    expect(screen.getByTestId("comments-panel")).toBe(panel);
    expect(screen.queryByTestId("comments-bubble")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(screen.getByTestId("corner-toggle")).toHaveFocus());
    doc.destroy();
  });
});
