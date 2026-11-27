import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import * as Y from "yjs";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { canonicalNotePath, YDOC_FRAGMENT, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider, useTheme } from "@/theme";
import { FakeReveal } from "@/test/fake-reveal";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { PresentationShell } from "./PresentationShell";
import PresentationOverlay, { type PresentationOverlayProps } from "./PresentationOverlay";
import { resetCodeHighlightForTests } from "./code-highlight";
import { createExportEditor, renderDeck } from "./render";
import { UPDATE_DEBOUNCE_MS } from "./debounce";
import { OWNER_PERMS } from "@/test/fixtures";

vi.mock("reveal.js", async () => ({ default: (await import("@/test/fake-reveal")).FakeReveal }));
const mermaid = vi.hoisted(() => ({ renderMermaid: vi.fn(async () => ({ ok: true as const, svg: "<svg data-m></svg>" })) }));
vi.mock("@/lib/mermaid", () => mermaid);
const katex = vi.hoisted(() => ({ renderMath: vi.fn(async () => ({ ok: true as const, html: '<span class="katex" data-k></span>' })) }));
vi.mock("@/lib/katex", () => katex);
const shikiMock = vi.hoisted(() => {
  const codeToTokens = vi.fn((code: string) => ({
    tokens: code.split("\n").map((line) => [{ content: line, color: "var(--code-token-keyword)", fontStyle: 0 }]),
  }));
  const loadLanguage = vi.fn(async () => {});
  const createHighlighter = vi.fn(async () => ({
    getLoadedLanguages: () => ["typescript"],
    loadLanguage,
    getLoadedThemes: () => ["knotebook-code"],
    codeToTokens,
  }));
  return { createHighlighter, loadLanguage, codeToTokens };
});
vi.mock("@/lib/code-highlight", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/code-highlight")>();
  return { ...real, createHighlighter: shikiMock.createHighlighter };
});
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
  const { setTheme } = useTheme();
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

/** Waits until reveal is built (not until ready: cases where the config check fails never become ready). */
const instance = async () => {
  await waitFor(() => expect(FakeReveal.instances.length).toBeGreaterThan(0));
  return FakeReveal.instances.at(-1)!;
};
/** Waits for the controller to finish initialize().then (slidechanged listener attached = checked, positioned, ready announced). */
const ready = async () => {
  const deck = await instance();
  await waitFor(() => expect(deck.listenerCount("slidechanged")).toBe(1));
  return deck;
};
const loc = () => screen.getByTestId("loc").textContent;
const slideEl = (id: string) => document.querySelector<HTMLElement>(`[data-kn-slide-id="${id}"]`)!;

