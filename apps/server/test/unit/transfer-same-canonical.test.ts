import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, canonicalizeElements, topLevelContainers } from "@knotebook/shared";
import { fingerprintOf, topLevelFingerprints, topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { toNoteMarkdown } from "../../src/notes/editing/read.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { sameCanonicalOf, sameCanonicalSeq } from "../../src/transfer/same-canonical.js";
import { SHAPE_LINK_TARGET, SHAPE_TITLES, TRANSFER_SHAPES, type ShapeBlock } from "./fixtures/transfer-shapes.js";

/** bulk transfer 的 same／canonical 判定（C1）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const SITE = "http://localhost";
const CANDIDATES = [{ id: SHAPE_LINK_TARGET, title: "Other note", slug: "other-note", groupId: null, ownerHandle: "owner" }];
const frag = (doc: Y.Doc) => doc.getXmlFragment(YDOC_FRAGMENT);

async function docWith(blocks: ShapeBlock[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
/** 在 doc 上開一次 session 做事（人的修改、匯出）。 */
async function withEditor<T>(doc: Y.Doc, f: (ed: EditorSession["editor"]) => T): Promise<T> {
  const s = await EditorSession.open(rt, doc);
  try {
    return f(s.editor);
  } finally {
    s.close();
  }
}
/** scratch：空 Y.Doc 上 parse → （拿掉第一顆 numbered 的 start）→ insertBlocks → close；回 scratch 的 fragment 與插入的 id。 */
async function scratchOf(md: string, stripStart: boolean): Promise<{ frag: Y.XmlFragment; ids: string[] }> {
  const doc = new Y.Doc();
  const ids = await withEditor(doc, ed => {
    const p = parseMarkdownForNote(ed, md, CANDIDATES, SITE);
    if ("error" in p) throw new Error(p.error);
    const blocks = p.blocks;
    if (stripStart && blocks[0]?.type === "numberedListItem" && blocks[0].props) delete (blocks[0].props as Record<string, unknown>).start;
    return ed.insertBlocks(blocks, ed.document[0]!.id, "before").map(b => b.id);
  });
  return { frag: frag(doc), ids };
}
const fpsOf = (f: Y.XmlFragment, ids: string[]) => {
  const byId = new Map(topLevelContainers(f).map(c => [c.getAttribute("id"), c]));
  return ids.map(id => fingerprintOf(canonicalizeElements([byId.get(id)!])));
};
const paras = (n: number): ShapeBlock[] => Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: `p${i}` }));

describe("C1 topLevelSnapshot", () => {
  it.each(TRANSFER_SHAPES.map(s => [`[${s.group}] ${s.name}`, s] as const))("%s：ids／fps＝topLevelFingerprints、types＝editor.document 的 type", async (_l, shape) => {
    const doc = await docWith(shape.blocks);
    const snap = topLevelSnapshot(frag(doc));
    const tf = topLevelFingerprints(frag(doc));
    expect(snap.ids).toEqual(tf.ids);
    expect(snap.fps).toEqual(tf.fps);
    const types = await withEditor(doc, ed => ed.document.map(b => b.type as string));
    expect(snap.types).toEqual(types);
  });
  it("缺 id 丟錯", () => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    frag(doc).insert(0, [g]);
    g.insert(0, [new Y.XmlElement("blockContainer")]);
    expect(() => topLevelSnapshot(frag(doc))).toThrow();
  });
});

describe("C2 效能（一次走完）", () => {
  it("C2 2 000 顆 topLevelSnapshot < 500 ms", async () => {
    const doc = await docWith(paras(2000));
    const t0 = performance.now();
    const snap = topLevelSnapshot(frag(doc));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(snap.ids).toHaveLength(2000);
  }, 60_000);
  it("C2b 2 000 顆 sameCanonicalSeq(全部 id) < 500 ms", async () => {
    const doc = await docWith(paras(2000));
    const ids = topLevelSnapshot(frag(doc)).ids;
    const t0 = performance.now();
    const seq = sameCanonicalSeq(frag(doc), ids);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(seq).toHaveLength(2000);
  }, 60_000);
});

