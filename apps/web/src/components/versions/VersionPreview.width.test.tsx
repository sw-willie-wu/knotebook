import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type VersionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { ThemeProvider } from "@/theme";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { VersionPreview } from "./VersionPreview";

const NOTE = "n1";
const observed: Array<{ el: Element; cb: ResizeObserverCallback }> = [];
class FakeRO {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    observed.push({ el, cb: this.cb });
  }
  unobserve() {}
  disconnect() {}
}
function b64(blocks: unknown[]): string {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock 泛型三元組
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}
const ver = (seq: number): VersionDto => ({ id: `v-${seq}`, seq, kind: "auto", name: null, editors: [], baseSeq: null, createdAt: "2026-10-09T00:00:00.000Z" });

function Host() {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview({ seq: 2, id: "v-2" })}>go</button>
      <VersionPreview doc={new Y.Doc()} />
    </VersionsProvider>
  );
}

describe("VersionPreview 寬度量尺（gate r2 M-1：loading 也畫在 ref wrapper 裡）", () => {
  const original = globalThis.ResizeObserver;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    observed.length = 0;
    globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = original;
    vi.unstubAllGlobals();
  });

  it("先 loading（快照還沒回）時量尺已掛在 wrapper 上；資料回來後回報 1200 → 自動並排", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const body = (json: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(json) }) as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/notes/${NOTE}/versions?limit=50`)
          return body({ versions: [ver(2), ver(1)], current: { baseSeq: 2, dirty: false, nextSeq: 3, autoEnabled: true }, nextBefore: null });
        if (url === `/api/notes/${NOTE}/versions/2`) {
          await held;
          return body({ id: "v-2", seq: 2, ydoc: b64([{ id: "A", type: "paragraph", content: "新" }]) });
        }
        if (url === `/api/notes/${NOTE}/versions/1`) return body({ id: "v-1", seq: 1, ydoc: b64([{ id: "A", type: "paragraph", content: "舊" }]) });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <Host />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    const loading = await screen.findByText("Loading version…");
    const wrapper = observed.find((o) => o.el.contains(loading));
    expect(wrapper).toBeDefined();
    release();
    act(() => {
      wrapper!.cb([{ contentRect: { width: 1200 } } as ResizeObserverEntry], {} as ResizeObserver);
    });
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
  });
});
