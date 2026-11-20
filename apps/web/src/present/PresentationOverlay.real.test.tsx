import { StrictMode } from "react";
import type * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { H, P, row } from "@/test/columns-fixtures";
import { PresentationShell } from "./PresentationShell";
import PresentationOverlay from "./PresentationOverlay";
import { createExportEditor } from "./render";

// Real reveal (unmocked), wrapped to record the instance so getConfig() can be read; `listening` records the events the controller attached (signals that `.then()` has run).
const captured = vi.hoisted(() => ({
  instances: [] as { getConfig(): Record<string, unknown>; getIndices(): { h: number }; next(): void }[],
  listening: [] as string[],
}));
vi.mock("reveal.js", async (importOriginal) => {
  const Real = (await importOriginal<typeof import("reveal.js")>()).default as unknown as new (el: HTMLElement, o: object) => never;
  function Wrapped(el: HTMLElement, options: object) {
    const instance = new Real(el, options) as { on(type: string, ...rest: unknown[]): unknown };
    const on = instance.on.bind(instance);
    instance.on = (type: string, ...rest: unknown[]) => {
      captured.listening.push(type);
      return on(type, ...rest);
    };
    captured.instances.push(instance as never);
    return instance;
  }
  return { default: Wrapped };
});
vi.mock("@/lib/mermaid", () => ({ renderMermaid: vi.fn(async () => ({ ok: true, svg: "<svg></svg>" })) }));

function doc() {
  return blocksToYDoc(createExportEditor(), [
    { id: "a", type: "heading", props: { level: 2 }, content: "A" },
    { id: "b", type: "heading", props: { level: 2 }, content: "B" },
  ] as never, YDOC_FRAGMENT);
}

