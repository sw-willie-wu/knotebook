import { afterEach, describe, expect, it, vi } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, mountEditor, row, type AnyEditor } from "@/test/columns-fixtures";
import { createWidthPreview, writeColumnWidths } from "./width-preview";

const mounts: { destroy(): void }[] = [];
afterEach(() => {
  while (mounts.length) mounts.pop()!.destroy();
  document.head.querySelectorAll("style[data-kb-col-preview]").forEach((s) => s.remove());
  vi.restoreAllMocks();
});

const mount = (content: Parameters<typeof mountEditor>[0], collab = true) => {
  const m = mountEditor(content, { collab });
  mounts.push(m);
  return m.editor;
};
const widths = (editor: AnyEditor, rowId = "r") =>
  (editor.getBlock(rowId) as unknown as { children: { props: { width: number } }[] }).children.map((c) => c.props.width);
const previewTables = () => document.head.querySelectorAll("style[data-kb-col-preview]");

/** 數編輯器的 Y.Doc 收到幾次 update。 */
function countUpdates(editor: AnyEditor) {
  const doc = collabUndoManager(editor)!.doc;
  const spy = vi.fn();
  doc.on("update", spy);
  return spy;
}

describe("WP1 createWidthPreview", () => {
  it("WP1 set 後 head 恰有一張表，整列每欄一行、值同輸入；clear 後沒有", () => {
    const preview = createWidthPreview(document);
    expect(previewTables().length).toBe(0);
    preview.set({ columnIds: ["a", "b", "c"], grows: [0.5, 1.25, 1.25] });
    preview.set({ columnIds: ["a", "b", "c"], grows: [0.6, 1.2, 1.2] });
    expect(previewTables().length).toBe(1);
    const text = previewTables()[0]!.textContent!;
    expect(text.split("\n").length).toBe(3);
    expect(text).toContain('[data-id="a"] { flex-grow: 0.6 !important; }');
    expect(text).toContain('[data-id="b"] { flex-grow: 1.2 !important; }');
    expect(text).toContain('[data-id="c"] { flex-grow: 1.2 !important; }');
    preview.clear();
    expect(previewTables().length).toBe(0);
  });

  it("WP1 id 含引號與特殊字元時經 CSS.escape", () => {
    const preview = createWidthPreview(document);
    const id = 'a"]{x:y}';
    preview.set({ columnIds: [id], grows: [1] });
    const text = previewTables()[0]!.textContent!;
    expect(text).toContain(`[data-id="${CSS.escape(id)}"]`);
    expect(text).not.toContain(`[data-id="${id}"]`);
  });

  it("WP-RF2 clear 冪等：沒有預覽、或連呼兩次都不丟例外，且不留表", () => {
    const preview = createWidthPreview(document);
    expect(() => preview.clear()).not.toThrow();
    preview.set({ columnIds: ["a"], grows: [1] });
    preview.clear();
    expect(() => preview.clear()).not.toThrow();
    expect(previewTables().length).toBe(0);
  });

  it("WP-RF2 編輯器卸載後呼叫端清理，head 不留預覽表", () => {
    const m = mountEditor([row([[P("a")], [P("b")]], "r")], { collab: true });
    const preview = createWidthPreview(document);
    preview.set({ columnIds: ["rc0", "rc1"], grows: [1, 1] });
    m.destroy();
    preview.clear();
    expect(previewTables().length).toBe(0);
  });
});

describe("WP2 預覽不碰文件", () => {
  it("WP2 set 期間 Y.Doc 沒有 update、文件不變，預覽經樣式表到達欄元素", () => {
    const m = mountEditor([row([[P("a")], [P("b")]], "r")], { collab: true });
    mounts.push(m);
    const editor = m.editor;
    const col = (id: string) => m.container.querySelector<HTMLElement>(`[data-node-type="column"][data-id="${id}"]`)!;
    const styleBefore = [col("rc0").getAttribute("style"), col("rc1").getAttribute("style")];
    const updates = countUpdates(editor);
    const before = JSON.stringify(editor.document);
    const preview = createWidthPreview(document);
    preview.set({ columnIds: ["rc0", "rc1"], grows: [0.4, 1.6] });
    expect(updates).not.toHaveBeenCalled();
    expect(JSON.stringify(editor.document)).toBe(before);
    expect([col("rc0").getAttribute("style"), col("rc1").getAttribute("style")]).toEqual(styleBefore);
    expect(getComputedStyle(col("rc0")).flexGrow).toBe("0.4");
    expect(getComputedStyle(col("rc1")).flexGrow).toBe("1.6");
    preview.clear();
  });
});

