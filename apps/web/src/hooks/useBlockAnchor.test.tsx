import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { useState } from "react";
import "@/i18n";
import { BlockAnchorContext, type BlockAnchorApi } from "./block-anchor-context";
import { useWikilinkActivate } from "@/components/wikilink/useWikilinkClick";

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
 * NotePage shape: one instance, noteId supplied by the resolver (undefined during transitions); the anchor goes through the real
 * `useMemberBlockAnchor` (the one NotePage calls). Blocks appear only after THIS note has synced: on a real page B's Y.Doc is empty
 * until the provider syncs, so BlockNote has no blocks to render (rendering as soon as the doc exists would let a stale commit find
 * the block too, and the cross-note case could not tell right from wrong).
 */
function MemberHost({ noteId, rootKey = 0, presenting = false }: { noteId: string | undefined; rootKey?: number; presenting?: boolean }) {
  navigate = useNavigate();
  const { doc, synced, syncedFor } = useCollab({ noteId, onUnauthorized: () => {} });
  const [root, setRoot] = useState<HTMLElement | null>(null);
  api = useMemberBlockAnchor({ noteId, collab: { synced, syncedFor }, root, presenting });
  commits.push({ noteId, synced, docNull: doc === null, syncedFor });
  const contentLoaded = doc !== null && noteId !== undefined && syncedFor === noteId;
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

let activate!: ReturnType<typeof useWikilinkActivate>;
function Activator() {
  activate = useWikilinkActivate();
  return null;
}

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
  vi.restoreAllMocks(); // pageLikeRoot's getBoundingClientRect spy
  vi.useRealTimers();
});

