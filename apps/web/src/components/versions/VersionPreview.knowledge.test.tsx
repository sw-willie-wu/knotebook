import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vid, vtarget } from "@/test/version-fixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type VersionDto, type VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { ThemeProvider } from "@/theme";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { stubLayout, stubMedia } from "@/components/knowledge/test-support";
import { DiffEditor, VersionPreview } from "./VersionPreview";

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => widthRef.current }));
vi.mock("@/lib/mermaid", () => ({
  renderMermaid: vi.fn(() => Promise.resolve({ ok: true, svg: "<svg viewBox='0 0 10 10'></svg>" })),
  cachedMermaid: vi.fn(() => null),
  preloadMermaid: vi.fn(),
  nextMermaidId: () => "mermaid-test",
}));
const widthRef = vi.hoisted(() => ({ current: 600 }));

const NOTE = "n1";
function b64(blocks: unknown[]): string {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock generic triple
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}
const ver = (seq: number): VersionDto => ({ id: vid(seq), seq, kind: "auto", name: null, editors: [{ handle: "ann", agentLabel: null, avatar: null }], baseSeq: null, base: null, createdAt: "2026-10-09T00:00:00.000Z" });
const list = (versions: VersionDto[]): VersionListDto => ({
  versions,
  current: { baseSeq: versions[0]?.seq ?? null, base: versions[0] ? { id: versions[0].id, name: versions[0].name, deleted: false } : null, dirty: false, nextSeq: (versions[0]?.seq ?? 0) + 1, autoEnabled: true },
  nextBefore: null,
});

const heading = (id: string, knowledgeId: string, props: Record<string, unknown> = {}, level = 1) => ({
  id,
  type: "heading",
  props: { level, knowledgeId, knowledgeWhen: "when alice", knowledgeConclusion: "conclusion bob", knowledgeVerified: "2026-10-01", ...props },
  content: `Title ${id}`,
});

// Version 1: an outdated top heading with a child. Version 2: only the child's sibling is new.
const V1 = [heading("H1", "k_00000001", { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" }), heading("H2", "k_00000002", {}, 2), { id: "P", type: "paragraph", content: "text" }];
const V2 = [heading("H1", "k_00000001"), heading("H3", "k_00000003"), { id: "P", type: "paragraph", content: "text" }];

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!(url in routes)) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) } as Response);
    }),
  );
}
const routes = () => ({
  [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
  [`/api/notes/${NOTE}/versions/2`]: { id: vid(2), seq: 2, ydoc: b64(V2) },
  [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(V1) },
});

function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview(vtarget(1))}>go</button>
      <button type="button" onClick={() => value.setCompareRight(vtarget(2))}>r</button>
      {value.preview && <VersionPreview doc={doc} />}
    </VersionsProvider>
  );
}

function renderPreview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Host doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("go"));
  fireEvent.click(screen.getByText("r"));
}

const iconIds = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-kb-knowledge-icon]")].map((i) => i.dataset.blockId);

describe("VersionPreview knowledge", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubLayout();
    stubMedia([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("side by side, each column shows the icons of its own version", async () => {
    widthRef.current = 900;
    stub(routes());
    renderPreview();
    const split = await screen.findByTestId("diff-split");
    const [left, right] = within(split).getAllByTestId("diff-pane");
    await waitFor(() => expect(iconIds(left!)).toEqual(["H1", "H2"]));
    await waitFor(() => expect(iconIds(right!)).toEqual(["H1", "H3"]));
    expect(left!.querySelector('[data-block-id="H1"]')).toHaveAttribute("data-kind", "outdated");
    expect(right!.querySelector('[data-block-id="H1"]')).toHaveAttribute("data-kind", "verified");
  });

  it("single column shows the previewed version's icons", async () => {
    widthRef.current = 600;
    stub(routes());
    renderPreview();
    const single = await screen.findByTestId("diff-single");
    // H2 only exists in the previewed version, so the column shows it under its synthetic id.
    await waitFor(() => expect(iconIds(single)).toEqual(["H1", "diff-del-1"]));
  });

  it("an outdated parent in the previewed version strikes through its knowledge child in single column", async () => {
    widthRef.current = 600;
    stub(routes());
    renderPreview();
    const single = await screen.findByTestId("diff-single");
    await waitFor(() => expect(single.querySelector('[data-id="diff-del-1"] [data-kb-knowledge-outdated]')).not.toBeNull());
    expect(single.querySelector('[data-id="H1"] [data-kb-knowledge-outdated]')).not.toBeNull();
    expect(single.querySelector('[data-id="P"] [data-kb-knowledge-outdated]')).toBeNull();
  });

  it("the before/after dialog shows no knowledge icon", async () => {
    stub(routes());
    // The dialog's editors get no `knowledge` prop.
    const view = render(
      <ThemeProvider>
        <DiffEditor blocks={V1 as never} marks={new Map()} />
      </ThemeProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(iconIds(view.container)).toEqual([]);
  });

  it("accept() keeps icons off blocks the single column marks as added or collapsed", async () => {
    const entries = (await import("@knotebook/shared")).listKnowledgeInBlocks(V1 as never);
    const marks = new Map([["H2", { mark: "added" as const }]]);
    render(
      <ThemeProvider>
        <DiffEditor
          blocks={V1 as never}
          marks={marks as never}
          knowledge={{ entries, accept: (outer) => (marks.get(outer.dataset.id!)?.mark ?? "context") !== "added" }}
        />
      </ThemeProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll("[data-kb-knowledge-icon]").length).toBeGreaterThan(0));
    expect(iconIds(document.body)).toEqual(["H1"]);
  });

  it("cards opened in the preview have no Edit", async () => {
    widthRef.current = 600;
    stub(routes());
    renderPreview();
    const single = await screen.findByTestId("diff-single");
    await waitFor(() => expect(iconIds(single)).toEqual(["H1", "diff-del-1"]));
    fireEvent.click(single.querySelector<HTMLElement>('[data-block-id="H1"]')!);
    const card = await screen.findByRole("dialog");
    expect(within(card).getByText("when alice")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
  });
});
