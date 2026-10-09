import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { AiSessionProvider, useAiSession } from "@/components/ai/AiSession";
import { AiPanel } from "@/components/ai/AiPanel";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { CornerStack } from "./CornerStack";

const ACTION: AiActionDto = { id: "a1", name: "Rewrite", applyMode: "direct" };

function stubFetch(actions: AiActionDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ai/actions") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ actions }) } as Response);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

/** 探針：把 versions 與 AI 的狀態印出來，並提供兩顆外部按鈕模擬「從 ⋮ 開版本面板」「AI start()」。 */
function Probe() {
  const v = useVersions();
  const ai = useAiSession();
  return (
    <div>
      <span data-testid="panel-open">{String(v.panelOpen)}</span>
      <span data-testid="ai-collapsed">{String(ai.collapsed)}</span>
      <span data-testid="preview">{String(v.previewSeq)}</span>
      <button type="button" onClick={() => v.open()}>probe-open-versions</button>
      <button type="button" onClick={() => v.startPreview({ seq: 2, id: "v2" })}>probe-preview</button>
      <button type="button" onClick={() => ai.setCollapsed(false)}>probe-ai-expand</button>
      <button type="button" onClick={() => ai.setCollapsed(true)}>probe-ai-collapse</button>
    </div>
  );
}

function Host({ enabled, editable = true, children }: { enabled: boolean; editable?: boolean; children: ReactNode }) {
  const versions = useVersionsController({ noteId: "n1", enabled });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AiSessionProvider 只在 start()/apply 時摸 editor；本檔不觸發
  const editor = {} as any;
  return (
    <VersionsProvider value={versions}>
      <AiSessionProvider editor={editor} noteId="n1" editable={editable}>
        {children}
      </AiSessionProvider>
    </VersionsProvider>
  );
}

function renderStack(opts: { enabled: boolean; actions: AiActionDto[]; editable?: boolean }) {
  stubFetch(opts.actions);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <Host enabled={opts.enabled} editable={opts.editable}>
          <Probe />
          <AiPanel />
          <CornerStack />
        </Host>
      </QueryClientProvider>,
    ),
  };
}

const settled = (qc: QueryClient) => waitFor(() => expect(qc.getQueryState(["ai-actions"])?.status).toBe("success"));

