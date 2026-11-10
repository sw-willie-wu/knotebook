import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { matchesBase } from "../../src/transfer/decide.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";
import { bodyLines, normalizeBody } from "../../src/transfer/normalize.js";
import { applyInMemory, docWith, forkOf, makeBaseInMemory, planInMemory, topOf, withEditor } from "./fixtures/transfer-sync.js";

/**
 * bulk transfer spec 2026-11-02 §25.3（spike S3 `spk-s3.mts` 的 37 案）＋溢位與重送情境（plan PR-2 T13；O1–O5、O3b）。
 * 記憶體夾具（H6）：基底 → 「人」改現況 → agent 改檔 → 規劃＋一次 mount 套用＋`Y.applyUpdate` 合併。每案斷言
 * 「寫回後整篇匯出」「留下的基底 id（以基底頂層的序號表示）」「決策標記」。§25.3「比預期好」的那 1 案（C04）照表斷言 `same`。
 * 標題寫「known-limitation」的案是照實釘住的已知限制：日後若改善，要改這些案。
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

type Ed = Parameters<Parameters<typeof withEditor>[2]>[0];
const P = (t: string, extra: object = {}) => ({ type: "paragraph", content: t, ...extra });
const E = () => ({ type: "paragraph" });
const B = (t: string, extra: object = {}) => ({ type: "bulletListItem", content: t, ...extra });
const N = (t: string, extra: object = {}) => ({ type: "numberedListItem", content: t, ...extra });
const T = (t: string) => ({ type: "toggleListItem", content: t });
const H = (t: string) => ({ type: "heading", content: t, props: { level: 2 } });
const CODE = (t: string) => ({ type: "codeBlock", props: { language: "text" }, content: t });
const red = { props: { backgroundColor: "red" } };
const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
const trimR = (s: string) => s.replace(/[ \t]+$/, "");
const linesTrim = (s: string) => bodyLines(normalizeBody(s)).map(trimR).join("\n");

interface Outcome {
  error: string | null;
  final: string | null;
  eqAgent: boolean;
  kept: number[];
  marks: string[];
  top: Array<{ id: string; text: string; type: string }>;
  baseIds: string[];
}

/** 一案：基底 blocks → 人改（可無）→ agent 改匯出的本文 → 寫回。 */
async function run(blocks: unknown[], edit: (body: string) => string, human: ((ed: Ed) => void) | null = null, opts: { maxD?: number } = {}): Promise<Outcome> {
  const doc = await docWith(rt, blocks);
  const b = await makeBaseInMemory(rt, doc);
  if (b.base.segments === null) throw new Error("base not_mergeable");
  const live = forkOf(doc);
  if (human) await withEditor(rt, live, human);
  const agent = edit(b.body);
  // 同 `syncFileInQueue` ⑦：現況與基底段表逐顆不符 → 整篇 409 `note_changed`、不規劃也不套用。
  if (!matchesBase(b.base.segments, topLevelSnapshot(live.getXmlFragment(YDOC_FRAGMENT)))) return { error: "note_changed", final: null, eqAgent: false, kept: [], marks: [], top: topOf(live), baseIds: b.ids };
  const planned = await planInMemory(rt, b, agent, forkOf(live), opts);
  if (!planned.ok) return { error: planned.code, final: null, eqAgent: false, kept: [], marks: [], top: topOf(live), baseIds: b.ids };
  const r = await applyInMemory(rt, b, agent, live, opts);
  const final = (await exportNoteForTransfer(rt, live, new Map())).body;
  const top = topOf(live);
  const after = new Set(top.map(x => x.id));
  return {
    error: null,
    final,
    eqAgent: linesTrim(final) === linesTrim(agent),
    kept: b.ids.map((id, i) => (after.has(id) ? i : -1)).filter(i => i >= 0),
    marks: r.plan.decisions.map(d => `${d.kind}:${d.mark}`),
    top,
    baseIds: b.ids,
  };
}
const NB = [N("a"), N("b"), N("c"), N("d")];
const N12 = many(12, i => N(`n${i + 1}`, i === 8 ? { children: [B("child")] } : {}));
/** 頂端插 `1. new`、其餘重編號；`reindent` 時兩位數項的子行補一格縮排（spike m1）。 */
const renum = (reindent: boolean) => (w: string) => {
  const o: string[] = ["1. new"];
  let cur = 0;
  for (const l of bodyLines(w)) {
    const m = /^(\d+)\. (.*)$/.exec(l);
    if (m) {
      cur = Number(m[1]) + 1;
      o.push(`${cur}. ${m[2]}`);
    } else o.push(reindent && cur >= 10 && /^ {3}\S/.test(l) ? ` ${l}` : l);
  }
  return o.join("\n");
};
const PS = many(6, i => P(`p${i}`));
const all = (n: number) => many(n, i => i) as number[];

