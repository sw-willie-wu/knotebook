import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { INSTRUCT_ACTION_ID, REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AiCall, type AnyEditor } from "@/test/ai-host";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };
const INSTRUCT: AiActionDto = { id: INSTRUCT_ACTION_ID, name: "Instruct", applyMode: "preview", kind: "instruct" };
const CUSTOM: AiActionDto = { id: "11111111-2222-4333-8444-555555555555", name: "Make it formal", applyMode: "preview", kind: "quick" };

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
const box = () => screen.queryByTestId("selection-ai-box");
const editorHasFocus = () => !!editor.domElement && editor.domElement.contains(document.activeElement);

/** Host 照 NoteEditor 的真實掛法：`SelectionAiController`（它渲染工具列與框）是 `NoteEditorView` 的 children。 */
async function mount(opts: { actions?: AiActionDto[]; editable?: boolean } = {}) {
  editor = createTestEditor(DOC);
  const actions = opts.actions ?? [REWRITE, SUMMARIZE, INSTRUCT];
  const ai = stubAiFetch({ actions });
  const host = renderAiHost({
    editor,
    editable: opts.editable,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(actions.length));
  return { ai, host };
}

async function openViaToolbar(blockId = "p1", start = 0, end = 5): Promise<HTMLElement> {
  selectInBlock(editor, blockId, start, end);
  fireEvent.click(await screen.findByRole("button", { name: "AI" }));
  return screen.findByTestId("selection-ai-box");
}

/** 等一個 macrotask（讓 pointerdown 排的 setTimeout(0) 焦點重讀先跑完）。 */
async function nextMacrotask(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function finish(call: AiCall, text: string): Promise<void> {
  await act(async () => {
    call.delta(text);
    call.done();
  });
  await waitFor(() => expect(session.state.phase).not.toBe("streaming"));
}

describe("SelectionAiBox（#263 §5.3、§5.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("開啟：region（不是 dialog）、aria-label、焦點進輸入框；chips 以 icon 呈現、名稱在 aria-label／title", async () => {
    await mount({ actions: [REWRITE, CUSTOM, INSTRUCT] });
    const region = await openViaToolbar();
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAttribute("aria-label", "AI on selection");
    const input = within(region).getByRole("textbox", { name: "Instruction for the selected text" });
    expect(document.activeElement).toBe(input);
    const rewrite = within(region).getByRole("button", { name: "Rewrite" });
    expect(rewrite).toHaveAttribute("title", "Rewrite");
    expect(rewrite.querySelector('svg[data-icon="pen-line"]')).not.toBeNull();
    expect(within(region).getByRole("button", { name: "Make it formal" }).querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("沒有 Instruct 動作：輸入框與送出鈕不渲染、焦點落在第一顆 chip；框內 Esc 關框且焦點回編輯器", async () => {
    await mount({ actions: [REWRITE, SUMMARIZE] });
    const region = await openViaToolbar();
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Rewrite" }));
    // 回傳 false＝事件被 preventDefault（NotePage 的全頁 Esc 以 defaultPrevented 放棄，不會再關版本預覽）
    expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(false);
    expect(session.state.phase).toBe("idle");
    expect(editorHasFocus()).toBe(true);
  });

  it("Enter 送出（trim 後）→ 焦點進取消鈕；串流中框內 Esc 取消、回 idle、焦點回編輯器", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole("textbox");
    fireEvent.change(input, { target: { value: "  make it shorter  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ai.calls[0]!.body.instruction).toBe("make it shorter");
    const cancel = await within(region).findByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(session.state.phase).toBe("idle");
    expect(editorHasFocus()).toBe(true);
  });

  it("輸入法組字中的 Enter 不送、Shift+Enter 不送", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole("textbox");
    fireEvent.change(input, { target: { value: "改短一點" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(ai.calls).toHaveLength(0);
  });

  it("RF2：超過 500 code point 不能再輸入（emoji 以 1 計、不切半個）", async () => {
    await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(input, { target: { value: "😀".repeat(501) } });
    expect(Array.from(input.value)).toHaveLength(500);
    expect(input.value).toBe("😀".repeat(500));
  });

  it("完成時焦點在框內 → 焦點進框容器（不進任何按鈕）", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    expect(document.activeElement).toBe(within(region).getByRole("button", { name: "Cancel" }));
    await finish(ai.calls[0]!, "SUMMARY");
    expect(document.activeElement).toBe(screen.getByTestId("selection-ai-box"));
  });

  it("完成時焦點在編輯器 → 焦點不動（取消鈕卸載前已記下「不在框內」）", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    act(() => editor.focus());
    expect(editorHasFocus()).toBe(true);
    await finish(ai.calls[0]!, "SUMMARY");
    expect(editorHasFocus()).toBe(true);
  });

  it("完成前點了框外不可聚焦處（焦點落到 body、只有 focusout）→ 完成時焦點不被拉進框", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    const cancel = within(region).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    // 真實瀏覽器點不可聚焦的頁面背景：先 pointerdown，再讓焦點掉到 body（只發 blur／focusout，沒有 focusin）。
    fireEvent.pointerDown(document.body);
    act(() => cancel.blur());
    expect(document.activeElement).toBe(document.body);
    await nextMacrotask(); // pointerdown 排的重讀在焦點移動之後才跑
    await finish(ai.calls[0]!, "SUMMARY");
    expect(document.activeElement).toBe(document.body);
  });

  it("完成前在框外按下但焦點沒動（觸控捲動、拖框外捲軸、外部元件擋掉 mousedown）→ 完成時焦點仍進框容器", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    const cancel = within(region).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.pointerDown(document.body);
    await nextMacrotask();
    expect(document.activeElement).toBe(cancel);
    await finish(ai.calls[0]!, "SUMMARY");
    expect(document.activeElement).toBe(screen.getByTestId("selection-ai-box"));
  });

  it("RF2：只有空白（含全形空白 U+3000、tab）的指令按 Enter 不送出", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    const input = within(region).getByRole("textbox");
    fireEvent.change(input, { target: { value: "\u3000 \t" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ai.calls).toHaveLength(0);
    expect(session.state.phase).toBe("input");
  });

  it("編輯器內按 Esc 不關框（只認框內的 Esc）", async () => {
    await mount();
    await openViaToolbar();
    act(() => editor.focus());
    fireEvent.keyDown(editor.domElement!, { key: "Escape" });
    expect(session.state.phase).toBe("input");
    expect(box()).toBeInTheDocument();
  });

  it("重開時輸入框為空（不沿用舊指令）", async () => {
    await mount();
    let region = await openViaToolbar();
    fireEvent.change(within(region).getByRole("textbox"), { target: { value: "old instruction" } });
    fireEvent.keyDown(within(region).getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    region = await openViaToolbar("p2", 0, 6);
    expect(within(region).getByRole("textbox")).toHaveValue("");
  });

  it("錨點 changed（輸入態）→ 顯示「原文已變更」，送出與 chips 隱藏、只剩捨棄", async () => {
    await mount();
    const region = await openViaToolbar();
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    expect(await within(region).findByText("The original text has changed since this was opened.")).toBeInTheDocument();
    expect(within(region).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Rewrite" })).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Discard" }));
    expect(session.state.phase).toBe("idle");
  });

  it("串流中錨點 changed → 「原文已變更」，按鈕列是捨棄＋取消；捨棄 → abort、回 idle", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    act(() => {
      editor.updateBlock("p1", { content: "changed by a collaborator" });
    });
    expect(await within(region).findByText("The original text has changed since this was opened.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Discard" }));
    expect(ai.calls[0]!.signal.aborted).toBe(true);
    expect(session.state.phase).toBe("idle");
  });

  it("RF4：錨點區塊被刪 → 框仍在（沿用上一次位置）、顯示「原文已變更」、只剩捨棄", async () => {
    await mount();
    const region = await openViaToolbar("p2", 0, 6);
    act(() => {
      editor.removeBlocks(["p2"]);
    });
    expect(await within(region).findByText("The original text has changed since this was opened.")).toBeInTheDocument();
    expect(screen.getByTestId("selection-ai-box")).toBe(region);
    expect(within(region).getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("串流態：Instruct 顯示「Your instruction」，quick 顯示動作名稱；錯誤態顯示 errors.<code> 文案＋重試／關閉", async () => {
    const { ai } = await mount();
    let region = await openViaToolbar();
    fireEvent.change(within(region).getByRole("textbox"), { target: { value: "x" } });
    fireEvent.keyDown(within(region).getByRole("textbox"), { key: "Enter" });
    expect(within(region).getByText("Your instruction")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Cancel" }));
    region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    expect(within(region).getByText("Summarize")).toBeInTheDocument();
    await act(async () => {
      ai.calls[1]!.fail("upstream_error");
    });
    expect(await within(region).findByRole("alert")).toHaveTextContent(i18n.t("errors.upstream_error"));
    expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("寬度＝活動錨點首區塊寬＋左右外框，上限可視寬減 16px", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.matches('.bn-block-outer[data-id="p1"]') ? new DOMRect(0, 0, 500, 24) : new DOMRect(0, 0, 0, 0);
    });
    await mount();
    const region = await openViaToolbar();
    // jsdom 的 CSSStyleDeclaration 會把 min() 的參數序列化走樣，只釘數字與上限兩段
    await waitFor(() => expect(region.style.width).toContain("502px"));
    expect(region.style.width).toContain("calc(100vw - 16px)");
    expect(region).toHaveClass("max-w-[calc(100vw-16px)]");
  });

  it("editable 為 false（viewer）→ 框不渲染", async () => {
    const { host } = await mount();
    await openViaToolbar();
    host.rerenderHost({ editable: false });
    await waitFor(() => expect(box()).not.toBeInTheDocument());
  });

  it("預覽態經真正的框：套用 → 框關閉、焦點回編輯器（動作前焦點在框內）", async () => {
    const { ai } = await mount();
    const region = await openViaToolbar();
    fireEvent.click(within(region).getByRole("button", { name: "Summarize" }));
    await finish(ai.calls[0]!, "SUMMARY TEXT");
    const apply = await within(screen.getByTestId("selection-ai-box")).findByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    expect(session.state.phase).toBe("idle");
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    expect(editorHasFocus()).toBe(true);
  });
});
