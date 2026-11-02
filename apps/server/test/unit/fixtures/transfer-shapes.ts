// 由 scratchpad 的 wb1-gen-shapes.py 自動產生（不要手改）：形取自 docs/superpowers/plans/2026-11-02-bulk-transfer-ref/spk-shapes.mts
// （gate r3 exp1 的 66 形＋r4 的 35 新形＋spike 的 28 形），預期段表與統計取自同目錄 spk-s1-tableNorm.out.txt（表格填充正規化版，129／129 OK）。
// bulk transfer spec §6.4-2～-5、§25.1；plan T6 Step 1。

export type ShapeBlock = Record<string, unknown>;
type Inline = string | ReadonlyArray<Record<string, unknown>>;
type Extra = Record<string, unknown> & { props?: Record<string, unknown> };

const P_ = (t: Inline, extra: Extra = {}): ShapeBlock => ({ type: "paragraph", content: t, ...extra });
const E_ = (): ShapeBlock => ({ type: "paragraph" });
const B = (t: Inline, extra: Extra = {}): ShapeBlock => ({ type: "bulletListItem", content: t, ...extra });
const N = (t: Inline, extra: Extra = {}): ShapeBlock => ({ type: "numberedListItem", content: t, ...extra });
const C = (t: Inline, checked = false, extra: Extra = {}): ShapeBlock => ({ type: "checkListItem", content: t, ...extra, props: { checked, ...(extra.props ?? {}) } });
const T = (t: Inline, extra: Extra = {}): ShapeBlock => ({ type: "toggleListItem", content: t, ...extra });
const H = (t: Inline, level = 2, extra: Extra = {}): ShapeBlock => ({ type: "heading", content: t, ...extra, props: { level, ...(extra.props ?? {}) } });
const Q = (t: Inline, extra: Extra = {}): ShapeBlock => ({ type: "quote", content: t, ...extra });
const CODE = (t: string, lang = "js"): ShapeBlock => ({ type: "codeBlock", props: { language: lang }, content: t });
const TBL = (rows: unknown[]): ShapeBlock => ({ type: "table", content: { type: "tableContent", rows } });
const red = { props: { backgroundColor: "red" } };
const WL = [
  { type: "wikilink", props: { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "Other" } },
  { type: "text", text: " tail", styles: {} },
];
const ner = <X>(n: number, f: (i: number) => X): X[] => Array.from({ length: n }, (_, i) => f(i));
const blue = { props: { textColor: "blue" } };

/** wikilink 形的目標（spike 的 TITLES）：看得到時的現行標題。 */
export const SHAPE_LINK_TARGET = "11111111-1111-4111-8111-111111111111";
export const SHAPE_TITLES: ReadonlyMap<string, string> = new Map([[SHAPE_LINK_TARGET, "Other note"]]);

export interface TransferShape {
  group: "66" | "35" | "spike";
  name: string;
  blocks: ShapeBlock[];
  /** 預期段表（每段的頂層 index）。 */
  segs: number[][];
  groupCalls: number;
  groupUsedWhilePerMatched: number;
}

