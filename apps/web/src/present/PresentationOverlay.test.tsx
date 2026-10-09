import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider, useTheme } from "@/theme";
import { FakeReveal } from "@/test/fake-reveal";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { PresentationShell } from "./PresentationShell";
import PresentationOverlay, { type PresentationOverlayProps } from "./PresentationOverlay";
import { createExportEditor, renderDeck } from "./render";
import { OWNER_PERMS } from "@/test/fixtures";

vi.mock("reveal.js", async () => ({ default: (await import("@/test/fake-reveal")).FakeReveal }));
const mermaid = vi.hoisted(() => ({ renderMermaid: vi.fn(async () => ({ ok: true as const, svg: "<svg data-m></svg>" })) }));
vi.mock("@/lib/mermaid", () => mermaid);
vi.mock("./render", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./render")>();
  return { ...mod, renderDeck: vi.fn(mod.renderDeck) };
});
const nav = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return ((...args: Parameters<typeof real>) => {
        nav.fn(...args);
        return real(...args);
      }) as typeof real;
    },
  };
});

const BASE = "/n/tester/my-note";

/** 章：H2 a（含段落）、H3 a2（縱向）、H2 b；封面帶一個 wikilink（test 19）。 */
function makeDoc(extra: unknown[] = []): Y.Doc {
  const editor = createExportEditor();
  return blocksToYDoc(
    editor,
    [
      { id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } }] },
      { id: "a", type: "heading", props: { level: 2 }, content: "A" },
      { id: "pa", type: "paragraph", content: "alpha" },
      { id: "a2", type: "heading", props: { level: 3 }, content: "A2" },
      { id: "b", type: "heading", props: { level: 2 }, content: "B" },
      ...extra,
    ] as never,
    YDOC_FRAGMENT,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function ThemeSwitch() {
  const { setTheme } = useTheme(); // theme.tsx 的 setTheme；theme.test.tsx 同手法
  return <button type="button" aria-label="switch-theme-dark" onClick={() => setTheme("dark")} />;
}

interface Setup {
  entry?: string;
  windowSearch?: string;
  props?: PresentationOverlayProps;
  strict?: boolean;
  notes?: NoteDto[];
}

function setup({ entry = `${BASE}?present`, windowSearch, props, strict = false, notes }: Setup = {}) {
  window.history.replaceState(null, "", windowSearch === undefined ? entry : `${BASE}${windowSearch}`);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (notes) queryClient.setQueryData(["notes"], notes);
  const overlayProps = props ?? { variant: "member" as const, doc: makeDoc(), title: "My Note" };
  const tree = (p: PresentationOverlayProps): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ThemeSwitch />
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          <Routes>
            <Route
              path="/n/:handle/:slug"
              element={
                <PresentationShell title="My Note" status="ready">
                  <PresentationOverlay {...p} />
                </PresentationShell>
              }
            />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
  const wrap = (node: ReactNode) => (strict ? <StrictMode>{node}</StrictMode> : node);
  const result = render(wrap(tree(overlayProps)));
  return { ...result, queryClient, rerenderWith: (p: PresentationOverlayProps) => result.rerender(wrap(tree(p))) };
}

/** 等到 reveal 建好（不等就緒——config 核對失敗的案永遠不會就緒）。 */
const instance = async () => {
  await waitFor(() => expect(FakeReveal.instances.length).toBeGreaterThan(0));
  return FakeReveal.instances.at(-1)!;
};
/** 等到 controller 走完 initialize().then（掛了 slidechanged 監聽＝已核對、已定位、已宣告就緒）。 */
const ready = async () => {
  const deck = await instance();
  await waitFor(() => expect(deck.listenerCount("slidechanged")).toBe(1));
  return deck;
};
const loc = () => screen.getByTestId("loc").textContent;
const slideEl = (id: string) => document.querySelector<HTMLElement>(`[data-kn-slide-id="${id}"]`)!;

