import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiResult } from "./SelectionAiResult";

/**
 * 預覽就緒訊號的時序案（#263 §5.4）：lazy 預覽模組換成可控的替身——只控制「掛起／就緒／render 錯誤」三種時序，就緒時照真實模組的
 * 契約呼叫 `onReady(preview)`、卸載時 `onReady(null)`。真實模組的行為由 SelectionAiResult.test.tsx 驗（memory
 * knotebook-review-probe-fidelity-lessons：替身只放寬時序，不比真實更嚴）。
 */
const gate = vi.hoisted(() => ({
  mode: "ready" as "ready" | "pending" | "crash",
  promise: Promise.resolve(),
  release: () => {},
}));

vi.mock("@/components/versions/VersionsLazy", async () => {
  const { useEffect } = await import("react");
  function Gate(): null {
    if (gate.mode === "crash") throw new Error("preview render bug");
    if (gate.mode === "pending") throw gate.promise;
    return null;
  }
  function Ready({ preview, onReady }: { preview: unknown; onReady: (ready: unknown) => void }) {
    useEffect(() => {
      onReady(preview);
      return () => onReady(null);
    }, [preview, onReady]);
    return <div data-testid="selection-ai-preview" />;
  }
  return {
    SelectionAiPreview: (props: { preview: unknown; onReady: (ready: unknown) => void }) => (
      <>
        <Gate />
        <Ready {...props} />
      </>
    ),
  };
});

const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

let session!: AiSessionValue;
let editor: AnyEditor;

/** 同 SelectionAiResult.test.tsx 的 ResultHost：`phase === "done"` 才掛（錨點此檔不改，anchorOk 恆 true）。 */
function ResultHost() {
  session = useAiSession();
  return session.state.phase === "done" ? <SelectionAiResult state={session.state} anchorOk run={(action) => action()} /> : null;
}

async function mount() {
  editor = createTestEditor([{ id: "p1", type: "paragraph", content: "alpha beta gamma" }]);
  const ai = stubAiFetch({ actions: [SUMMARIZE] });
  renderAiHost({ editor, children: <ResultHost /> });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  return ai;
}

async function finish(call: AiCall, text: string) {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).toBe("done"));
}

function setPending(): void {
  gate.mode = "pending";
  gate.promise = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
}

describe("SelectionAiResult：預覽就緒訊號（#263 §5.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    gate.mode = "ready";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lazy 模組未就緒（掛起）→ 套用停用、顯示載入中；就緒後啟用", async () => {
    const ai = await mount();
    setPending();
    selectInBlock(editor, "p1", 0, 5);
    act(() => session.open());
    act(() => {
      session.start(SUMMARIZE.id);
    });
    await finish(ai.calls[0]!, "SUMMARY");
    expect(screen.getByText("Loading preview…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    gate.mode = "ready";
    await act(async () => {
      gate.release();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
  });

  it("預覽 render 錯誤（boundary 錯誤態）→ 套用停用、顯示預覽錯誤文案、捨棄仍可用", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = await mount();
    gate.mode = "crash";
    selectInBlock(editor, "p1", 0, 5);
    act(() => session.open());
    act(() => {
      session.start(SUMMARIZE.id);
    });
    await finish(ai.calls[0]!, "SUMMARY");
    expect(await screen.findByText("The preview couldn't be shown.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(session.state.phase).toBe("idle");
  });

  it("第二次預覽（模組已快取）：重試後新結果就緒時套用仍能啟用", async () => {
    const ai = await mount();
    selectInBlock(editor, "p1", 0, 5);
    act(() => session.open());
    act(() => {
      session.start(SUMMARIZE.id);
    });
    await finish(ai.calls[0]!, "FIRST");
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await finish(ai.calls[1]!, "SECOND");
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
  });
});
