import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { useState } from "react";
import "@/i18n";
import { BlockAnchorContext, type BlockAnchorApi } from "./block-anchor-context";
import { useWikilinkActivate } from "@/components/wikilink/useWikilinkClick";

// spec 2026-10-13 site-links §10.2、§15.1 W8；Review Focus RF4。Host 照真實掛載：member 用**真的 useCollab**＋假 provider
// （memory knotebook-review-probe-fidelity-lessons），root 在 doc 存在時才有這篇的區塊。

interface FakeProvider {
  emit(event: string, payload: unknown): void;
}
const hoisted = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    configuration: unknown;
    listeners = new Map<string, ((p: unknown) => void)[]>();
    disconnect = vi.fn();
    connect = vi.fn();
    destroy = vi.fn();
    awareness = {};
    synced = false;
    constructor(configuration: unknown) {
      this.configuration = configuration;
      hoisted.instances.push(this);
    }
    on(event: string, handler: (p: unknown) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, payload: unknown) {
      for (const h of this.listeners.get(event) ?? []) h(payload);
    }
  },
}));

const { useCollab } = await import("@/collab/useCollab");
const { blockIdFromHash, scrollToBlock, useBlockAnchor, useMemberBlockAnchor, ANCHOR_FLASH_ATTR, ANCHOR_FLASH_CLASS, ANCHOR_FLASH_MS, ANCHOR_WAIT_MS } =
  await import("./useBlockAnchor");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const providerAt = (i: number) => hoisted.instances[i] as FakeProvider;

let navigate!: NavigateFunction;
let api!: BlockAnchorApi;
const commits: Array<{ noteId: string | undefined; synced: boolean; docNull: boolean; syncedFor: string | null }> = [];

/**
 * NotePage 的形：同一個實例、noteId 由解析層給（轉場中 undefined）；錨點走**正式的** `useMemberBlockAnchor`（NotePage 呼叫的同一支）。
 * 區塊只在**這一篇同步之後**才出現——真實頁面上 B 的 Y.Doc 在 provider 同步前是空的，BlockNote 沒有任何區塊可渲染
 * （plan gate r1 I2：先前「doc 有了就渲染」讓殘值 commit 也找得到區塊，跨篇案分不出對錯）。
 */
function MemberHost({ noteId, rootKey = 0, presenting = false }: { noteId: string | undefined; rootKey?: number; presenting?: boolean }) {
  navigate = useNavigate();
  const { doc, synced, syncedFor } = useCollab({ noteId, onUnauthorized: () => {} });
  const [root, setRoot] = useState<HTMLElement | null>(null);
  api = useMemberBlockAnchor({ noteId, collab: { synced, syncedFor }, root, presenting });
  commits.push({ noteId, synced, docNull: doc === null, syncedFor });
  const contentLoaded = doc !== null && noteId !== undefined && syncedFor === noteId;
  // NotePage 的形：BlockAnchorContext 由頁面提供給 wikilink 的共用點擊（useWikilinkActivate）。
  return (
    <BlockAnchorContext.Provider value={api}>
      <div key={rootKey} ref={setRoot} data-testid="root">
        {contentLoaded && (
          <div className="bn-block-outer" data-id="x" data-note={noteId}>
            <div className="bn-block-group">
              <div className="bn-block-outer" data-id="nested" data-note={noteId} />
            </div>
          </div>
        )}
      </div>
      <Activator />
    </BlockAnchorContext.Provider>
  );
}

/** 把 wikilink 的共用點擊語意（真的 useWikilinkActivate，讀 BlockAnchorContext）露給測試。 */
let activate!: ReturnType<typeof useWikilinkActivate>;
function Activator() {
  activate = useWikilinkActivate();
  return null;
}

/** 公開頁的形：noteKey＝公開 ref 的識別字串；ready＝doc 解碼完成。 */
function PublicHost({ refKey, loaded }: { refKey: string; loaded: boolean }) {
  navigate = useNavigate();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  api = useBlockAnchor({ noteKey: refKey, ready: loaded, root, currentNoteId: null });
  return <div ref={setRoot}>{loaded && <div className="bn-block-outer" data-id="x" data-note={refKey} />}</div>;
}