describe("PresentationOverlay（fake reveal）", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    FakeReveal.reset();
    nav.fn.mockClear();
    mermaid.renderMermaid.mockClear();
    vi.mocked(renderDeck).mockClear();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    window.history.replaceState(null, "", "/");
    document.documentElement.classList.remove("dark");
  });

  it("初始化：自建 .reveal > .slides、設定照 A3、沒有任何 id／data-id（A11）", async () => {
    setup();
    const deck = await ready();
    expect(deck.el.className).toContain("reveal");
    expect(deck.config).toMatchObject({ embedded: true, disableLayout: true, hash: false, postMessage: false, view: null });
    expect(document.querySelectorAll(".reveal .slides [id], .reveal .slides [data-id]")).toHaveLength(0);
    expect(document.querySelectorAll(".reveal .slides section[data-kn-slide-id]")).toHaveLength(4);
  });

  it("test 2：ready 後外殼不聽 Esc；reveal 的 keyboard[27] → 離開、navigate 恰一次", async () => {
    setup();
    const deck = await ready();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(nav.fn).not.toHaveBeenCalled();
    act(() => deck.pressKey(27));
    await waitFor(() => expect(loc()).toBe(BASE));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("總覽開著時 Esc 只關總覽；O 切換總覽", async () => {
    setup();
    const deck = await ready();
    act(() => deck.pressKey(79));
    expect(deck.toggleOverview).toHaveBeenLastCalledWith();
    expect(deck.overview).toBe(true);
    act(() => deck.pressKey(27));
    expect(deck.toggleOverview).toHaveBeenLastCalledWith(false);
    expect(nav.fn).not.toHaveBeenCalled();
  });

  it("F → 外殼的 toggleFullscreen（requestFullscreen 一次）", async () => {
    fake = installFakeFullscreen();
    setup();
    const deck = await ready();
    act(() => deck.pressKey(70));
    expect(fake.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("test 20：config 核對失敗 → 外殼顯示 configRefused、overlay 拆除（destroy 一次、.reveal 移除）；之後 Esc 恰一次", async () => {
    FakeReveal.configOverride = { postMessage: true };
    setup();
    const deck = await instance();
    expect(await screen.findByRole("alert")).toHaveTextContent("Presentation settings were unexpected, so playback stopped");
    expect(deck.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".reveal")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("test 20：初始化前查詢字串斷言失敗（window.location.search 不是 ?present）→ 不建 reveal、configRefused", async () => {
    setup({ windowSearch: "?present&hash=true" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Presentation settings were unexpected, so playback stopped");
    expect(FakeReveal.instances).toHaveLength(0);
  });

  it("test 8：initialize resolve 前卸載 → resolve 後才 destroy、恰一次", async () => {
    FakeReveal.autoResolve = false;
    const { unmount } = setup();
    await waitFor(() => expect(FakeReveal.instances).toHaveLength(1));
    const deck = FakeReveal.instances[0];
    unmount();
    expect(deck.destroy).not.toHaveBeenCalled();
    await act(async () => {
      deck.resolveInit();
      await Promise.resolve();
    });
    expect(deck.destroy).toHaveBeenCalledTimes(1);
  });

  it("test 17（fake 版）：StrictMode 下恰一個 .reveal、恰建一份 reveal", async () => {
    setup({ strict: true });
    await ready();
    expect(document.querySelectorAll(".reveal")).toHaveLength(1);
    expect(FakeReveal.instances).toHaveLength(1);
  });

  it("RF2：深連結到縱向投影片 → slide(h, v) 的 v 為 1", async () => {
    setup({ entry: `${BASE}?present#/a2` });
    const deck = await ready();
    expect(deck.slide).toHaveBeenCalledWith(1, 1);
  });

  it.each(["#/%E0%A4%A", "#/nope", "#/1", "#/2/0", "#x"])("RF1：hash %s 找不到投影片 → 不 throw、明確 slide(0, 0) 回封面、仍 ready", async (hash) => {
    setup({ entry: `${BASE}?present${hash}` });
    const deck = await ready();
    expect(deck.slide).toHaveBeenCalledWith(0, 0);
    expect(deck.indices).toEqual({ h: 0, v: 0 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("換頁 → hash 以 replace 寫 #/<id>（不增 history）", async () => {
    setup();
    const deck = await ready();
    act(() => deck.slide(2, 0));
    await waitFor(() => expect(loc()).toBe(`${BASE}?present#/b`));
    expect(nav.fn).toHaveBeenLastCalledWith({ pathname: BASE, search: "?present", hash: "#/b" }, { replace: true, state: null });
  });

  it("test 19：首次建置後含 wikilink 的封面 DOM 有 wikilink 文字（匯出在 microtask，§5.1-6）", async () => {
    setup();
    await ready();
    expect(slideEl("_title").textContent).toContain("Meeting Notes");
  });

  it("已登入 wikilink 讀渲染當下的 ['notes'] 快取（命中 → 現行標題）", async () => {
    setup({
      notes: [{ id: "n1", title: "Renamed meeting", ownerId: "u1", role: "owner", createdAt: "", updatedAt: "", slug: "renamed", slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, permissions: OWNER_PERMS }],
    });
    await ready();
    expect(slideEl("_title").querySelector("a")!.textContent).toBe("Renamed meeting");
  });

  it("test 6：100 ms 內 5 次更新 → 一次重切；持續更新 > 2 s → 至少套用一次", async () => {
    const doc = makeDoc();
    setup({ props: { variant: "member", doc, title: "My Note" } });
    await ready();
    const initialCalls = vi.mocked(renderDeck).mock.calls.length;
    // 合法的內容變動：在文件裡第一段文字（標題 A 的 XmlText）前插一個字——直接往 fragment 塞元素會產生
    // BlockNote 讀不懂的結構。
    const firstText = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlText) return child;
        if (child instanceof Y.XmlElement) {
          const found = firstText(child);
          if (found) return found;
        }
      }
      return null;
    };
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const typeChar = () => act(() => firstText(fragment)!.insert(0, "x"));
    for (let i = 0; i < 5; i++) {
      typeChar();
      await new Promise((r) => setTimeout(r, 20));
    }
    await waitFor(() => expect(vi.mocked(renderDeck).mock.calls.length).toBe(initialCalls + 1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 700));
    expect(vi.mocked(renderDeck).mock.calls.length).toBe(initialCalls + 1);

    const before = vi.mocked(renderDeck).mock.calls.length;
    const started = Date.now();
    while (Date.now() - started < 2300) {
      typeChar();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(vi.mocked(renderDeck).mock.calls.length).toBeGreaterThan(before);
  });

  it("test 7：目前那張被刪 → slide() 到前一張、hash replace；目前那張內容變 → 捲頂；別張變 → 不捲、不重建目前那張", async () => {
    const editor = createExportEditor();
    const v1 = makeDoc();
    const { rerenderWith } = setup({ props: { variant: "public", doc: v1, title: "My Note", publicRef: { kind: "token", token: "t" } } });
    const deck = await ready();
    act(() => deck.slide(1, 1)); // 到 a2
    await waitFor(() => expect(loc()).toBe(`${BASE}?present#/a2`));

    // 別張（b）內容變：目前那張不重建、不捲頂
    const a2Body = slideEl("a2").querySelector(".kn-slide-body")!.firstChild;
    const scrollSet = vi.fn();
    Object.defineProperty(slideEl("a2"), "scrollTop", { configurable: true, set: scrollSet, get: () => 0 });
    const v2 = blocksToYDoc(editor, [
      { id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } }] },
      { id: "a", type: "heading", props: { level: 2 }, content: "A" },
      { id: "pa", type: "paragraph", content: "alpha" },
      { id: "a2", type: "heading", props: { level: 3 }, content: "A2" },
      { id: "b", type: "heading", props: { level: 2 }, content: "B changed" },
    ] as never, YDOC_FRAGMENT);
    rerenderWith({ variant: "public", doc: v2, title: "My Note", publicRef: { kind: "token", token: "t" } });
    await waitFor(() => expect(slideEl("b").textContent).toContain("B changed"), { timeout: 2000 });
    expect(slideEl("a2").querySelector(".kn-slide-body")!.firstChild).toBe(a2Body);
    expect(scrollSet).not.toHaveBeenCalled();
    // §7.1-4：結構沒變 → 只 syncSlide 有變的那張、不 sync（r1-p2 MINOR 7）
    expect(deck.syncSlide).toHaveBeenCalledWith(slideEl("b"));
    expect(deck.sync).not.toHaveBeenCalled();

    // 目前那張內容變：捲頂
    const v3 = blocksToYDoc(editor, [
      { id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } }] },
      { id: "a", type: "heading", props: { level: 2 }, content: "A" },
      { id: "pa", type: "paragraph", content: "alpha" },
      { id: "a2", type: "heading", props: { level: 3 }, content: "A2 edited" },
      { id: "b", type: "heading", props: { level: 2 }, content: "B changed" },
    ] as never, YDOC_FRAGMENT);
    rerenderWith({ variant: "public", doc: v3, title: "My Note", publicRef: { kind: "token", token: "t" } });
    await waitFor(() => expect(scrollSet).toHaveBeenCalledWith(0), { timeout: 2000 });

    // 目前那張被刪（a2 的標題沒了）→ 前一張 a
    const v4 = blocksToYDoc(editor, [
      { id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } }] },
      { id: "a", type: "heading", props: { level: 2 }, content: "A" },
      { id: "pa", type: "paragraph", content: "alpha" },
      { id: "b", type: "heading", props: { level: 2 }, content: "B changed" },
    ] as never, YDOC_FRAGMENT);
    rerenderWith({ variant: "public", doc: v4, title: "My Note", publicRef: { kind: "token", token: "t" } });
    await waitFor(() => expect(loc()).toBe(`${BASE}?present#/a`), { timeout: 2000 });
    expect(deck.slide).toHaveBeenLastCalledWith(1, 0);
    expect(deck.sync).toHaveBeenCalled();
    expect(deck.destroy).not.toHaveBeenCalled(); // 不重建 reveal
  });

  it("主題切換 → mermaid 以新主題重畫（§5.3、§10-3）", async () => {
    setup({ props: { variant: "public", doc: makeDoc([{ id: "m", type: "mermaid", props: { code: "graph TD" } }]), title: "T", publicRef: { kind: "token", token: "t" } } });
    await ready();
    await waitFor(() => expect(mermaid.renderMermaid).toHaveBeenCalledWith("graph TD", "light"));
    const before = mermaid.renderMermaid.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "switch-theme-dark" }));
    await waitFor(() => expect(mermaid.renderMermaid.mock.calls.length).toBeGreaterThan(before));
    expect(mermaid.renderMermaid).toHaveBeenLastCalledWith("graph TD", "dark");
  });

  it("mermaid 世代號：先發的晚回 → 丟掉，DOM 是後發的結果（§5.3「每張世代號，舊結果丟」，r1-p2 MINOR 8）", async () => {
    let resolveFirst: (value: { ok: true; svg: string }) => void = () => {};
    mermaid.renderMermaid
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ ok: true as const, svg: '<svg data-gen="2"></svg>' }));
    setup({ props: { variant: "public", doc: makeDoc([{ id: "m", type: "mermaid", props: { code: "graph TD" } }]), title: "T", publicRef: { kind: "token", token: "t" } } });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "switch-theme-dark" }));
    await waitFor(() => expect(document.querySelector('.reveal svg[data-gen="2"]')).not.toBeNull());
    await act(async () => {
      resolveFirst({ ok: true, svg: '<svg data-gen="1"></svg>' });
      await Promise.resolve();
    });
    expect(document.querySelector('.reveal svg[data-gen="1"]')).toBeNull();
    expect(document.querySelector('.reveal svg[data-gen="2"]')).not.toBeNull();
  });
});
