import { describe, expect, it } from "vitest";
import { diffBlocks, markOf, renderDiff, sideBySideMarks, type DiffBlock } from "./version-diff";

const p = (id: string, text: string, children: DiffBlock[] = []): DiffBlock => ({
  id,
  type: "paragraph",
  props: { textAlignment: "left" },
  content: [{ type: "text", text, styles: {} }],
  children,
});
const img = (id: string, url: string): DiffBlock => ({ id, type: "image", props: { url }, content: undefined, children: [] });

/** 只取一層的 (key, mark) 對，方便讀。 */
const marksOf = (a: DiffBlock[], b: DiffBlock[]) => diffBlocks(a, b).map((e) => [e.key, markOf(e)]);

describe("diffBlocks（spec §8.4）", () => {
  it("新增：只在 b 的區塊 → added，順序依 b", () => {
    expect(marksOf([p("A", "a")], [p("A", "a"), p("B", "b")])).toEqual([
      ["A", "context"],
      ["B", "added"],
    ]);
  });

  it("刪除：插在 a 裡它前一顆存活區塊之後；前面沒有存活的就放開頭；合成 id", () => {
    const out = marksOf([p("X", "x"), p("A", "a"), p("D", "d"), p("B", "b")], [p("A", "a"), p("B", "b")]);
    expect(out).toEqual([
      ["diff-del-1", "deleted"],
      ["A", "context"],
      ["diff-del-2", "deleted"],
      ["B", "context"],
    ]);
  });

  it("修改：同 id、去掉 children 後 JSON 不等 → changed；只改 children 的父不算 changed", () => {
    const a = [p("A", "舊字"), p("P", "同", [p("C", "子一")])];
    const b = [p("A", "新字"), p("P", "同", [p("C", "子二")])];
    const out = diffBlocks(a, b);
    expect(out.map(markOf)).toEqual(["changed", "context"]);
    expect(out[1].children.map(markOf)).toEqual(["changed"]);
  });

  it("搬動：LIS 外的才標 moved（[A,B,C] → [C,A,B] 只有 C）", () => {
    expect(marksOf([p("A", "a"), p("B", "b"), p("C", "c")], [p("C", "c"), p("A", "a"), p("B", "b")])).toEqual([
      ["C", "moved"],
      ["A", "context"],
      ["B", "context"],
    ]);
  });

  it("搬動＋修改並存：mark 是 changed、moved 旗標仍為 true", () => {
    const [first] = diffBlocks([p("A", "a"), p("B", "b")], [p("B", "b2"), p("A", "a")]);
    expect(first.key).toBe("B");
    expect(markOf(first)).toBe("changed");
    expect(first.moved).toBe(true);
  });

  it("父刪子升：跨層搬移顯示為刪除＋新增（§13-7）；P 前面沒有存活區塊 → 刪除放開頭（§8.4-2）；渲染 id 全部唯一", () => {
    const a = [p("P", "父", [p("C", "子")])];
    const b = [p("C", "子")];
    const entries = diffBlocks(a, b);
    expect(entries.map((e) => [e.key, markOf(e)])).toEqual([
      ["diff-del-1", "deleted"],
      ["C", "added"],
    ]);
    expect(entries[0].children.map((e) => [e.key, markOf(e)])).toEqual([["diff-del-2", "deleted"]]);
    const { blocks } = renderDiff(entries);
    const ids: string[] = [];
    const walk = (bs: DiffBlock[]) => bs.forEach((x) => (ids.push(x.id!), walk(x.children ?? [])));
    walk(blocks);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("非文字區塊（image）只標 changed、內容取 b、nonText 旗標", () => {
    const entries = diffBlocks([img("I", "/api/uploads/1")], [img("I", "/api/uploads/2")]);
    const { blocks, marks } = renderDiff(entries);
    expect(marks.get("I")).toEqual({ mark: "changed", moved: false, nonText: true });
    expect(blocks[0].props).toEqual({ url: "/api/uploads/2" });
  });

  it("inline 重組：equal／added 沿用 b 的樣式、removed 沿用 a 的樣式並加 strike＋紅底、added 加綠底", () => {
    const a: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [{ type: "text", text: "舊 字", styles: { bold: true } }], children: [] }];
    const b: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [{ type: "text", text: "新 字", styles: { italic: true } }], children: [] }];
    const { blocks } = renderDiff(diffBlocks(a, b));
    expect(blocks[0].content).toEqual([
      { type: "text", text: "舊", styles: { bold: true, strike: true, backgroundColor: "red" } },
      { type: "text", text: "新", styles: { italic: true, backgroundColor: "green" } },
      { type: "text", text: " 字", styles: { italic: true } },
    ]);
  });

  it("inline 重組：連結與非文字 inline（wikilink）保留原形", () => {
    const wl = { type: "wikilink", props: { targetNoteId: "n2", snapshotTitle: "T" } };
    const a: DiffBlock[] = [{ id: "A", type: "paragraph", props: {}, content: [wl, { type: "text", text: " 看", styles: {} }], children: [] }];
    const b: DiffBlock[] = [
      { id: "A", type: "paragraph", props: {}, content: [wl, { type: "text", text: " 看 ", styles: {} }, { type: "link", href: "https://x.test", content: [{ type: "text", text: "這", styles: {} }] }], children: [] },
    ];
    const { blocks } = renderDiff(diffBlocks(a, b));
    const content = blocks[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual(wl);
    expect(content).toContainEqual({ type: "link", href: "https://x.test", content: [{ type: "text", text: "這", styles: { backgroundColor: "green" } }] });
  });

  it("兩邊都空 → 一顆空 paragraph（initialContent 不可為空陣列）", () => {
    const { blocks, marks } = renderDiff(diffBlocks([], []));
    expect(blocks).toEqual([{ id: "diff-empty", type: "paragraph" }]);
    expect(marks.size).toBe(0);
  });

  it("v1 vs 空文件：全部 added（子孫也是）", () => {
    const entries = diffBlocks([], [p("A", "a", [p("C", "c")])]);
    expect(entries.map(markOf)).toEqual(["added"]);
    expect(entries[0].children.map(markOf)).toEqual(["added"]);
  });

  it("只看差異：連續 context 折成一顆合成段落，子樹有變更的 context 不折", () => {
    const a = [p("A", "a"), p("B", "b"), p("C", "c"), p("D", "d", [p("E", "e")])];
    const b = [p("A", "a"), p("B", "b"), p("C", "c2"), p("D", "d", [p("E", "e2")])];
    const { blocks, marks } = renderDiff(diffBlocks(a, b), { onlyChanges: true, collapsedText: (n) => `… ${n} …` });
    expect(blocks.map((x) => x.id)).toEqual(["diff-ctx-1", "C", "D"]);
    expect(blocks[0].content).toEqual([{ type: "text", text: "… 2 …", styles: {} }]);
    expect(marks.get("diff-ctx-1")?.mark).toBe("collapsed");
  });

  it("並排標記：左邊標 deleted／changed、右邊標 added／changed／moved", () => {
    const { left, right } = sideBySideMarks(diffBlocks([p("A", "a"), p("D", "d"), p("M", "m")], [p("M", "m"), p("A", "a2"), p("N", "n")]));
    expect(Object.fromEntries(left)).toEqual({ A: "changed", D: "deleted" });
    expect(Object.fromEntries(right)).toEqual({ M: "moved", A: "changed", N: "added" });
  });

  it("RF1：缺 id 與同一層重複的 id 不 throw；同一層重複出現的 id **全部**不配對（含第一次出現的那顆），渲染 id 全唯一", () => {
    const noId: DiffBlock = { type: "paragraph", props: {}, content: [], children: [] };
    const a = [p("A", "a"), p("A", "a 重複"), noId];
    const b = [p("A", "a"), p("A", "又重複"), { ...noId }];
    const entries = diffBlocks(a, b);
    const { blocks } = renderDiff(entries);
    const ids = blocks.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.filter((e) => markOf(e) === "context")).toHaveLength(0);
    expect(entries.filter((e) => markOf(e) === "added")).toHaveLength(3);
    expect(entries.filter((e) => markOf(e) === "deleted")).toHaveLength(3);
  });

  it("RF1 對照：同一個 id 只在一側重複時，另一側那顆也不配對（重複判定是逐側、逐層）", () => {
    const entries = diffBlocks([p("A", "a")], [p("A", "a"), p("A", "a2")]);
    expect(entries.map(markOf).sort()).toEqual(["added", "added", "deleted"]);
  });
});
