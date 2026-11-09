import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  PER_ELEMENT_BYTES,
  PER_INLINE_NODE_BYTES,
  PER_MARK_BYTES,
  createNoteSizeGuard,
  createNoteSizePasteHandlers,
  estimateBlocksBytes,
  estimatePmBytes,
  exceedsNoteLimit,
  formatNoteLimit,
  noteStateBytes,
  utf8Bytes,
} from "./note-size-guard";

function docOf(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return d;
}
/** ProseMirror 節點的替身（只有估計會讀的欄位）。 */
const text = (s: string, marks: Array<{ attrs?: Record<string, unknown> }> = []) => ({ isText: true, text: s, marks });
const el = (children: unknown[], isInline = false, type = "paragraph", attrs: Record<string, unknown> = {}) => ({
  isText: false,
  isInline,
  type: { name: type },
  attrs,
  marks: [],
  content: { forEach: (f: (c: never) => void) => children.forEach(c => f(c as never)) },
});
const slice = (nodes: unknown[]) => ({ content: { forEach: (f: (c: never) => void) => nodes.forEach(c => f(c as never)) } });

describe("筆記大小上限的前端檢查（lib/note-size-guard）", () => {
  it("estimatePmBytes：文字的 UTF-8＋每個元素節點 PER_ELEMENT_BYTES＋行內節點 PER_INLINE_NODE_BYTES＋格式標記", () => {
    // 一個段落 block：blockContainer > paragraph > 「中文ab」＋換行＋粗體「x」
    const block = el([el([text("中文ab"), el([], true), text("x", [{ attrs: {} }])])]);
    expect(estimatePmBytes(slice([block]))).toBe(2 * PER_ELEMENT_BYTES + 8 + PER_INLINE_NODE_BYTES + 1 + PER_MARK_BYTES);
    // 連結的網址也算
    const link = el([el([text("go", [{ attrs: { href: "https://e.com" } }])])]);
    expect(estimatePmBytes(slice([link]))).toBe(2 * PER_ELEMENT_BYTES + 2 + PER_MARK_BYTES + utf8Bytes("href") + utf8Bytes("https://e.com"));
    // 連結的每個有值的屬性：key＋字串值；null 的不算
    const link2 = el([el([text("go", [{ attrs: { href: "https://e.com", target: "_blank", class: null } }])])]);
    expect(estimatePmBytes(slice([link2]))).toBe(2 * PER_ELEMENT_BYTES + 2 + PER_MARK_BYTES + utf8Bytes("hrefhttps://e.comtarget_blank"));
  });

  it("estimatePmBytes：節點上長的字串屬性（mermaid 原始碼、網址；id 除外）算進去；blockGroup 便宜、待辦清單項貴一點", () => {
    const code = "graph TD; " + "A-->B; ".repeat(100);
    const mermaid = el([el([], false, "mermaid", { code, id: "x".repeat(36), textColor: "default" })], false, "blockContainer");
    expect(estimatePmBytes(slice([mermaid]))).toBe(2 * PER_ELEMENT_BYTES + utf8Bytes(code));
    const nested = el([el([text("a")], false, "bulletListItem"), el([el([el([text("b")], false, "bulletListItem")], false, "blockContainer")], false, "blockGroup")], false, "blockContainer");
    expect(estimatePmBytes(slice([nested]))).toBe(4 * PER_ELEMENT_BYTES + 20 + 2);
    const task = el([el([text("t")], false, "checkListItem")], false, "blockContainer");
    expect(estimatePmBytes(slice([task]))).toBe(PER_ELEMENT_BYTES + 130 + 1);
  });

  it("estimateBlocksBytes（站內 AI）：每個 block 兩個元素節點、子 block 多一個 blockGroup、表格每列一個每格兩個；換行算行內節點，程式碼區塊不算", () => {
    expect(estimateBlocksBytes([{ type: "paragraph", content: [{ type: "text", text: "ab", styles: {} }] }])).toBe(2 * PER_ELEMENT_BYTES + 2);
    expect(estimateBlocksBytes([{ type: "paragraph", content: [{ type: "text", text: "a\nb", styles: { bold: true } }] }])).toBe(2 * PER_ELEMENT_BYTES + 2 + PER_INLINE_NODE_BYTES + PER_MARK_BYTES);
    expect(estimateBlocksBytes([{ type: "codeBlock", content: [{ type: "text", text: "a\nb", styles: {} }] }])).toBe(2 * PER_ELEMENT_BYTES + 3);
    expect(estimateBlocksBytes([{ type: "paragraph", content: [], children: [{ type: "paragraph", content: [] }] }])).toBe(4 * PER_ELEMENT_BYTES + 20);
    expect(estimateBlocksBytes([{ type: "checkListItem", content: [] }])).toBe(PER_ELEMENT_BYTES + 130);
    expect(estimateBlocksBytes([{ type: "mermaid", props: { code: "graph TD; A-->B; B-->C;" } }])).toBe(2 * PER_ELEMENT_BYTES + utf8Bytes("graph TD; A-->B; B-->C;"));
    const table = { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "x", styles: {} }], { content: [{ type: "text", text: "yy", styles: {} }] }] }] } };
    expect(estimateBlocksBytes([table])).toBe(2 * PER_ELEMENT_BYTES + PER_ELEMENT_BYTES + 2 * 2 * 95 + 3); // 儲存格＋格內段落各 95
  });

  it("noteStateBytes：原始大小沒超過門檻就用原始大小；超過才量回收過的複本（本機刪掉、還被留著的內容不算）", () => {
    const d = new Y.Doc({ gc: false }); // 模擬 UndoManager 留住刪掉的內容
    d.getText("t").insert(0, "x".repeat(5_000));
    d.getText("t").delete(0, 4_900);
    const raw = Y.encodeStateAsUpdate(d).byteLength;
    expect(raw).toBeGreaterThan(5_000);
    expect(noteStateBytes(d)).toBe(raw);
    expect(noteStateBytes(d, raw)).toBe(raw); // 沒超過門檻
    const gced = noteStateBytes(d, raw - 1);
    expect(gced).toBeLessThan(300);
  });

  it("exceedsNoteLimit：回收過的大小＋成長 > 上限才擋；剛好等於不擋；沒有成長（≤ 0）或上限未知不擋", () => {
    const d = docOf("x".repeat(100));
    const size = Y.encodeStateAsUpdate(d).byteLength;
    expect(exceedsNoteLimit(d, 10, size + 10)).toBe(false);
    expect(exceedsNoteLimit(d, 11, size + 10)).toBe(true);
    expect(exceedsNoteLimit(d, -50, size - 100)).toBe(false); // 縮短：就算已超過上限也放
    expect(exceedsNoteLimit(d, 1_000_000, undefined)).toBe(false);
    expect(exceedsNoteLimit(d, 5_001, 5_000), "光是這次就超過：不必量").toBe(true);
    // 墓碑：原始大小會擋、回收過的不會 → 放
    const t = new Y.Doc({ gc: false });
    t.getText("t").insert(0, "y".repeat(5_000));
    t.getText("t").delete(0, 4_900);
    expect(exceedsNoteLimit(t, 1_000, 2_000)).toBe(false);
  });

  it("formatNoteLimit：MB／KB，至多一位小數", () => {
    expect(formatNoteLimit(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatNoteLimit(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatNoteLimit(20 * 1024)).toBe("20 KB");
    expect(formatNoteLimit(20_000)).toBe("19.5 KB");
  });

  it("createNoteSizeGuard：超過 → 提示（帶上限）並回 true；沒超過、上限未知 → false、不提示；每次呼叫時才讀文件與上限", () => {
    let doc = docOf("x".repeat(100));
    let limit: number | undefined = Y.encodeStateAsUpdate(doc).byteLength + 50;
    const notify = vi.fn();
    const guard = createNoteSizeGuard(() => doc, () => limit, notify);
    expect(guard(50)).toBe(false);
    expect(guard(51)).toBe(true);
    expect(notify).toHaveBeenCalledWith(limit);
    notify.mockClear();
    limit = undefined;
    expect(guard(1_000_000)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    doc = docOf("");
    limit = Y.encodeStateAsUpdate(doc).byteLength + 10;
    expect(guard(10)).toBe(false);
  });

  it("createNoteSizePasteHandlers：貼上估 slice 減去被取代的選取；拖放估 slice，站內搬移（moved）不問", () => {
    const guard = vi.fn(() => false);
    const h = createNoteSizePasteHandlers(guard);
    const incoming = slice([el([el([text("x".repeat(100))])])]);
    const selected = slice([el([el([text("y".repeat(30))])])]);
    const emptySel = { state: { selection: { empty: true, content: () => selected } } };
    const withSel = { state: { selection: { empty: false, content: () => selected } } };
    h.handlePaste(emptySel, {} as ClipboardEvent, incoming);
    expect(guard).toHaveBeenLastCalledWith(estimatePmBytes(incoming));
    h.handlePaste(withSel, {} as ClipboardEvent, incoming);
    expect(guard).toHaveBeenLastCalledWith(estimatePmBytes(incoming) - estimatePmBytes(selected));
    guard.mockClear();
    expect(h.handleDrop(withSel, {} as DragEvent, incoming, true)).toBe(false);
    expect(guard).not.toHaveBeenCalled();
    guard.mockReturnValue(true);
    expect(h.handleDrop(withSel, {} as DragEvent, incoming, false)).toBe(true);
    expect(guard).toHaveBeenLastCalledWith(estimatePmBytes(incoming));
  });
});