describe("§25.3 numbered（9 案）", () => {
  it("C01 中間插一項並重編號 → 只有插入區、其餘 id 不變、結果＝agent 檔", async () => {
    const o = await run(NB, () => "1. a\n2. new\n3. b\n4. c\n5. d");
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 2, 3], marks: ["insert:applied"] });
  });
  it("C02 刪中間一項並重編號 → 只有刪除區、其餘 id 不變、結果＝agent 檔", async () => {
    const o = await run(NB, () => "1. a\n2. c\n3. d");
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 2, 3], marks: ["delete:applied"] });
  });
  it("C03 懶人編號全改 `1.` → 零區、結果仍 1–4", async () => {
    const o = await run(NB, w => w.replace(/^\d+\./gm, "1."));
    expect(o).toMatchObject({ kept: [0, 1, 2, 3], marks: [] });
    expect(linesTrim(o.final!)).toBe("1. a\n2. b\n3. c\n4. d");
  });
  it("C04（比預期好）12 項第 9 項有子、頂端插一項重編號、子行補縮排 → 第 9 項區判 same、id 全不變、結果＝agent 檔", async () => {
    const o = await run(N12, renum(true));
    expect(o.kept).toEqual(all(12));
    expect(o.marks).toContain("insert:applied");
    expect(o.marks.filter(m => m !== "insert:applied").every(m => m.endsWith(":same"))).toBe(true);
    expect(o.marks.some(m => m.endsWith(":same"))).toBe(true);
    expect(o.eqAgent).toBe(true);
  });
  it("C05 同上、子行不補縮排 → 只有插入區、id 全不變；結果是正規的匯出形（≠ agent 檔）", async () => {
    const o = await run(N12, renum(false));
    expect(o).toMatchObject({ kept: all(12), marks: ["insert:applied"], eqAgent: false });
  });
  it("C06 start 5 清單把 `5. a` 改 `1. a` → 零區、不寫（known-limitations ㉔）", async () => {
    const o = await run([N("a", { props: { start: 5 } }), N("b")], w => w.replace("5. a", "1. a"));
    expect(o).toMatchObject({ kept: [0, 1], marks: [] });
  });
  it("C07 numbered 項改成行首仍是數字的內容 → 只那一項改（§22 第 4 條）", async () => {
    const o = await run(NB, w => w.replace("3. c", "3. 2024 年"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 3], marks: ["rewrite:applied"] });
  });
  it("C08 numbered 項改成段落 → 那一項改；後一項之後重新從 `1.` 起號", async () => {
    const o = await run(NB, w => w.replace("3. c", "c 變段落"));
    expect(o).toMatchObject({ kept: [0, 1, 3], marks: ["rewrite:applied"] });
    expect(linesTrim(o.final!)).toBe("1. a\n2. b\n\nc 變段落\n\n1. d");
  });
  it("C09 code 裡 `2. y`→`3. y` → 算改、結果＝agent 檔", async () => {
    const o = await run([CODE("1. x\n2. y"), P("after")], w => w.replace("2. y", "3. y"));
    expect(o).toMatchObject({ eqAgent: true, kept: [1], marks: ["rewrite:applied"] });
  });
});

describe("§25.3 空行與空段落（6 案）", () => {
  it("C10 A、空段落、B：收掉多餘空行 → 空段落被刪（⑱）", async () => {
    const o = await run([P("A"), E(), P("B")], w => w.replace(/\n{3,}/g, "\n\n"));
    expect(o).toMatchObject({ kept: [0, 2], marks: ["delete:applied"] });
  });
  it("C11 A、空段落×2、B：收掉多餘空行 → 兩顆空段落都刪", async () => {
    const o = await run([P("A"), E(), E(), P("B")], w => w.replace(/\n{3,}/g, "\n\n"));
    expect(o.kept).toEqual([0, 3]);
    expect(o.top.map(x => x.text)).toEqual(["A", "B"]);
  });
  it("C12 只插空行 → 零區（空段落無法靠插空行新增，⑱）", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n\nB", "A\n\n\n\nB"));
    expect(o).toMatchObject({ kept: [0, 1], marks: [] });
  });
  it("C13 結尾空段落＋在最後加一段 → 新段在空段落之前、結果＝agent 檔", async () => {
    const o = await run([P("A"), E()], w => `${w.replace(/\n*$/, "")}\n\nnew`);
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1] });
    expect(o.top.map(x => x.text)).toEqual(["A", "new", ""]);
  });
  it("C14 開頭空段落＋在最前加一段 → 新段在開頭空段落之後（0 行段留在最前）", async () => {
    const o = await run([E(), P("A")], w => `new\n\n${w}`);
    expect(o.kept).toEqual([0, 1]);
    expect(o.top.map(x => x.text)).toEqual(["", "new", "A"]);
  });
  it("C15 CRLF＋BOM＋行尾空白 → 零區", async () => {
    const o = await run([P("A"), P("B")], w => `\ufeff${w.replace(/\n/g, "  \r\n")}`);
    expect(o).toMatchObject({ kept: [0, 1], marks: [] });
  });
});

