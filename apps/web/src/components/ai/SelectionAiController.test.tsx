import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { REWRITE_ACTION_ID, SUMMARIZE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const SUMMARIZE: AiActionDto = { id: SUMMARIZE_ACTION_ID, name: "Summarize", applyMode: "preview", kind: "quick" };

const DOC = [
  { id: "p1", type: "paragraph", content: "alpha beta gamma" },
  { id: "p2", type: "paragraph", content: "second paragraph" },
  { id: "p3", type: "paragraph", content: "third paragraph here" },
  { id: "img", type: "image", props: { url: "https://example.com/a.png" } },
];

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

let editor: AnyEditor;
const toolbar = () => document.querySelector(".bn-formatting-toolbar");

async function mount() {
  editor = createTestEditor(DOC);
  const ai = stubAiFetch({ actions: [REWRITE, SUMMARIZE] });
  renderAiHost({
    editor,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(2));
  return ai;
}

describe("SelectionAiController（#263 §5.3：工具列壓制與 AI 鈕）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("按 AI 鈕開框；框開著且選取在 target 內 → 內建工具列收起；關框後恢復", async () => {
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
    await waitFor(() => expect(toolbar()).toBeNull());
    act(() => session.close());
    await waitFor(() => expect(toolbar()).not.toBeNull());
  });

  it("串流中在 target 外做非空選取 → 工具列出現、框不關、AI 鈕停用", async () => {
    const ai = await mount();
    selectInBlock(editor, "p1", 0, 5);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    act(() => {
      session.start(SUMMARIZE.id);
    });
    selectInBlock(editor, "p3", 0, 5);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(session.state.phase).toBe("streaming");
    expect(screen.getByRole("button", { name: "AI" })).toBeDisabled();
    expect(ai.calls).toHaveLength(1);
  });

  it("RF1：Ctrl+A 全選後開框 → 工具列收起（全選算在 target 內）", async () => {
    await mount();
    act(() => {
      editor._tiptapEditor.commands.selectAll();
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
    await waitFor(() => expect(toolbar()).toBeNull());
  });

  it("NodeSelection（選到圖片）→ 工具列照上游出現，但沒有 AI 項", async () => {
    await mount();
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "AI" })).not.toBeInTheDocument();
  });

  it("AI 項是一顆 icon 鈕：沒有下拉、沒有 aria-expanded（§5.1）", async () => {
    await mount();
    selectInBlock(editor, "p1", 0, 5);
    const button = await screen.findByRole("button", { name: "AI" });
    const toolbarRoot = button.closest<HTMLElement>(".bn-formatting-toolbar")!;
    expect(button).not.toHaveAttribute("aria-expanded");
    expect(button.querySelector('svg[data-icon="sparkles"]')).not.toBeNull();
    fireEvent.click(button);
    // 舊版的下拉清單畫在工具列根元素裡；新版按下只開框（Task 11 起框裡才有動作 chip）。
    expect(within(toolbarRoot).queryByRole("button", { name: REWRITE.name })).not.toBeInTheDocument();
  });
});
