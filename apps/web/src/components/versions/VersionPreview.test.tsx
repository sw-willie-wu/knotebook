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
const widthRef = vi.hoisted(() => ({ current: 600 }));

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
  return (
    <>
      <span data-testid="preview-state">{JSON.stringify(s.preview)}</span>
      <span data-testid="right-state">{JSON.stringify(s.compareRight)}</span>
    </>
  );
}
/** `profile`：包在 VersionPreview **單獨**外面的 `<Profiler>` 的 onRender——只計 VersionPreview 子樹的 commit（PreviewBanner 也讀清單，不能算進來）。
 * `right`：「r」鈕把右邊設成那一版；「rc」鈕把右邊設回目前狀態（也拿來在 widthRef 變動後觸發一次 context 變動）。 */
function Host({ doc, seq, seq2, right, forceSingle, profile }: { doc: Y.Doc; seq: number; seq2?: number; right?: number; forceSingle?: boolean; profile?: () => void }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview({ seq, id: `v-${seq}` })}>go</button>
      {seq2 !== undefined && (
        <button type="button" onClick={() => value.startPreview({ seq: seq2, id: `v-${seq2}` })}>
          go2
        </button>
      )}
      {right !== undefined && (
        <button type="button" onClick={() => value.setCompareRight({ seq: right, id: `v-${right}` })}>
          r
        </button>
      )}
      <button type="button" onClick={() => value.setCompareRight("current")}>
        rc
      </button>
      <button type="button" onClick={() => value.setSplitMode("single")}>
        ss
      </button>
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
function renderPreview(opts: { seq: number; seq2?: number; right?: number; live?: unknown[]; forceSingle?: boolean; profile?: () => void }) {
  const live = new Y.Doc();
  if (opts.live) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), opts.live as any, live.getXmlFragment(YDOC_FRAGMENT));
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={live} seq={opts.seq} seq2={opts.seq2} right={opts.right} forceSingle={opts.forceSingle} profile={opts.profile} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("go"));
  if (opts.right !== undefined) fireEvent.click(screen.getByText("r"));
  return { live, queryClient };
}
/** 左 v1（V1）vs 活文件（V2）——rev 10 的預設比較：A changed、B deleted、C added。 */
const routesV1 = () => ({
  [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
  [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
  [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
});

describe("VersionPreview（spec §8.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    // 預設 < 720（並排門檻）：單欄。
    widthRef.current = 600;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rev 10 預設＝左（選的版）vs 目前狀態（活文件 fork）：單欄唯讀編輯器、回貼 data-diff（A changed、B deleted 合成 id、C added）、未變更回貼 context、活文件零寫入", async () => {
    stub(routesV1());
    const { live } = renderPreview({ seq: 1, live: [...V2, { id: "D", type: "paragraph", content: "丁" }] });
    let updates = 0;
    live.on("update", () => (updates += 1));
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull();
    expect(view.querySelector('[data-id^="diff-del-"][data-diff="deleted"]')).not.toBeNull();
    expect(view.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByTestId("right-state")).toHaveTextContent('"current"');
    expect(updates).toBe(0);
  });

  it("Task 2 carry：未變更的區塊不在 marks 裡，由 DiffEditor 回貼 context（vs 目前狀態）", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1, live: [{ id: "A", type: "paragraph", content: "甲" }, { id: "D", type: "paragraph", content: "丁" }] });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="D"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="context"]')).not.toBeNull();
  });

  it("I-5（兩快照）：無關的 context 變動（splitMode）→ VersionPreview 確實 re-render，但不重建唯讀編輯器（BlockNoteEditor.create 呼叫數 0）；單欄套文章欄寬", async () => {
    // gate r2 I-2：第二次回應**必須**與第一次不同。body 不變時 React Query 的 structural sharing 沿用舊 data 參照、
    // VersionPreview 根本不 re-render（reviewer 實跑：body 不變 0 次、dirty 翻面 1 次），守衛有無 useMemo 都綠。
    // gate r3 I-1：不能用「.bn-editor 同一節點」判斷——BlockNote 重建唯讀 editor 時 .bn-editor 根節點沿用，有無 useMemo 都綠。
    // 唯一斷言是 BlockNoteEditor.create 在重抓之後的呼叫數（reviewer 實跑：原碼 0；拿掉 entries 或左快照的 useMemo 各 1）。
    // rev 10：右邊是兩個快照（右選 v2），讓兩條快照 useMemo 都在路徑上。
    // rev 10：VersionPreview 不再讀清單的 data（`usePreviousTarget` 刪了；React Query 只在讀過的欄位變動時 re-render），
    // 清單重抓本身已不會讓它 re-render——所以另用一次與 diff 無關的 context 變動（窄寬下 setSplitMode("single")，版面不變）
    // 保證「確實 re-render」，再斷言沒重建。
    // 下面那段清單重抓（dirty 翻面）保留為**回歸防線**：今天它對 VersionPreview 是空操作；若日後 VersionPreview 又讀清單 data，
    // 它會跟著 re-render，這段就重新成為「清單重抓不重建」的守衛（create 呼叫數仍斷言 0）。
    const routes: Record<string, unknown> = routesV1();
    stub(routes);
    const commits = vi.fn();
    const { queryClient } = renderPreview({ seq: 1, right: 2, profile: commits });
    const view = await screen.findByTestId("diff-single");
    expect(view).toHaveClass(...ARTICLE_COLUMN.split(" "), ARTICLE_COLUMN_PADDING);
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      const base = list([ver(2), ver(1)]);
      routes[`/api/notes/${NOTE}/versions?limit=50`] = { ...base, current: { ...base.current, dirty: true } };
      await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
      const commitsBefore = commits.mock.calls.length;
      fireEvent.click(screen.getByText("ss"));
      await waitFor(() => expect(commits.mock.calls.length).toBeGreaterThan(commitsBefore));
      expect(screen.getByTestId("diff-single")).toBeInTheDocument();
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
  });

  it("I-5（vs 目前狀態）：無關的 context 變動（splitMode）→ 不重建唯讀編輯器、不重讀活文件", async () => {
    // 清單重抓那段同上一案：今天對 VersionPreview 是空操作，保留為回歸防線。
    const routes: Record<string, unknown> = routesV1();
    stub(routes);
    const commits = vi.fn();
    const { queryClient } = renderPreview({ seq: 1, live: V2, profile: commits });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      const base = list([ver(2), ver(1)]);
      routes[`/api/notes/${NOTE}/versions?limit=50`] = { ...base, current: { ...base.current, dirty: true } };
      await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
      const commitsBefore = commits.mock.calls.length;
      fireEvent.click(screen.getByText("ss"));
      await waitFor(() => expect(commits.mock.calls.length).toBeGreaterThan(commitsBefore));
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
  });

  it("rev 10：右選某版 → 兩個快照比較，方向左→右（左 v2、右 v1：B added、C 刪除、A changed）；不讀活文件", async () => {
    stub(routesV1());
    renderPreview({ seq: 2, right: 1, live: [{ id: "Z", type: "paragraph", content: "活" }] });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="B"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull();
    expect(view.querySelector('[data-id^="diff-del-"][data-diff="deleted"]')).not.toBeNull();
    expect(view.querySelector('[data-id="C"]')).toBeNull();
    expect(view.querySelector('[data-id="Z"]')).toBeNull();
    // 刪除的那顆是 C 的文字
    expect(view.querySelector('[data-diff="deleted"]')).toHaveTextContent("丙");
  });

  it("rev 10：右選到比左新的版（左 v1、右 v2）照樣算、不換邊：C added、B 刪除；觸發鈕仍是左 v1、右 v2", async () => {
    stub(routesV1());
    renderPreview({ seq: 1, right: 2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-diff="deleted"]')).toHaveTextContent("乙");
    const banner = within(screen.getByTestId("preview-banner"));
    expect(banner.getByRole("button", { name: "Left side" })).toHaveTextContent("v1");
    expect(banner.getByRole("button", { name: "Right side" })).toHaveTextContent("v2");
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":1');
    expect(screen.getByTestId("right-state")).toHaveTextContent('"seq":2');
  });

  it("只看差異：未變更的區塊折成一行", async () => {
    const many = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }, { id: "E", type: "paragraph", content: "戊" }];
    const many2 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }, { id: "E", type: "paragraph", content: "戊改" }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(many) },
    });
    renderPreview({ seq: 1, live: many2 });
    fireEvent.click(await screen.findByRole("button", { name: "Only changes" }));
    expect(await screen.findByText("… 2 unchanged blocks …")).toBeInTheDocument();
  });

  it("並排（門檻 720）：寬 >= 720 自動並排（兩顆唯讀編輯器、左右各標、grid 兩欄）；手動「單欄」蓋過", async () => {
    stub(routesV1());
    widthRef.current = 720;
    renderPreview({ seq: 1, live: V2 });
    const split = await screen.findByTestId("diff-split");
    // 窄時不走並排渲染，所以並排一律兩欄（沒有「窄時上下疊」的容器查詢）。
    expect(split).toHaveClass("grid", "grid-cols-2");
    expect(split).not.toHaveClass("grid-cols-1");
    const [left, right] = within(split).getAllByTestId("diff-pane");
    await waitFor(() => expect(left.querySelector('[data-id="B"][data-diff="deleted"]')).not.toBeNull());
    await waitFor(() => expect(right.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Single column" }));
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
  });

  it("rev 10：並排時兩欄標頭是兩個下拉（左側 v1／右側 Current state），不是純文字 h3；橫幅沒有下拉", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    const split = await screen.findByTestId("diff-split");
    // 標頭列與兩欄同一組 grid 兩欄（左右對齊），標頭列在兩欄之上。
    const head = screen.getByTestId("diff-split-head");
    expect(head).toHaveClass("grid", "grid-cols-2", "gap-4");
    expect(head.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const [leftCell, rightCell] = Array.from(head.children) as HTMLElement[];
    expect(within(leftCell).getByRole("button", { name: "Left side" })).toHaveTextContent("v1");
    expect(within(rightCell).getByRole("button", { name: "Right side" })).toHaveTextContent("Current state");
    expect(document.querySelector('[data-testid="diff-split-head"] h3, [data-testid="diff-split"] h3')).toBeNull();
    const banner = within(screen.getByTestId("preview-banner"));
    await waitFor(() => expect(banner.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true"));
    expect(banner.queryByRole("button", { name: "Left side" })).not.toBeInTheDocument();
    expect(banner.queryByRole("button", { name: "Right side" })).not.toBeInTheDocument();
  });

  it("review I-1：並排、右選 v1 的快照讀取失敗（500）→ 欄標頭的下拉仍在；右選回「Current state」→ 錯誤消失、仍在預覽", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as Response);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return ok(list([ver(2), ver(1)]));
        if (url === `/api/notes/${NOTE}/versions/2`) return ok({ id: "v-2", seq: 2, ydoc: b64(V2) });
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    widthRef.current = 900;
    renderPreview({ seq: 2, right: 1, live: V1 });
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    const right = within(screen.getByTestId("diff-split-head")).getByRole("button", { name: "Right side" });
    expect(right).toHaveTextContent("v1");
    fireEvent.pointerDown(right, { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: "Current state" }));
    await waitFor(() => expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument());
    expect(screen.getByTestId("right-state")).toHaveTextContent('"current"');
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
  });

  it("review I-1：並排、在欄標頭選一個未快取的版本（快照 pending）→ 標頭列仍在、同一顆觸發鈕仍掛載", async () => {
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as Response);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return ok(list([ver(2), ver(1)]));
        if (url === `/api/notes/${NOTE}/versions/1`) return ok({ id: "v-1", seq: 1, ydoc: b64(V1) });
        if (url === `/api/notes/${NOTE}/versions/2`)
          return new Promise<Response>((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve({ id: "v-2", seq: 2, ydoc: b64(V2) }) } as Response)));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const right = within(screen.getByTestId("diff-split-head")).getByRole("button", { name: "Right side" });
    fireEvent.pointerDown(right, { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: "v2" }));
    expect(await screen.findByText("Loading version…")).toBeInTheDocument();
    expect(screen.getByTestId("diff-split-head")).toBeInTheDocument();
    expect(right.isConnected).toBe(true);
    expect(right).toHaveTextContent("v2");
    release();
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
  });

  it("final M-1：並排時「只看差異」不起作用 → 橫幅的開關 aria-disabled＋title 說明、點了不切；切回單欄後恢復可按", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = within(screen.getByTestId("preview-banner"));
    const only = banner.getByRole("button", { name: "Only changes" });
    await waitFor(() => expect(only).toHaveAttribute("aria-disabled", "true"));
    expect(only).toHaveAttribute("title", "Only changes works in single column");
    // N-B：報讀器的說明走 aria-describedby 指向 sr-only 文字，不只靠 title（toHaveAccessibleDescription 會退回 title，分不出來，所以直接查參照）。
    const describedBy = only.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent("Only changes works in single column");
    expect(document.getElementById(describedBy!)).toHaveClass("sr-only");
    fireEvent.click(only);
    expect(only).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(banner.getByRole("button", { name: "Single column" }));
    await screen.findByTestId("diff-single");
    await waitFor(() => expect(only).not.toHaveAttribute("aria-disabled"));
    // Task 19：圖示鈕的 title 平時是名稱（hover 看得到），停用時才換成說明。
    expect(only).toHaveAttribute("title", "Only changes");
    expect(only).not.toHaveAttribute("aria-describedby");
    fireEvent.click(only);
    expect(only).toHaveAttribute("aria-pressed", "true");
  });

  it("final §14-6：預覽區 < 720 px → 沒有並排：「Side by side」「Single column」兩顆都不渲染，DOM 只有單欄 diff", async () => {
    stub(routesV1());
    widthRef.current = 719;
    renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const banner = within(screen.getByTestId("preview-banner"));
    expect(banner.getByRole("button", { name: "Only changes" })).toBeInTheDocument();
    expect(banner.queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
    expect(banner.queryByRole("button", { name: "Single column" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-split")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("diff-single-editor")).toHaveLength(1);
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();
  });

  it("final §14-6：≥ 720 px 鈕存在、auto 以實際生效的「Side by side」為按下；選單欄 → 單欄按下；選回並排 → 兩欄；縮窄 → 只剩單欄且鈕消失；再變寬 → 回到選過的並排", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, right: 2, live: V2 });
    // 起點右邊是 v2；下面靠「rc」（右回目前狀態）／「r」（右回 v2）兩種 context 變動觸發重新 render。
    await screen.findByTestId("diff-split");
    const banner = () => within(screen.getByTestId("preview-banner"));
    const split = () => banner().getByRole("button", { name: "Side by side" });
    const single = () => banner().getByRole("button", { name: "Single column" });
    await waitFor(() => expect(split()).toHaveAttribute("aria-pressed", "true"));
    expect(single()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(single());
    await screen.findByTestId("diff-single");
    expect(single()).toHaveAttribute("aria-pressed", "true");
    expect(split()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(split());
    expect(await screen.findByTestId("diff-split")).toHaveClass("grid-cols-2");
    expect(split()).toHaveAttribute("aria-pressed", "true");
    // 縮窄：useContainerWidth 被 mock 成讀 widthRef，靠一次 context 變動（換右邊）觸發重新 render。
    widthRef.current = 600;
    fireEvent.click(screen.getByText("rc"));
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
    await waitFor(() => expect(banner().queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument());
    expect(screen.queryByTestId("diff-split")).not.toBeInTheDocument();
    widthRef.current = 900;
    fireEvent.click(screen.getByText("r"));
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
    await waitFor(() => expect(split()).toHaveAttribute("aria-pressed", "true"));
  });

  it("final fix 2 M-B：寬時手動選單欄 → 縮到 < 720 → 再變回 ≥ 720 仍是單欄（手動選擇有保留，不被 auto 蓋掉）", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, right: 2, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = () => within(screen.getByTestId("preview-banner"));
    fireEvent.click(banner().getByRole("button", { name: "Single column" }));
    await screen.findByTestId("diff-single");
    // 縮窄／變寬：useContainerWidth 被 mock 成讀 widthRef，靠一次 context 變動（換右邊）觸發重新 render。
    widthRef.current = 600;
    fireEvent.click(screen.getByText("rc"));
    await waitFor(() => expect(banner().queryByRole("button", { name: "Single column" })).not.toBeInTheDocument());
    widthRef.current = 900;
    fireEvent.click(screen.getByText("r"));
    await waitFor(() => expect(banner().getByRole("button", { name: "Single column" })).toHaveAttribute("aria-pressed", "true"));
    expect(banner().getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-split")).not.toBeInTheDocument();
  });

  it("rev 10 樣式：切換鈕（並排／單欄、只看差異）的按下鈕帶 bg-brand/25＋hover:bg-brand/30（品牌色底上看得出），hover 不會換回 bg-accent", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = within(screen.getByTestId("preview-banner"));
    const split = banner.getByRole("button", { name: "Side by side" });
    await waitFor(() => expect(split).toHaveAttribute("aria-pressed", "true"));
    expect(split).toHaveClass("bg-brand/25", "hover:bg-brand/30");
    // ghost 的 hover:bg-accent：留著的話，滑鼠停在按下鈕上時按下底色會被蓋掉（final fix 2，真瀏覽器截圖 12／13 的現象）。
    expect(split).not.toHaveClass("hover:bg-accent");
    const idle = banner.getByRole("button", { name: "Single column" });
    expect(idle).toHaveAttribute("aria-pressed", "false");
    expect(idle).not.toHaveClass("bg-brand/25");
  });

  it("final fix 2 樣式：並排兩欄的內文不套 justify（index.css 在 .kb-diff-split 之下把未自訂對齊的區塊改回 left；jsdom 不載 index.css，計算樣式由 e2e 截圖驗）", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const justifyAt = css.search(/text-align:\s*justify;/);
    const rule = /\.kb-diff-split \.bn-editor \.bn-block-content:not\(\[data-text-alignment\]\)\s*\{[^}]*text-align:\s*left;[^}]*\}/.exec(css);
    expect(justifyAt).toBeGreaterThan(-1);
    expect(rule, "找不到 .kb-diff-split 的 text-align:left 覆寫").not.toBeNull();
    // 特性相同（0,4,0），靠出現順序勝出：覆寫必須在 justify 規則之後。
    expect(rule!.index).toBeGreaterThan(justifyAt);
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    expect(await screen.findByTestId("diff-split")).toHaveClass("kb-diff-split");
  });

  it("final Task 8 ready：清單背景重抓失敗（data 還在）→ 預覽留著，不變回「正在載入」", async () => {
    let failList = false;
    const listUrl = `/api/notes/${NOTE}/versions?limit=50`;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === listUrl) {
          if (failList) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list([ver(1)])) } as Response);
        }
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "v-1", seq: 1, ydoc: b64(V1) }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { queryClient } = renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    failList = true;
    await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
    await waitFor(() => expect(queryClient.getQueryState(["notes", NOTE, "versions"])?.status).toBe("error"));
    expect(calls.filter((u) => u === listUrl).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Loading version…")).not.toBeInTheDocument();
    expect(screen.getByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument();
  });

  it("forceSingle（窄視窗整頁）：一律單欄、沒有並排／單欄切換鈕", async () => {
    stub(routesV1());
    widthRef.current = 1600;
    renderPreview({ seq: 1, live: V2, forceSingle: true });
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
  });

  it("非文字區塊 changed → 「已變更 · 看前後」按鈕，點開是兩顆唯讀 mini editor 的對話框", async () => {
    const i1 = [{ id: "I", type: "image", props: { url: "/api/uploads/1" } }];
    const i2 = [{ id: "I", type: "image", props: { url: "/api/uploads/2" } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(i1) },
    });
    renderPreview({ seq: 1, live: i2 });
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

  it("左邊快照 id 不符 → toast「這一版已經不存在」、離開預覽", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-OTHER", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    expect(await screen.findByText("This version no longer exists. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent("null"));
  });

  it("rev 10：右邊快照 id 不符 → 右邊回到目前狀態、toast 同一句、不離開預覽", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-OTHER", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 2, right: 1, live: V1 });
    expect(await screen.findByText("This version no longer exists. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("right-state")).toHaveTextContent('"current"'));
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
    // 改比活文件（V1）：左 v2 → 右 V1：B added
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="B"][data-diff="added"]')).not.toBeNull());
    expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument();
    // N-1：toast 只出現一次（重設後右快照 query 停用，rightGone 不會再翻 true）。等一段讓可能的第二發有機會出現。
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getAllByText("This version no longer exists. The list has been refreshed.")).toHaveLength(1);
  });

  it("rev 10：右邊快照讀取失敗（非 id 不符）→ 預覽區顯示通用錯誤、不離開預覽", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as Response);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return ok(list([ver(2), ver(1)]));
        if (url === `/api/notes/${NOTE}/versions/2`) return ok({ id: "v-2", seq: 2, ydoc: b64(V2) });
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPreview({ seq: 2, right: 1 });
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
  });

  it("Task 19 橫幅：三顆模式鈕是圖示鈕（aria-label＋title＝名稱、沒有文字、h-7 w-7）、包在 ml-auto 容器裡置右；沒有 ✕（Close preview）", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = screen.getByTestId("preview-banner");
    const names = ["Side by side", "Single column", "Only changes"] as const;
    const buttons = names.map((name) => within(banner).getByRole("button", { name }));
    await waitFor(() => expect(buttons[2]).toHaveAttribute("aria-disabled", "true"));
    buttons.forEach((b, i) => {
      expect(b).toHaveAttribute("aria-label", names[i]);
      expect(b).toHaveClass("h-7", "w-7");
      expect(b.textContent).toBe("");
      expect(b.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });
    expect(buttons[0]).toHaveAttribute("title", "Side by side");
    expect(buttons[1]).toHaveAttribute("title", "Single column");
    // 只看差異在並排時停用：title 換成說明（final M-1 保留）。
    expect(buttons[2]).toHaveAttribute("title", "Only changes works in single column");
    expect(buttons[0].querySelector("svg")).toHaveAttribute("data-icon", "columns-2");
    expect(buttons[1].querySelector("svg")).toHaveAttribute("data-icon", "rows-3");
    expect(buttons[2].querySelector("svg")).toHaveAttribute("data-icon", "list-filter");
    // 三顆同一個 ml-auto 容器（置右；真瀏覽器的實際位置由截圖驗【推】）。
    const group = buttons[0].parentElement!;
    expect(group).toHaveClass("ml-auto");
    expect(buttons[1].parentElement).toBe(group);
    expect(buttons[2].parentElement).toBe(group);
    expect(within(banner).queryByRole("button", { name: "Close preview" })).not.toBeInTheDocument();
    expect(within(banner).queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
  });

  it("rev 10 橫幅：bg-brand-soft（不是 bg-accent、不是 bg-primary）、「Previewing v1」、沒有時間／editors／Compare with；單欄時有左右兩個下拉（中間 →）", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    const banner = await screen.findByTestId("preview-banner");
    expect(banner).toHaveClass("bg-brand-soft");
    expect(banner).not.toHaveClass("bg-accent");
    expect(banner).not.toHaveClass("flex-wrap");
    expect(banner).toHaveClass("flex-nowrap");
    await waitFor(() => expect(within(banner).getByRole("button", { name: "Left side" })).toHaveTextContent("v1"));
    expect(within(banner).getByRole("button", { name: "Right side" })).toHaveTextContent("Current state");
    // 收尾 M-A：單欄時欄標頭列不存在，整頁上的下拉只有橫幅那一對。
    await screen.findByTestId("diff-single");
    expect(screen.queryByTestId("diff-split-head")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Left side" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Right side" })).toHaveLength(1);
    expect(within(banner).getByText("Previewing v1")).toBeInTheDocument();
    expect(within(banner).getByText("→")).toHaveAttribute("aria-hidden", "true");
    expect(banner).not.toHaveTextContent("ann");
    expect(banner).not.toHaveTextContent("Compare with");
    expect(banner).not.toHaveTextContent("2026");
    expect(banner).not.toHaveTextContent("Previous version");
    // Task 19：橫幅不再有 ✕；Esc 離開預覽由 NotePage.test「Esc（沒有浮層）」守，面板的離開方式由 VersionsPanel.test 守。
    expect(within(banner).queryByRole("button", { name: "Close preview" })).not.toBeInTheDocument();
  });

  it("fix1 M-4：「看前後」對話框開著時換一版預覽 → 對話框關掉，新一版的鈕照常出現", async () => {
    const img = (n: number) => [{ id: "I", type: "image", props: { url: `/api/uploads/${n}` } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(3), ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/3`]: { id: "v-3", seq: 3, ydoc: b64(img(3)) },
      [`/api/notes/${NOTE}/versions/2`]: { id: "v-2", seq: 2, ydoc: b64(img(2)) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-1", seq: 1, ydoc: b64(img(1)) },
    });
    renderPreview({ seq: 2, seq2: 3, live: img(9) });
    fireEvent.click(await screen.findByRole("button", { name: "Changed · see before and after" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("go2"));
    await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":3'));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Changed · see before and after" })).toBeInTheDocument();
  });
});