describe("§25.3 子 block（6 案）", () => {
  it("C16 bullet 下新增子項 → 父項一區改寫、id 換新、結果＝agent 檔", async () => {
    const o = await run([B("a"), B("b")], w => w.replace("* a\n", "* a\n  * child\n"));
    expect(o).toMatchObject({ eqAgent: true, kept: [1], marks: ["rewrite:applied"] });
  });
  it("C17 把第 2 項縮到第 1 項下 → 一區改寫、結果＝agent 檔", async () => {
    const o = await run([B("a"), B("b"), B("c")], w => w.replace("* b", "  * b"));
    expect(o).toMatchObject({ eqAgent: true, kept: [2] });
  });
  it("C18 把子項拉出成頂層 → 一區改寫、結果＝agent 檔", async () => {
    const o = await run([B("a", { children: [B("x")] }), B("b")], w => w.replace("  * x", "* x"));
    expect(o).toMatchObject({ eqAgent: true, kept: [1] });
  });
  it("C19（known-limitation F31）改帶段落子的 bullet 本身 → 子段落攤平成頂層、巢狀消失", async () => {
    const o = await run([B("a", { children: [P("child")] }), P("after")], w => w.replace("* a", "* a2"));
    expect(o.kept).toEqual([1]);
    expect(o.top.map(x => `${x.type}:${x.text}`)).toEqual(["bulletListItem:a2", "paragraph:child", "paragraph:after"]);
  });
  it("C20 改有色清單其中一項 → 整串一區、id 全換、結果＝agent 檔", async () => {
    const o = await run([B("a", red), B("b"), B("c"), P("after")], w => w.replace("<p>b</p>", "<p>b2</p>"));
    expect(o).toMatchObject({ eqAgent: true, kept: [3], marks: ["rewrite:applied"] });
  });
  it("C21（known-limitation E14）toggle 改內容 → 變 bullet", async () => {
    const o = await run([T("t1"), T("t2")], w => w.replace("* t1", "* t1x"));
    expect(o.kept).toEqual([1]);
    expect(o.top[0]).toMatchObject({ type: "bulletListItem", text: "t1x" });
  });
});

describe("動過就 409（取代 §25.3 並行 9 案的合併）", () => {
  // 記憶體版只驗結構判準（`matchesBase`）；整篇匯出判準與合併時的整篇指紋在 `transfer-write-reread.test.ts`（整合）。
  it("C22 形：人改第 5 段、agent 改第 2 段 → note_changed、現況不動", async () => {
    const o = await run(PS, w => w.replace("p1", "p1-agent"), ed => ed.updateBlock(ed.document[4]!.id, { content: "p4-human" }));
    expect(o.error).toBe("note_changed");
    expect(o.top.map(x => x.text)).toEqual(["p0", "p1", "p2", "p3", "p4-human", "p5"]);
  });
  it("C23 形：人在第 2 段前插段 → note_changed", async () => {
    const o = await run(PS, w => w.replace("p1", "p1-agent"), ed => ed.insertBlocks([P("human-new")], ed.document[1]!.id, "before"));
    expect(o.error).toBe("note_changed");
  });
  it("C27 形：人也刪了 agent 刪的段 → note_changed（不再判 same）", async () => {
    const o = await run(PS, w => w.replace("p2\n\n", ""), ed => ed.removeBlocks([ed.document[2]!.id]));
    expect(o.error).toBe("note_changed");
  });
  it("C30 形：人把一段換成內容相同的新 block（id 換了）→ note_changed（匯出相同、結構不同）", async () => {
    const o = await run(PS, w => w.replace("p3", "p3-agent"), ed => {
      const d = ed.document;
      ed.insertBlocks([P("p1")], d[1]!.id, "before");
      ed.removeBlocks([d[1]!.id]);
    });
    expect(o.error).toBe("note_changed");
  });
});

