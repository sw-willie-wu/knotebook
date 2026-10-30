import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P, row, shape, withChildren } from "@/test/columns-fixtures";
import { useAiSession, type AiSessionValue } from "./AiSession";
import { SelectionAiController } from "./SelectionAiController";

// D25：工具列的檔案刪除鈕換成自家版（`KnotebookFileDeleteButton`），刪欄內的圖不收欄。掛法照 `SelectionAiController.test.tsx`。

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };

let session!: AiSessionValue;
function Probe() {
  session = useAiSession();
  return null;
}

const deleteButtons = () => document.querySelectorAll("[data-kb-file-delete]");
const toolbar = () => document.querySelector(".bn-formatting-toolbar");

async function mount(doc: unknown[]): Promise<AnyEditor> {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [REWRITE] });
  renderAiHost({
    editor,
    children: (
      <>
        <SelectionAiController />
        <Probe />
      </>
    ),
  });
  await waitFor(() => expect(session.actions).toHaveLength(1));
  return editor;
}

describe("AiToolbar 檔案刪除鈕（D25）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("AT1：選取欄內的圖 → 恰一顆自家刪除鈕；點它 → 圖刪掉、列與兩欄都在", async () => {
    const editor = await mount([P("x", "x"), row([[P("a", "a")], [IMG("img")]], "r"), P("z", "z")]);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(deleteButtons()).toHaveLength(1));
    // 原生的刪除鈕也不能還在（同一個 tooltip 字串）：保留原生、另加自家的話，按原生那顆照樣收欄。
    const label = deleteButtons()[0]!.getAttribute("aria-label")!;
    expect(toolbar()!.querySelectorAll(`[aria-label="${label}"]`)).toHaveLength(1);
    fireEvent.click(deleteButtons()[0]!);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
  });

  it("AT2：選取的是段落文字 → 工具列在、沒有刪除鈕", async () => {
    const editor = await mount([P("x", "x"), row([[P("abc", "a")], [IMG("img")]], "r"), P("z", "z")]);
    selectInBlock(editor, "a", 0, 2);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(deleteButtons()).toHaveLength(0);
  });

  it("AT2b：選取從圖跨到下一段（兩個 block）→ 工具列在、沒有刪除鈕", async () => {
    const editor = await mount([P("x", "x"), IMG("img"), P("qq", "q")]);
    act(() => {
      editor._tiptapEditor.commands.setTextSelection({ from: contentStart(editor, "img") - 1, to: contentStart(editor, "q") + 2 });
    });
    expect(editor.getSelection()!.blocks.map((b) => b.id)).toEqual(["img", "q"]);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(deleteButtons()).toHaveLength(0);
  });
});

// 並排 PR-2（spec §7.5、Q7）：跨欄或含整列的選取照常出 AI 鈕，`open()` 把錨點擴大成整列（AiSession.test AO*）。
const TWO = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r"), P("z", "z")];
const THREE = () => [P("x", "x"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z")];
const NESTED = () => [P("x", "x"), row([[P("a", "a1")], [withChildren(P("p", "p1"), [P("c", "c1")])]], "r"), P("z", "z")];

describe("AiToolbar AI 鈕與並排（擴大成整列）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each<[string, () => unknown[], string, string, string]>([
    ["AX1 跨欄 a..b", TWO, "a1", "b1", "a1:paragraph, rc1:column"],
    ["AX2 三欄 a..c", THREE, "a1", "c1", "a1:paragraph, rc1:column, rc2:column"],
    ["AX3 從列外 x 選進列內", TWO, "x", "b1", "x:paragraph, r:columnList"],
    ["AX4 從欄內選到列外 z（清單裡沒有欄節點）", TWO, "b1", "z", "b1:paragraph, q1:paragraph, z:paragraph"],
    ["AX6 從末欄的巢狀子 block 選到列外 z（欄是祖父節點）", NESTED, "c1", "z", "c1:paragraph, z:paragraph"],
  ])("%s → AI 鈕出現、按下開框", async (_name, doc, from, to, blocks) => {
    const editor = await mount(doc());
    act(() => {
      editor.setSelection(from, to);
    });
    // 事實釘：core 的選取清單（core 升版時第一個紅）。
    expect(editor.getSelection()!.blocks.map((b) => `${b.id}:${b.type}`).join(", ")).toBe(blocks);
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
  });

  it("AX5 完全在單一欄內（b..q）→ AI 鈕照常出現、按下開框", async () => {
    const editor = await mount(TWO());
    act(() => {
      editor.setSelection("b1", "q1");
    });
    fireEvent.click(await screen.findByRole("button", { name: "AI" }));
    expect(session.state.phase).toBe("input");
  });
});
