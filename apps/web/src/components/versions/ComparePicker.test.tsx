import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionDto, VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useMemo } from "react";
import { useVersionList } from "@/api/versions";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { ComparePicker } from "./ComparePicker";

const NOTE = "n1";
const FIRST = `/api/notes/${NOTE}/versions?limit=50`;
const ver = (seq: number, name: string | null = null): VersionDto => ({ id: `v-${seq}`, seq, kind: "manual", name, editors: [], baseSeq: null, createdAt: "2026-10-09T00:00:00.000Z" });
const list = (versions: VersionDto[], nextBefore: number | null = null): VersionListDto => ({
  versions,
  current: { baseSeq: versions[0]?.seq ?? null, dirty: false, nextSeq: (versions[0]?.seq ?? 0) + 1, autoEnabled: true },
  nextBefore,
});

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

/** 清單已載入的探針：觸發鈕只顯示 vN（C1），不再能拿它判斷清單到了沒。同一個 query key，與 picker 共用快取。 */
function ListProbe() {
  const list = useVersionList(NOTE, true);
  return <span data-testid="rows">{list.data ? "loaded" : "pending"}</span>;
}
async function listLoaded() {
  await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("loaded"));
}

/** controller 狀態探針：左＝preview、右＝compareRight。`startPreview` 包一層計數（N-3：重選同一版不呼叫）。 */
const startCalls: unknown[] = [];
function Host({ start }: { start: { seq: number; id: string } }) {
  const inner = useVersionsController({ noteId: NOTE, enabled: true });
  const value = useMemo(
    () => ({
      ...inner,
      startPreview: (t: { seq: number; id: string }) => {
        startCalls.push(t);
        inner.startPreview(t);
      },
    }),
    [inner],
  );
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview(start)}>
        go
      </button>
      <ListProbe />
      <span data-testid="left">{JSON.stringify(value.preview)}</span>
      <span data-testid="right">{JSON.stringify(value.compareRight)}</span>
      {value.preview && (
        <>
          <ComparePicker side="left" />
          <ComparePicker side="right" />
        </>
      )}
    </VersionsProvider>
  );
}

function renderPicker(start = { seq: 2, id: "v-2" }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host start={start} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("go"));
}

async function openPicker(name: "Left side" | "Right side") {
  fireEvent.pointerDown(await screen.findByRole("button", { name }), { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

describe("ComparePicker（spec §8.4【rev 10】）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    startCalls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("C1：觸發鈕只顯示 vN（有名稱也不顯示名稱）、右預設「Current state」；名稱只在下拉項裡；aria-label 左側／右側", async () => {
    stub({ [FIRST]: list([ver(2, "定稿"), ver(1)]) });
    renderPicker();
    await listLoaded();
    const left = screen.getByRole("button", { name: "Left side" });
    expect(left.textContent).toBe("v2");
    expect(screen.getByRole("button", { name: "Right side" }).textContent).toBe("Current state");
    const menu = await openPicker("Left side");
    expect(within(menu).getByRole("menuitemradio", { name: "v2 定稿" })).toHaveAttribute("aria-checked", "true");
  });

  it("N-3：左下拉重選已勾的同一版 → 不呼叫 startPreview（不重新取樣目前狀態、不重建預覽）", async () => {
    stub({ [FIRST]: list([ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    expect(startCalls).toHaveLength(1); // 「go」那一次
    fireEvent.click(within(await openPicker("Left side")).getByRole("menuitemradio", { name: "v2" }));
    expect(startCalls).toHaveLength(1);
    expect(screen.getByTestId("right")).toHaveTextContent('"current"');
  });

  it("M-1：載下一頁進行中 → 載入項 disabled，再點不會多打一次", async () => {
    const page2 = `/api/notes/${NOTE}/versions?before=2&limit=50`;
    const calls: string[] = [];
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list([ver(2)], 2)) } as Response);
        if (url === page2)
          return new Promise<Response>((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve(list([ver(1)])) } as Response)));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    const item = within(menu).getByRole("menuitem", { name: "Load older versions" });
    fireEvent.click(item);
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Load older versions" })).toHaveAttribute("data-disabled"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Load older versions" }));
    expect(calls.filter((u) => u === page2)).toHaveLength(1);
    release();
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "v1" })).toBeInTheDocument());
    expect(calls.filter((u) => u === page2)).toHaveLength(1);
  });

  it("左邊的選項＝清單所有版本（沒有「Current state」），aria-checked 在目前值上", async () => {
    stub({ [FIRST]: list([ver(3), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["v3", "v2", "v1"]);
    expect(within(menu).getByRole("menuitemradio", { name: "v2" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: "v3" })).toHaveAttribute("aria-checked", "false");
  });

  it("右邊的選項＝「Current state」在最前＋所有版本；預設勾在「Current state」", async () => {
    stub({ [FIRST]: list([ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Right side");
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Current state", "v2", "v1"]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
  });

  it("選左 → startPreview（左換、右不動）", async () => {
    stub({ [FIRST]: list([ver(3), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "v1" }));
    expect(screen.getByTestId("left")).toHaveTextContent(JSON.stringify({ seq: 1, id: "v-1" }));
    expect(screen.getByTestId("right")).toHaveTextContent('"current"');
    await waitFor(() => expect(screen.getByRole("button", { name: "Left side" })).toHaveTextContent("v1"));
  });

  it("選右 → setCompareRight（某版／再選回 Current state）；左不動", async () => {
    stub({ [FIRST]: list([ver(3), ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    fireEvent.click(within(await openPicker("Right side")).getByRole("menuitemradio", { name: "v3" }));
    expect(screen.getByTestId("right")).toHaveTextContent(JSON.stringify({ seq: 3, id: "v-3" }));
    expect(screen.getByTestId("left")).toHaveTextContent(JSON.stringify({ seq: 2, id: "v-2" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Right side" })).toHaveTextContent("v3"));
    fireEvent.click(within(await openPicker("Right side")).getByRole("menuitemradio", { name: "Current state" }));
    expect(screen.getByTestId("right")).toHaveTextContent('"current"');
  });

  it("有下一頁 → 選單底部「Load older versions」；點了 fetchNextPage、選單不關、新版本出現在選項裡", async () => {
    const calls = stub({
      [FIRST]: list([ver(2)], 2),
      [`/api/notes/${NOTE}/versions?before=2&limit=50`]: list([ver(1)]),
    });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Right side");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Load older versions" }));
    await waitFor(() => expect(calls).toContain(`/api/notes/${NOTE}/versions?before=2&limit=50`));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "v1" })).toBeInTheDocument());
    // 到底了：載入項消失
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Load older versions" })).not.toBeInTheDocument();
  });

  it("載下一頁失敗 → 不自動重抓（只打一次）；項目留著可再手動按", async () => {
    const page2 = `/api/notes/${NOTE}/versions?before=2&limit=50`;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list([ver(2)], 2)) } as Response);
        if (url === page2) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Load older versions" }));
    await waitFor(() => expect(calls.filter((u) => u === page2)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((u) => u === page2)).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Load older versions" })).not.toHaveAttribute("data-disabled"));
  });

  it("沒有下一頁 → 沒有「Load older versions」", async () => {
    stub({ [FIRST]: list([ver(2), ver(1)]) });
    renderPicker();
    await listLoaded();
    const menu = await openPicker("Left side");
    expect(within(menu).queryByRole("menuitem", { name: "Load older versions" })).not.toBeInTheDocument();
  });
});