/** 4 案「人已經做了同樣修改」：agent 的區文字＝人改完那顆的匯出（numbered 中間項用整篇匯出的編號）。 */
describe("C3 人已經做了同樣修改 → sameCanonical 相等、指紋不等（前提）", () => {
  const N = (t: string): ShapeBlock => ({ type: "numberedListItem", content: t });
  async function humanEdited(blocks: ShapeBlock[], idx: number, edit: (ed: EditorSession["editor"], id: string) => void, opts: { browser?: boolean } = {}) {
    const doc = await docWith(blocks);
    const id = topLevelSnapshot(frag(doc)).ids[idx]!;
    await withEditor(doc, ed => edit(ed, id));
    if (opts.browser) {
      // 瀏覽器建的形：numbered 沒有 `start` 屬性（直接改 Y 結構）
      doc.transact(() => {
        for (const c of topLevelContainers(frag(doc))) {
          const content = c.get(0);
          if (content instanceof Y.XmlElement && content.nodeName === "numberedListItem") content.removeAttribute("start");
        }
      });
    }
    return { doc, id };
  }
  const cases: Array<[string, () => Promise<{ doc: Y.Doc; id: string }>, (md: string) => string, boolean]> = [
    ["numbered 中間項（server 建）", () => humanEdited([N("a"), N("b"), N("c")], 1, (ed, id) => ed.updateBlock(id, { content: "b2" })), md => md.replace(/^1\./, "2."), true],
    ["numbered 中間項（瀏覽器形）", () => humanEdited([N("a"), N("b"), N("c")], 1, (ed, id) => ed.updateBlock(id, { content: "b2" }), { browser: true }), md => md.replace(/^1\./, "2."), true],
    [
      "帶 wikilink 的 bullet",
      () =>
        humanEdited([{ type: "bulletListItem", content: [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other" } }, { type: "text", text: " tail", styles: {} }] }], 0, (ed, id) =>
          ed.updateBlock(id, { content: [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other" } }, { type: "text", text: " tail2", styles: {} }] } as never),
        ),
      md => md,
      false,
    ],
    ["image 改說明", () => humanEdited([{ type: "image", props: { url: "/api/uploads/u1", caption: "cap" } }], 0, (ed, id) => ed.updateBlock(id, { props: { caption: "cap2" } } as never)), md => md, false],
  ];
  it.each(cases)("%s", async (_n, make, toAgent, stripStart) => {
    const { doc, id } = await make();
    const exported = await withEditor(doc, ed => toNoteMarkdown(ed, [ed.getBlock(id)!], SHAPE_TITLES));
    const sc = await scratchOf(toAgent(exported), stripStart);
    expect(sameCanonicalSeq(sc.frag, sc.ids)).toEqual(sameCanonicalSeq(frag(doc), [id]));
    // 前提：同一組用 `fingerprintOf` 比 → 不等（證明 sameCanonical 承重）
    expect(fpsOf(sc.frag, sc.ids)).not.toEqual(fpsOf(frag(doc), [id]));
  });
  // 第 ② 條（丟 `start`）單獨承重的形：預解析帶真的 `start: 2`（插入點前一顆已不是 numbered，所以沒拿掉——「之後別人刪掉
  // 前兩項」），現況那顆沒有 start 值。上面兩案的 `start` 在兩邊都是 undefined 或不存在，第 ①、② 條任一條就夠。
  it("numbered 預解析帶 start: 2（沒拿掉）、現況那顆已是清單第一項 → 相等（只靠第 ② 條）", async () => {
    const { doc, id } = await humanEdited([N("b")], 0, (ed, bid) => ed.updateBlock(bid, { content: "b2" }));
    const sc = await scratchOf("2. b2", false);
    expect(sameCanonicalSeq(sc.frag, sc.ids)).toEqual(sameCanonicalSeq(frag(doc), [id]));
    expect(fpsOf(sc.frag, sc.ids)).not.toEqual(fpsOf(frag(doc), [id]));
  });
});

describe("C4 不吞真修改", () => {
  const wl = (props: Record<string, unknown>): ShapeBlock => ({ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other", ...props } }] });
  const one = async (b: ShapeBlock) => sameCanonicalOf(topLevelContainers(frag(await docWith([b])))[0]!);
  it.each([
    ["wikilink 改自訂文字（label）", wl({ label: "mine" }), wl({ label: "yours" })],
    ["wikilink 加上 label", wl({}), wl({ label: "mine" })],
    ["wikilink 拿掉錨點", wl({ anchorBlockId: "abc" }), wl({})],
    ["wikilink 加上錨點", wl({}), wl({ anchorBlockId: "abc" })],
    ["段落改一字", { type: "paragraph", content: "hello" }, { type: "paragraph", content: "hellp" }],
    ["非 wikilink 的空字串屬性：code language \"\" vs \"text\"", { type: "codeBlock", props: { language: "" }, content: "x" }, { type: "codeBlock", props: { language: "text" }, content: "x" }],
  ] as Array<[string, ShapeBlock, ShapeBlock]>)("%s → 不相等", async (_n, a, b) => {
    expect(await one(a)).not.toBe(await one(b));
  });
  // 「其他元素的空字串屬性照常比」單獨承重的形：code `language: ""` 對「沒有 language 屬性」（讀時取預設 `text`）。上一案的
  // `""` vs `"text"` 不管空字串丟不丟都不等，擋不住「對所有元素丟空字串屬性」。
  it("非 wikilink 的空字串屬性：code language \"\" vs 沒有 language 屬性 → 不相等", async () => {
    const doc = await docWith([{ type: "codeBlock", props: { language: "" }, content: "x" }]);
    const a = sameCanonicalOf(topLevelContainers(frag(doc))[0]!);
    doc.transact(() => {
      const content = topLevelContainers(frag(doc))[0]!.get(0) as Y.XmlElement;
      content.removeAttribute("language");
    });
    expect(sameCanonicalOf(topLevelContainers(frag(doc))[0]!)).not.toBe(a);
  });
  it("對照：wikilink 只差 snapshotTitle → 相等", async () => {
    expect(await one(wl({ snapshotTitle: "A" }))).toBe(await one(wl({ snapshotTitle: "B" })));
  });
});
