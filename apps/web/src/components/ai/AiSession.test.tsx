import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import {
  contentStart,
  createTestEditor,
  placeCursor,
  renderAiHost,
  selectInBlock,
  selectText,
  selectWholeBlocks,
  stubAiFetch,
  type AiCall,
  type AnyEditor,
} from "@/test/ai-host";
import { activeAnchorOf, useAiSession, type AiSessionValue } from "./AiSession";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };
const INSTRUCT: AiActionDto = { id: INSTRUCT_ACTION_ID, name: "Instruct", applyMode: "preview", kind: "instruct" };
const ACTIONS = [REWRITE, SUMMARIZE, INSTRUCT];

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second paragraph" },
  { id: "p3", type: "paragraph", content: "third paragraph here" },
];

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;
const highlighted = () => editor.getExtension(ShowSelectionExtension)!.store.state.enabledSet.has("selection-ai");
const docText = () => JSON.stringify(editor.document);
const phase = () => session.state.phase;

async function mount(opts: { actions?: AiActionDto[]; doc?: unknown[]; onAutoClose?: () => void } = {}) {
  editor = createTestEditor(opts.doc ?? DOC);
  const ai = stubAiFetch({ actions: opts.actions ?? ACTIONS });
  const host = renderAiHost({ editor, onAutoClose: opts.onAutoClose, children: <Probe /> });
  await waitFor(() => expect(session.actions).toHaveLength((opts.actions ?? ACTIONS).length));
  return { ai, host };
}

function openOn(blockId: string, start: number, end: number): void {
  selectInBlock(editor, blockId, start, end);
  act(() => session.open());
}

function startAction(actionId: string, instruction?: string): void {
  act(() => {
    session.start(actionId, instruction);
  });
}

async function finishStream(call: AiCall, text: string): Promise<void> {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(phase()).not.toBe("streaming"));
}

