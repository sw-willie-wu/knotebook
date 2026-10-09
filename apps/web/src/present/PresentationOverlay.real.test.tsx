import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { installFakeFullscreen, type FakeFullscreen } from "@/test/fake-fullscreen";
import { PresentationShell } from "./PresentationShell";
import PresentationOverlay from "./PresentationOverlay";
import { createExportEditor } from "./render";

// 真 reveal（不 mock），但包一層記下實例以便讀 getConfig()。
const captured = vi.hoisted(() => ({ instances: [] as { getConfig(): Record<string, unknown>; getIndices(): { h: number } }[] }));
vi.mock("reveal.js", async (importOriginal) => {
  const Real = (await importOriginal<typeof import("reveal.js")>()).default as unknown as new (el: HTMLElement, o: object) => never;
  function Wrapped(el: HTMLElement, options: object) {
    const instance = new Real(el, options);
    captured.instances.push(instance);
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

function App({ strict = false }: { strict?: boolean }) {
  const tree = (
    <QueryClientProvider client={new QueryClient()}>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/n/:handle/:slug"
              element={
                <PresentationShell title="T" status="ready">
                  <PresentationOverlay variant="public" doc={doc()} title="T" publicRef={{ kind: "token", token: "t" }} />
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

describe("PresentationOverlay（真 reveal.js 6.0.2）", () => {
  let fake: FakeFullscreen | null = null;
  let intervals: MockInstance<typeof setInterval>;
  let timeouts: MockInstance<typeof setTimeout>;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    captured.instances.length = 0;
    intervals = vi.spyOn(globalThis, "setInterval");
    timeouts = vi.spyOn(globalThis, "setTimeout");
  });
  afterEach(async () => {
    // 先卸載（失敗的案也走 controller teardown → reveal.destroy()），再清掉本案建的 timer：reveal 6.0.2 的
    // setupScrollPrevention（js/reveal.js:461）每個實例一支 1 s setInterval、destroy 不清；滑鼠游標隱藏的 5 s
    // setTimeout（controllers/pointer.js:98）也會留下（Task 9 棚內探針：不清時每案卸載 1.5 s 後仍 pending）。
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

  it("test 13：查詢字串鎖定——初始化前網址已正規化、鎖定鍵全符合、沒有 message 監聽、<html> 無列印 class", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present&postMessage=true&hash=true&parallaxBackgroundImage=x&print-pdf");
    const addListener = vi.spyOn(window, "addEventListener");
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
    addListener.mockRestore();
  });

  it("test 15：點全螢幕鈕後按 Space → 全螢幕只切一次、reveal 只前進一張、焦點不在鈕上", async () => {
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

  it("RF1（真 reveal）：?present#/1 → reveal 的 readURL 會依索引跳，controller 拉回封面（§6.4-4，r1-p2 M2）", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present#/1");
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
    await waitFor(() => expect(captured.instances[0].getIndices().h).toBe(0));
    expect(document.querySelector(".reveal .slides section.present[data-kn-slide-id]")?.getAttribute("data-kn-slide-id")).toBe("_title");
    unmount();
  });

  it("test 17：<StrictMode> 下恰一個 .reveal、恰一個 .controls，且 .reveal 有 ready", async () => {
    window.history.replaceState(null, "", "/n/tester/my-note?present");
    const { unmount } = render(<App strict />);
    await waitFor(() => expect(document.querySelector(".reveal.ready")).not.toBeNull());
    expect(document.querySelectorAll(".reveal")).toHaveLength(1);
    expect(document.querySelectorAll(".controls")).toHaveLength(1);
    unmount();
  });
});
