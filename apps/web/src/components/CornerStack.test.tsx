import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { CornerStack } from "./CornerStack";
import { CORNER_STACK_COLLAPSED_STORAGE_KEY, __resetCornerStackForTests } from "./corner-stack-state";
import { CORNER_STACK_FOOTPRINT_PX, CORNER_STACK_RIGHT_INSET_PX, CORNER_STACK_SIZE_PX } from "./corner-stack-geometry";

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

describe("CornerStack (history bubble at the bottom right of a note)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    __resetCornerStackForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("container: zero-height anchor (relative, h-0) at the scroll area's bottom edge, stack absolute above the anchor on the right; not fixed, ignores safe area; the toggle at the bottom, the history bubble above it", async () => {
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["corner-toggle", "corner-bubbles"]);
    expect(Array.from(screen.getByTestId("corner-bubbles").children).map((el) => el.getAttribute("data-testid"))).toEqual(["versions-bubble"]);
    expect(screen.getByTestId("corner-bubbles")).toHaveClass("flex", "flex-col-reverse", "gap-3");
    expect(screen.queryByTestId("ai-bubble")).not.toBeInTheDocument();
    expect(stack).toHaveClass("absolute", "bottom-[18px]", "right-[calc(18px+var(--bubble-gutter,var(--scrollbar-size)))]", "flex", "flex-col-reverse", "gap-3");
    expect(stack).not.toHaveClass("fixed");
    expect(stack.className).not.toMatch(/safe-area|sm:right|sm:bottom/);
    const anchor = screen.getByTestId("corner-anchor");
    expect(anchor).toContainElement(stack);
    expect(anchor).toHaveClass("relative", "h-0", "shrink-0", "z-20");
  });

  function installTier(tier: LayoutTier): (next: LayoutTier) => void {
    const handle = stubLayoutTier(tier);
    return (next) => act(() => handle.setLayoutTier(next));
  }

  it("phone (< 640): no history bubble (whole container not rendered); floating and fixed tiers have it; follows when crossing breakpoints", async () => {
    const setTier = installTier("phone");
    renderStack(true);
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-anchor")).not.toBeInTheDocument();
    setTier("overlay");
    expect(await screen.findByTestId("versions-bubble")).toBeInTheDocument();
    setTier("docked");
    expect(screen.getByTestId("versions-bubble")).toBeInTheDocument();
    setTier("phone");
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("viewer (versions enabled=false) -> whole container not rendered", () => {
    renderStack(false);
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-anchor")).not.toBeInTheDocument();
  });

  it("history bubble: frosted surface (same as the phone floating button), brand icon color, aria-label; clicking opens the panel, the bubble stays pressed, and clicking it again closes the panel", async () => {
    renderStack(true);
    const bubble = await screen.findByTestId("versions-bubble");
    expect(bubble).toHaveAttribute("aria-label", "Version history");
    expect(bubble).toHaveClass("h-12", "w-12", "rounded-full", "text-brand-on-soft");
    // All tokens of the shared surface are present (hover/active opacity are deepened by the bubble itself, see below).
    for (const token of FROSTED_SURFACE.split(" ").filter((c) => !/hover:bg-card|active:bg-card/.test(c))) expect(bubble).toHaveClass(token);
    expect(bubble).toHaveClass("supports-[backdrop-filter]:backdrop-blur-xs", "supports-[backdrop-filter]:backdrop-saturate-150", "bg-card/95", "shadow-lg");
    expect(bubble).not.toHaveClass("bg-brand-soft");
    // hover is a light brand background, pressed one step darker, pointer cursor; the frosted surface's hover/pressed opacity is merged away.
    expect(bubble).toHaveClass("cursor-pointer", "hover:bg-brand-soft", "supports-[backdrop-filter]:hover:bg-brand-soft", "active:bg-brand-soft-strong", "supports-[backdrop-filter]:active:bg-brand-soft-strong");
    expect(bubble).not.toHaveClass("hover:shadow-xl", "hover:bg-card/95", "active:bg-card/95");
    expect(bubble).not.toHaveClass("supports-[backdrop-filter]:hover:bg-card/30", "supports-[backdrop-filter]:active:bg-card/40");
    expect(bubble).toHaveAttribute("aria-pressed", "false");
    expect(bubble).toHaveClass("aria-pressed:bg-brand-soft-strong", "supports-[backdrop-filter]:aria-pressed:bg-brand-soft-strong");
    fireEvent.click(bubble);
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("versions-bubble"));
    expect(screen.getByTestId("panel-open")).toHaveTextContent("false");
    expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "false");
  });

  describe("the toggle", () => {
    it("expanded by default: points down, names the bubbles it controls, and has the bubble look", async () => {
      renderStack(true);
      const toggle = await screen.findByTestId("corner-toggle");
      expect(toggle).toHaveAttribute("aria-label", "Note panels");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle.getAttribute("aria-controls")).toBe(screen.getByTestId("corner-bubbles").id);
      expect(toggle.querySelector("[data-icon]")).toHaveAttribute("data-icon", "chevron-down");
      expect(toggle).toHaveClass("h-12", "w-12", "rounded-full", "text-brand-on-soft", "bg-card/95", "hover:bg-brand-soft");
    });

    it("collapsing hides the bubbles, points up, keeps focus on the toggle and is remembered; expanding brings them back", async () => {
      const first = renderStack(true);
      const toggle = await screen.findByTestId("corner-toggle");
      toggle.focus();
      fireEvent.click(toggle);
      expect(screen.queryByTestId("versions-bubble")).toBeNull();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).not.toHaveAttribute("aria-controls");
      expect(toggle.querySelector("[data-icon]")).toHaveAttribute("data-icon", "chevron-up");
      expect(toggle).toHaveFocus();
      expect(window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY)).toBe("1");
      first.unmount();

      renderStack(true);
      const again = await screen.findByTestId("corner-toggle");
      expect(again).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("versions-bubble")).toBeNull();
      fireEvent.click(again);
      expect(screen.getByTestId("versions-bubble")).toBeInTheDocument();
      expect(window.localStorage.getItem(CORNER_STACK_COLLAPSED_STORAGE_KEY)).toBeNull();
    });

    it("only shows or hides the bubbles: an open panel stays open, a closed one stays closed", async () => {
      renderStack(true);
      fireEvent.click(await screen.findByTestId("versions-bubble"));
      expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
      fireEvent.click(screen.getByTestId("corner-toggle"));
      expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
      fireEvent.click(screen.getByTestId("corner-toggle"));
      expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
      expect(screen.getByTestId("versions-bubble")).toHaveAttribute("aria-pressed", "true");
    });

    it("storage that throws on read: renders expanded", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      renderStack(true);
      expect(await screen.findByTestId("corner-toggle")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("versions-bubble")).toBeInTheDocument();
    });

    it("storage that throws on write: the toggle still works for this session", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("quota");
      });
      renderStack(true);
      const toggle = await screen.findByTestId("corner-toggle");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("versions-bubble")).toBeNull();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("versions-bubble")).toBeInTheDocument();
    });
  });

  it("CORNER_STACK_FOOTPRINT_PX equals the bubble's 18px offset from the bottom plus the 48px bubble height, and the bubble classes are still bottom-[18px] and h-12", async () => {
    expect(CORNER_STACK_FOOTPRINT_PX).toBe(18 + 48);
    renderStack(true);
    expect(await screen.findByTestId("corner-stack")).toHaveClass("bottom-[18px]");
    expect(screen.getByTestId("versions-bubble")).toHaveClass("h-12");
  });

  it("outline rail geometry: right inset 18px and size 48px match the bubble's classes", async () => {
    expect(CORNER_STACK_RIGHT_INSET_PX).toBe(18);
    expect(CORNER_STACK_SIZE_PX).toBe(48);
    renderStack(true);
    expect(await screen.findByTestId("corner-stack")).toHaveClass("right-[calc(18px+var(--bubble-gutter,var(--scrollbar-size)))]");
    expect(screen.getByTestId("versions-bubble")).toHaveClass("h-12", "w-12");
  });

  it("doesn't fade on scroll: after any scroll event the container has no opacity-0/pointer-events-none and no timer", async () => {
    renderStack(true);
    const stack = await screen.findByTestId("corner-stack");
    const anchor = screen.getByTestId("corner-anchor");
    vi.useFakeTimers();
    try {
      fireEvent.scroll(document.body);
      fireEvent.scroll(window);
      expect(stack).not.toHaveClass("opacity-0");
      expect(stack.className).not.toMatch(/opacity-0|transition-opacity|pointer-events-none/);
      expect(anchor).not.toHaveClass("opacity-0");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
