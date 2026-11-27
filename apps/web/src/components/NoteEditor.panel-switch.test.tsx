import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { CommentsProvider, useCommentsController } from "@/lib/comments-context";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { COMMENT_NOTE, createLiveSource, page } from "@/test/comment-fixtures";
import { ThemeProvider } from "@/theme";
import { __resetCornerStackForTests } from "./corner-stack-state";
import { NoteEditor } from "./NoteEditor";

// Its own file: the panels' lazy chunks must not have been rendered yet by an earlier test.

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

function Host({ doc }: { doc: Y.Doc }) {
  const comments = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: createLiveSource(), onOpen: () => versionsClose() });
  const versions = useVersionsController({ noteId: COMMENT_NOTE, enabled: true, onOpen: comments.close });
  const versionsClose = versions.close;
  return (
    <VersionsProvider value={versions}>
      <CommentsProvider value={comments}>
        <button type="button" onClick={() => comments.open()}>host-open-comments</button>
        <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u-alice", name: "Alice" }} noteId={COMMENT_NOTE} />
      </CommentsProvider>
    </VersionsProvider>
  );
}

describe("NoteEditor panel switch", () => {
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

  it("the first switch from the comments to the version history shows the version history in the same commit (the other panel is loaded while one is open)", async () => {
    stubLayoutTier("docked");
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Host doc={doc} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await screen.findByTestId("note-editor");
    fireEvent.click(screen.getByText("host-open-comments"));
    await screen.findByTestId("comments-panel");
    // Stands in for the time spent reading the comments: the module finishes loading and its callbacks run.
    await act(async () => {
      await import("@/components/versions/VersionsLazy");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const bubble = screen.getByTestId("versions-bubble");
    fireEvent.pointerDown(bubble);
    fireEvent.click(bubble);
    expect(screen.queryByTestId("comments-panel")).toBeNull();
    expect(screen.getByTestId("versions-panel")).toBeInTheDocument();
    doc.destroy();
  });
});