describe("CornerStack（spec §8.1）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("容器：fixed 右下（<md 20px、md+ 24px）、由下往上排、z-30；兩顆泡泡 DOM 順序 AI 在前（＝最底）", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    const stack = await screen.findByTestId("corner-stack");
    expect(stack).toHaveClass("fixed", "bottom-5", "right-5", "md:bottom-6", "md:right-6", "flex", "flex-col-reverse", "gap-3", "z-30");
    const kids = Array.from(stack.children).map((el) => el.getAttribute("data-testid"));
    expect(kids).toEqual(["ai-bubble", "versions-bubble"]);
  });

  it("AI 不渲染（零動作）→ versions-bubble 是容器唯一子項（自然落到最底格）", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [] });
    await settled(queryClient);
    const stack = await screen.findByTestId("corner-stack");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["versions-bubble"]);
  });

  it("viewer（versions enabled=false 且 AI editable=false）→ 整個容器不渲染", async () => {
    const { queryClient } = renderStack({ enabled: false, actions: [ACTION], editable: false });
    await settled(queryClient);
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("歷史泡泡：<md 不渲染（max-md:hidden）、brand icon 鈕同形、aria-label；點了開面板，開著時泡泡消失", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [] });
    await settled(queryClient);
    const bubble = await screen.findByTestId("versions-bubble");
    expect(bubble).toHaveAttribute("aria-label", "Version history");
    expect(bubble).toHaveClass("max-md:hidden", "h-12", "w-12", "rounded-full", "bg-brand-soft");
    fireEvent.click(bubble);
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(screen.queryByTestId("versions-bubble")).not.toBeInTheDocument();
  });

  it("互斥：版本面板 false→true 那一刻 → AI 收合；之後再展開 AI 會關掉版本面板（不是被版本面板立刻收回）", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-ai-expand"));
    expect(screen.getByTestId("ai-collapsed")).toHaveTextContent("false");
    fireEvent.click(screen.getByText("probe-open-versions"));
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(screen.getByTestId("ai-collapsed")).toHaveTextContent("true");
    fireEvent.click(screen.getByText("probe-ai-expand"));
    expect(screen.getByTestId("ai-collapsed")).toHaveTextContent("false");
    expect(screen.getByTestId("panel-open")).toHaveTextContent("false");
  });

  it("互斥只在邊緣觸發：版本面板開著時收合 AI（true）不會重開或再關任何東西", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-open-versions"));
    fireEvent.click(screen.getByText("probe-ai-collapse"));
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(screen.getByTestId("ai-collapsed")).toHaveTextContent("true");
  });

  it("點 AI 泡泡 → 版本面板關、預覽不關（spec §8.1：預覽由橫幅 ✕ 關）", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-open-versions"));
    fireEvent.click(screen.getByText("probe-preview"));
    // 面板開著時 AI 泡泡仍在容器裡（spec：任一面板展開時另一顆照常顯示）
    fireEvent.click(within(screen.getByTestId("corner-stack")).getByTestId("ai-bubble"));
    expect(screen.getByTestId("panel-open")).toHaveTextContent("false");
    expect(screen.getByTestId("preview")).toHaveTextContent("2");
  });

  it("I-4／起草裁定 22：沒有面板展開 → 容器在原位（沒有讓位 class）；版本面板展開 → 容器加 md:right-[calc(20rem+2.25rem)]，bottom 不變", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    const SHIFT = "md:right-[calc(20rem+2.25rem)]";
    expect(await screen.findByTestId("corner-stack")).not.toHaveClass(SHIFT);
    fireEvent.click(screen.getByText("probe-open-versions"));
    const stack = screen.getByTestId("corner-stack");
    expect(stack).toHaveClass(SHIFT, "md:bottom-6", "bottom-5", "right-5");
    expect(stack).not.toHaveClass("md:right-6");
  });

  it("I-4：AI 面板展開（版本 enabled、面板關）→ 容器同樣讓位，只剩歷史泡泡", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-ai-expand"));
    const stack = screen.getByTestId("corner-stack");
    expect(stack).toHaveClass("md:right-[calc(20rem+2.25rem)]");
    expect(Array.from(stack.children).map((el) => el.getAttribute("data-testid"))).toEqual(["versions-bubble"]);
  });

  it("N-2：AI 零動作（AI 面板根本不渲染）時，即使 collapsed=false 也不讓位", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-ai-expand"));
    expect(screen.getByTestId("ai-collapsed")).toHaveTextContent("false");
    const stack = screen.getByTestId("corner-stack");
    expect(stack).toHaveClass("md:right-6");
    expect(stack).not.toHaveClass("md:right-[calc(20rem+2.25rem)]");
  });

  it("M-10 反例：AI 展開時 AI 泡泡不在容器裡（只看 editable／actions 不夠，還要 collapsed）", async () => {
    const { queryClient } = renderStack({ enabled: false, actions: [ACTION] });
    await settled(queryClient);
    expect(await screen.findByTestId("ai-bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByText("probe-ai-expand"));
    expect(screen.getByTestId("ai-collapsed")).toHaveTextContent("false");
    expect(screen.queryByTestId("ai-bubble")).not.toBeInTheDocument();
    expect(screen.queryByTestId("corner-stack")).not.toBeInTheDocument();
  });

  it("捲動淡出掛在容器：capture 收內層捲動、800ms 後恢復；鍵盤焦點強制現形", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
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

  it("淡出監聽的掛載條件（正例）：版本面板開著、AI 收合 → 容器裡還有 AI 泡泡 → 掛監聽（捲動起 1 個計時器）", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [ACTION] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-open-versions"));
    expect(screen.getByTestId("panel-open")).toHaveTextContent("true");
    expect(within(screen.getByTestId("corner-stack")).getByTestId("ai-bubble")).toBeInTheDocument();
    vi.useFakeTimers();
    try {
      fireEvent.scroll(document.body);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("淡出監聽的掛載條件（反例）：AI 零動作＋版本面板開著 → 容器空、不渲染、不掛監聽", async () => {
    const { queryClient } = renderStack({ enabled: true, actions: [] });
    await settled(queryClient);
    fireEvent.click(screen.getByText("probe-open-versions"));
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
