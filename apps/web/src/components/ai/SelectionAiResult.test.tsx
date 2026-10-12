import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEditorState } from "@blocknote/react";
import { REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { verifyAnchor } from "@/ai/anchor";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { activeAnchorOf, useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiResult } from "./SelectionAiResult";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

const DOC = [
  { id: "p0", type: "paragraph", content: "context before" },
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "context after" },
];

let session!: AiSessionValue;
let editor: AnyEditor;

/**
 * 照 `SelectionAiBox`（Task 11）的條件掛 `SelectionAiResult`：`phase === "done"` 才渲染，`anchorOk` 由活動錨點的 `verifyAnchor` 算、
 * 隨每次 editor 交易重算（框裡用同一個 useEditorState 形）。Task 11 再經真正的框重驗一次。
 */
function ResultHost() {
  session = useAiSession();
  const anchor = activeAnchorOf(session.state);
  const status = useEditorState({ editor, selector: ({ editor: current }) => (current && anchor ? verifyAnchor(current, anchor) : null) });
  return session.state.phase === "done" ? <SelectionAiResult state={session.state} anchorOk={status === "ok"} run={(action) => action()} /> : null;
}

async function mount() {
  editor = createTestEditor(DOC);
  const ai = stubAiFetch({ actions: [REWRITE, SUMMARIZE] });
  renderAiHost({
    editor,
    children: <ResultHost />,
  });
  await waitFor(() => expect(session.actions).toHaveLength(2));
  return ai;
}

async function runToDone(ai: { calls: AiCall[] }, actionId: string, result: string) {
  selectInBlock(editor, "p1", 0, 5);
  act(() => session.open());
  act(() => {
    session.start(actionId);
  });
  await act(async () => {
    const call = ai.calls.at(-1)!;
    call.delta(result);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).toBe("done"));
}

const docText = () => JSON.stringify(editor.document);

describe("SelectionAiResult（#263 §5.4 預覽態，真的 lazy 模組）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("預覽就緒後套用啟用；按套用 → idle、文件換字", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    const apply = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    expect(session.state.phase).toBe("idle");
    expect(docText()).toContain("SUMMARY TEXT");
  });

  it("預覽的前後上下文塊貼 surround（.kb-ai-preview 之內），中間是 diff", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    await screen.findByTestId("selection-ai-preview");
    const outer = (id: string) => document.querySelector(`.kb-ai-preview [data-testid="selection-ai-preview"] .bn-block-outer[data-id="${id}"]`);
    await waitFor(() => expect(outer("p0")).toHaveAttribute("data-diff", "surround"));
    expect(outer("p2")).toHaveAttribute("data-diff", "surround");
  });

  it("noChange → 顯示「沒有變更」、預覽就緒後套用仍停用", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "alpha beta gamma\r\n");
    expect(screen.getByText("No changes — the result is the same as the original text.")).toBeInTheDocument();
    await screen.findByTestId("selection-ai-preview");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("錨點 changed（未套用）→ 沒有套用、沒有重試，只剩捨棄；捨棄 → idle", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(session.state.phase).toBe("idle");
  });

  it("direct 自動套用後：按鈕列是還原／關閉；還原成功 → 回到套用／捨棄／重試", async () => {
    const ai = await mount();
    await runToDone(ai, REWRITE.id, "REWRITTEN TEXT");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(docText()).toContain("alpha beta gamma");
    for (const name of ["Apply", "Discard", "Retry"]) expect(await screen.findByRole("button", { name })).toBeInTheDocument();
  });

  it("已套用且插入的內容又被改 → 還原鈕停用（錨點失效時 canRevert 為假），框只剩關閉可用", async () => {
    const ai = await mount();
    await runToDone(ai, REWRITE.id, "REWRITTEN TEXT");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    act(() => {
      editor.updateBlock(s.applied!.insertedAnchor.blockIds[0]!, { content: "edited after apply" });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("重試以同一組 request 重送", async () => {
    const ai = await mount();
    await runToDone(ai, SUMMARIZE.id, "SUMMARY TEXT");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.body).toEqual(ai.calls[0]!.body);
  });
});
