import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { VersionCurrentDto, VersionDto, VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { versionListKey, versionsKey } from "@/api/versions";
import { KIND_FILTER_STORAGE_KEY, VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { VersionsPanel } from "./VersionsPanel";

const NOTE = "n1";
const v = (seq: number, over: Partial<VersionDto> = {}): VersionDto => ({
  id: `v-${seq}`,
  seq,
  kind: "auto",
  name: null,
  editors: [{ handle: "ann", agentLabel: null }],
  baseSeq: null,
  createdAt: "2026-10-09T01:00:00.000Z",
  ...over,
});
const cur = (over: Partial<VersionCurrentDto> = {}): VersionCurrentDto => ({ baseSeq: null, dirty: false, nextSeq: 1, autoEnabled: true, ...over });

function stub(pages: Record<string, VersionListDto>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = pages[url];
      if (!body) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    }),
  );
  return calls;
}
const FIRST = `/api/notes/${NOTE}/versions?limit=50`;
const FIRST_MANUAL = `/api/notes/${NOTE}/versions?kind=manual&limit=50`;

function Probe() {
  const s = useVersions();
  return (
    <span data-testid="state">
      {JSON.stringify({ preview: s.preview, mode: s.mode, dialog: s.dialog?.kind ?? null, dialogSeq: s.dialog && "version" in s.dialog ? s.dialog.version.seq : null })}
    </span>
  );
}
function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={value.open}>host-open</button>
      <Probe />
      {value.panelOpen && <VersionsPanel doc={doc} />}
    </VersionsProvider>
  );
}
function renderPanel(doc = new Y.Doc()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={queryClient}>
      <Host doc={doc} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("host-open"));
  return { ...r, doc, queryClient };
}
const state = () => JSON.parse(screen.getByTestId("state").textContent!);