const scrolls: Array<string | null> = [];
beforeEach(() => {
  hoisted.instances.length = 0;
  commits.length = 0;
  scrolls.length = 0;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolls.push(this.getAttribute("data-note") ? `${this.getAttribute("data-note")}:${this.getAttribute("data-id")}` : null);
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks(); // pageLikeRoot 的 getBoundingClientRect spy
  vi.useRealTimers();
});

describe("#269 blockIdFromHash／scrollToBlock", () => {
  it("只認 #b-<BLOCK_ANCHOR_RE>；#/slide、空、壞 id → null", () => {
    expect(blockIdFromHash("#b-ok_1")).toBe("ok_1");
    expect(blockIdFromHash("#/slide-1")).toBeNull();
    expect(blockIdFromHash("")).toBeNull();
    expect(blockIdFromHash("#b-壞")).toBeNull();
  });

  /**
   * 頁面的形：捲動容器（root）＞文章欄 wrapper（`relative`）＞編輯器根（`.ProseMirror`）＞區塊。getBoundingClientRect 以 stub 給：
   * 浮層在 (0,0) 時量到的原點 (40, 10)、目標區塊 (300, 30, 500×24) ⇒ 浮層該放在 top 260、left 20、500×24。
   */
  function pageLikeRoot(): { root: HTMLElement; column: HTMLElement; target: HTMLElement } {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-testid="column" style="position: relative"><div class="ProseMirror" style="position: relative">' +
      '<div class="bn-block-outer" data-id="p"><div class="bn-block-group"><div class="bn-block-outer" data-id="deep" data-note="n"></div></div></div>' +
      "</div></div>";
    document.body.appendChild(root);
    const rect = (top: number, left: number, width: number, height: number) =>
      ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains(ANCHOR_FLASH_CLASS)) return rect(40, 10, 0, 0);
      if (this.getAttribute("data-id") === "deep") return rect(300, 30, 500, 24);
      return rect(0, 0, 0, 0);
    });
    return { root, column: root.querySelector<HTMLElement>('[data-testid="column"]')!, target: root.querySelector<HTMLElement>('[data-id="deep"]')! };
  }
  const overlaysIn = (root: HTMLElement) => root.querySelectorAll(`.${ANCHOR_FLASH_CLASS}`);

  it("找得到：捲＋高亮浮層蓋住該區塊（座標由 rect 換算）、掛在 ProseMirror 管轄外的文章欄、區塊本身不改屬性；RF4 巢狀區塊也找得到", () => {
    const { root, column, target } = pageLikeRoot();
    scrollToBlock(root, "deep");
    expect(scrolls).toEqual(["n:deep"]);
    const overlays = overlaysIn(root);
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0] as HTMLElement;
    expect(overlay.parentElement).toBe(column); // 不是 root、也不在 .ProseMirror 裡（編輯器根本身 positioned 也要跳過）
    expect(overlay.closest(".ProseMirror")).toBeNull();
    expect(overlay.getAttribute(ANCHOR_FLASH_ATTR)).toBe("deep");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect({ position: overlay.style.position, top: overlay.style.top, left: overlay.style.left, width: overlay.style.width, height: overlay.style.height }).toEqual({
      position: "absolute",
      top: "260px",
      left: "20px",
      width: "500px",
      height: "24px",
    });
    expect(target.attributes).toHaveLength(3); // class、data-id、data-note——ProseMirror 管的節點不被改
    root.remove();
  });

  it("浮層：動畫結束（animationend）就移除", () => {
    const { root } = pageLikeRoot();
    scrollToBlock(root, "deep");
    overlaysIn(root)[0]!.dispatchEvent(new Event("animationend"));
    expect(overlaysIn(root)).toHaveLength(0);
    root.remove();
  });

  it("浮層：沒有 animationend（prefers-reduced-motion 不動畫）時 2 s 後移除；取消（卸載／下一個請求）立即移除", () => {
    vi.useFakeTimers();
    const { root } = pageLikeRoot();
    scrollToBlock(root, "deep");
    vi.advanceTimersByTime(ANCHOR_FLASH_MS - 1);
    expect(overlaysIn(root)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(overlaysIn(root)).toHaveLength(0);
    const cancel = scrollToBlock(root, "deep");
    expect(overlaysIn(root)).toHaveLength(1);
    cancel();
    expect(overlaysIn(root)).toHaveLength(0);
    root.remove();
  });

  it("一開始找不到：MutationObserver 等到出現才捲；2 s 內都沒出現 → 不捲、不丟錯", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    scrollToBlock(root, "late");
    const el = document.createElement("div");
    el.className = "bn-block-outer";
    el.setAttribute("data-id", "late");
    el.setAttribute("data-note", "n");
    root.appendChild(el);
    await new Promise((r) => setTimeout(r, 0));
    expect(scrolls).toEqual(["n:late"]);
    vi.useFakeTimers();
    const root2 = document.createElement("div");
    expect(() => scrollToBlock(root2, "never")).not.toThrow();
    vi.advanceTimersByTime(ANCHOR_WAIT_MS + 10);
    const tooLate = document.createElement("div");
    tooLate.className = "bn-block-outer";
    tooLate.setAttribute("data-id", "never");
    tooLate.setAttribute("data-note", "n");
    root2.appendChild(tooLate);
    await Promise.resolve();
    await Promise.resolve();
    expect(scrolls).toEqual(["n:late"]); // 等待上限過了才出現的區塊不捲（observer 已停）
    root.remove();
  });
});

