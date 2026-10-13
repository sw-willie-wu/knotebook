import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { NARROW_QUERY, VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { CornerStack } from "./CornerStack";

/** 探針：印出版本面板狀態，並提供「從 ⋮ 開版本面板」的外部按鈕。 */
function Probe() {
  const v = useVersions();
  return (
    <div>
      <span data-testid="panel-open">{String(v.panelOpen)}</span>
      <button type="button" onClick={() => v.open()}>
        probe-open-versions
      </button>
    </div>
  );
}

function Host({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const versions = useVersionsController({ noteId: "n1", enabled });
  return <VersionsProvider value={versions}>{children}</VersionsProvider>;
}

function renderStack(enabled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Host enabled={enabled}>
        <Probe />
        <CornerStack />
      </Host>
    </QueryClientProvider>,
  );
}

const SHIFT = "md:right-[calc(20rem+2.25rem)]";

describe("CornerStack（spec 2026-10-09 §8.1；#263 起只剩歷史泡泡）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("容器：fixed 右下（<md 20px、md+ 24px）、由下往上排、z-30；唯一子項是歷史泡泡，沒有 AI 泡泡、沒有讓位 class", async () => {
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["versions-bubble"]);
    expect(screen.queryByTestId("ai-bubble")).not.toBeInTheDocument();
    expect(stack).toHaveClass("fixed", "bottom-5", "right-5", "md:bottom-6", "md:right-6", "flex", "flex-col-reverse", "gap-3", "z-30");
    expect(stack).not.toHaveClass(SHIFT);
  });

  function installMatchMedia(narrow: boolean): (next: boolean) => void {
    let current = narrow;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        get matches() {
          return query === NARROW_QUERY ? current : false;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      })),
    );
    return (next) => {
      current = next;
      act(() => listeners.forEach((fn) => fn()));
    };
  }

  it("窄視窗：沒有歷史泡泡（整個容器不渲染）；寬：有；跨斷點跟著變", async () => {
    const setNarrow = installMatchMedia(true);
    renderStack(true);
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    setNarrow(false);
    expect(await screen.findByTestId("versions-bubble")).toBeInTheDocument();
    setNarrow(true);
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("viewer（versions enabled=false）→ 整個容器不渲染", () => {
    renderStack(false);
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
  });

  it("歷史泡泡：brand icon 鈕同形、aria-label；點了開面板，開著時整個容器消失", async () => {
    renderStack(true);
    const bubble = await screen.findByTestId("versions-bubble");
    expect(bubble).toHaveAttribute("aria-label", "Version history");
    expect(bubble).toHaveClass("h-12", "w-12", "rounded-full", "bg-brand-soft");
    fireEvent.click(bubble);
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
  });

  it("捲動淡出掛在容器：capture 收內層捲動、800ms 後恢復；鍵盤焦點強制現形", async () => {
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    expect(stack).toHaveClass("focus-within:opacity-100", "focus-within:pointer-events-auto");
    vi.useFakeTimers();
    try {
      fireEvent.scroll(document.body);
      expect(stack).toHaveClass("opacity-0", "pointer-events-none");
      act(() => {
        vi.advanceTimersByTime(799);
      });
      expect(stack).toHaveClass("opacity-0");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(stack).not.toHaveClass("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("淡出監聽的掛載條件：版本面板開著（容器不渲染）→ 不掛監聽，捲動不起計時器", async () => {
    renderStack(true);
    fireEvent.click(await screen.findByText("probe-open-versions"));
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    vi.useFakeTimers();
    try {
      fireEvent.scroll(document.body);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