describe("PresentationOverlay (fake reveal)", () => {
  let fake: FakeFullscreen | null = null;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    FakeReveal.reset();
    nav.fn.mockClear();
    mermaid.renderMermaid.mockClear();
    katex.renderMath.mockClear();
    resetCodeHighlightForTests();
    shikiMock.createHighlighter.mockClear();
    shikiMock.loadLanguage.mockClear();
    shikiMock.codeToTokens.mockClear();
    vi.mocked(renderDeck).mockClear();
  });

  afterEach(async () => {
    await fake?.uninstall();
    fake = null;
    window.history.replaceState(null, "", "/");
    document.documentElement.classList.remove("dark");
  });

  it("init: builds its own .reveal > .slides, config follows `reveal-config`, no id / data-id", async () => {
    setup();
    const deck = await ready();
    expect(deck.el.className).toContain("reveal");
    expect(deck.config).toMatchObject({ embedded: true, disableLayout: true, hash: false, postMessage: false, view: null });
    expect(document.querySelectorAll(".reveal .slides [id], .reveal .slides [data-id]")).toHaveLength(0);
    expect(document.querySelectorAll(".reveal .slides section[data-kn-slide-id]")).toHaveLength(4);
  });

  it("after ready the shell doesn't listen to Esc; reveal's keyboard[27] leaves, navigate exactly once", async () => {
    setup();
    const deck = await ready();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(nav.fn).not.toHaveBeenCalled();
    act(() => deck.pressKey(27));
    await waitFor(() => expect(loc()).toBe(BASE));
    expect(nav.fn).toHaveBeenCalledTimes(1);
  });

  it("with the overview open, Esc closes only the overview; O toggles the overview", async () => {
    setup();
    const deck = await ready();
    act(() => deck.pressKey(79));
    expect(deck.toggleOverview).toHaveBeenLastCalledWith();
    expect(deck.overview).toBe(true);
    act(() => deck.pressKey(27));
    expect(deck.toggleOverview).toHaveBeenLastCalledWith(false);
    expect(nav.fn).not.toHaveBeenCalled();
  });

  it("F -> the shell's toggleFullscreen (requestFullscreen once)", async () => {
    fake = installFakeFullscreen();
    setup();
    const deck = await ready();
    act(() => deck.pressKey(70));
    expect(fake.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("config check failure -> shell shows configRefused, overlay torn down (destroy once, .reveal removed); a later Esc navigates exactly once", async () => {
    FakeReveal.configOverride = { postMessage: true };
    setup();
    const deck = await instance();
    expect(await screen.findByRole("alert")).toHaveTextContent("Presentation settings were unexpected, so playback stopped");
    expect(deck.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".reveal")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("query-string assertion fails before init (window.location.search is not ?present) -> no reveal built, configRefused", async () => {
    setup({ windowSearch: "?present&hash=true" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Presentation settings were unexpected, so playback stopped");
    expect(FakeReveal.instances).toHaveLength(0);
    expect(document.querySelector(".kn-present")).toBeNull();
    expect(nav.fn).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(nav.fn).toHaveBeenCalledTimes(1));
  });

  it("initial export throws (in a microtask, the error boundary can't catch it) -> shell shows app.noteCrash, no reveal built, no uncaught exception", async () => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = new Error("export failure");
      vi.mocked(renderDeck).mockImplementationOnce(() => {
        throw failure;
      });
      setup();
      expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on this page.");
      expect(FakeReveal.instances).toHaveLength(0);
      expect(document.querySelector(".reveal")).toBeNull();
      expect(uncaught).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(failure); // The error object must stay in the console so it can be found in production.
    } finally {
      consoleError.mockRestore();
      process.off("uncaughtException", uncaught);
    }
  });

  it("export throws on update (inside the debounce timer) -> shell shows app.noteCrash, overlay torn down (destroy once), no uncaught exception", async () => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const publicRef = { kind: "token" as const, token: "t" };
      const { rerenderWith } = setup({ props: { variant: "public", doc: makeDoc(), title: "My Note", publicRef } });
      const deck = await ready();
      const failure = new Error("export failure");
      vi.mocked(renderDeck).mockImplementationOnce(() => {
        throw failure;
      });
      rerenderWith({ variant: "public", doc: makeDoc(), title: "Renamed", publicRef });
      expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on this page.");
      // The error message and the overlay unmount land in the same commit, but the effect cleanup (dispose -> destroy) runs in a later scheduler task;
      // if the event loop stalls for >= 1 ms, findByRole's closing setTimeout(0) arrives first (went red under CI load).
      await waitFor(() => expect(deck.destroy).toHaveBeenCalledTimes(1));
      expect(document.querySelector(".reveal")).toBeNull();
      expect(uncaught).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(failure);
    } finally {
      consoleError.mockRestore();
      process.off("uncaughtException", uncaught);
    }
  });

  it("after unmount: slide DOM emptied, keyboard handler no longer touches reveal or the shell (mitigates the reveal 6.0.2 interval leak)", async () => {
    fake = installFakeFullscreen();
    const { unmount } = setup();
    const deck = await ready();
    const slidesEl = deck.el.querySelector(".slides")!;
    const body = slideEl("a").querySelector(".kn-slide-body")!;
    expect(body.childNodes.length).toBeGreaterThan(0);
    unmount();
    expect(deck.destroy).toHaveBeenCalledTimes(1);
    expect(slidesEl.childElementCount).toBe(0);
    expect(body.childNodes).toHaveLength(0);
    nav.fn.mockClear();
    deck.isOverview.mockClear();
    deck.toggleOverview.mockClear();
    // reveal's interval keeps config.keyboard alive, so the handler must already be detached from this presentation.
    deck.pressKey(27);
    deck.pressKey(79);
    deck.pressKey(70);
    expect(deck.isOverview).not.toHaveBeenCalled();
    expect(deck.toggleOverview).not.toHaveBeenCalled();
    expect(fake.requestFullscreen).not.toHaveBeenCalled();
    expect(nav.fn).not.toHaveBeenCalled();
  });

  it("unmount before initialize resolves -> destroy only after it resolves, exactly once", async () => {
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

  it("under StrictMode exactly one .reveal and exactly one reveal created", async () => {
    setup({ strict: true });
    await ready();
    expect(document.querySelectorAll(".reveal")).toHaveLength(1);
    expect(FakeReveal.instances).toHaveLength(1);
  });

  it("deep link to a vertical slide -> slide(h, v) has v = 1", async () => {
    setup({ entry: `${BASE}?present#/a2` });
    const deck = await ready();
    expect(deck.slide).toHaveBeenCalledWith(1, 1);
  });

  it.each(["#/%E0%A4%A", "#/nope", "#/", "#/1", "#/2/0", "#x"])("hash %s matches no slide -> no throw, explicit slide(0, 0) returns to the cover, still ready", async (hash) => {
    setup({ entry: `${BASE}?present${hash}` });
    const deck = await ready();
    expect(deck.slide).toHaveBeenCalledWith(0, 0);
    expect(deck.indices).toEqual({ h: 0, v: 0 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("slide change -> hash written as #/<id> with replace (history isn't extended)", async () => {
    setup();
    const deck = await ready();
    act(() => deck.slide(2, 0));
    await waitFor(() => expect(loc()).toBe(`${BASE}?present#/b`));
    expect(nav.fn).toHaveBeenLastCalledWith({ pathname: BASE, search: "?present", hash: "#/b" }, { replace: true, state: null });
  });

  it("after the first build the cover DOM with a wikilink contains the wikilink text (the export runs in a microtask)", async () => {
    setup();
    await ready();
    expect(slideEl("_title").textContent).toContain("Meeting Notes");
  });

  it("signed-in wikilink reads the ['notes'] cache at render time (hit -> current title)", async () => {
    setup({
      notes: [{ id: "n1", title: "Renamed meeting", ownerId: "u1", role: "owner", createdAt: "", updatedAt: "", slug: "renamed", slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS }],
    });
    await ready();
    expect(slideEl("_title").querySelector("a")!.textContent).toBe("Renamed meeting");
  });

  it("#269: the document stores an uppercase targetNoteId and the ['notes'] cache has lowercase ids => hit (clickable link plus current title), not a broken link", async () => {
    // Must contain a-f: an all-digit id is unchanged by toUpperCase(), so case handling wouldn't be exercised.
    const hex = "abcdef12-3456-4789-8abc-def123456789";
    expect(hex.toUpperCase()).not.toBe(hex);
    const note: NoteDto = { id: hex, title: "Renamed meeting", ownerId: "u1", role: "owner", createdAt: "", updatedAt: "", slug: "renamed", slugIsCustom: false, prevSlug: null, ownerHandle: "tester", lastEdited: null, group: null, groupId: null, folderId: null, permissions: OWNER_PERMS };
    const doc = blocksToYDoc(
      createExportEditor(),
      [{ id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: hex.toUpperCase(), snapshotTitle: "Meeting Notes" } }] }] as never,
      YDOC_FRAGMENT,
    );
    setup({ props: { variant: "member", doc, title: "My Note" }, notes: [note] });
    await ready();
    const a = slideEl("_title").querySelector("a")!;
    expect([a.textContent, a.getAttribute("href")]).toEqual(["Renamed meeting", canonicalNotePath(note)]);
    expect(slideEl("_title").querySelector(".kn-present-wikilink-broken")).toBeNull();
  });

  it("5 updates within 100 ms -> one re-slice; sustained updates > 2 s -> applied at least once", async () => {
    const doc = makeDoc();
    setup({ props: { variant: "member", doc, title: "My Note" } });
    await ready();
    const initialCalls = vi.mocked(renderDeck).mock.calls.length;
    // A valid content change: insert one character before the first text (the XmlText of heading A) in the document; pushing an element straight into the fragment
    // produces a structure BlockNote can't read.
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
    await waitFor(() => expect(vi.mocked(renderDeck).mock.calls.length).toBe(initialCalls + 1));
    await new Promise((r) => setTimeout(r, 700));
    expect(vi.mocked(renderDeck).mock.calls.length).toBe(initialCalls + 1);

    // Type one character every 100 ms until the re-slice happens (cap 6 s). A fixed 'verify after typing for 2.3 s' window is avoided: maxWait is 2 s,
    // leaving only 300 ms of slack, so a late timer under parallel load would give a false red. Instead prove the trailing timer never had a chance to expire:
    // debouncer.schedule() is called synchronously inside the insert's transaction, so the i-th schedule falls between [before typing, after typing];
    // the re-slice time is taken when renderDeck is called (>= when the timer actually fired). Hence
    //   the gap between consecutive schedules <= the later one's 'after typing' - the earlier one's 'before typing',
    //   last schedule to re-slice <= re-slice time - the last one's 'before typing',
    // and all these upper bounds are < UPDATE_DEBOUNCE_MS => this re-slice can only have been triggered by maxWait. Only typing and the re-slice itself are measured,
    // not sleep/poll latency, so a CPU stall can only cause a false red if it really lands between two schedules.
    // The exact maxWait instant is covered by debounce.test.ts with fake timers.
    const fireTimes: number[] = [];
    const realRenderDeck = vi.mocked(renderDeck).getMockImplementation()!;
    vi.mocked(renderDeck).mockImplementation((input) => {
      fireTimes.push(Date.now());
      return realRenderDeck(input);
    });
    try {
      const keys: { before: number; after: number }[] = [];
      const started = Date.now();
      while (fireTimes.length === 0 && Date.now() - started < 6_000) {
        const t = Date.now();
        typeChar();
        keys.push({ before: t, after: Date.now() });
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(fireTimes.length).toBeGreaterThan(0);
      const fire = fireTimes[0];
      // A timer callback can't interleave with the synchronous typeChar: inputs completed before the re-slice are those whose 'after typing' is not later than it.
      const sent = keys.filter((k) => k.after <= fire);
      expect(sent.length).toBeGreaterThan(0);
      const gapBounds = sent.slice(1).map((k, i) => k.after - sent[i].before);
      gapBounds.push(fire - sent[sent.length - 1].before);
      expect(Math.max(...gapBounds)).toBeLessThan(UPDATE_DEBOUNCE_MS);
    } finally {
      vi.mocked(renderDeck).mockImplementation(realRenderDeck);
    }
  });

  it("current slide deleted -> slide() to the previous one, hash replaced; current slide content changed -> scroll to top; other slide changed -> no scroll, current slide not rebuilt", async () => {
    const editor = createExportEditor();
    const v1 = makeDoc();
    const { rerenderWith } = setup({ props: { variant: "public", doc: v1, title: "My Note", publicRef: { kind: "token", token: "t" } } });
    const deck = await ready();
    act(() => deck.slide(1, 1));
    await waitFor(() => expect(loc()).toBe(`${BASE}?present#/a2`));

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
    await waitFor(() => expect(slideEl("b").textContent).toContain("B changed"));
    expect(slideEl("a2").querySelector(".kn-slide-body")!.firstChild).toBe(a2Body);
    expect(scrollSet).not.toHaveBeenCalled();
    expect(deck.syncSlide).toHaveBeenCalledWith(slideEl("b"));
    expect(deck.sync).not.toHaveBeenCalled();

    const v3 = blocksToYDoc(editor, [
      { id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } }] },
      { id: "a", type: "heading", props: { level: 2 }, content: "A" },
      { id: "pa", type: "paragraph", content: "alpha" },
      { id: "a2", type: "heading", props: { level: 3 }, content: "A2 edited" },
      { id: "b", type: "heading", props: { level: 2 }, content: "B changed" },
    ] as never, YDOC_FRAGMENT);
    rerenderWith({ variant: "public", doc: v3, title: "My Note", publicRef: { kind: "token", token: "t" } });
    await waitFor(() => expect(scrollSet).toHaveBeenCalledWith(0));

    const v4 = blocksToYDoc(editor, [
      { id: "p0", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } }] },
      { id: "a", type: "heading", props: { level: 2 }, content: "A" },
      { id: "pa", type: "paragraph", content: "alpha" },
      { id: "b", type: "heading", props: { level: 2 }, content: "B changed" },
    ] as never, YDOC_FRAGMENT);
    rerenderWith({ variant: "public", doc: v4, title: "My Note", publicRef: { kind: "token", token: "t" } });
    await waitFor(() => expect(loc()).toBe(`${BASE}?present#/a`));
    expect(nav.fn).toHaveBeenLastCalledWith({ pathname: BASE, search: "?present", hash: "#/a" }, { replace: true, state: null });
    expect(deck.slide).toHaveBeenLastCalledWith(1, 0);
    expect(deck.sync).toHaveBeenCalled();
    expect(deck.destroy).not.toHaveBeenCalled();
  });

  it("theme switch -> mermaid redrawn with the new theme", async () => {
    setup({ props: { variant: "public", doc: makeDoc([{ id: "m", type: "mermaid", props: { code: "graph TD" } }]), title: "T", publicRef: { kind: "token", token: "t" } } });
    await ready();
    await waitFor(() => expect(mermaid.renderMermaid).toHaveBeenCalledWith("graph TD", "light"));
    const before = mermaid.renderMermaid.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "switch-theme-dark" }));
    await waitFor(() => expect(mermaid.renderMermaid.mock.calls.length).toBeGreaterThan(before));
    expect(mermaid.renderMermaid).toHaveBeenLastCalledWith("graph TD", "dark");
  });

  it("math block is drawn after mount with the KaTeX html, and a theme switch does not redraw it", async () => {
    setup({ props: { variant: "public", doc: makeDoc([{ id: "m", type: "math", props: { tex: "E=mc^2" } }]), title: "T", publicRef: { kind: "token", token: "t" } } });
    await ready();
    await waitFor(() => expect(document.querySelector(".kn-present-math .katex[data-k]")).not.toBeNull());
    expect(katex.renderMath).toHaveBeenCalledTimes(1);
    expect(katex.renderMath).toHaveBeenCalledWith("E=mc^2");
    fireEvent.click(screen.getByRole("button", { name: "switch-theme-dark" }));
    await waitFor(() => expect(document.querySelector(".kn-present-math .katex[data-k]")).not.toBeNull());
    expect(katex.renderMath).toHaveBeenCalledTimes(1);
  });

  it("math block that fails to render shows the localized hint and its source", async () => {
    katex.renderMath.mockResolvedValueOnce({ ok: false as never, message: "bad" } as never);
    setup({ props: { variant: "public", doc: makeDoc([{ id: "m", type: "math", props: { tex: "\\bad" } }]), title: "T", publicRef: { kind: "token", token: "t" } } });
    await ready();
    await waitFor(() => expect(document.querySelector(".kn-present-math-error")).not.toBeNull());
    expect(document.querySelector(".kn-present-math-error")!.textContent).toBe("This formula couldn't be drawn — here is its source");
    expect(document.querySelector(".kn-present-math pre > code")!.textContent).toBe("\\bad");
  });

  it("math live edit: the changed slide redraws with the new tex, and a late result for the replaced element is discarded", async () => {
    let resolveFirst!: (r: { ok: true; html: string }) => void;
    katex.renderMath
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }) as never)
      .mockImplementation((async (tex: string) => ({ ok: true as const, html: `<span class="katex" data-tex="${tex}"></span>` })) as never);
    const publicRef = { kind: "token" as const, token: "t" };
    const { rerenderWith } = setup({ props: { variant: "public", doc: makeDoc([{ id: "m", type: "math", props: { tex: "a+b" } }]), title: "T", publicRef } });
    await ready();
    const firstEl = slideEl("b").querySelector(".kn-present-math")!;
    expect(katex.renderMath).toHaveBeenCalledWith("a+b");

    rerenderWith({ variant: "public", doc: makeDoc([{ id: "m", type: "math", props: { tex: "c+d" } }]), title: "T", publicRef });
    await waitFor(() => expect(slideEl("b").querySelector(".katex[data-tex]")?.getAttribute("data-tex")).toBe("c+d"));
    expect(katex.renderMath).toHaveBeenLastCalledWith("c+d");
    expect(firstEl.isConnected).toBe(false);

    await act(async () => {
      resolveFirst({ ok: true, html: '<span class="katex" data-stale></span>' });
      await Promise.resolve();
    });
    expect(firstEl.querySelector("[data-stale]")).toBeNull();
    expect(slideEl("b").querySelector("[data-stale]")).toBeNull();
    expect(slideEl("b").querySelector(".katex[data-tex]")?.getAttribute("data-tex")).toBe("c+d");
  });

  it("mermaid generation counter: an earlier request returning late is discarded and the DOM holds the later result (one counter per slide, stale results dropped)", async () => {
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

  it("code highlighting: notes without supported code blocks never load shiki", async () => {
    setup({
      props: {
        variant: "public",
        doc: makeDoc([{ id: "c0", type: "codeBlock", props: { language: "text" }, content: "plain text" }]),
        title: "T",
        publicRef: { kind: "token", token: "t" },
      },
    });
    await ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(shikiMock.createHighlighter).not.toHaveBeenCalled();
    expect(slideEl("b").querySelector("pre > code")!.textContent).toBe("plain text");
  });

  it("code highlighting: colors code blocks with --code-* vars, skips re-tokenizing on theme switch, and reuses cache synchronously on live update", async () => {
    const publicRef = { kind: "token" as const, token: "t" };
    const doc1 = makeDoc([
      { id: "c1", type: "codeBlock", props: { language: "ts" }, content: "const x = 1;" },
      { id: "pb", type: "paragraph", content: "v1" },
    ]);
    const { rerenderWith } = setup({ props: { variant: "public", doc: doc1, title: "T", publicRef } });
    await ready();

    await waitFor(() => {
      const span = slideEl("b").querySelector<HTMLSpanElement>("pre > code > span");
      expect(span?.style.color).toBe("var(--code-token-keyword)");
      expect(span?.textContent).toBe("const x = 1;");
    });
    expect(shikiMock.createHighlighter).toHaveBeenCalledTimes(1);
    expect(shikiMock.codeToTokens).toHaveBeenCalledTimes(1);

    // Theme switch: CSS variables flip automatically, so shiki is not called again.
    fireEvent.click(screen.getByRole("button", { name: "switch-theme-dark" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(shikiMock.codeToTokens).toHaveBeenCalledTimes(1);

    // Editing another block on the same slide rebuilds the slide, but the unchanged code block hits the cache synchronously.
    const doc2 = makeDoc([
      { id: "c1", type: "codeBlock", props: { language: "ts" }, content: "const x = 1;" },
      { id: "pb", type: "paragraph", content: "v2" },
    ]);
    rerenderWith({ variant: "public", doc: doc2, title: "T", publicRef });
    await waitFor(() => expect(slideEl("b").textContent).toContain("v2"));
    const spanAfter = slideEl("b").querySelector<HTMLSpanElement>("pre > code > span");
    expect(spanAfter?.style.color).toBe("var(--code-token-keyword)");
    expect(spanAfter?.textContent).toBe("const x = 1;");
    expect(shikiMock.codeToTokens).toHaveBeenCalledTimes(1);
  });

  it("code highlighting: stale async job is discarded when the slide is replaced before shiki resolves", async () => {
    type FakeHl = Awaited<ReturnType<typeof shikiMock.createHighlighter>>;
    let resolveFirst!: (hl: FakeHl) => void;
    shikiMock.createHighlighter.mockImplementationOnce(
      () => new Promise<FakeHl>((resolve) => { resolveFirst = resolve; }),
    );
    const publicRef = { kind: "token" as const, token: "t" };
    const doc1 = makeDoc([{ id: "c1", type: "codeBlock", props: { language: "ts" }, content: "const a = 1;" }]);
    const { rerenderWith } = setup({ props: { variant: "public", doc: doc1, title: "T", publicRef } });
    await ready();
    const firstCodeEl = slideEl("b").querySelector("pre > code")!;
    expect(firstCodeEl.textContent).toBe("const a = 1;");

    const doc2 = makeDoc([{ id: "c1", type: "codeBlock", props: { language: "ts" }, content: "const b = 2;" }]);
    rerenderWith({ variant: "public", doc: doc2, title: "T", publicRef });
    await waitFor(() => expect(slideEl("b").querySelector("pre > code")!.textContent).toBe("const b = 2;"));

    await act(async () => {
      resolveFirst({
        getLoadedLanguages: () => ["typescript"],
        loadLanguage: vi.fn(async () => {}),
        getLoadedThemes: () => ["knotebook-code"],
        codeToTokens: vi.fn((code: string) => ({
          tokens: [[{ content: code, color: "var(--code-token-comment)", fontStyle: 0 }]],
        })),
      });
      await Promise.resolve();
    });
    // The detached element from doc1 was never mutated; doc2's element gets highlighted from its own job.
    expect(firstCodeEl.querySelector("span")).toBeNull();
    await waitFor(() => {
      const span = slideEl("b").querySelector<HTMLSpanElement>("pre > code > span");
      expect(span?.style.color).toBe("var(--code-token-comment)");
      expect(span?.textContent).toBe("const b = 2;");
    });
  });
});