describe("WP3 writeColumnWidths", () => {
  it("WP3 只對有變的欄 updateBlock；undoStack 多 1；undo 回原值", () => {
    const editor = mount([row([[P("a")], [P("b")], [P("c")]], "r", [1, 1, 1])]);
    const manager = collabUndoManager(editor)!;
    const spy = vi.spyOn(editor, "updateBlock");
    const stack = manager.undoStack.length;
    expect(writeColumnWidths(editor, "r", [0.5, 1.5, 1])).toBe(true);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["rc0", "rc1"]);
    expect(widths(editor)).toEqual([0.5, 1.5, 1]);
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths(editor)).toEqual([1, 1, 1]);
  });

  it("WP3 next 與現值相同 → false、undoStack 不變、無 update", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r", [0.5, 1.5])]);
    const manager = collabUndoManager(editor)!;
    const updates = countUpdates(editor);
    const stack = manager.undoStack.length;
    expect(writeColumnWidths(editor, "r", [0.5, 1.5])).toBe(false);
    expect(manager.undoStack.length).toBe(stack);
    expect(updates).not.toHaveBeenCalled();
  });

  it("WP3 id 不是並排列（段落）→ false、不 stopCapturing、無 update", () => {
    const editor = mount([P("x", "p0"), row([[P("a")], [P("b")]], "r")]);
    const stop = vi.spyOn(collabUndoManager(editor)!, "stopCapturing");
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "p0", [1, 1])).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  it("WP3 列不在、欄數不同 → false 不寫", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r")]);
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "nope", [1, 1])).toBe(false);
    expect(writeColumnWidths(editor, "r", [1, 1, 1])).toBe(false);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("WP4 previewWidth 同一筆寫入", () => {
  it("WP4 欄寬與 previewWidth 在同一筆 Y update；undo 一次兩者都還原", () => {
    const editor = mount([row([[IMG("i", 300)], [P("b")]], "r", [1, 1])]);
    const manager = collabUndoManager(editor)!;
    const updates = countUpdates(editor);
    expect(writeColumnWidths(editor, "r", [1.5, 0.5], { previewWidth: { blockId: "i", value: 500 } })).toBe(true);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(widths(editor)).toEqual([1.5, 0.5]);
    expect((editor.getBlock("i") as unknown as { props: { previewWidth: number } }).props.previewWidth).toBe(500);
    manager.undo();
    expect(widths(editor)).toEqual([1, 1]);
    expect((editor.getBlock("i") as unknown as { props: { previewWidth: number } }).props.previewWidth).toBe(300);
  });
});

describe("WP5 撤銷步切分", () => {
  it("WP5 預設前後各 stopCapturing 一次；undoStep:false 不呼叫", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r")]);
    const stop = vi.spyOn(collabUndoManager(editor)!, "stopCapturing");
    writeColumnWidths(editor, "r", [0.5, 1.5]);
    expect(stop).toHaveBeenCalledTimes(2);
    stop.mockClear();
    writeColumnWidths(editor, "r", [0.6, 1.4], { undoStep: false });
    expect(stop).not.toHaveBeenCalled();
  });

  it("WP5 undoStep:false 連呼兩次只多一步、undo 一次回到兩次之前；預設連呼兩次多兩步", () => {
    const editor = mount([row([[P("a")], [P("b")]], "r", [1, 1])]);
    const manager = collabUndoManager(editor)!;
    manager.stopCapturing();
    const stack = manager.undoStack.length;
    writeColumnWidths(editor, "r", [0.9, 1.1], { undoStep: false });
    writeColumnWidths(editor, "r", [0.8, 1.2], { undoStep: false });
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths(editor)).toEqual([1, 1]);

    manager.stopCapturing();
    const stack2 = manager.undoStack.length;
    writeColumnWidths(editor, "r", [0.9, 1.1]);
    writeColumnWidths(editor, "r", [0.8, 1.2]);
    expect(manager.undoStack.length).toBe(stack2 + 2);
  });
});
