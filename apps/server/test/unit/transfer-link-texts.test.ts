import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { exportedLinkTextOf, keepLabelFree, labelFreeLinkTexts, linkTextHash } from "../../src/transfer/link-texts.js";
import { TEST_KEY, TEST_SALT, docWith, forkOf, makeBaseInMemory, planInMemory } from "./fixtures/transfer-sync.js";

/** 8000 第三輪探索測試 F1：沒有自訂文字的 wikilink 在寫回時不被凍結成自訂文字（`transfer/link-texts.ts`）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const T = "abcdef11-1111-4111-8111-111111111111"; // 含英文字母：大小寫斷言才有作用
const U = "22222222-2222-4222-8222-222222222222";
const cand = (id: string, title: string) => ({ id, title, slug: "s", groupId: null, ownerHandle: "x" });
const wl = (props: Record<string, string>) => ({ type: "wikilink", props: { targetNoteId: T, snapshotTitle: "Old snapshot", ...props } });
const linkPara = (lead: string, props: Record<string, string> = {}) => ({ type: "paragraph", content: [{ type: "text", text: lead, styles: {} }, wl(props)] });
const P = (t: string) => ({ type: "paragraph", content: t });
const ok = <R extends { ok: boolean }>(r: R): Extract<R, { ok: true }> => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<R, { ok: true }>;
};
/** parse 出的每個 wikilink 的 props（各區依序）。 */
function wikilinksOf(parsed: unknown[][]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const o = x as { type?: unknown; props?: Record<string, unknown> };
      if (o.type === "wikilink") out.push(o.props ?? {});
      Object.values(x).forEach(walk);
    }
  };
  walk(parsed);
  return out;
}

describe("labelFreeLinkTexts／keepLabelFree", () => {
  it("只收沒有自訂文字的 wikilink（含子 block、表格格子），文字＝匯出時顯示的（現行標題，查不到退 snapshotTitle）", () => {
    const blocks = [
      { type: "paragraph", content: [wl({}), wl({ label: "Custom" })], children: [{ type: "paragraph", content: [wl({ targetNoteId: U })], children: [] }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[wl({ targetNoteId: T.toUpperCase() })]] }] }, children: [] },
    ];
    expect(labelFreeLinkTexts(blocks, new Map([[T, "Target v1"]]))).toEqual([
      [T, "Target v1"],
      [U, "Old snapshot"],
      [T, "Target v1"],
    ]);
  });

  it("keepLabelFree：label 是下載時的匯出文字 → 清掉、snapshotTitle 換現行標題；其餘不動（回同一個陣列）", () => {
    const exported = (id: string, text: string) => id === T && text === "Target v1";
    const blocks = [{ type: "paragraph", content: [wl({ label: "Target v1" }), wl({ label: "Mine" }), wl({ targetNoteId: U, label: "Target v1" })] }];
    const [out, n] = keepLabelFree(blocks, exported, id => (id === T ? "Target v2" : undefined));
    expect(n).toBe(1);
    expect(wikilinksOf([out]).map(p => [p.label, p.snapshotTitle])).toEqual([["", "Target v2"], ["Mine", "Old snapshot"], ["Target v1", "Old snapshot"]]);
    const untouched = [P("x")];
    expect(keepLabelFree(untouched, exported, () => undefined)[0]).toBe(untouched);
  });

  it("exportedLinkTextOf：併所有段的 links；一個都沒有 → undefined；id 不分大小寫", () => {
    const h = linkTextHash(TEST_KEY, TEST_SALT, T, "Target v1");
    expect(exportedLinkTextOf([{ ids: ["a"], fps: ["f"], start: 0, count: 1 }], TEST_KEY, TEST_SALT)).toBeUndefined();
    const f = exportedLinkTextOf([{ ids: ["a"], fps: ["f"], start: 0, count: 1 }, { ids: ["b"], fps: ["g"], start: 1, count: 1, links: [h] }], TEST_KEY, TEST_SALT)!;
    expect(f(T, "Target v1")).toBe(true);
    expect(f(T.toUpperCase(), "Target v1")).toBe(true);
    expect(f(T, "Target v2")).toBe(false);
    expect(f(U, "Target v1")).toBe(false);
    expect(linkTextHash(TEST_KEY, Buffer.alloc(16, 1), T, "Target v1")).not.toBe(h); // 加鹽
  });
});

describe("匯出段表帶 links、規劃時保住「沒有自訂文字」", () => {
  it("段表：只有含沒有自訂文字的 wikilink 的段帶 links（去重）；不給 linkHash 的匯出不帶", async () => {
    const doc = await docWith(rt, [linkPara("See ", {}), P("Para"), linkPara("Mine ", { label: "Custom" })]);
    const b = await makeBaseInMemory(rt, doc, new Map([[T, "Target v1"]]));
    const segs = b.base.segments!;
    expect(segs.map(s => s.links)).toEqual([[linkTextHash(TEST_KEY, TEST_SALT, T, "Target v1")], undefined, undefined]);
  });

  const scene = async (props: Record<string, string> = {}) => {
    const doc = await docWith(rt, [linkPara("See ", props), P("Para 2")]);
    const b = await makeBaseInMemory(rt, doc, new Map([[T, "Target v1"]]));
    return { doc, b };
  };

  it("目標下載後改名、agent 改了同段別的字（連結文字沒動）→ label 空、snapshotTitle＝現行標題", async () => {
    const { doc, b } = await scene();
    expect(b.body).toContain(`[Target v1](/notes/${T})`);
    const r = ok(await planInMemory(rt, b, b.body.replace("See ", "Look "), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
    expect(wikilinksOf(r.plan.parsed)).toEqual([{ targetNoteId: T, snapshotTitle: "Target v2", label: "", anchorBlockId: "" }]);
  });

  it("目標改名、連結改寫成全站網址（讀回相同）→ 這區判 same（不寫）", async () => {
    const { doc, b } = await scene();
    const r = ok(await planInMemory(rt, b, b.body.replace(`](/notes/${T})`, `](http://localhost/notes/${T})`), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
    expect(r.plan.decisions.map(d => `${d.kind}:${d.mark}`)).toEqual(["rewrite:same"]);
  });

  it("agent 把連結文字改成別的（含基底的 snapshotTitle）→ 存成自訂文字", async () => {
    for (const text of ["My words", "Old snapshot"]) {
      const { doc, b } = await scene();
      const r = ok(await planInMemory(rt, b, b.body.replace("[Target v1]", `[${text}]`), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
      expect(wikilinksOf(r.plan.parsed).map(p => p.label)).toEqual([text]);
    }
  });

  it("原本就有自訂文字 → 保持自訂文字", async () => {
    const { doc, b } = await scene({ label: "Custom words" });
    const r = ok(await planInMemory(rt, b, b.body.replace("See ", "Look "), forkOf(doc), { candidates: [cand(T, "Target v2")] }));
    expect(wikilinksOf(r.plan.parsed).map(p => p.label)).toEqual(["Custom words"]);
  });
});
