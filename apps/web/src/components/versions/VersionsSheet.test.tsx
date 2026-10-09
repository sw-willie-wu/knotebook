import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type VersionDto, type VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { ThemeProvider } from "@/theme";
import { NARROW_QUERY, VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { VersionsSheet } from "./VersionsSheet";

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => widthRef.current }));
const widthRef = vi.hoisted(() => ({ current: 800 }));

const NOTE = "n1";
const LIST = `/api/notes/${NOTE}/versions?limit=50`;
const SNAP = (n: number) => `/api/notes/${NOTE}/versions/${n}`;

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

/** 同 versions-context.test 的 installMatchMedia：只有 `NARROW_QUERY` 回 `narrow`。 */
function installMatchMedia(narrow: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === NARROW_QUERY ? narrow : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={value.open}>host-open</button>
      <span data-testid="s-state">{JSON.stringify({ mode: value.mode, preview: value.preview })}</span>
      <span data-testid="s-compare">{value.compareTo}</span>
      {/* 模擬「寬版先開了只看差異」：controller 的 onlyChanges 跨斷點不重設。 */}
      <button type="button" onClick={() => value.setOnlyChanges(true)}>host-only-changes</button>
      <span data-testid="s-only">{String(value.onlyChanges)}</span>
      {value.mode === "sheet" && <VersionsSheet doc={doc} lastEdited={{ byHandle: "ann", agentLabel: null, at: "2026-10-09T00:00:00.000Z" } as never} />}
    </VersionsProvider>
  );
}

/** final I-1：模擬頁首 ⋮ 開整頁——選單項按下後即卸載；`fake-menu-trigger` 是交給整頁的 returnFocusRef（NotePage 的 ⋮ 鈕）。 */
function MenuHost({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(true);
  return (
    <VersionsProvider value={value}>
      <button ref={triggerRef} type="button">
        fake-menu-trigger
      </button>
      {menuOpen && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            value.open();
          }}
        >
          menu-item
        </button>
      )}
      {value.mode === "sheet" && <VersionsSheet doc={doc} lastEdited={null as never} returnFocusRef={triggerRef} />}
    </VersionsProvider>
  );
}

function renderSheet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={new Y.Doc()} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("host-open"));
}
const sState = () => JSON.parse(screen.getByTestId("s-state").textContent!);
const footerOf = (sheet: HTMLElement) => within(within(sheet).getByTestId("sheet-footer"));