export const TRANSFER_SHAPES: TransferShape[] = [
  { group: "66", name: "bullet->check", blocks: [B("a"), C("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "check->bullet", blocks: [C("a"), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "bullet->numbered", blocks: [B("a"), N("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "numbered->check", blocks: [N("a"), C("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "bullet w/ paragraph child", blocks: [B("a", { children: [P_("child")] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "bullet w/ numbered child", blocks: [B("a", { children: [N("x"), N("y")] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "empty bullet in middle", blocks: [B("a"), B(""), B("c")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "emptyPara->bullet", blocks: [P_("A"), E_(), B("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "bullet->emptyPara", blocks: [B("a"), E_(), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "heading->bullet->heading", blocks: [H("H"), B("a"), H("H2")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "code w/ trailing blank", blocks: [CODE("x\n\n"), P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "para hard break", blocks: [P_("a\nb"), P_("c")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "quote multi", blocks: [Q("q1\nq2"), B("a")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "table->bullet", blocks: [TBL([{ cells: ["x", "y"] }]), B("a")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "toggle list", blocks: [T("t1"), T("t2")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "numbered 12 items w/ child on 10", blocks: ner(12, i => N(`n${i + 1}`, i === 9 ? { children: [B("child")] } : {})), segs: [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9],[10],[11]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "numbered start 5", blocks: [N("a", { props: { start: 5 } }), N("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "numbered, para, numbered", blocks: [N("a"), P_("p"), N("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet + plain bullet", blocks: [B("a", red), B("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "plain bullet + colored bullet", blocks: [B("a"), B("b", { props: { textColor: "blue" } })], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "inline color in bullet", blocks: [B([{ type: "text", text: "a", styles: { textColor: "red" } }]), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored para between paras", blocks: [P_("A"), P_("B", { props: { backgroundColor: "yellow" } }), P_("C")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "two empty bullets", blocks: [B(""), B("")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "bullet nested 3 deep", blocks: [B("a", { children: [B("a1", { children: [B("a11")] })] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "check nested under bullet", blocks: [B("a", { children: [C("c1")] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "image w/ width + bullet", blocks: [{ type: "image", props: { url: "/api/uploads/u1", previewWidth: 200 } }, B("a")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "para + nested child para (flatten)", blocks: [P_("A", { children: [P_("child")] }), P_("B")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "A,empty", blocks: [P_("A"), E_()], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "A,empty,empty", blocks: [P_("A"), E_(), E_()], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "empty,A", blocks: [E_(), P_("A")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "only empty", blocks: [E_()], segs: [[0]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "H,empty", blocks: [H("H"), E_()], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "A,empty,empty,B", blocks: [P_("A"), E_(), E_(), P_("B")], segs: [[0],[1],[2],[3]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "A,empty,B,empty,C", blocks: [P_("A"), E_(), P_("B"), E_(), P_("C")], segs: [[0],[1],[2],[3],[4]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "table w/ header + 2 rows", blocks: [TBL([{ cells: ["h1", "h2"] }, { cells: ["a", "b"] }, { cells: ["c", "d"] }]), P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "table w/ colored cell", blocks: [P_("before"), TBL([{ cells: [{ type: "tableCell", content: [{ type: "text", text: "x", styles: {} }], props: { backgroundColor: "red" } }, "y"] }]), P_("after")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "mermaid", blocks: [P_("before"), { type: "mermaid", props: { code: "graph TD\n  A-->B" } }, B("after")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "columns (para | bullet)", blocks: [P_("before"), { type: "columnList", children: [{ type: "column", children: [P_("left")] }, { type: "column", children: [B("r1"), B("r2")] }] }, P_("after")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "columns w/ colored bullet inside", blocks: [{ type: "columnList", children: [{ type: "column", children: [B("r1", red), B("r2")] }, { type: "column", children: [P_("x")] }] }, B("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "wikilink in para + bullet", blocks: [P_(WL), B(WL)], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "image no width + caption", blocks: [{ type: "image", props: { url: "/api/uploads/u1", caption: "cap" } }, P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "file block + para", blocks: [{ type: "file", props: { url: "/api/uploads/u2", name: "a.pdf" } }, P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "nested bullet>numbered>check", blocks: [B("a", { children: [N("n1", { children: [C("c1")] })] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "numbered 10 w/ nested numbered child", blocks: ner(10, i => N(`n${i + 1}`, i === 9 ? { children: [N("x"), N("y")] } : {})), segs: [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "numbered 10 w/ code child (flatten)", blocks: ner(10, i => N(`n${i + 1}`, i === 9 ? { children: [CODE("c")] } : {})), segs: [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "toggle w/ children", blocks: [T("t1", { children: [P_("inner")] }), T("t2")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "toggle w/ bullet child", blocks: [T("t1", { children: [B("inner")] }), P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored heading", blocks: [P_("A"), H("H", 2, { props: { textColor: "red" } }), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored quote", blocks: [P_("A"), Q("q", red), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored check among checks", blocks: [C("a"), C("b", true, red), C("c")], segs: [[0,1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored numbered among numbered", blocks: [N("a"), N("b", red), N("c")], segs: [[0,1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored toggle + toggle", blocks: [T("a", red), T("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "single colored bullet between paras", blocks: [P_("A"), B("a", red), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet + check (diff family)", blocks: [B("a", red), C("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet w/ child", blocks: [B("a", { ...red, children: [B("a1")] }), B("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "bullet, colored bullet, numbered", blocks: [B("a"), B("b", red), N("c")], segs: [[0,1],[2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "divider between paras", blocks: [P_("A"), { type: "divider" }, P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "hard break in bullet", blocks: [B("a\nb"), B("c")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "code containing ```", blocks: [CODE("x\n```\ny", "markdown"), P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet + plain + middle empty para + para", blocks: [B("a", red), B("b"), E_(), P_("P")], segs: [[0,1],[2],[3]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "para, empty, para, colored bullet list", blocks: [P_("A"), E_(), P_("B"), B("x", red), B("y")], segs: [[0],[1],[2],[3,4]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet list + bullet w/ para child elsewhere", blocks: [B("a", red), B("b"), P_("mid"), B("c", { children: [P_("child")] })], segs: [[0,1],[2],[3]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet list + file block", blocks: [B("a", red), B("b"), { type: "file", props: { url: "/api/uploads/u2", name: "a.pdf" } }], segs: [[0,1],[2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet list + multi-para quote", blocks: [B("a", red), B("b"), Q("q1\nq2")], segs: [[0,1],[2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "colored bullet list + heading + code", blocks: [H("T"), B("a", red), B("b"), CODE("x")], segs: [[0],[1,2],[3]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "66", name: "realistic: heading, para, empty, colored list, empty, para", blocks: [H("Title", 1), P_("intro"), E_(), B("todo", red), B("done"), E_(), P_("end")], segs: [[0],[1],[2],[3,4],[5],[6]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n1 12 numbered, item 11 colored", blocks: ner(12, i => N(`n${i + 1}`, i === 10 ? red : {})), segs: [[0,1,2,3,4,5,6,7,8,9,10,11]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n2 12 numbered then colored bullet", blocks: [...ner(12, i => N(`n${i + 1}`)), B("x", red)], segs: [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9],[10],[11],[12]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n3 two colored runs split by empty para", blocks: [B("a", red), B("b"), E_(), B("c", red), B("d")], segs: [[0,1],[2],[3,4]], groupCalls: 2, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n4 colored bullet w/ paragraph child", blocks: [B("a", { ...red, children: [P_("child")] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n5 colored check w/ colored bullet child", blocks: [C("a", false, { ...red, children: [B("x", red)] }), C("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n6 colored bullet, empty, bullet", blocks: [B("a", red), E_(), B("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n7a two quotes adjacent", blocks: [Q("q1"), Q("q2")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n7b two colored paras adjacent", blocks: [P_("A", red), P_("B", red)], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n7c two code blocks adjacent", blocks: [CODE("x"), CODE("y")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n8 bullet w/ quote child", blocks: [B("a", { children: [Q("q")] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n9 literal markers in text", blocks: [P_("1. not a list"), P_("* not a list"), B("1. starts with number")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n10 toggle w/ colored bullet child", blocks: [T("t", { children: [B("x", red)] }), P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n11 colored run w/ empty bullet", blocks: [B("a", red), B(""), B("c")], segs: [[0,1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n12 numbered, colored bullet, numbered", blocks: [N("a"), B("b", red), N("c")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n13 para w/ colored list children", blocks: [P_("A", { children: [B("x", red), B("y")] }), P_("B")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n14 heading w/ colored bullet child", blocks: [H("H", 2, { children: [B("x", red)] }), P_("B")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n15 12 numbered, item 1 colored", blocks: ner(12, i => N(`n${i + 1}`, i === 0 ? red : {})), segs: [[0,1,2,3,4,5,6,7,8,9,10,11]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n16 two tables adjacent", blocks: [TBL([{ cells: ["a", "b"] }]), TBL([{ cells: ["c", "d"] }])], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n17 all families in colored run", blocks: [B("a", red), C("b"), N("c"), T("d"), P_("after")], segs: [[0,1],[2],[3],[4]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n18 colored numbered start 5", blocks: [N("a", { props: { start: 5, backgroundColor: "red" } }), N("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n19 colored bullet after 10 numbered w/ child", blocks: [...ner(10, i => N(`n${i + 1}`, i === 9 ? { children: [B("c")] } : {})), B("x", red)], segs: [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9],[10]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "n20 empty colored bullet", blocks: [B("", red), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e1 bullet, empty, bullet", blocks: [B("a"), E_(), B("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e2 bullet, empty, empty, bullet", blocks: [B("a"), E_(), E_(), B("b")], segs: [[0],[1],[2],[3]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e3 numbered, empty, numbered", blocks: [N("a"), E_(), N("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e4 check, empty, check", blocks: [C("a"), E_(), C("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e5 empty, empty, A", blocks: [E_(), E_(), P_("A")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e6 quote, empty, para", blocks: [Q("q"), E_(), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e7 code, empty, para", blocks: [CODE("x"), E_(), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e8 heading, empty, empty, para", blocks: [H("H"), E_(), E_(), P_("B")], segs: [[0],[1],[2],[3]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e9 colored bullet, empty, colored bullet", blocks: [B("a", red), E_(), B("b", red)], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e10 toggle, empty, toggle", blocks: [T("a"), E_(), T("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e11 A, empty x3, B", blocks: [P_("A"), E_(), E_(), E_(), P_("B")], segs: [[0],[1],[2],[3],[4]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e12 table, empty, bullet", blocks: [TBL([{ cells: ["x", "y"] }]), E_(), B("a")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "35", name: "e13 bullet w/ child, empty, para", blocks: [B("a", { children: [B("x")] }), E_(), P_("B")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k1 colored bullet, bullet, toggle w/ children", blocks: [B("a", red), B("b"), T("t", { children: [P_("inner")] }), P_("after")], segs: [[0,1,2],[3]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k2 colored bullet, toggle, check, bullet w/ code child", blocks: [B("a", red), T("t"), C("c"), B("d", { children: [CODE("x")] })], segs: [[0,1,2,3]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k3 40 bullets, item 35 colored", blocks: ner(40, i => B(`b${i}`, i === 34 ? red : {})), segs: [[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k4 40 bullets, every 10th w/ para child, item 20 colored", blocks: ner(40, i => B(`b${i}`, { ...(i === 19 ? red : {}), ...(i % 10 === 0 ? { children: [P_("c" + i)] } : {}) })), segs: [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9],[10],[11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k5 colored numbered start 3 among numbered", blocks: [N("a", { props: { start: 3 } }), N("b", red), N("c")], segs: [[0,1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k6 check list w/ checked colored + nested checks", blocks: [C("a", true, { children: [C("a1"), C("a2", true)] }), C("b", false, red), C("c")], segs: [[0,1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k7 bullet colored text + bullet colored bg (different color kinds)", blocks: [B("a", blue), B("b", red), B("c")], segs: [[0,1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k8 two colored runs adjacent families (bullet run, numbered run)", blocks: [B("a", red), B("b"), N("c", red), N("d")], segs: [[0,1],[2,3]], groupCalls: 2, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k9 colored run then table then colored run", blocks: [B("a", red), TBL([{ cells: ["x"] }]), C("c", false, red), C("d")], segs: [[0],[1],[2,3]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k10 colored bullet w/ image child", blocks: [B("a", { ...red, children: [{ type: "image", props: { url: "/api/uploads/u1" } }] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k11 colored bullet w/ table child", blocks: [B("a", { ...red, children: [TBL([{ cells: ["x", "y"] }])] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k12 colored bullet w/ empty para child", blocks: [B("a", { ...red, children: [E_()] }), B("b")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k13 bullet w/ empty para child (uncolored)", blocks: [B("a", { children: [E_()] }), B("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 1 },
  { group: "spike", name: "k14 colored toggle w/ children + toggle", blocks: [T("a", { ...red, children: [P_("x")] }), T("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k15 bullet w/ hard break + colored sibling", blocks: [B("a\nb"), B("c", red)], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k16 colored bullet w/ wikilink + bullet", blocks: [B(WL, red), B("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k17 bullet w/ multi-para quote child + colored", blocks: [B("a", { children: [Q("q1\nq2")] }), B("b", red)], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k18 numbered 12 w/ child on 10, item 12 colored", blocks: ner(12, i => N(`n${i + 1}`, { ...(i === 11 ? red : {}), ...(i === 9 ? { children: [B("child")] } : {}) })), segs: [[0,1,2,3,4,5,6,7,8,9,10,11]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k19 empty bullet colored only", blocks: [B("", red)], segs: [[0]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k20 colored para, bullet (para colored, list not)", blocks: [P_("A", red), B("a"), B("b")], segs: [[0],[1],[2]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k21 heading, colored check run 5, empty, para", blocks: [H("H"), ...ner(5, i => C(`c${i}`, i % 2 === 0, i === 2 ? red : {})), E_(), P_("end")], segs: [[0],[1,2,3,4,5],[6],[7]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k22 bullet w/ check child colored", blocks: [B("a", { children: [C("x", false, red)] }), B("b")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k23 deep nest 4 w/ colored leaf", blocks: [B("a", { children: [B("b", { children: [B("c", { children: [B("d", red)] })] })] }), B("e")], segs: [[0,1]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k24 code with literal <ul> then colored list", blocks: [CODE("<ul><li>x</li></ul>", "html"), B("a", red)], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k25 para with html-ish text then colored list", blocks: [P_("<ul><li>not html</li></ul>"), B("a", red), B("b")], segs: [[0],[1,2]], groupCalls: 1, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k26 5 paras w/ inline color, then table w/ inline-colored cell (佔位符位數)", blocks: [...ner(5, i => P_([{ type: "text", text: "p" + i, styles: { textColor: "red" } }])), TBL([{ cells: ["h1", "h2"] }, { cells: [[{ type: "text", text: "ok", styles: { textColor: "green" } }], "long cell text"] }]), P_("after")], segs: [[0],[1],[2],[3],[4],[5],[6]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k27 table w/ 6 inline-colored cells (表內跨 9→10)", blocks: [TBL([{ cells: ["h1", "h2", "h3"] }, ...ner(2, r => ({ cells: ner(3, c => [{ type: "text", text: `c${r}${c}`, styles: { textColor: "red" } }]) }))]), P_("after")], segs: [[0],[1]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
  { group: "spike", name: "k28 colored-inline para x5 then numbered/bullet (無表格對照)", blocks: [...ner(5, i => P_([{ type: "text", text: "p" + i, styles: { textColor: "red" } }])), B([{ type: "text", text: "b", styles: { textColor: "red" } }]), N("n")], segs: [[0],[1],[2],[3],[4],[5],[6]], groupCalls: 0, groupUsedWhilePerMatched: 0 },
];
