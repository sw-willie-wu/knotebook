import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type PublicLinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { ThemeProvider } from "@/theme";
import type { PublicNoteRef } from "@/lib/public-note-ref";
import { PublicNoteEditor } from "./PublicNoteEditor";

// spec 2026-10-13 site-links §11.2、§11.3、§15.1 W5、§15.2 I4（web 半）。**沒有 QueryClientProvider**：任何 useNotes 呼叫都會直接拋錯。

const PUB = "11111111-1111-4111-8111-111111111111";
const PRIV = "22222222-2222-4222-8222-222222222222";

/** `pubTarget`：第一個 wikilink 的 targetNoteId——預設小寫；Task 7 審查帶過來的案傳大寫（舊文件可能存大寫 id）。 */
function docWith(pubTarget: string = PUB): Y.Doc {
  const doc = new Y.Doc();
  blocksToYXmlFragment(
    BlockNoteEditor.create({ schema: noteSchema }),
    [
      { id: "top", type: "heading", props: { level: 2 }, content: "Top" },
      {
        id: "p1",
        type: "paragraph",
        content: [
          { type: "wikilink", props: { targetNoteId: pubTarget, snapshotTitle: "Snap Pub", label: "", anchorBlockId: "" } },
          " | ",
          { type: "wikilink", props: { targetNoteId: PRIV, snapshotTitle: "Secret Snap", label: "", anchorBlockId: "" } },
          " | ",
          { type: "wikilink", props: { targetNoteId: PRIV, snapshotTitle: "Back to top", label: "", anchorBlockId: "top" } },
        ],
      },
    ] as never,
    doc.getXmlFragment(YDOC_FRAGMENT),
  );
  return doc;
}

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="loc">{`${l.pathname}${l.hash}`}</p>;
}

function renderPublic(publicRef: PublicNoteRef, links: PublicLinkDto[], doc: Y.Doc = docWith()) {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={["/p/start"]}>
        <PublicNoteEditor doc={doc} publicRef={publicRef} links={links} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("#269 公開頁渲染 wikilink", () => {
  const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => new Promise(() => {}));
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const publicRef of [{ kind: "token", token: "t".repeat(43) }, { kind: "path", handle: "h", slug: "s" }] as PublicNoteRef[]) {
    it(`${publicRef.kind} 形：公開目標成 <a href=/p/…>、非公開純文字、同篇錨點 <a href=#b-…>；零 GET /api/notes`, async () => {
      renderPublic(publicRef, [{ id: PUB, title: "Public Title", path: "/p/alice/pub" }]);
      const pub = await screen.findByRole("link", { name: "Public Title" });
      expect(pub).toHaveAttribute("href", "/p/alice/pub");
      expect(screen.getByText("Secret Snap").closest("a")).toBeNull();
      const top = screen.getByRole("link", { name: "Back to top" });
      expect(top).toHaveAttribute("href", "#b-top");
      fireEvent.click(pub);
      await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/p/alice/pub"));
      expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/notes"))).toEqual([]);
    });
  }

  it("Task 7 審查：文件存大寫 targetNoteId、payload 回 DB 正規化的小寫 id ⇒ 仍連到公開目標（不退成純文字）", async () => {
    // 必須含 a–f：PUB 全是數字，toUpperCase() 不變，測不出大小寫（T16-M6 首跑存活即因此）。
    const hexId = "abcdef12-3456-4789-8abc-def123456789";
    expect(hexId.toUpperCase()).not.toBe(hexId);
    renderPublic({ kind: "token", token: "t".repeat(43) }, [{ id: hexId, title: "Public Title", path: "/p/alice/pub" }], docWith(hexId.toUpperCase()));
    const pub = await screen.findByRole("link", { name: "Public Title" });
    expect(pub).toHaveAttribute("href", "/p/alice/pub");
    expect(screen.queryByText("Snap Pub")).toBeNull();
  });
});
