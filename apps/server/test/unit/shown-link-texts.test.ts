/**
 * #387：`edit_note` 寫回時，讀者讀到的「沒有自訂文字的連結」的文字不得被凍結成自訂文字（`notes/editing/shown-link-texts.ts`）。
 * 這支釘住記憶體本身（誰、哪個目標、哪段文字、多久、上限）與讀出時的走訪；寫入端的整合行為在 `test/mcp-edit-note-linklabel.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { ShownLinkTexts, shownLinkTextsOf } from "../../src/notes/editing/shown-link-texts.js";

const T = "abcdef00-0000-4000-8000-00000000000a";
const T2 = "abcdef00-0000-4000-8000-00000000000b";

describe("ShownLinkTexts", () => {
  it("記下的 (使用者, 目標, 文字) 才命中；別的使用者、別的目標、別的文字都不命中；目標 id 不分大小寫", () => {
    const m = new ShownLinkTexts();
    m.record("u1", { free: [[T, "Target v1"]], custom: [] });
    expect(m.has("u1", T, "Target v1")).toBe(true);
    expect(m.has("u1", T.toUpperCase(), "Target v1")).toBe(true);
    expect(m.has("u2", T, "Target v1")).toBe(false);
    expect(m.has("u1", T2, "Target v1")).toBe(false);
    expect(m.has("u1", T, "Target v2")).toBe(false);
    expect(m.has("u1", T, "target v1")).toBe(false);
  });

  it("過了保存期限就不命中，也從表裡拿掉", () => {
    let now = 1000;
    const m = new ShownLinkTexts({ ttlMs: 100, now: () => now });
    m.record("u1", { free: [[T, "A"]], custom: [] });
    now = 1099;
    expect(m.has("u1", T, "A")).toBe(true);
    now = 1100;
    expect(m.has("u1", T, "A")).toBe(false);
    expect(m.size).toBe(0);
  });

  it("再讀到同一個連結會重算期限", () => {
    let now = 0;
    const m = new ShownLinkTexts({ ttlMs: 100, now: () => now });
    m.record("u1", { free: [[T, "A"]], custom: [] });
    now = 90;
    m.record("u1", { free: [[T, "A"]], custom: [] });
    now = 150;
    expect(m.has("u1", T, "A")).toBe(true);
  });

  it("讀到同一個目標、同一段文字的自訂文字連結 → 拿掉先前記下的；同一次讀出兩種都有時，沒有自訂文字的那個算數", () => {
    const m = new ShownLinkTexts();
    m.record("u1", { free: [[T, "A"]], custom: [] });
    m.record("u1", { free: [], custom: [[T, "A"]] });
    expect(m.has("u1", T, "A")).toBe(false);
    m.record("u1", { free: [[T, "A"]], custom: [[T, "A"]] });
    expect(m.has("u1", T, "A")).toBe(true);
    // 自訂文字只拿掉同一個使用者的
    m.record("u2", { free: [[T, "B"]], custom: [] });
    m.record("u1", { free: [], custom: [[T, "B"]] });
    expect(m.has("u2", T, "B")).toBe(true);
  });

  it("超過上限 → 丟掉最舊的；重新記下的那筆算新的", () => {
    const m = new ShownLinkTexts({ max: 3 });
    m.record("u1", { free: [[T, "1"], [T, "2"], [T, "3"]], custom: [] });
    m.record("u1", { free: [[T, "1"]], custom: [] });
    m.record("u1", { free: [[T, "4"]], custom: [] });
    expect(m.size).toBe(3);
    expect(m.has("u1", T, "2")).toBe(false);
    expect(["1", "3", "4"].map(t => m.has("u1", T, t))).toEqual([true, true, true]);
  });

  it("每個帳號有自己的上限：超過只丟這個帳號自己最舊的，別的帳號（即使更舊）不受影響（審查 m1）", () => {
    const m = new ShownLinkTexts({ max: 100, perUserMax: 2 });
    m.record("u2", { free: [[T, "a"]], custom: [] });
    m.record("u1", { free: [[T, "1"], [T, "2"]], custom: [] });
    m.record("u1", { free: [[T, "3"]], custom: [] });
    expect(m.size).toBe(3);
    expect(["1", "2", "3"].map(t => m.has("u1", T, t))).toEqual([false, true, true]);
    expect(m.has("u2", T, "a")).toBe(true);
  });
});

describe("ShownLinkTexts.keepLabelFree", () => {
  it("清掉讀到過的文字的 label、換上現行標題，並回報被清掉的 (目標, 原文字)；沒讀到過的、別人讀到的不動（第二輪 m-b）", () => {
    const m = new ShownLinkTexts();
    m.record("u1", { free: [[T, "Old"]], custom: [] });
    const wl = (label: string) => ({ type: "wikilink", props: { targetNoteId: T, snapshotTitle: label, label, anchorBlockId: "" } });
    const blocks = [{ type: "paragraph", content: [wl("Old"), wl("Mine")] }];
    const [out, cleared] = m.keepLabelFree(blocks, "u1", [{ id: T, title: "New" }]);
    expect(cleared).toEqual([[T, "Old"]]);
    expect((out[0]!.content as Array<{ props: { label: string; snapshotTitle: string } }>).map(n => [n.props.label, n.props.snapshotTitle])).toEqual([["", "New"], ["Mine", "Mine"]]);
    const [same, none] = m.keepLabelFree(blocks, "u2", [{ id: T, title: "New" }]);
    expect(same).toBe(blocks);
    expect(none).toEqual([]);
  });
});

describe("shownLinkTextsOf", () => {
  const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { snapshotTitle: "", label: "", anchorBlockId: "", ...props } });
  it("沒有自訂文字的連結：讀者看得到目標＝現行標題、看不到＝snapshotTitle、都空＝網址；有自訂文字的另列；表格格子與子 block 都走到", () => {
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, wl({ targetNoteId: T.toUpperCase(), snapshotTitle: "Old" }), wl({ targetNoteId: T, label: "Mine" })] },
      { type: "paragraph", content: [wl({ targetNoteId: T2, snapshotTitle: "Hidden snap" })], children: [{ type: "paragraph", content: [wl({ targetNoteId: T2, anchorBlockId: "h1" })] }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({ targetNoteId: T })], { type: "tableCell", content: [wl({ targetNoteId: T, label: "Cell" })] }] }] } },
    ];
    const titles = new Map([[T, "Live"]]);
    const shown = shownLinkTextsOf(blocks, titles);
    expect(shown.free).toEqual([
      [T, "Live"],
      [T2, "Hidden snap"],
      [T2, `/notes/${T2}#b-h1`],
      [T, "Live"],
    ]);
    expect(shown.custom).toEqual([
      [T, "Mine"],
      [T, "Cell"],
    ]);
  });
});
