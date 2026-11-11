import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { isLoneEmptyParagraph } from "../../src/transfer/decide.js";
import { docWith, forkOf, withEditor } from "./fixtures/transfer-sync.js";

/**
 * 寫回判「筆記動過沒」改用結構比對——頂層 id＋單顆指紋（`topLevelSnapshot`）。這裡確認單顆指紋
 * 涵蓋整個 block 子樹的文字與屬性（巢狀清單、toggle 子層、表格儲存格、並排、行內樣式、block 屬性）；以及 `isLoneEmptyParagraph`。
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
type Ed = Parameters<Parameters<typeof withEditor>[2]>[0];
const snap = (doc: Y.Doc) => topLevelSnapshot(doc.getXmlFragment(YDOC_FRAGMENT));

/** 基底 doc → fork 上改一處 → 回 [改前, 改後] 的頂層快照。 */
async function before_after(blocks: unknown[], edit: (ed: Ed) => void) {
  const doc = await docWith(rt, blocks);
  const live = forkOf(doc);
  await withEditor(rt, live, edit);
  return [snap(doc), snap(live)] as const;
}
/** 只有 index `k` 那顆的指紋變了、id 都沒變。 */
function onlyChanged(a: ReturnType<typeof snap>, b: ReturnType<typeof snap>, k: number) {
  expect(b.ids).toEqual(a.ids);
  a.fps.forEach((fp, i) => (i === k ? expect(b.fps[i], `#${i}`).not.toBe(fp) : expect(b.fps[i], `#${i}`).toBe(fp)));
}

describe("SC1 單顆指紋涵蓋整個子樹", () => {
  it("巢狀清單：改子項的字、子項的子項、加一個子項 → 父那顆的指紋變", async () => {
    const blocks = [
      { type: "paragraph", content: "A" },
      { type: "bulletListItem", content: "parent", children: [{ type: "bulletListItem", content: "child", children: [{ type: "bulletListItem", content: "grand" }] }] },
    ];
    const childText = await before_after(blocks, ed => ed.updateBlock(ed.document[1]!.children[0]!.id, { content: "child!" }));
    onlyChanged(...childText, 1);
    const grand = await before_after(blocks, ed => ed.updateBlock(ed.document[1]!.children[0]!.children[0]!.id, { content: "grand!" }));
    onlyChanged(...grand, 1);
    const added = await before_after(blocks, ed => ed.insertBlocks([{ type: "bulletListItem", content: "new" }], ed.document[1]!.children[0]!.id, "after"));
    onlyChanged(...added, 1);
  });
  it("toggle 的子層：改子段落的字 → toggle 那顆的指紋變", async () => {
    const blocks = [{ type: "toggleListItem", content: "T", children: [{ type: "paragraph", content: "inside" }] }, { type: "paragraph", content: "B" }];
    const r = await before_after(blocks, ed => ed.updateBlock(ed.document[0]!.children[0]!.id, { content: "inside!" }));
    onlyChanged(...r, 0);
  });
  it("表格：改一格的字 → 表格那顆的指紋變", async () => {
    const table = (cell: string) => ({ type: "table", content: { type: "tableContent", rows: [{ cells: [["a"], ["b"]] }, { cells: [["c"], [cell]] }] } });
    const r = await before_after([{ type: "paragraph", content: "A" }, table("d")], ed => ed.updateBlock(ed.document[1]!.id, table("d!") as never));
    onlyChanged(...r, 1);
  });
  it("行內樣式（只加粗、字不變）與 block 屬性（只改顏色）→ 指紋變", async () => {
    const blocks = [{ type: "paragraph", content: "plain" }, { type: "paragraph", content: "B" }];
    const bold = await before_after(blocks, ed => ed.updateBlock(ed.document[0]!.id, { content: [{ type: "text", text: "plain", styles: { bold: true } }] }));
    onlyChanged(...bold, 0);
    const color = await before_after(blocks, ed => ed.updateBlock(ed.document[0]!.id, { props: { textColor: "red" } }));
    onlyChanged(...color, 0);
  });
  it("對照：沒改 → 指紋與 id 全同；把一顆換成內容相同的新 block → id 變（matchesBase 靠 id 抓）", async () => {
    const blocks = [{ type: "paragraph", content: "A" }, { type: "paragraph", content: "B" }];
    const same = await before_after(blocks, () => {});
    expect(same[1]).toEqual(same[0]);
    const swapped = await before_after(blocks, ed => ed.replaceBlocks([ed.document[1]!.id], [{ type: "paragraph", content: "B" }]));
    expect(swapped[1].fps).toEqual(swapped[0].fps);
    expect(swapped[1].ids[1]).not.toBe(swapped[0].ids[1]);
  });
});

describe("SC2 isLoneEmptyParagraph", () => {
  const frag = async (blocks: unknown[], edit?: (ed: Ed) => void) => {
    const doc = await docWith(rt, blocks);
    if (edit) await withEditor(rt, doc, edit);
    return doc.getXmlFragment(YDOC_FRAGMENT);
  };
  it("一顆空段落 → true；打過字又刪光 → true；有顏色的空段落 → true", async () => {
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph" }]))).toBe(true);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", content: "x" }], ed => ed.updateBlock(ed.document[0]!.id, { content: [] })))).toBe(true);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", props: { backgroundColor: "red" } }]))).toBe(true);
  });
  it("有字、兩顆、不是段落、有子層、0 顆 → false", async () => {
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", content: "x" }]))).toBe(false);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph" }, { type: "paragraph" }]))).toBe(false);
    expect(isLoneEmptyParagraph(await frag([{ type: "heading", props: { level: 1 } }]))).toBe(false);
    expect(isLoneEmptyParagraph(await frag([{ type: "paragraph", children: [{ type: "paragraph", content: "c" }] }]))).toBe(false);
    expect(isLoneEmptyParagraph(new Y.Doc().getXmlFragment(YDOC_FRAGMENT))).toBe(false);
  });
});