describe("#269 W8 useBlockAnchor（member：真的 useCollab）", () => {
  it("A → /notes/B#b-x（經過 undefined、收斂 REPLACE 在 B 同步之前）：殘值 commit 與 A 的舊 provider 遲到的 synced 都不消耗；B 在等待上限之後才同步，仍恰捲一次", async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={["/notes/A"]}>
        <MemberHost noteId={A} />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([]);
    act(() => void navigate("/notes/B#b-x"));
    rerender(
      <MemoryRouter initialEntries={["/notes/A"]}>
        <MemberHost noteId={undefined} />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter initialEntries={["/notes/A"]}>
        <MemberHost noteId={B} />
      </MemoryRouter>,
    );
    act(() => void navigate("/n/h/b#b-x", { replace: true })); // 收斂 REPLACE（保留 hash）
    expect(commits.some((c) => c.noteId === B && c.synced && c.docNull)).toBe(true);
    expect(scrolls).toEqual([]);
    act(() => providerAt(0).emit("synced", { state: true })); // A 的舊 provider 遲到的 synced：synced 變 true、syncedFor 仍 null
    // 這一發是**假 provider 製造的分辨條件**（plan gate r2 I1）：假 provider 的 destroy 不清監聽器，所以被拆掉的 A 仍能送出 "synced"；
    // useCollab 的 `setSynced(true)` 沒有 `disposed` 守衛（`setSyncedFor` 有）⇒ `synced` 為真、`syncedFor` 仍是 null。看 synced 的實作在這裡
    // 就消耗、B 的區塊還沒渲染、MutationObserver 2 s 後放棄 ⇒ scrolls 為空；看 syncedFor 的實作等到 syncedFor === B 才消耗 ⇒ 恰捲一次。
    // 產品上到不了這一步：真的 `HocuspocusProvider.destroy()` 會 removeAllListeners（useCollab 的 cleanup 同步呼叫它）。只走殘值 commit 那條路
    // 時兩者等價（pending 設定與 synced 歸零在同一次批次更新）——`syncedFor` 在產品上是防禦性條件（spec rev 5）。
    // 真計時器：等超過 ANCHOR_WAIT_MS 才讓 B 同步。
    await act(async () => {
      await new Promise((r) => setTimeout(r, ANCHOR_WAIT_MS + 300));
    });
    expect(scrolls).toEqual([]);
    act(() => providerAt(1).emit("synced", { state: true }));
    expect(scrolls).toEqual([`${B}:x`]);
  }, 10_000);

  it("新分頁／冷開 /notes/B#b-x（REPLACE 在 synced 之前）恰捲一次；之後無關 REPLACE、modal 開關（query 變化）不再捲", () => {
    render(
      <MemoryRouter initialEntries={["/notes/B#b-x"]}>
        <MemberHost noteId={B} />
      </MemoryRouter>,
    );
    act(() => void navigate("/n/h/b#b-x", { replace: true }));
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([`${B}:x`]);
    act(() => void navigate("/n/h/b?settings=1#b-x"));
    act(() => void navigate("/n/h/b#b-x", { replace: true }));
    act(() => void navigate(-1));
    expect(scrolls).toEqual([`${B}:x`]);
  });

  it("捲完之後捲動容器換掉（NoteEditor 重掛 ⇒ onScrollRoot 回報新元素）：不再捲（待處理錨點消耗後已清掉）", () => {
    const tree = (rootKey: number) => (
      <MemoryRouter initialEntries={["/notes/B#b-x"]}>
        <MemberHost noteId={B} rootKey={rootKey} />
      </MemoryRouter>
    );
    const { rerender } = render(tree(0));
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([`${B}:x`]);
    rerender(tree(1)); // key 換了 ⇒ 舊 div 卸載、新 div 掛上，ref callback 依序回報 null 與新元素
    expect(scrolls).toEqual([`${B}:x`]);
  });

  it("同一錨點捲走後再點（requestAnchor）會再捲；requestAnchor 的區塊在本篇；2 s 內連續要求只留最後一個高亮浮層", () => {
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/notes/B#b-x"]}>
        <MemberHost noteId={B} />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    act(() => api.requestAnchor("x"));
    act(() => api.requestAnchor("nested"));
    expect(scrolls).toEqual([`${B}:x`, `${B}:x`, `${B}:nested`]);
    const overlays = getByTestId("root").querySelectorAll(`.${ANCHOR_FLASH_CLASS}`);
    expect(Array.from(overlays, (o) => o.getAttribute(ANCHOR_FLASH_ATTR))).toEqual(["nested"]);
  });

  it("noteId 為 undefined 時 requestAnchor 不設定（不消耗、不拋錯）", () => {
    render(
      <MemoryRouter initialEntries={["/notes/x#b-x"]}>
        <MemberHost noteId={undefined} />
      </MemoryRouter>,
    );
    expect(() => act(() => api.requestAnchor("x"))).not.toThrow();
    expect(scrolls).toEqual([]);
  });

  it("#/slide hash 不處理", () => {
    render(
      <MemoryRouter initialEntries={["/notes/B#/slide-1"]}>
        <MemberHost noteId={B} />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([]);
  });

  it("§10.1 簡報播放中（presenting）冷開 /notes/B?present#b-x：同步後也不捲", () => {
    render(
      <MemoryRouter initialEntries={["/notes/B?present#b-x"]}>
        <MemberHost noteId={B} presenting />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([]);
  });

  it("同篇錨點點擊（真的 useWikilinkActivate，目標 id 大寫）經 currentNoteId 判同篇 ⇒ 捲到該區塊", () => {
    render(
      <MemoryRouter initialEntries={[`/notes/${B}`]}>
        <MemberHost noteId={B} />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([]);
    act(() => activate({ href: `/notes/${B}#b-nested`, targetNoteId: B.toUpperCase(), anchorBlockId: "nested", broken: false }));
    expect(scrolls).toEqual([`${B}:nested`]);
  });
});

describe("#269 W8 useBlockAnchor（公開頁）", () => {
  it("/p/h/a → /p/h/b#b-x（同一個實例）：b 的 doc 到了恰捲一次", () => {
    const tree = (refKey: string, loaded: boolean) => (
      <MemoryRouter initialEntries={["/p/h/a"]}>
        <PublicHost refKey={refKey} loaded={loaded} />
      </MemoryRouter>
    );
    const { rerender } = render(tree("path:h/a", true));
    act(() => void navigate("/p/h/b#b-x"));
    rerender(tree("path:h/b", false));
    expect(scrolls).toEqual([]);
    rerender(tree("path:h/b", true));
    expect(scrolls).toEqual(["path:h/b:x"]);
  });

  it("§10.1 簡報播放中（ignore）冷開 …?present#b-x：不設定、不捲", () => {
    function PresentingHost() {
      const [root, setRoot] = useState<HTMLElement | null>(null);
      useBlockAnchor({ noteKey: "path:h/b", ready: true, root, ignore: true, currentNoteId: null });
      return (
        <div ref={setRoot}>
          <div className="bn-block-outer" data-id="x" data-note="path:h/b" />
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={["/p/h/b?present#b-x"]}>
        <PresentingHost />
      </MemoryRouter>,
    );
    expect(scrolls).toEqual([]);
  });
});
