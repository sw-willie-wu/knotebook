import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import i18n from "@/i18n";
import { CommentsProvider, useCommentsController } from "@/lib/comments-context";
import { stubLayoutTier } from "@/test/layout-tier";
import { COMMENT_NOTE, NEWEST_URL, createLiveSource, json, page, stubCommentFetch } from "@/test/comment-fixtures";
import { CommentsSheet } from "./CommentsSheet";

function Host() {
  const value = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: createLiveSource() });
  return (
    <CommentsProvider value={value}>
      <button type="button" onClick={() => value.open()}>host-open</button>
      {value.mode === "sheet" && <CommentsSheet doc={new Y.Doc()} />}
    </CommentsProvider>
  );
}

describe("CommentsSheet", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubLayoutTier("phone");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Esc keeps the sheet while the composer holds a draft, and closes it once the draft is empty", async () => {
    stubCommentFetch({ [`POST /api/notes/${COMMENT_NOTE}/comments/read`]: json(null, 204), [NEWEST_URL]: json(page([1])) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Host />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("host-open"));
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    const box = within(sheet).getByRole("textbox", { name: "Comment" });
    box.focus();
    fireEvent.change(box, { target: { value: "draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Comments" })).toBeInTheDocument();
    expect(box).toHaveValue("draft");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull());
  });
});