function App({ strict = false, doc: source, client }: { strict?: boolean; doc?: Y.Doc; client?: QueryClient }) {
  const tree = (
    <QueryClientProvider client={client ?? new QueryClient()}>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/n/:handle/:slug"
              element={
                <PresentationShell title="T" status="ready">
                  <PresentationOverlay variant="public" doc={source ?? doc()} title="T" publicRef={{ kind: "token", token: "t" }} />
                </PresentationShell>
              }
            />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

describe("PresentationOverlay (real reveal.js 6.0.2)", () => {
  let fake: FakeFullscreen | null = null;
  let intervals: MockInstance<typeof setInterval>;
  let timeouts: MockInstance<typeof setTimeout>;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    captured.instances.length = 0;
    captured.listening.length = 0;
    intervals = vi.spyOn(globalThis, "setInterval");
    timeouts = vi.spyOn(globalThis, "setTimeout");
  });
  afterEach(async () => {
    // Unmount first (failed cases also go through controller teardown -> reveal.destroy()), then clear the timers this case created: reveal 6.0.2's
    // setupScrollPrevention starts a 1 s setInterval per instance that destroy doesn't clear, and the 5 s mouse-cursor-hide
    // setTimeout (controllers/pointer.js) also lingers (without clearing, each case is still pending 1.5 s after unmount).
    cleanup();
    for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
    for (const result of timeouts.mock.results) if (result.type === "return") clearTimeout(result.value);
    intervals.mockRestore();
    timeouts.mockRestore();
    await fake?.uninstall();
    fake = null;
    document.documentElement.classList.remove("reveal-print", "print-pdf", "reveal-full-page");
    window.history.replaceState(null, "", "/");
  });

  it("query-string lock: URL normalized before init, all lock keys match, no message listener, <html> has no print class", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present&postMessage=true&hash=true&parallaxBackgroundImage=x&print-pdf");
    const addListener = vi.spyOn(window, "addEventListener");
    try {
      const { unmount } = render(<App />);
      await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
      expect(window.location.search).toBe("?present");
      const config = captured.instances[0].getConfig();
      expect(config).toMatchObject({ postMessage: false, hash: false, parallaxBackgroundImage: "", view: null, postMessageEvents: false });
      expect(addListener.mock.calls.some(([type]) => type === "message")).toBe(false);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const html = document.documentElement.classList;
      expect([html.contains("reveal-print"), html.contains("print-pdf"), html.contains("reveal-full-page")]).toEqual([false, false, false]);
      unmount();
    } finally {
      addListener.mockRestore(); // Restore even when the case fails
    }
  });

  it("slides contain no tag row", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present");
    // The note is tagged in the cached list, so a tag row anywhere in the overlay would have something to show.
    const client = new QueryClient();
    client.setQueryData(["notes"], [{ id: "n1", groupId: null, tags: [{ id: "t1", name: "AWS", color: "blue" }] }]);
    render(<App client={client} />);
    await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
    expect(document.querySelector(".reveal .slides")).not.toBeNull();
    expect(document.querySelector("[data-note-content-top], [data-note-tags]")).toBeNull();
    expect(screen.queryByText("AWS")).toBeNull();
  });

  it("after clicking the fullscreen button, Space toggles fullscreen only once, reveal advances one slide, focus isn't on the button", async () => {
    fake = installFakeFullscreen();
    window.history.replaceState(null, "", "/n/tester/my-note?present");
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
    const button = screen.getByRole("button", { name: "Full screen" });
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(document.activeElement).not.toBe(button);
    fireEvent.keyDown(document, { key: " ", code: "Space", keyCode: 32 });
    expect(fake.requestFullscreen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(captured.instances[0].getIndices().h).toBe(1));
    unmount();
  });

  it("real reveal: ?present#/1 -> reveal's readURL jumps by index, the controller pulls back to the cover", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present#/1");
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
    await waitFor(() => expect(captured.instances[0].getIndices().h).toBe(0));
    expect(document.querySelector(".reveal .slides section.present[data-kn-slide-id]")?.getAttribute("data-kn-slide-id")).toBe("_title");
    unmount();
  });

  it("under <StrictMode> exactly one .reveal and one .controls, and .reveal has ready", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present");
    const { unmount } = render(<App strict />);
    await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
    expect(document.querySelectorAll(".reveal")).toHaveLength(1);
    expect(document.querySelectorAll(".controls")).toHaveLength(1);
    unmount();
  });

  describe("stacked columns (the controller's three call sites)", () => {
    // Mimics reveal.css `.slides>section{display:none}`: only a .kn-slide-body inside section.present and attached to the document has a measurable width.
    // jsdom defines clientWidth on Element.prototype and HTMLElement.prototype has no own descriptor, so cleanup uses delete to restore.
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get(this: HTMLElement) {
          return this.isConnected && this.classList.contains("kn-slide-body") && this.closest("section.present") ? 300 : 0;
        },
      });
    });
    afterEach(() => {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    });

    const coverDoc = (left: string) =>
      blocksToYDoc(createExportEditor(), [row([[P(left, "l")], [P("R", "r")]], "row"), H("A", "a"), P("x", "p")] as never, YDOC_FRAGMENT);
    const coverRow = () => document.querySelector('section.present[data-kn-slide-id="_title"] [data-kb-columns]');
    const thenDone = async () => {
      await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
      await waitFor(() => expect(captured.listening).toContain("slidechanged"));
    };

    it("row on the cover (the cover sends no slidechanged): `.then()` measures the width and sets data-stacked", async () => {
      window.history.replaceState(null, "", "/n/tester/my-note?present");
      const { unmount } = render(<App doc={coverDoc("L")} />);
      await thenDone();
      expect(coverRow()?.hasAttribute("data-stacked")).toBe(true);
      unmount();
    });

    it("row on the second slide: not present at `.then()` so not marked; marked data-stacked after navigating to it", async () => {
      window.history.replaceState(null, "", "/n/tester/my-note?present");
      const source = blocksToYDoc(createExportEditor(), [H("A", "a"), row([[P("L", "l")], [P("R", "r")]], "row")] as never, YDOC_FRAGMENT);
      const { unmount } = render(<App doc={source} />);
      await thenDone();
      const rowOnA = () => document.querySelector('section[data-kn-slide-id="a"] [data-kb-columns]');
      expect(rowOnA()).not.toBeNull();
      expect(rowOnA()!.hasAttribute("data-stacked")).toBe(false);
      act(() => captured.instances[0]!.next());
      expect(document.querySelector("section.present")?.getAttribute("data-kn-slide-id")).toBe("a");
      expect(rowOnA()!.hasAttribute("data-stacked")).toBe(true);
      unmount();
    });

    it("swapping the Y.Doc (cover row text changed): after the debounce applyUpdateNow replaces the cover body, and the new row is also marked data-stacked", async () => {
      window.history.replaceState(null, "", "/n/tester/my-note?present");
      const { rerender, unmount } = render(<App doc={coverDoc("L")} />);
      await thenDone();
      expect(coverRow()?.hasAttribute("data-stacked")).toBe(true);
      const before = coverRow();
      rerender(<App doc={coverDoc("L2")} />);
      await waitFor(
        () => {
          const current = coverRow();
          expect(current?.textContent).toContain("L2");
          expect(current).not.toBe(before);
          expect(current!.hasAttribute("data-stacked")).toBe(true);
        },
      );
      unmount();
    });
  });
});