describe("VersionsSheet（spec §8.3）", () => {
  let restoreMatchMedia: () => void;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    widthRef.current = 800;
    restoreMatchMedia = installMatchMedia(true);
  });
  afterEach(() => {
    restoreMatchMedia();
    vi.unstubAllGlobals();
  });

  it("步一：全螢幕 dialog（名稱「Version history」）、返回鈕、最後編輯、目前狀態、清單、底部儲存鈕", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]) });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(sheet).toHaveClass("fixed", "inset-0");
    expect(within(sheet).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(within(sheet).getByTestId("sheet-last-edited")).toHaveTextContent("ann");
    expect(await within(sheet).findByText("= v2, no unsaved changes")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /^v1(?!\d)/ })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Save current version" })).toBeInTheDocument();
  });

  it("點列 → 步二：標題「List · v2」、單欄 diff（沒有並排鈕；容器寬 1600 仍單欄）、底部 上一版｜套用 v2｜下一版", async () => {
    widthRef.current = 1600;
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: "v-2", seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v2(?!\d)/ }));
    expect(await within(sheet).findByTestId("diff-single")).toBeInTheDocument();
    expect(within(sheet).queryByTestId("diff-split")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: /^List · v2/ })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
    const footer = footerOf(sheet);
    expect(footer.getByRole("button", { name: "Older version" })).toBeEnabled();
    expect(footer.getByRole("button", { name: "Apply v2" })).toBeEnabled();
    expect(footer.getByRole("button", { name: "Newer version" })).toBeDisabled();
  });

  it("步二頁首的比較對象兩顆鈕：預設按下「前一版」，點「目前狀態」→ compareTo=current、aria-pressed 跟著換", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: "v-2", seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v2(?!\d)/ }));
    const group = within(await within(sheet).findByRole("group", { name: "Compare with" }));
    const previous = group.getByRole("button", { name: "Previous version" });
    const current = group.getByRole("button", { name: "Current state" });
    expect(screen.getByTestId("s-compare")).toHaveTextContent("previous");
    expect(previous).toHaveAttribute("aria-pressed", "true");
    expect(current).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(current);
    expect(screen.getByTestId("s-compare")).toHaveTextContent("current");
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(previous).toHaveAttribute("aria-pressed", "false");
  });

  it("「只看差異」：寬版先開著 → 整頁步二的開關顯示 on，按一下關回 off", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: "v-2", seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    fireEvent.click(screen.getByText("host-only-changes"));
    expect(screen.getByTestId("s-only")).toHaveTextContent("true");
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v2(?!\d)/ }));
    const toggle = await within(sheet).findByRole("button", { name: "Only changes" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(screen.getByTestId("s-only")).toHaveTextContent("false");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("「vs 空文件」：預覽最舊那版（沒有更舊、沒有下一頁）且比前一版時顯示；有更舊的版本時不顯示", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: "v-2", seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v2(?!\d)/ }));
    // 清單已載入（列已渲染）——v2 有更舊的 v1，提示若會出現此刻就已出現。
    await within(sheet).findByRole("button", { name: /^List · v2/ });
    expect(within(sheet).queryByText("vs empty document")).not.toBeInTheDocument();
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Older version" }));
    expect(await within(sheet).findByText("vs empty document")).toBeInTheDocument();
    fireEvent.click(within(within(sheet).getByRole("group", { name: "Compare with" })).getByRole("button", { name: "Current state" }));
    expect(within(sheet).queryByText("vs empty document")).not.toBeInTheDocument();
  });

  it("關整頁後焦點回到開啟前的元素（受控 Dialog 沒有 Trigger，Radix 不會自己還原）", async () => {
    stub({ [LIST]: list([ver(1)]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Host doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const opener = screen.getByText("host-open");
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("final I-1：開啟前的焦點元素（⋮ 選單項）在關閉前已卸載 → 關整頁後焦點退回 returnFocusRef（頁首 ⋮ 鈕）", async () => {
    stub({ [LIST]: list([ver(1)]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MenuHost doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const item = screen.getByText("menu-item");
    item.focus();
    expect(document.activeElement).toBe(item);
    // 同一批次：開整頁＋選單項卸載（同 NoteMenu 的 setMenuOpen(false)＋versions.open()）。整頁掛載當下記到的是選單項。
    fireEvent.click(item);
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    expect(screen.queryByText("menu-item")).not.toBeInTheDocument();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("final fix 2 M-A：開整頁時焦點在 body → 關閉後退回 returnFocusRef（⋮ 鈕），不是還給 body", async () => {
    stub({ [LIST]: list([ver(1)]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MenuHost doc={new Y.Doc()} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    // fireEvent.click 不移動焦點：整頁掛載當下 activeElement 仍是 body。
    fireEvent.click(screen.getByText("menu-item"));
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("final I-1(b)：步二比較對象 group 允許換行（flex-wrap；320 px 不溢出是依 class 推論，真瀏覽器量測留 e2e）", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: "v-2", seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v2(?!\d)/ }));
    expect(await within(sheet).findByRole("group", { name: "Compare with" })).toHaveClass("flex-wrap");
  });

  it("上一版／下一版：在 seq 間移動，最舊那版的上一版 disabled", async () => {
    stub({ [LIST]: list([ver(2), ver(1)]), [SNAP(2)]: { id: "v-2", seq: 2, ydoc: b64(V2) }, [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v2(?!\d)/ }));
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Older version" }));
    await waitFor(() => expect(sState().preview).toEqual({ seq: 1, id: "v-1" }));
    expect(footerOf(sheet).getByRole("button", { name: "Older version" })).toBeDisabled();
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Newer version" }));
    await waitFor(() => expect(sState().preview).toEqual({ seq: 2, id: "v-2" }));
  });

  it("‹ 清單 → 回步一並離開預覽；‹ 返回 → 關整頁（mode=null）", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v1(?!\d)/ }));
    fireEvent.click(await within(sheet).findByRole("button", { name: /^List/ }));
    expect(sState().preview).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(sState()).toEqual({ mode: null, preview: null }));
    expect(screen.queryByRole("dialog", { name: "Version history" })).not.toBeInTheDocument();
  });

  it("從整頁外 pointerdown＋click 關閉時預覽也停（不留 mode=null 的孤兒預覽）", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v1(?!\d)/ }));
    await within(sheet).findByRole("button", { name: /^List/ });
    expect(sState()).toEqual({ mode: "sheet", preview: { seq: 1, id: "v-1" } });
    // Radix 對左鍵的「點外面」延到 click 才判（deferPointerDownOutside），所以 pointerdown＋click 一組送。
    const outside = screen.getByTestId("s-state");
    fireEvent.pointerDown(outside, { button: 0 });
    fireEvent.click(outside, { button: 0 });
    await waitFor(() => expect(sState()).toEqual({ mode: null, preview: null }));
  });

  it("Esc：步二回清單（preventDefault、整頁留著），步一再按才關整頁（同樣 preventDefault）", async () => {
    stub({ [LIST]: list([ver(1)]), [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) } });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v1(?!\d)/ }));
    const listButton = await within(sheet).findByRole("button", { name: /^List/ });
    // fireEvent 回傳 false＝事件被 preventDefault（NotePage 的 Esc 監聽以 defaultPrevented 讓路）。
    expect(fireEvent.keyDown(listButton, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(sState()).toEqual({ mode: "sheet", preview: null }));
    expect(screen.getByRole("dialog", { name: "Version history" })).toBeInTheDocument();
    expect(fireEvent.keyDown(within(sheet).getByRole("button", { name: "Back" }), { key: "Escape" })).toBe(false);
    await waitFor(() => expect(sState()).toEqual({ mode: null, preview: null }));
  });

  it("步二按「套用 v1」→ 走 requestApply（先重抓 current，不 dirty 直接 POST apply）", async () => {
    const calls = stub({
      [LIST]: list([ver(1)]),
      [SNAP(1)]: { id: "v-1", seq: 1, ydoc: b64(V1) },
      [`/api/notes/${NOTE}/versions?limit=1`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1/apply`]: { current: { baseSeq: 1, dirty: false, nextSeq: 2, autoEnabled: true } },
    });
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: "Version history" });
    fireEvent.click(await within(sheet).findByRole("button", { name: /^v1(?!\d)/ }));
    fireEvent.click(footerOf(sheet).getByRole("button", { name: "Apply v1" }));
    await waitFor(() => expect(calls).toContain(`/api/notes/${NOTE}/versions/1/apply`));
    expect(calls.indexOf(`/api/notes/${NOTE}/versions?limit=1`)).toBeLessThan(calls.indexOf(`/api/notes/${NOTE}/versions/1/apply`));
    // 套用成功 → 離開預覽回步一（useApplyFlow 的成功路徑）。
    await waitFor(() => expect(sState()).toEqual({ mode: "sheet", preview: null }));
  });
});