describe("AiSession 狀態機（#263 spec §5.2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("open：取選取區塊當錨點、部分選取的子字串當 focus、進 input、開標亮", async () => {
    await mount();
    openOn("p1", 6, 10);
    const s = session.state;
    if (s.phase !== "input") throw new Error(`預期 input，實得 ${s.phase}`);
    expect(s.target.anchor.blockIds).toEqual(["p1"]);
    expect(s.target.focus).toBe("beta");
    await waitFor(() => expect(highlighted()).toBe(true));
  });

  it("open：整塊選取 → focus 為空字串；跨區塊部分選取 → 換行分隔", async () => {
    await mount();
    selectWholeBlocks(editor, "p1", "p2");
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("");
    act(() => session.close());
    selectText(editor, contentStart(editor, "p1") + 6, contentStart(editor, "p2") + 6);
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("beta gamma\nsecond");
  });

  it("open：空選取（只放游標）或 NodeSelection（圖片）→ 不開", async () => {
    await mount({ doc: [...DOC, { id: "img", type: "image", props: { url: "https://example.com/a.png" } }] });
    placeCursor(editor, "p1", 2);
    act(() => session.open());
    expect(phase()).toBe("idle");
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    act(() => session.open());
    expect(phase()).toBe("idle");
  });

  it("quick direct：串流完自動套用；activeAnchor 換成 insertedAnchor；before 是套用前凍結的原文；寫入的就是 prepared.blocks", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    const spy = vi.spyOn(editor, "replaceBlocks");
    startAction(REWRITE.id);
    expect(ai.calls[0]!.body).toEqual({ action_id: REWRITE.id, note_id: "note-1", text: "alpha beta gamma\n" });
    await finishStream(ai.calls[0]!, "ALPHA REWRITTEN");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error(`預期 done＋applied，實得 ${s.phase}`);
    expect(docText()).toContain("ALPHA REWRITTEN");
    expect(docText()).not.toContain("alpha beta gamma");
    expect(activeAnchorOf(s)).toBe(s.applied.insertedAnchor);
    expect(s.applied.insertedAnchor.blockIds).not.toContain("p1");
    expect(JSON.stringify(s.preview.before)).toContain("alpha beta gamma");
    expect(spy.mock.calls[0]![1]).toBe(s.prepared.blocks);
  });

  it("Instruct 一律預覽（就算清單把它標成 direct）；送 trim 後的 instruction 與 focus", async () => {
    const { ai } = await mount({ actions: [REWRITE, { ...INSTRUCT, applyMode: "direct" }] });
    openOn("p1", 0, 5);
    startAction(INSTRUCT.id, "  make it upper  ");
    expect(ai.calls[0]!.body).toEqual({
      action_id: INSTRUCT.id,
      note_id: "note-1",
      text: "alpha beta gamma\n",
      instruction: "make it upper",
      focus: "alpha",
    });
    await finishStream(ai.calls[0]!, "ALPHA beta gamma");
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("Instruct 整塊選取 → wire 不帶 focus；空白指令不送", async () => {
    const { ai } = await mount();
    selectWholeBlocks(editor, "p1", "p1");
    act(() => session.open());
    startAction(INSTRUCT.id, " 　 ");
    expect(ai.calls).toHaveLength(0);
    startAction(INSTRUCT.id, "shorter");
    expect(ai.calls[0]!.body).not.toHaveProperty("focus");
    expect(ai.calls[0]!.body.instruction).toBe("shorter");
  });

  it("RF5 noChange：模型回的與原文只差 CRLF／尾端空白 → 不自動套用、preview.noChange、apply() 回 false、文件不動", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    const spy = vi.spyOn(editor, "replaceBlocks");
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "alpha beta gamma  \r\n");
    const s = session.state;
    if (s.phase !== "done") throw new Error(`預期 done，實得 ${s.phase}`);
    expect(s.preview.noChange).toBe(true);
    expect(s.applied).toBeNull();
    let applied = true;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("外層 <text> 剝除：prepared 與預覽都不含標記", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "<text>\nSUMMARY\n</text>");
    const s = session.state;
    if (s.phase !== "done") throw new Error(`預期 done，實得 ${s.phase}`);
    expect(JSON.stringify(s.prepared.blocks)).toContain("SUMMARY");
    expect(JSON.stringify(s.preview.after)).not.toContain("<text>");
  });

  it("空結果 → error 態 empty_result（不是 toast）", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "   ");
    expect(session.state.phase === "error" && session.state.code).toBe("empty_result");
  });

  it("串流錯誤 → error 態；retry 以同一組 request（含 instruction 與 focus）重送", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(INSTRUCT.id, "shorter");
    await act(async () => {
      ai.calls[0]!.fail("upstream_error");
    });
    await waitFor(() => expect(session.state.phase === "error" && session.state.code).toBe("upstream_error"));
    let retried = false;
    act(() => {
      retried = session.retry();
    });
    expect(retried).toBe(true);
    expect(ai.calls[1]!.body).toEqual(ai.calls[0]!.body);
  });

  it("retry 在已自動套用後不可用", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN");
    let retried = true;
    act(() => {
      retried = session.retry();
    });
    expect(retried).toBe(false);
    expect(ai.calls).toHaveLength(1);
  });

  it("手動套用成功 → 回 idle（S1）、文件換字、關標亮", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY TEXT");
    await waitFor(() => expect(highlighted()).toBe(true));
    let applied = false;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(true);
    expect(phase()).toBe("idle");
    expect(docText()).toContain("SUMMARY TEXT");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("apply(false)（預覽尚未就緒）→ 回 false、停在 done、文件不動（spec §5.2：previewReady 是 apply 的前置條件）", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY TEXT");
    let applied = true;
    act(() => {
      applied = session.apply(false);
    });
    expect(applied).toBe(false);
    expect(phase()).toBe("done");
    expect(docText()).not.toContain("SUMMARY TEXT");
  });

  it("手動套用撞守門（錨點被改）→ toast、停在 done、文件不動", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY TEXT");
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    let applied = true;
    act(() => {
      applied = session.apply(true);
    });
    expect(applied).toBe(false);
    expect(phase()).toBe("done");
    expect(await screen.findByText("The original text changed since this result was generated, so it wasn't applied.")).toBeInTheDocument();
    expect(docText()).not.toContain("SUMMARY TEXT");
  });

  it("cancel：abort 串流、回 idle、關標亮", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    act(() => session.cancel());
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(phase()).toBe("idle");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("close：done → idle、關標亮", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    act(() => session.close());
    expect(phase()).toBe("idle");
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("D12：done 態在 target 外做非空選取 → 自動關閉、關標亮；onAutoClose 被呼叫一次", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    selectInBlock(editor, "p3", 0, 5);
    expect(phase()).toBe("idle");
    expect(onAutoClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("D12：串流中在 target 外選取不關；串流完成當下也不關；下一次選取變更才關", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    selectInBlock(editor, "p3", 0, 5);
    expect(phase()).toBe("streaming");
    await finishStream(ai.calls[0]!, "SUMMARY");
    expect(phase()).toBe("done");
    selectInBlock(editor, "p3", 6, 10);
    expect(phase()).toBe("idle");
  });

  it("D12：空選取（只放游標）不關；在 target 內選取不關", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    placeCursor(editor, "p3", 2);
    expect(phase()).toBe("done");
    selectInBlock(editor, "p1", 6, 10);
    expect(phase()).toBe("done");
  });

  it("D12（W14）：input 與 error 態一樣——在 target 外做非空選取 → 自動關閉、關標亮；onAutoClose 各呼叫一次", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    await waitFor(() => expect(highlighted()).toBe(true));
    selectInBlock(editor, "p3", 0, 5);
    expect(phase()).toBe("idle");
    expect(onAutoClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(highlighted()).toBe(false));

    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await act(async () => {
      ai.calls[0]!.fail("upstream_error");
    });
    await waitFor(() => expect(phase()).toBe("error"));
    await waitFor(() => expect(highlighted()).toBe(true));
    selectInBlock(editor, "p3", 6, 10);
    expect(phase()).toBe("idle");
    expect(onAutoClose).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("editable 轉 false：串流中 abort、回 idle、關標亮", async () => {
    const { ai, host } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    host.rerenderHost({ editable: false });
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("noteId 換手：非 idle 態回 idle、關標亮", async () => {
    const { ai, host } = await mount();
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    await finishStream(ai.calls[0]!, "SUMMARY");
    host.rerenderHost({ noteId: "note-2" });
    await waitFor(() => expect(phase()).toBe("idle"));
    await waitFor(() => expect(highlighted()).toBe(false));
  });

  it("open() 從 done（已套用）出發：舊結果與還原入口丟棄、對當下選取開新框；串流中呼叫 open() 不動作", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN FIRST");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    const insertedId = s.applied.insertedAnchor.blockIds[0]!;
    selectInBlock(editor, insertedId, 0, 3); // 在 activeAnchor 內：D12 不關
    act(() => session.open());
    const reopened = session.state;
    if (reopened.phase !== "input") throw new Error(`預期 input，實得 ${reopened.phase}`);
    expect(reopened.target.anchor.blockIds).toEqual([insertedId]);
    startAction(SUMMARIZE.id);
    act(() => session.open());
    expect(phase()).toBe("streaming");
    expect(ai.calls).toHaveLength(2);
  });

  it("open() 從 input 與 error 出發：同樣先關舊框（error 的 request 丟棄）再對當下選取開新框", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    selectInBlock(editor, "p1", 6, 10); // 仍在 target 內：D12 不關
    act(() => session.open());
    expect(session.state.phase === "input" && session.state.target.focus).toBe("beta");
    startAction(SUMMARIZE.id);
    await act(async () => {
      ai.calls[0]!.fail("upstream_error");
    });
    await waitFor(() => expect(phase()).toBe("error"));
    selectInBlock(editor, "p1", 11, 16);
    act(() => session.open());
    const s = session.state;
    expect(s.phase).toBe("input");
    expect(s.phase === "input" && s.target.focus).toBe("gamma");
  });

  it("selfWriteRef（自動套用＋還原那半）：串流中在 target 後方做非空選取 → direct 自動套用 → 還原，框仍在、回到未套用；D12 回呼 0 次", async () => {
    // 白箱斷言 onAutoClose：沒有旗標時 D12 會在還原的 replaceBlocks 期間 close()，但 revert() 隨後的 setState 會蓋掉 idle（同一批次），
    // 框照樣留著——只看 state 抓不到（起草時 jsdom 突變實測：拿掉旗標只有 onAutoClose 斷言會紅）。
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    selectInBlock(editor, "p3", 0, 5); // target 後方；長度不同的替換會讓 replaceBlocks 平移這個選取並發 selection change
    await finishStream(ai.calls[0]!, "A much longer rewritten first paragraph than before");
    expect(session.state.phase === "done" && session.state.applied !== null).toBe(true);
    act(() => session.revert());
    expect(onAutoClose).not.toHaveBeenCalled();
    const s = session.state;
    expect(s.phase).toBe("done");
    expect(s.phase === "done" && s.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("selfWriteRef（手動套用那半，白箱）：選取在 target 後方時按套用，D12 回呼 0 次", async () => {
    const onAutoClose = vi.fn();
    const { ai } = await mount({ onAutoClose });
    openOn("p1", 0, 5);
    startAction(SUMMARIZE.id);
    selectInBlock(editor, "p3", 0, 5); // 串流中選，不觸發 D12；完成後選取仍在 p3
    await finishStream(ai.calls[0]!, "A much longer summary than the original first paragraph");
    act(() => {
      session.apply(true);
    });
    expect(onAutoClose).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
  });

  it("RF3：選取含圖片區塊時 direct 動作不自動套用（強制預覽）", async () => {
    const { ai } = await mount({ doc: [...DOC, { id: "img", type: "image", props: { url: "https://example.com/a.png" } }] });
    act(() => {
      editor._tiptapEditor.commands.selectAll();
    });
    act(() => session.open());
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "EVERYTHING REWRITTEN");
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(docText()).toContain("alpha beta gamma");
  });

  it("還原撞 stale（插入的內容又被改）→ toast、applied 清空、文件不動", async () => {
    const { ai } = await mount();
    openOn("p1", 0, 5);
    startAction(REWRITE.id);
    await finishStream(ai.calls[0]!, "REWRITTEN");
    const s = session.state;
    if (s.phase !== "done" || !s.applied) throw new Error("預期已自動套用");
    act(() => {
      editor.updateBlock(s.applied!.insertedAnchor.blockIds[0]!, { content: "edited after apply" });
    });
    act(() => session.revert());
    expect(await screen.findByText("This change can no longer be reverted — the text may have changed since.")).toBeInTheDocument();
    expect(session.state.phase === "done" && session.state.applied).toBeNull();
    expect(docText()).toContain("edited after apply");
  });
});