describe("#269 blockIdFromHash / scrollToBlock", () => {
  it("accepts only #b-<BLOCK_ANCHOR_RE>; #/slide, empty and malformed ids -> null", () => {
    expect(blockIdFromHash("#b-ok_1")).toBe("ok_1");
    expect(blockIdFromHash("#/slide-1")).toBeNull();
    expect(blockIdFromHash("")).toBeNull();
    expect(blockIdFromHash("#b-壞")).toBeNull();
  });

  /**
   * Page shape: scroll container (root) > article column wrapper (`relative`) > editor root (`.ProseMirror`) > blocks.
   * getBoundingClientRect is stubbed: the origin measured with the overlay at (0,0) is (40, 10), the target block is (300, 30, 500x24)
   * => the overlay should sit at top 260, left 20, 500x24.
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

  it("found: scrolls and the highlight overlay covers the block (coordinates converted from rects), mounted in the article column outside ProseMirror's control, block attributes untouched; nested blocks are found too", () => {
    const { root, column, target } = pageLikeRoot();
    scrollToBlock(root, "deep");
    expect(scrolls).toEqual(["n:deep"]);
    const overlays = overlaysIn(root);
    expect(overlays).toHaveLength(1);
    const overlay = overlays[0] as HTMLElement;
    expect(overlay.parentElement).toBe(column); // not root, and not inside .ProseMirror (a positioned editor root must be skipped too)
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
    expect(target.attributes).toHaveLength(3); // class, data-id, data-note - nodes managed by ProseMirror are not modified
    root.remove();
  });

  it("overlay: removed on animationend", () => {
    const { root } = pageLikeRoot();
    scrollToBlock(root, "deep");
    overlaysIn(root)[0]!.dispatchEvent(new Event("animationend"));
    expect(overlaysIn(root)).toHaveLength(0);
    root.remove();
  });

  it("overlay: with no animationend (prefers-reduced-motion does not animate) removed after 2 s; cancelling (unmount / next request) removes it immediately", () => {
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

  it("not found at first: MutationObserver waits for it to appear, then scrolls; not appearing within 2 s -> no scroll, no error", async () => {
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
    expect(scrolls).toEqual(["n:late"]); // a block that appears after the wait limit is not scrolled to (the observer has stopped)
    root.remove();
  });
});

describe("#269 useBlockAnchor (member: real useCollab)", () => {
  it("A -> /notes/B#b-x (through undefined, converging REPLACE before B syncs): the stale commit does not consume it; B syncs only after the wait limit and still scrolls exactly once", async () => {
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
    act(() => void navigate("/n/h/b#b-x", { replace: true })); // converging REPLACE (keeps the hash)
    expect(commits.some((c) => c.noteId === B && c.synced && c.docNull)).toBe(true);
    expect(scrolls).toEqual([]);
    // Real timers: wait past ANCHOR_WAIT_MS before letting B sync.
    await act(async () => {
      await new Promise((r) => setTimeout(r, ANCHOR_WAIT_MS + 300));
    });
    expect(scrolls).toEqual([]);
    act(() => providerAt(1).emit("synced", { state: true }));
    expect(scrolls).toEqual([`${B}:x`]);
  }, 10_000);

  it("the member anchor waits for syncedFor to name this note, not for synced", () => {
    // B's blocks are present throughout, so only `ready` decides when the anchor is consumed.
    function SyntheticHost({ collab }: { collab: { synced: boolean; syncedFor: string | null } }) {
      const [root, setRoot] = useState<HTMLElement | null>(null);
      useMemberBlockAnchor({ noteId: B, collab, root, presenting: false });
      return (
        <div ref={setRoot}>
          <div className="bn-block-outer" data-id="x" data-note={B} />
        </div>
      );
    }
    const tree = (collab: { synced: boolean; syncedFor: string | null }) => (
      <MemoryRouter initialEntries={["/notes/B#b-x"]}>
        <SyntheticHost collab={collab} />
      </MemoryRouter>
    );
    const { rerender } = render(tree({ synced: true, syncedFor: null }));
    expect(scrolls).toEqual([]);
    rerender(tree({ synced: true, syncedFor: A }));
    expect(scrolls).toEqual([]);
    rerender(tree({ synced: true, syncedFor: B }));
    expect(scrolls).toEqual([`${B}:x`]);
  });

  it("new tab / cold open /notes/B#b-x (REPLACE before synced) scrolls exactly once; later unrelated REPLACEs and modal toggles (query changes) do not scroll again", () => {
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

  it("after scrolling, the scroll container is swapped (NoteEditor remount => onScrollRoot reports a new element): no scroll (the pending anchor was cleared once consumed)", () => {
    const tree = (rootKey: number) => (
      <MemoryRouter initialEntries={["/notes/B#b-x"]}>
        <MemberHost noteId={B} rootKey={rootKey} />
      </MemoryRouter>
    );
    const { rerender } = render(tree(0));
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([`${B}:x`]);
    rerender(tree(1)); // key changed => old div unmounts, new div mounts; the ref callback reports null then the new element in order
    expect(scrolls).toEqual([`${B}:x`]);
  });

  it("the same anchor can be scrolled to again via requestAnchor after scrolling away; requestAnchor's block is in this note; repeated requests within 2 s leave only the last highlight overlay", () => {
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

  it("requestAnchor sets nothing when noteId is undefined (nothing consumed, no throw)", () => {
    render(
      <MemoryRouter initialEntries={["/notes/x#b-x"]}>
        <MemberHost noteId={undefined} />
      </MemoryRouter>,
    );
    expect(() => act(() => api.requestAnchor("x"))).not.toThrow();
    expect(scrolls).toEqual([]);
  });

  it("#/slide hash is not handled", () => {
    render(
      <MemoryRouter initialEntries={["/notes/B#/slide-1"]}>
        <MemberHost noteId={B} />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([]);
  });

  it("presenting: cold open /notes/B?present#b-x does not scroll after sync either", () => {
    render(
      <MemoryRouter initialEntries={["/notes/B?present#b-x"]}>
        <MemberHost noteId={B} presenting />
      </MemoryRouter>,
    );
    act(() => providerAt(0).emit("synced", { state: true }));
    expect(scrolls).toEqual([]);
  });

  it("same-note anchor click (real useWikilinkActivate, uppercase target id) is judged same-note via currentNoteId => scrolls to that block", () => {
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

describe("#269 useBlockAnchor (public page)", () => {
  it("/p/h/a -> /p/h/b#b-x (same instance): scrolls exactly once when b's doc arrives", () => {
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

  it("presenting (ignoreInitialAnchor): cold open ...?present#b-x sets nothing and does not scroll", () => {
    function PresentingHost() {
      const [root, setRoot] = useState<HTMLElement | null>(null);
      useBlockAnchor({ noteKey: "path:h/b", ready: true, root, ignoreInitialAnchor: true, currentNoteId: null });
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
