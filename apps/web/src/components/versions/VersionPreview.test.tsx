import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type VersionDto, type VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING } from "@/components/ui/article-column";
import { ThemeProvider } from "@/theme";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { VersionPreview } from "./VersionPreview";
import { PreviewBanner } from "./PreviewBanner";

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => widthRef.current }));
const widthRef = vi.hoisted(() => ({ current: 800 }));

const NOTE = "n1";
function b64(blocks: unknown[]): string {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock 泛型三元組
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}
const ver = (seq: number): VersionDto => ({ id: `v-${seq}`, seq, kind: "auto", name: null, editors: [{ handle: "ann", agentLabel: null }], baseSeq: null, createdAt: "2026-10-09T00:00:00.000Z" });
const V1 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }];
const V2 = [{ id: "A", type: "paragraph", content: "甲改" }, { id: "C", type: "paragraph", content: "丙" }];

function stub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!(url in routes)) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) } as Response);
    }),
  );
  return calls;
}
const list = (versions: VersionDto[], nextBefore: number | null = null): VersionListDto => ({
  versions,
  current: { baseSeq: versions[0]?.seq ?? null, dirty: false, nextSeq: (versions[0]?.seq ?? 0) + 1, autoEnabled: true },
  nextBefore,
});

function Probe() {
  const s = useVersions();
  return <span data-testid="preview-state">{JSON.stringify(s.preview)}</span>;
}
/** `profile`：包在 VersionPreview **單獨**外面的 `<Profiler>` 的 onRender——只計 VersionPreview 子樹的 commit（PreviewBanner 也讀清單，不能算進來）。 */
function Host({ doc, seq, seq2, forceSingle, profile }: { doc: Y.Doc; seq: number; seq2?: number; forceSingle?: boolean; profile?: () => void }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview({ seq, id: `v-${seq}` })}>go</button>
      {seq2 !== undefined && (
        <button type="button" onClick={() => value.startPreview({ seq: seq2, id: `v-${seq2}` })}>
          go2
        </button>
      )}
      <Probe />
      {value.preview && (
        <>
          {/* gate r3 I-3：窄視窗整頁（forceSingle）沒有並排／單欄鈕——橫幅也要收到 narrow，否則 forceSingle 案的「沒有 Side by side 鈕」斷言打不過 */}
          <PreviewBanner narrow={forceSingle} />
          <Profiler id="version-preview" onRender={() => profile?.()}>
            <VersionPreview doc={doc} forceSingle={forceSingle} />
          </Profiler>
        </>
      )}
    </VersionsProvider>
  );
}
function renderPreview(opts: { seq: number; seq2?: number; live?: unknown[]; forceSingle?: boolean; profile?: () => void }) {
  const live = new Y.Doc();
  if (opts.live) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), opts.live as any, live.getXmlFragment(YDOC_FRAGMENT));
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={live} seq={opts.seq} seq2={opts.seq2} forceSingle={opts.forceSingle} profile={opts.profile} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("go"));
  return { live, queryClient };
}
describe("VersionPreview（spec §8.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    widthRef.current = 800;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("預設 vs 前一版：單欄唯讀編輯器、回貼 data-diff（A changed、B deleted 合成 id、C added）", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull();
    expect(view.querySelector('[data-id^="diff-del-"][data-diff="deleted"]')).not.toBeNull();
    expect(view.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it("I-5：清單重抓且 current 變了（打字 → 去抖動 → dirty 翻面）→ VersionPreview 確實 re-render，但不重建唯讀編輯器（BlockNoteEditor.create 呼叫數 0）；單欄套文章欄寬", async () => {
    // gate r2 I-2：第二次回應**必須**與第一次不同。body 不變時 React Query 的 structural sharing 沿用舊 data 參照、
    // VersionPreview 根本不 re-render（reviewer 實跑：body 不變 0 次、dirty 翻面 1 次），守衛有無 useMemo 都綠。
    // gate r3 I-1：不能用「.bn-editor 同一節點」判斷——BlockNote 重建唯讀 editor 時 .bn-editor 根節點沿用，有無 useMemo 都綠。
    // 唯一斷言是 BlockNoteEditor.create 在重抓之後的呼叫數（reviewer 實跑：原碼 0；拿掉 entries 或 b0 的 useMemo 各 1）。
    const routes: Record<string, unknown> = {
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    };
    stub(routes);
    const commits = vi.fn();
    const { queryClient } = renderPreview({ seq: 2, profile: commits });
    const view = await screen.findByTestId("diff-single");
    expect(view).toHaveClass(...ARTICLE_COLUMN.split(" "), ARTICLE_COLUMN_PADDING);
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      const base = list([ver(2), ver(1)]);
      routes[`/api/notes/${NOTE}/versions?limit=50`] = { ...base, current: { ...base.current, dirty: true } };
      const commitsBefore = commits.mock.calls.length;
      await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
      await waitFor(() => expect(commits.mock.calls.length).toBeGreaterThan(commitsBefore));
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
  });

  it("比較對象切到「目前狀態」：讀活文件的 fork，活文件零寫入", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    const { live } = renderPreview({ seq: 1, live: [{ id: "A", type: "paragraph", content: "甲" }, { id: "D", type: "paragraph", content: "丁" }] });
    let updates = 0;
    live.on("update", () => (updates += 1));
    fireEvent.click(await screen.findByRole("button", { name: "Current state" }));
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="D"][data-diff="added"]')).not.toBeNull());
    // Task 2 carry：未變更的區塊不在 marks 裡，由 DiffEditor 回貼 context
    expect(view.querySelector('[data-id="A"][data-diff="context"]')).not.toBeNull();
    expect(updates).toBe(0);
  });

  it("v1（清單已到底）→ 比空文件、橫幅寫「vs empty document」、全部 added", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    expect(await screen.findByText("vs empty document")).toBeInTheDocument();
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="A"][data-diff="added"]')).not.toBeNull());
  });

  it("RF5：前一版在下一頁 → 先載下一頁再比，不誤判成空文件", async () => {
    const calls = stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2)], 2),
      [`/api/notes/${NOTE}/versions?before=2&limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull());
    expect(calls).toContain(`/api/notes/${NOTE}/versions?before=2&limit=50`);
    expect(screen.queryByText("vs empty document")).not.toBeInTheDocument();
  });

  it("只看差異：未變更的區塊折成一行", async () => {
    const many = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }, { id: "E", type: "paragraph", content: "戊" }];
    const many2 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }, { id: "E", type: "paragraph", content: "戊改" }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(many2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(many) },
    });
    renderPreview({ seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Only changes" }));
    expect(await screen.findByText("… 2 unchanged blocks …")).toBeInTheDocument();
  });

  it("並排：寬 >= 1100 自動並排（兩顆唯讀編輯器、左右各標）；寬 < 1100 單欄；手動鈕蓋過", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    widthRef.current = 1200;
    renderPreview({ seq: 2 });
    const split = await screen.findByTestId("diff-split");
    expect(split).toHaveClass("@min-[1100px]:grid-cols-2");
    const [left, right] = within(split).getAllByTestId("diff-pane");
    await waitFor(() => expect(left.querySelector('[data-id="B"][data-diff="deleted"]')).not.toBeNull());
    await waitFor(() => expect(right.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Single column" }));
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
  });

  it("forceSingle（窄視窗整頁）：一律單欄、沒有並排／單欄切換鈕", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    widthRef.current = 1600;
    renderPreview({ seq: 2, forceSingle: true });
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
  });

  it("非文字區塊 changed → 「已變更 · 看前後」按鈕，點開是兩顆唯讀 mini editor 的對話框", async () => {
    const i1 = [{ id: "I", type: "image", props: { url: "/api/uploads/1" } }];
    const i2 = [{ id: "I", type: "image", props: { url: "/api/uploads/2" } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(i2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(i1) },
    });
    renderPreview({ seq: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Changed · see before and after" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Before")).toBeInTheDocument();
    expect(within(dialog).getByText("After")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId("diff-pane")).toHaveLength(2);
  });

  it("RF2：快照裡的 javascript: 圖片網址不會出現在任何 img src", async () => {
    const bad = [{ id: "I", type: "image", props: { url: "javascript:alert(1)" } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(bad) },
    });
    renderPreview({ seq: 1 });
    await screen.findByTestId("diff-single");
    await new Promise((r) => setTimeout(r, 50));
    const srcs = Array.from(document.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
    expect(srcs.some((s) => s.startsWith("javascript:"))).toBe(false);
  });

  it("快照 id 不符 → toast「這一版已經不存在」、離開預覽", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-OTHER", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    expect(await screen.findByText("This version no longer exists. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent("null"));
  });

  it("橫幅 ✕ → 離開預覽；橫幅是 bg-accent", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    const banner = await screen.findByTestId("preview-banner");
    expect(banner).toHaveClass("bg-accent");
    expect(banner).toHaveTextContent("Previewing v1");
    fireEvent.click(within(banner).getByRole("button", { name: "Close preview" }));
    expect(screen.getByTestId("preview-state")).toHaveTextContent("null");
  });
  // ── fix round 1 ──────────────────────────────────────────────────────────────
  const okRes = (json: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(json) }) as Response;

  it("fix1 M-1：前一版在下一頁、載下一頁失敗 → 預覽區顯示通用錯誤、不再重抓；橫幅 ✕ 照常可按", async () => {
    const page2Url = `/api/notes/${NOTE}/versions?before=2&limit=50`;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return Promise.resolve(okRes(list([ver(2)], 2)));
        if (url === page2Url) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        if (url === `/api/notes/${NOTE}/versions/2`) return Promise.resolve(okRes({ id: "v-2", seq: 2, ydoc: b64(V2) }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPreview({ seq: 2 });
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    const page2 = () => calls.filter((u) => u === page2Url).length;
    expect(page2()).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(page2()).toBe(1);
    fireEvent.click(within(screen.getByTestId("preview-banner")).getByRole("button", { name: "Close preview" }));
    expect(screen.getByTestId("preview-state")).toHaveTextContent("null");
  });

  it("fix1 M-3：「前一版」快照 id 不符 → 不跳「這一版已經不存在」、不離開預覽；清單重抓後依新列重算比較對象", async () => {
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) {
          listCalls += 1;
          if (listCalls === 1) return Promise.resolve(okRes(list([ver(2), ver(1)])));
          // 重抓延遲 100 ms：mock 立即回應時，「前一版 mismatch」與重抓結果會落在 React Query 同一批通知裡，
          // 畫面從沒看到 mismatch 狀態，舊行為（關預覽）也不會觸發——本案就失去鑑別力（fix round 1 實跑）。
          return new Promise((r) => setTimeout(() => r(okRes(list([ver(2), { ...ver(1), id: "v-1b" }]))), 100));
        }
        if (url === `/api/notes/${NOTE}/versions/2`) return Promise.resolve(okRes({ id: "v-2", seq: 2, ydoc: b64(V2) }));
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve(okRes({ id: "v-1b", seq: 1, ydoc: b64(V1) }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPreview({ seq: 2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull());
    expect(listCalls).toBe(2);
    expect(screen.queryByText("This version no longer exists. The list has been refreshed.")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
  });

  it("fix1 M-4：「看前後」對話框開著時換一版預覽 → 對話框關掉，新一版的鈕照常出現", async () => {
    const img = (n: number) => [{ id: "I", type: "image", props: { url: `/api/uploads/${n}` } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(3), ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/3`]: { id: "v-3", seq: 3, ydoc: b64(img(3)) },
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(img(2)) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(img(1)) },
    });
    renderPreview({ seq: 2, seq2: 3 });
    fireEvent.click(await screen.findByRole("button", { name: "Changed · see before and after" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("go2"));
    await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":3'));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Changed · see before and after" })).toBeInTheDocument();
  });
});
