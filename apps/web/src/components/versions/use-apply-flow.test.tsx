import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionCurrentDto, VersionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { useApplyFlow } from "./use-apply-flow";

// useApplyFlow × controller 的 `onApplied`（Task 10 fix round 1）：只在套用成功、且 mutateAsync resolve 之後通知；
// 通知本身出錯不得把成功變成錯誤 toast（它排在 closeDialog／stopPreview 之後）。
const NOTE = "n1";
const V1: VersionDto = { id: "v-1", seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, createdAt: "2026-10-09T00:00:00.000Z" };
const CURRENT: VersionCurrentDto = { baseSeq: 2, dirty: false, nextSeq: 3, autoEnabled: true };
const APPLY1 = `/api/notes/${NOTE}/versions/1/apply`;

function Harness() {
  const s = useVersions();
  const { applyNow } = useApplyFlow(NOTE);
  return (
    <div>
      <button type="button" onClick={() => s.startPreview({ seq: 1, id: "v-1" })}>h-preview</button>
      <button type="button" onClick={() => s.openDialog({ kind: "apply", version: V1 })}>h-dialog</button>
      <button type="button" onClick={() => void applyNow(V1, true)}>h-apply-now</button>
      <span data-testid="h-state">{JSON.stringify({ preview: s.preview, dialog: s.dialog?.kind ?? null })}</span>
    </div>
  );
}

function Host({ onApplied }: { onApplied: () => void }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true, onApplied });
  return (
    <VersionsProvider value={value}>
      <Harness />
    </VersionsProvider>
  );
}

function renderFlow(onApplied: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host onApplied={onApplied} />
      <Toaster />
    </QueryClientProvider>,
  );
}

const hState = () => JSON.parse(screen.getByTestId("h-state").textContent!);

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}

describe("useApplyFlow × onApplied（Task 10 fix round 1）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("409 version_unsaved_changes → 不呼叫 onApplied（改跳三選一）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === APPLY1) {
          return Promise.resolve(jsonResponse(409, { error: { code: "version_unsaved_changes", message: "x" } }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const onApplied = vi.fn();
    renderFlow(onApplied);
    fireEvent.click(screen.getByText("h-apply-now"));
    await waitFor(() => expect(hState().dialog).toBe("apply"));
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("成功 → onApplied 恰一次，且在 apply 回應 resolve 之後才呼叫", async () => {
    const order: string[] = [];
    let resolveApply!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === APPLY1) {
          order.push("apply-request");
          return new Promise<Response>((resolve) => {
            resolveApply = resolve;
          });
        }
        if (url.startsWith(`/api/notes/${NOTE}/versions`)) return Promise.resolve(jsonResponse(200, { versions: [V1], current: CURRENT, nextBefore: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const onApplied = vi.fn(() => order.push("onApplied"));
    renderFlow(onApplied);
    fireEvent.click(screen.getByText("h-apply-now"));
    await waitFor(() => expect(order).toEqual(["apply-request"]));
    // 回應還沒回來：不得提前通知。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onApplied).not.toHaveBeenCalled();
    await act(async () => {
      order.push("apply-resolved");
      resolveApply(jsonResponse(200, { current: CURRENT }));
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["apply-request", "apply-resolved", "onApplied"]);
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
  });

  it("onApplied 丟錯 → 仍是成功路徑：對話框關、預覽離開、成功 toast，沒有錯誤 toast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === APPLY1) return Promise.resolve(jsonResponse(200, { current: CURRENT }));
        if (url.startsWith(`/api/notes/${NOTE}/versions`)) return Promise.resolve(jsonResponse(200, { versions: [V1], current: CURRENT, nextBefore: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const onApplied = vi.fn(() => {
      throw new Error("invalidate failed");
    });
    renderFlow(onApplied);
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-dialog"));
    expect(hState()).toEqual({ preview: { seq: 1, id: "v-1" }, dialog: "apply" });
    fireEvent.click(screen.getByText("h-apply-now"));
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(hState()).toEqual({ preview: null, dialog: null });
    expect(screen.queryByText(i18n.t("errors.fallback"))).not.toBeInTheDocument();
  });
});