describe("§25.3 其他（7 案）", () => {
  it("C31（known-limitation ⑫）重複行：刪的是第一顆", async () => {
    const o = await run([P("dup"), P("x"), P("dup")], w => w.replace("dup\n\nx\n\n", "x\n\n"));
    expect(o.kept).toEqual([1, 2]);
    expect(o.top.map(x => x.text)).toEqual(["x", "dup"]);
  });
  it("C32 全文重寫 → 一區、基底 id 全不留、結果＝agent 檔", async () => {
    const o = await run(PS, () => "totally\n\nnew");
    expect(o).toMatchObject({ kept: [], eqAgent: true, marks: ["rewrite:applied"] });
  });
  it("C33 區內含空段落：改 A 並刪空段落 → 一區、結果＝agent 檔", async () => {
    const o = await run([P("A"), E(), P("B")], w => w.replace(/A\n+B/, "A2\n\nB"));
    expect(o).toMatchObject({ kept: [2], eqAgent: true, marks: ["rewrite:applied"] });
  });
  it("C34 heading 下不空行加一行 → 插入、heading id 不變", async () => {
    const o = await run([H("H"), P("p")], w => w.replace("## H\n", "## H\nnew\n"));
    expect(o).toMatchObject({ kept: [0, 1], marks: ["insert:applied"] });
  });
  it("C35 paragraph 下不空行加一行 → 併進那一段（那段改寫）", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n", "A\nmore\n"));
    expect(o).toMatchObject({ kept: [1], marks: ["rewrite:applied"] });
  });
  // spike 當時（25.2-③）這兩案整篇 400；spec §9.3-6（gate r5 I-1）改成：只剩閉合註解的插入區不算區、改寫區當刪除區。照現行 spec 斷言。
  it("C36 新插 `<!-- todo -->` 自成一段 → 不算區（同只插空行）：零區、id 不變（§9.3-6）", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n\nB", "A\n\n<!-- todo -->\n\nB"));
    expect(o).toMatchObject({ error: null, kept: [0, 1], marks: [] });
  });
  it("C37 把段落改成只剩 HTML 註解 → 改寫區當刪除區：那段刪除（§9.3-6）", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n\nB", "<!-- A -->\n\nB"));
    expect(o).toMatchObject({ error: null, kept: [1], marks: ["delete:applied"] });
    expect(o.top.map(x => x.text)).toEqual(["B"]);
  });
});

describe("溢位與重複段（O2b、O2c、O5b；O1–O5、O3b 的「別人也改了」形已隨合併刪除）", () => {
  const PARAS = (n: number, f: (i: number) => string = i => `Para ${i}`) => many(n, i => P(f(i)));
  it("O5b（known-limitations：重複段）兩顆相鄰、檔案只留一顆 → 留第一顆；C31 是反例（中間的段還在時留的是第二顆）", async () => {
    const o = await run([P("x"), P("dup"), P("dup"), P("y")], w => w.replace("dup\n\ndup", "dup"));
    expect(o.kept).toEqual([0, 1, 3]);
    expect(o.top.map(x => x.text)).toEqual(["x", "dup", "y"]);
  });
  it("O2b（known-limitations：重複行）溢位時，三顆 `***` divider 夾在全部改掉的段之間 → 沒有唯一行可當錨點，divider 也被改寫（id 換新）", async () => {
    const blocks = [...PARAS(12, i => `A${i}`), { type: "divider" }, { type: "divider" }, { type: "divider" }, ...PARAS(12, i => `B${i}`)];
    const o = await run(blocks, w => w.replace(/\n+$/, "").split("\n\n").map(p => (p === "***" ? p : `${p}x`)).join("\n\n"), null, { maxD: 10 });
    expect(o.kept.filter(i => i >= 12 && i <= 14)).toEqual([]);
    expect(o.top.filter(x => x.type === "divider")).toHaveLength(3);
  });
  it("O2c（M-1 對照）同樣三顆重複段，但周圍有沒改的唯一行 → 配得到、id 不變（只有周圍整段也都改了才可能配不到）", async () => {
    const blocks = [...PARAS(12, i => `A${i}`), P("anchor-before"), P("dup"), P("dup"), P("dup"), P("anchor-after"), ...PARAS(12, i => `B${i}`)];
    const o = await run(blocks, w => w.replace(/\n+$/, "").split("\n\n").map(p => (/^[AB]\d/.test(p) ? `${p}x` : p)).join("\n\n"), null, { maxD: 10 });
    expect(o.kept).toEqual([12, 13, 14, 15, 16]);
  });
});

void Y;