describe("VersionsPanel（spec §8.2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("卡片 class：md:static md:w-80（w-80 不帶前綴即錯）＋ cardSurface", async () => {
    stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    renderPanel();
    const panel = await screen.findByTestId("versions-panel");
    expect(panel).toHaveClass("md:static", "md:w-80", "rounded-xl", "border", "bg-card");
    expect(panel).not.toHaveClass("w-80");
  });

  // #258：副標只看 current.baseSeq／dirty，與清單內容無關（清單可能被篩過、或根本是空的）。
  it.each([
    ["沒有基底（清單空）", { versions: [], current: cur() }, "No base version"],
    ["沒有基底版本", { versions: [v(2), v(1)], current: cur({ baseSeq: null, dirty: true, nextSeq: 3 }) }, "No base version"],
    ["沿自 vN · 無修改", { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: false, nextSeq: 3 }) }, "Based on v2 · no changes"],
    ["沿自 vN · 有未儲存的修改（vN 是最新）", { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: true, nextSeq: 3 }) }, "Based on v2 · unsaved changes"],
    ["沿自 vN · 有未儲存的修改（vN 不是最新）", { versions: [v(2), v(1)], current: cur({ baseSeq: 1, dirty: true, nextSeq: 3 }) }, "Based on v1 · unsaved changes"],
    ["基底不在清單裡（被篩掉）", { versions: [v(2)], current: cur({ baseSeq: 7, dirty: false, nextSeq: 8 }) }, "Based on v7 · no changes"],
  ])("目前狀態副標：%s", async (_name, body, text) => {
    stub({ [FIRST]: { ...(body as Omit<VersionListDto, "nextBefore">), nextBefore: null } });
    renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText(text)).toBeInTheDocument();
  });

  it("!autoEnabled → 副標下多一行「此空間已關閉自動儲存」；autoEnabled 時沒有", async () => {
    stub({ [FIRST]: { versions: [v(1)], current: cur({ baseSeq: 1, autoEnabled: false, nextSeq: 2 }), nextBefore: null } });
    const { queryClient } = renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText("Automatic saving is off for this space")).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(versionListKey(NOTE, "all"), {
        pages: [{ versions: [v(1)], current: cur({ baseSeq: 1, autoEnabled: true, nextSeq: 2 }), nextBefore: null }],
        pageParams: [undefined],
      });
    });
    await waitFor(() => expect(screen.queryByText("Automatic saving is off for this space")).not.toBeInTheDocument());
    expect(within(top).getByText("Based on v1 · no changes")).toBeInTheDocument();
  });

  it("列（#258）：沒有基底綠點、沒有「手動／自動」文字；只有自動版本有「Auto-saved」pill；第二行 編輯者（agent）· 時間 · 沿自 vX；刪除的使用者顯示替代字", async () => {
    stub({
      [FIRST]: {
        versions: [
          v(3, { kind: "manual", name: "給客戶", baseSeq: 1, editors: [{ handle: "ann", agentLabel: null }, { handle: "bob", agentLabel: "Claude" }] }),
          v(2, { editors: [{ handle: "", agentLabel: null }] }),
          v(1),
        ],
        current: cur({ baseSeq: 3, nextSeq: 4 }),
        nextBefore: null,
      },
    });
    renderPanel();
    const row3 = await screen.findByRole("button", { name: /^v3/ });
    expect(within(row3).getByText("給客戶")).toBeInTheDocument();
    expect(screen.queryByTestId("base-dot")).not.toBeInTheDocument();
    expect(row3).toHaveTextContent("ann, bob (Claude) ·");
    expect(row3).toHaveTextContent("based on v1");
    expect(row3).not.toHaveTextContent("Manual");
    expect(within(row3).queryByTestId("auto-badge")).not.toBeInTheDocument();
    const row2 = screen.getByRole("button", { name: /^v2/ });
    expect(row2).toHaveTextContent("Deleted user ·");
    expect(within(row2).getByTestId("auto-badge")).toHaveTextContent("Auto-saved");
    expect(within(row2).getByTestId("auto-badge")).toHaveClass("shrink-0", "rounded-full", "border", "border-border", "bg-muted", "text-foreground/70");
    expect(screen.getAllByTestId("auto-badge")).toHaveLength(2);
    // 名稱很長時 pill 不被擠掉：名稱 truncate、pill shrink-0。
    expect(within(row3).getByText("給客戶")).toHaveClass("truncate");
  });

  it("點列＝切換預覽（startPreview 帶 seq 與 id）；選中列 bg-accent；再點另一列換過去", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^v1/ }));
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
    expect(screen.getByRole("button", { name: /^v1/ })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: /^v2/ })).not.toHaveClass("bg-accent");
    fireEvent.click(screen.getByRole("button", { name: /^v2/ }));
    expect(state().preview).toEqual({ seq: 2, id: "v-2" });
  });

  it("Task 19：再點已選中的那一列 → 離開預覽（toggle）；再點一次又進預覽", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const row1 = await screen.findByRole("button", { name: /^v1/ });
    fireEvent.click(row1);
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
    fireEvent.click(row1);
    expect(state().preview).toBeNull();
    expect(row1).not.toHaveClass("bg-accent");
    fireEvent.click(row1);
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
  });

  it("Task 19：點清單空白處（<ul> 本身）→ 離開預覽；點列、點 ⋯ 都不算空白（不離開）", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^v1/ }));
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
    // 點另一列（事件冒泡到 <ul>）：換預覽、不離開。
    fireEvent.click(screen.getByRole("button", { name: /^v2/ }));
    expect(state().preview).toEqual({ seq: 2, id: "v-2" });
    // 點 ⋯（冒泡到 <ul>）：預覽留著。
    fireEvent.click(screen.getByRole("button", { name: "Actions for v1" }));
    expect(state().preview).toEqual({ seq: 2, id: "v-2" });
    // 點 <li> 列與 ⋯ 之間的空隙也不算（target 是 <li> 不是 <ul>）。
    fireEvent.click(screen.getByRole("button", { name: /^v1/ }).closest("li")!);
    expect(state().preview).toEqual({ seq: 2, id: "v-2" });
    // 按下與放開都在 <ul> 本身才算點空白（review M-1）。
    const list = screen.getByRole("list");
    fireEvent.pointerDown(list);
    fireEvent.click(list);
    expect(state().preview).toBeNull();
    expect(state().mode).toBe("panel");
  });

  it("Task 19 review M-1：在列上按下、拖到列間縫放開（click 派到 <ul>）→ 不離開預覽；之後單獨一發 click 到 <ul> 也不算", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const row1 = await screen.findByRole("button", { name: /^v1/ });
    fireEvent.click(row1);
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
    const list = screen.getByRole("list");
    // 瀏覽器在按下與放開的元素不同時，click 派給兩者的共同祖先（這裡是 <ul>）。
    fireEvent.pointerDown(row1);
    fireEvent.click(list);
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
    // 上一發的記錄用過即清：沒有 pointerdown 的 click 不會沿用。
    fireEvent.click(list);
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
  });

  it("Task 19：面板 ✕ 關面板 → 一併離開預覽", async () => {
    stub({ [FIRST]: { versions: [v(1)], current: cur({ baseSeq: 1, nextSeq: 2 }), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^v1/ }));
    expect(state().preview).toEqual({ seq: 1, id: "v-1" });
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(state().mode).toBeNull();
    expect(state().preview).toBeNull();
  });

  it("鍵盤：在列上按 ↓／↑ 移動焦點並切換預覽", async () => {
    stub({ [FIRST]: { versions: [v(3), v(2), v(1)], current: cur({ baseSeq: 3, nextSeq: 4 }), nextBefore: null } });
    renderPanel();
    const row3 = await screen.findByRole("button", { name: /^v3/ });
    row3.focus();
    fireEvent.keyDown(row3, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^v2/ })).toHaveFocus();
    expect(state().preview).toEqual({ seq: 2, id: "v-2" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(row3).toHaveFocus();
    expect(state().preview).toEqual({ seq: 3, id: "v-3" });
  });

  it("底部鈕：沒有選中 → 套用 disabled；選中 v1 → 「Apply v1」可按；儲存在 dirty 或沒有基底時才亮", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: false, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const footer = await screen.findByTestId("versions-footer");
    // 先等清單落地：footer 在資料到之前就存在，此時 current 為 undefined、儲存鈕恆 disabled（斷言會空轉）。
    const row1 = await screen.findByRole("button", { name: /^v1/ });
    expect(within(footer).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(within(footer).getByRole("button", { name: "Save current version" })).toBeDisabled();
    fireEvent.click(row1);
    expect(within(footer).getByRole("button", { name: "Apply v1" })).toBeEnabled();
  });

  it("底部「儲存當前版本」：有基底且 dirty → 亮", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, dirty: true, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    const footer = await screen.findByTestId("versions-footer");
    await screen.findByRole("button", { name: /^v2/ });
    await waitFor(() => expect(within(footer).getByRole("button", { name: "Save current version" })).toBeEnabled());
  });

  it("底部「儲存當前版本」：沒有基底（即使乾淨）也亮，點了開儲存對話框", async () => {
    stub({ [FIRST]: { versions: [], current: cur({ baseSeq: null, dirty: false }), nextBefore: null } });
    renderPanel();
    const save = await within(await screen.findByTestId("versions-footer")).findByRole("button", { name: "Save current version" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(state().dialog).toBe("save");
  });

  it("⋯ 選單：套用、編輯版本名稱、刪除；基底版的刪除 disabled 並有看得見的說明", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Actions for v2" }), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Apply" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Edit version name" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Delete/ })).toHaveAttribute("data-disabled");
    expect(within(menu).getByText("The base of the current content can't be deleted")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Edit version name" }));
    expect(state()).toMatchObject({ dialog: "rename", dialogSeq: 2 });
  });

  it("⋯ 選單：非基底版的刪除可按 → 開刪除對話框", async () => {
    stub({ [FIRST]: { versions: [v(2), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
    renderPanel();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Actions for v1" }), { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Delete/ }));
    expect(state()).toMatchObject({ dialog: "delete", dialogSeq: 1 });
  });

  it("游標：有 nextBefore 時顯示「載入更早的版本」，按了接續第二頁", async () => {
    const calls = stub({
      [FIRST]: { versions: [v(52)], current: cur({ baseSeq: 52, nextSeq: 53 }), nextBefore: 52 },
      [`/api/notes/${NOTE}/versions?before=52&limit=50`]: { versions: [v(51)], current: cur({ baseSeq: 52, nextSeq: 53 }), nextBefore: null },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Load older versions" }));
    expect(await screen.findByRole("button", { name: /^v51/ })).toBeInTheDocument();
    expect(calls).toContain(`/api/notes/${NOTE}/versions?before=52&limit=50`);
    expect(screen.queryByRole("button", { name: "Load older versions" })).not.toBeInTheDocument();
  });

  it("✕ 關閉面板（mode=null）", async () => {
    stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Close version history" }));
    expect(state().mode).toBeNull();
  });

  it("面板開著時活文件 update → 去抖動 1 s 後重抓清單（只一次）；面板關掉後不再重抓", async () => {
    const calls = stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
    const { doc, queryClient } = renderPanel();
    await screen.findByTestId("versions-current");
    await waitFor(() => expect(calls.filter((c) => c === FIRST)).toHaveLength(1));
    // 不開 shouldAdvanceTime（gate r1 M-2：真實時間會以 20 ms 為單位推假時鐘，「999 ms 時仍是 1 次」會間歇紅）。
    // 清單落地後才切 fake、推到 1000 後切回真 timer 再 waitFor（react-query 的通知排程走 setTimeout）。
    vi.useFakeTimers();
    doc.getText("t").insert(0, "a");
    doc.getText("t").insert(0, "b");
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(calls.filter((c) => c === FIRST)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();
    await waitFor(() => expect(calls.filter((c) => c === FIRST)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    doc.getText("t").insert(0, "c");
    await new Promise((r) => setTimeout(r, 1100));
    expect(calls.filter((c) => c === FIRST)).toHaveLength(2);
    // 卸載後沒有 observer，invalidate 只會把 query 標 stale、不會重抓——所以光看 fetch 次數抓不到「監聽沒拆」；
    // 殘留的監聽會把 query 標成 invalidated，這裡直接看這個旗標。
    expect(queryClient.getQueryState(versionListKey(NOTE, "all"))?.isInvalidated).toBe(false);
  });
  describe("篩選（#258）", () => {
    const manual = (seq: number) => v(seq, { kind: "manual" });
    const ALL = { versions: [manual(4), v(3), manual(2), v(1)], current: cur({ baseSeq: 4, nextSeq: 5 }), nextBefore: null };
    const ONLY = { versions: [manual(4), manual(2)], current: cur({ baseSeq: 4, nextSeq: 5 }), nextBefore: null };

    it("清單上方有「All／Manual only」兩段切換（aria-pressed）；預設全部；按「Manual only」改打 kind=manual、清單只剩手動、按下態 PRESSED_CLASS", async () => {
      const calls = stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      renderPanel();
      await screen.findByRole("button", { name: /^v3/ });
      const group = screen.getByRole("group", { name: "Filter versions" });
      const allBtn = within(group).getByRole("button", { name: "All" });
      const manualBtn = within(group).getByRole("button", { name: "Manual only" });
      expect(allBtn).toHaveAttribute("aria-pressed", "true");
      expect(manualBtn).toHaveAttribute("aria-pressed", "false");
      expect(allBtn).toHaveClass("bg-brand/25");
      // 位置：在「目前狀態」之後、清單之前。
      const order = [screen.getByTestId("versions-current"), group, screen.getByRole("list")];
      for (let i = 1; i < order.length; i += 1) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(manualBtn);
      expect(await screen.findByRole("button", { name: /^v4/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^v2/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^v3/ })).not.toBeInTheDocument();
      expect(calls).toContain(FIRST_MANUAL);
      expect(manualBtn).toHaveAttribute("aria-pressed", "true");
      expect(manualBtn).toHaveClass("bg-brand/25");
      expect(allBtn).toHaveAttribute("aria-pressed", "false");
      // 「目前狀態」不受篩選影響。
      expect(within(screen.getByTestId("versions-current")).getByText("Based on v4 · no changes")).toBeInTheDocument();
    });

    it("篩選寫進 localStorage；初值讀 localStorage（不合法的值當全部）", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      const first = renderPanel();
      await screen.findByRole("button", { name: /^v3/ });
      fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
      expect(window.localStorage.getItem(KIND_FILTER_STORAGE_KEY)).toBe("manual");
      first.unmount();
      const second = renderPanel();
      expect(await screen.findByRole("button", { name: "Manual only" })).toHaveAttribute("aria-pressed", "true");
      await screen.findByRole("button", { name: /^v2/ });
      expect(screen.queryByRole("button", { name: /^v3/ })).not.toBeInTheDocument();
      second.unmount();
      window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "auto");
      renderPanel();
      expect(await screen.findByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    });

    it("localStorage 讀寫丟例外 → 不當掉：初值全部，切換本次照樣生效", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("denied");
      });
      try {
        renderPanel();
        await screen.findByRole("button", { name: /^v3/ });
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
        await waitFor(() => expect(screen.queryByRole("button", { name: /^v3/ })).not.toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Manual only" })).toHaveAttribute("aria-pressed", "true");
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });

    it("僅手動且沒有符合的版本 → 一行灰字空狀態（載入中不顯示）；切回全部就消失", async () => {
      window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "manual");
      stub({ [FIRST_MANUAL]: { versions: [], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null }, [FIRST]: { versions: [v(2)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null } });
      renderPanel();
      expect(screen.queryByTestId("versions-filter-empty")).not.toBeInTheDocument();
      const empty = await screen.findByTestId("versions-filter-empty");
      expect(empty).toHaveTextContent("No manually saved versions");
      expect(empty).toHaveClass("text-muted-foreground");
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      await screen.findByRole("button", { name: /^v2/ });
      expect(screen.queryByTestId("versions-filter-empty")).not.toBeInTheDocument();
    });

    it("全部且沒有任何版本 → 不顯示篩選空狀態", async () => {
      stub({ [FIRST]: { versions: [], current: cur(), nextBefore: null } });
      renderPanel();
      await within(await screen.findByTestId("versions-current")).findByText("No base version");
      expect(screen.queryByTestId("versions-filter-empty")).not.toBeInTheDocument();
    });

    it("預覽中的版本被篩掉：預覽不變（preview 不動）、底部「Apply vN」仍可按", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: /^v3/ }));
      expect(state().preview).toEqual({ seq: 3, id: "v-3" });
      const footer = screen.getByTestId("versions-footer");
      expect(within(footer).getByRole("button", { name: "Apply v3" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: /^v3/ })).not.toBeInTheDocument());
      expect(state().preview).toEqual({ seq: 3, id: "v-3" });
      expect(within(footer).getByRole("button", { name: "Apply v3" })).toBeEnabled();
      // 再選別的版本 → 換成它。
      fireEvent.click(await screen.findByRole("button", { name: /^v2/ }));
      expect(within(footer).getByRole("button", { name: "Apply v2" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: /^v3/ })).not.toBeInTheDocument();
    });

    it("活文件 update 的去抖動 invalidate 以前綴同時標記兩種篩選的快取", async () => {
      stub({ [FIRST]: ALL, [FIRST_MANUAL]: ONLY });
      const { queryClient } = renderPanel();
      await screen.findByRole("button", { name: /^v3/ });
      fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
      await waitFor(() => expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.status).toBe("success"));
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: versionsKey(NOTE), refetchType: "none" });
      });
      expect(queryClient.getQueryState(versionListKey(NOTE, "all"))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.isInvalidated).toBe(true);
    });
  });
  it("#258 切筆記不關面板：新那篇的清單換上來，上一篇的列、選取（預覽／Apply）不殘留", async () => {
    const N2 = "n2";
    stub({
      [FIRST]: { versions: [v(2, { name: "舊筆記的版本" }), v(1)], current: cur({ baseSeq: 2, nextSeq: 3 }), nextBefore: null },
      [`/api/notes/${N2}/versions?limit=50`]: { versions: [v(9, { id: "w-9", name: "新筆記的版本" })], current: cur({ baseSeq: 9, nextSeq: 10 }), nextBefore: null },
    });
    function SwitchHost({ noteId, doc }: { noteId: string; doc: Y.Doc }) {
      const value = useVersionsController({ noteId, enabled: true });
      return (
        <VersionsProvider value={value}>
          <button type="button" onClick={value.open}>host-open</button>
          <Probe />
          {value.panelOpen && <VersionsPanel doc={doc} />}
        </VersionsProvider>
      );
    }
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (noteId: string) => (
      <QueryClientProvider client={queryClient}>
        <SwitchHost noteId={noteId} doc={doc} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(NOTE));
    fireEvent.click(screen.getByText("host-open"));
    const row2 = await screen.findByRole("button", { name: /^v2/ });
    row2.focus();
    fireEvent.click(row2);
    expect(state().preview).toEqual({ seq: 2, id: "v-2" });
    expect(within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Apply v2" })).toBeEnabled();

    rerender(ui(N2));
    expect(state().mode).toBe("panel");
    expect(state().preview).toBeNull();
    expect(screen.getByTestId("versions-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^v2/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^v9/ })).toBeInTheDocument();
    expect(screen.queryByText("舊筆記的版本")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^v1(?!\d)/ })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(within(screen.getByTestId("versions-current")).getByText("Based on v9 · no changes")).toBeInTheDocument();
  });

  it("#258 M1：切篩選的瞬間（新鍵還沒資料）「目前狀態」副標與儲存鈕不消失，改讀另一個篩選已快取的 current；新資料到了以新的為準", async () => {
    let release!: () => void;
    const body = (current: VersionCurrentDto, versions: VersionDto[]): VersionListDto => ({ versions, current, nextBefore: null });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body(cur({ baseSeq: 2, dirty: true, nextSeq: 3 }), [v(2, { kind: "manual" }), v(1)])) } as Response);
        if (url === FIRST_MANUAL)
          return new Promise<Response>((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve(body(cur({ baseSeq: 2, dirty: false, nextSeq: 3 }), [v(2, { kind: "manual" })])) } as Response)));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText("Based on v2 · unsaved changes")).toBeInTheDocument();
    const save = within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Save current version" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
    // 新鍵載入中：列空了，但副標還在、儲存鈕沒閃 disabled。
    await waitFor(() => expect(screen.queryByRole("button", { name: /^v1(?!\d)/ })).not.toBeInTheDocument());
    expect(within(top).getByText("Based on v2 · unsaved changes")).toBeInTheDocument();
    expect(save).toBeEnabled();
    release();
    // 新資料到了以新的為準。
    expect(await within(top).findByText("Based on v2 · no changes")).toBeInTheDocument();
  });
  it("#258 m-3：自己篩選的清單查詢失敗 → 不退回另一份可能過期的 current（副標消失、儲存鈕 disabled）", async () => {
    const body = (current: VersionCurrentDto, versions: VersionDto[]): VersionListDto => ({ versions, current, nextBefore: null });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === FIRST) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body(cur({ baseSeq: 2, dirty: true, nextSeq: 3 }), [v(2, { kind: "manual" }), v(1)])) } as Response);
        if (url === FIRST_MANUAL) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { queryClient } = renderPanel();
    const top = await screen.findByTestId("versions-current");
    expect(await within(top).findByText("Based on v2 · unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manual only" }));
    await waitFor(() => expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.status).toBe("error"));
    await waitFor(() => expect(within(top).queryByText(/^Based on v2/)).not.toBeInTheDocument());
    expect(within(screen.getByTestId("versions-footer")).getByRole("button", { name: "Save current version" })).toBeDisabled();
  });
});
