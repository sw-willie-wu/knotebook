import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { BOUNDARY_ADJ_MAX_CHARS, fenceParseStats, stripClosedComments, trailingOpenFenceLine, type Region } from "../../src/transfer/regions.js";
import { TRANSFER_SHAPES } from "./fixtures/transfer-shapes.js";
import { docWith, makeBaseInMemory, realBoundaryCheck, regionsOf, type InMemoryBase } from "./fixtures/transfer-sync.js";
import { expectLinear } from "../perf-helpers.js";

/** bulk transfer spec §9.3-2～-8、§18.1「區偵測」；plan PR-2 §0.1-2、-3、T4（R1–R10）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const check = realBoundaryCheck(rt);

const P = (t: string) => ({ type: "paragraph", content: t });
const EMPTY = { type: "paragraph" };
const BL = (t: string, extra: Record<string, unknown> = {}) => ({ type: "bulletListItem", content: t, ...extra });
const NL = (t: string, props: Record<string, unknown> = {}) => ({ type: "numberedListItem", content: t, props });
const base = async (blocks: unknown[]) => makeBaseInMemory(rt, await docWith(rt, blocks));
const exportOf = async (block: unknown) => normalizeBody((await base([block])).body);
/** E6：#386 之前下載的檔——一段文字 ``` 的那一行沒跳脫（基底照那份檔算）。 */
const legacyFenceBase = async () => makeBaseInMemory(rt, await docWith(rt, [P("A"), P("```"), P("B")]), new Map(), "T", l => (l === "\\`\\`\\`" ? "```" : l));
/** 區的摘要：kind、基底 id 在文件中的索引、文字。 */
const summary = (b: InMemoryBase, regions: Region[]) => regions.map(r => ({ kind: r.kind, idx: r.baseIds.map(id => b.ids.indexOf(id)), text: r.text }));
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe("R1 §9.3-3 邊界表（真 parser；true＝不併）", () => {
  const TEXT = "文字";
  const blocks: Record<string, unknown> = {
    paragraph: P("Para"),
    quote: { type: "quote", content: "q" },
    // spec 表的 image 是 markdown 形（沒有說明、沒有寬度 → `![](…)`）；有說明或寬度的匯出成 `<figure>` HTML，另列兩案（實測不併）
    image: { type: "image", props: { url: "/api/uploads/u1" } },
    figure: { type: "image", props: { url: "/api/uploads/u1", caption: "cap" } },
    heading: { type: "heading", content: "H", props: { level: 2 } },
    code: { type: "codeBlock", props: { language: "js" }, content: "x = 1" },
    mermaid: { type: "mermaid", props: { code: "graph TD; a-->b" } },
    table: { type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }, { cells: ["1", "2"] }] } },
    divider: { type: "divider" },
    columns: { type: "columnList", children: [{ type: "column", props: { width: 1 }, children: [P("c1")] }, { type: "column", props: { width: 1 }, children: [P("c2")] }] },
    bullet: BL("item"),
  };
  const rows: Array<[string, string, string, "before" | "after", boolean]> = [
    ["paragraph＋文字 → 併", "paragraph", TEXT, "after", false],
    ["quote＋文字 → 併（lazy）", "quote", TEXT, "after", false],
    ["image＋文字 → 併", "image", TEXT, "after", false],
    ["heading＋文字 → 不併", "heading", TEXT, "after", true],
    ["code＋文字 → 不併", "code", TEXT, "after", true],
    ["mermaid＋文字 → 不併", "mermaid", TEXT, "after", true],
    ["table＋文字 → 不併", "table", TEXT, "after", true],
    ["table＋新列 → 併", "table", "| 3 | 4 |", "after", false],
    ["divider＋文字 → 不併", "divider", TEXT, "after", true],
    ["columns＋文字 → 不併", "columns", TEXT, "after", true],
    ["清單項＋非縮排文字 → 不併", "bullet", TEXT, "after", true],
    ["清單項＋縮排文字 → 併（子 block）", "bullet", "  more", "after", false],
    ["段落＋任何編號的清單行（A\\n2. x）→ 不併", "paragraph", "2. x", "after", true],
    ["文字＋paragraph → 併", "paragraph", TEXT, "before", false],
    ["文字＋> q → 不併", "quote", TEXT, "before", true],
    ["文字＋image → 併", "image", TEXT, "before", false],
    ["文字＋# H → 不併", "heading", TEXT, "before", true],
    ["文字＋fence → 不併", "code", TEXT, "before", true],
    ["文字＋mermaid fence → 不併", "mermaid", TEXT, "before", true],
    ["文字＋table → 不併", "table", TEXT, "before", true],
    ["文字＋divider（***）→ 不併", "divider", TEXT, "before", true],
    ["文字＋columns → 不併", "columns", TEXT, "before", true],
    ["文字＋清單項 → 不併", "bullet", TEXT, "before", true],
    ["（表外）`<figure>` 形 image＋文字 → 不併（實測）", "figure", TEXT, "after", true],
    ["（表外）文字＋`<figure>` 形 image → 不併（實測）", "figure", TEXT, "before", true],
  ];
  it.each(rows)("%s", async (_n, kind, adj, side, want) => {
    const k = await exportOf(blocks[kind]);
    expect(await check(k, adj, side)).toBe(want);
  });
  it("numbered：改了的 `1. a2`＋沒改的 `2. b` → 不併；`1. new`＋沒改的 `2. b` → 不併（忽略 start）", async () => {
    expect(await check("2. b", "1. a2", "before")).toBe(true);
    expect(await check("2. b", "1. new", "before")).toBe(true);
    expect(await check("1. a", "2. b2", "after")).toBe(true);
  });
  it("parse 失敗 → false（未閉合 `<!--` 吞掉 k）", async () => {
    expect(await check("B", "<!--", "before")).toBe(false);
  });
});

describe("R2 觸發三形與不觸發", () => {
  it("貼著插入：A 後面不空行加一行 → A 併入、驗 1 次", async () => {
    const b = await base([P("A"), P("B")]);
    const r = ok(await regionsOf(rt, b, "A\nX\n\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0], text: "A\nX" }]);
    expect(r.boundaryChecks).toBe(1);
  });
  it("刪掉兩段之間的分隔行 → 兩段各驗一次、都併", async () => {
    const b = await base([P("A"), P("B")]);
    const r = ok(await regionsOf(rt, b, "A\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0, 1], text: "A\nB" }]);
    expect(r.boundaryChecks).toBe(2);
  });
  it("刪 0 行分隔清單的中間一項 → 前後項各驗一次、都不併、一個刪除區", async () => {
    const b = await base([BL("a"), BL("b"), BL("c")]);
    const r = ok(await regionsOf(rt, b, "* a\n* c"));
    expect(summary(b, r.regions)).toEqual([{ kind: "delete", idx: [1], text: "" }]);
    expect(r.boundaryChecks).toBe(2);
  });
  it("清單只改最後一項 → 只驗 1 次（緊鄰行就是基底緊鄰行的配對 → 不驗）", async () => {
    const b = await base([BL("a"), BL("b"), BL("c")]);
    const r = ok(await regionsOf(rt, b, "* a\n* b\n* c2"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [2], text: "* c2" }]);
    expect(r.boundaryChecks).toBe(1);
  });
  it("緊鄰是空行 → 不觸發", async () => {
    const b = await base([P("A"), P("B")]);
    const r = ok(await regionsOf(rt, b, "A\n\nX\n\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "insert", idx: [], text: "X" }]);
    expect(r.boundaryChecks).toBe(0);
  });
});

describe("R3 不迭代", () => {
  it("三段 paragraph，只在第一段後貼一行 → 只有第一段併入", async () => {
    const b = await base([P("a"), P("b"), P("c")]);
    const r = ok(await regionsOf(rt, b, "a\nX\n\nb\n\nc"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0], text: "a\nX" }]);
    expect(r.boundaryChecks).toBe(1);
  });
});

describe("R3b 觸發條件按文字定義、只跑一輪（審查 m3 釘住現行行為）", () => {
  it("0 行分隔清單：a 後面貼一行縮排文字 → a 併入；b 也被觸發（緊鄰行不是基底緊鄰行的配對），但獨立判、不因 a 併入而連鎖", async () => {
    const b = await base([BL("a"), BL("b"), BL("c")]);
    const r = ok(await regionsOf(rt, b, "* a\n  more\n* b\n* c"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0], text: "* a\n  more" }]);
    expect(r.boundaryChecks).toBe(2); // a 的下緣、b 的上緣；c 的上緣是基底緊鄰行（* b）的配對 → 不觸發
  });
});

describe("未閉合的 code fence（總管裁示，審查 m3）", () => {
  it("0 行分隔清單上方加一行未閉合 ``` → 整篇 unclosed_fence（不只把貼著的那一項併進區）", async () => {
    const b = await base([P("Z"), BL("a"), BL("b"), BL("c")]);
    expect(b.lines).toEqual(["Z", "", "* a", "* b", "* c"]);
    expect(await regionsOf(rt, b, "Z\n\n```\n* a\n* b\n* c")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("閉合的 fence、較長的收尾、~~~ 照常；``` 開、~~~ 收不算閉合；註解裡的 ``` 不算", async () => {
    const b = await base([P("A"), P("B")]);
    expect((await regionsOf(rt, b, "A\n\n```\ncode\n```\n\nB")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n```\ncode\n`````\n\nB")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n~~~\ncode\n~~~\n\nB")).ok).toBe(true);
    expect(await regionsOf(rt, b, "A\n\n```\ncode\n~~~\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
    expect((await regionsOf(rt, b, "A\n\n<!-- ``` -->\n\nB")).ok).toBe(true);
  });
  // #386 起匯出器跳脫文字裡的反引號（一段文字 ``` 讀出 \`\`\`，不再是 fence）；E6 留給這之前下載的檔：基底那一行是沒跳脫的 ```。
  it("#386 之後：一段文字就是 ``` → 讀出跳脫成 \\`\\`\\`，不是未閉合的 fence", async () => {
    const b = await base([P("A"), P("```"), P("B")]);
    expect(b.lines).toEqual(["A", "", "\\`\\`\\`", "", "B"]);
    expect(trailingOpenFenceLine(b.lines)).toBeNull();
  });
  it("E6：基底有一段文字就是 ```（#386 之前的匯出器不跳脫）→ 原檔重送 ok（零區）、只改 B ok（開頭那一行落在沒改的段裡）", async () => {
    const b = await legacyFenceBase();
    expect(b.lines).toEqual(["A", "", "```", "", "B"]);
    expect(trailingOpenFenceLine(b.lines)).toBe(2); // 前提：parser 確實把它當成延伸到檔尾的 code
    expect(ok(await regionsOf(rt, b, normalizeBody(b.body))).regions).toEqual([]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n```\n\nB2")).regions)).toEqual([{ kind: "rewrite", idx: [2], text: "B2" }]);
  });
  // 預篩之後，上一案（E6）根本不會 parse；這案讓「改過的行像 fence」通過預篩、但未閉合的開頭仍在沒改的段裡（~~~x 在 ``` 的 code 裡
  // 不收尾）→ 走到「開頭那一行在不在沒改的段」那一條判斷（MF1 的守衛）。
  it("E6＋改過的行像 fence 但不改變未閉合狀態（B → ~~~x）→ 有 parse、放行（開頭仍在沒改的段）", async () => {
    const b = await legacyFenceBase();
    fenceParseStats.calls = 0;
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n```\n\n~~~x")).regions)).toEqual([{ kind: "rewrite", idx: [2], text: "~~~x" }]);
    expect(fenceParseStats.calls).toBe(1);
  });
  it("F4 E6 變形：A\\n\\n```\\nX\\n\\nB（在 ``` 那段下面不空行接 X → 那段併入區）→ unclosed_fence", async () => {
    const b = await legacyFenceBase();
    expect(await regionsOf(rt, b, "A\n\n```\nX\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("F3 精確預篩：一般寫回（改過的行沒有像 fence 的）不呼叫 parser；E6 原檔重送（``` 在沒改的段裡）也不呼叫；改過的行含 ``` 才呼叫", async () => {
    const b = await base([P("A"), P("B")]);
    fenceParseStats.calls = 0;
    expect(ok(await regionsOf(rt, b, "A\n\nB2")).regions).toHaveLength(1);
    expect(fenceParseStats.calls).toBe(0);
    const e6 = await legacyFenceBase();
    expect(ok(await regionsOf(rt, e6, "A\n\n```\n\nB2")).regions).toHaveLength(1);
    expect(fenceParseStats.calls).toBe(0);
    expect(ok(await regionsOf(rt, b, "A\n\n```js\nx\n```\n\nB")).regions).toHaveLength(1);
    expect(fenceParseStats.calls).toBe(1);
  });
  it("agent 新增一行未閉合 ``` → 拒", async () => {
    const b = await base([P("A"), P("B")]);
    expect(await regionsOf(rt, b, "A\n\n```\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("清單項目內、<div> 內的合法 fence → 放行（以 parser 為準，不吞到檔尾）", async () => {
    const b = await base([P("A")]);
    expect((await regionsOf(rt, b, "A\n\n- ```js\n  code\n  ```")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n1. ```\n   x\n   ```")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n- [ ] ```\n  x\n  ```")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n<div>\n```\nx\n</div>")).ok).toBe(true);
  });
  it("```x```、``` a`b 這類由 parser 吞到檔尾的形，agent 新增的 → 拒", async () => {
    const b = await base([P("A"), P("B")]);
    expect(await regionsOf(rt, b, "A\n\n```x```\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
    expect(await regionsOf(rt, b, "A\n\n``` a`b\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("`<!--\\n```\\n-->`（fence 在註解裡）→ 放行", async () => {
    const b = await base([P("A"), P("B")]);
    expect((await regionsOf(rt, b, "A\n\n<!--\n```\n-->\n\nB")).ok).toBe(true);
  });
});

describe("R4 取 parse(k) 的顆數（不是 id 數）", () => {
  it("攤平子 block 的 1 id 段（bullet 帶段落子）＋文字貼在前面 → 不併", async () => {
    const b = await base([P("Z"), BL("a", { children: [P("child")] }), P("Y")]);
    const seg = b.base.segments![1]!;
    expect(seg.ids).toHaveLength(1); // 前提：1 id 段、逐顆匯出 3 行（parse 成 2 顆）
    expect(seg.count).toBe(3);
    const r = ok(await regionsOf(rt, b, "Z\n\nX\n* a\n\nchild\n\nY"));
    expect(summary(b, r.regions)).toEqual([{ kind: "insert", idx: [], text: "X" }]);
    expect(r.boundaryChecks).toBe(1);
  });
});

describe("R5 空段落段不驗邊界", () => {
  it("A、空段落、B：空段落旁不空行插 X → 一個插入區、不驗、不 400", async () => {
    const b = await base([P("A"), EMPTY, P("B")]);
    expect(b.lines).toEqual(["A", "", "", "", "B"]); // 前提：中間的空段落吃一個空行
    const r = ok(await regionsOf(rt, b, "A\n\nX\n\n\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "insert", idx: [], text: "X" }]);
    expect(r.boundaryChecks).toBe(0);
  });
  it("空 heading、空 check 不是空行（§0.1-3 的反例證明）", async () => {
    expect(await exportOf({ type: "heading", content: "", props: { level: 1 } })).not.toBe("");
    expect(await exportOf({ type: "checkListItem", content: "", props: { checked: false } })).not.toBe("");
  });
});

describe("R6 HTML 註解", () => {
  it("隔空行插 `<!-- TODO -->` → 零區", async () => {
    const b = await base([P("A"), P("B")]);
    expect(ok(await regionsOf(rt, b, "A\n\n<!-- TODO -->\n\nB")).regions).toEqual([]);
  });
  it("把一段改成 `<!-- B -->` → 一個刪除區", async () => {
    const b = await base([P("A"), P("B")]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n<!-- B -->")).regions)).toEqual([{ kind: "delete", idx: [1], text: "" }]);
  });
  it("整份只剩註解 → empty_content；整份空白 → empty_content", async () => {
    const b = await base([P("A")]);
    expect(await regionsOf(rt, b, "<!-- x -->\n\n<!-- y -->")).toMatchObject({ ok: false, code: "empty_content" });
    expect(await regionsOf(rt, b, "  \n\n")).toMatchObject({ ok: false, code: "empty_content" });
  });
  it("行內 `a <!-- c --> b` → 改寫區（文字原樣，交給 parse）", async () => {
    const b = await base([P("A"), P("B")]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\nB <!-- c --> b")).regions)).toEqual([{ kind: "rewrite", idx: [1], text: "B <!-- c --> b" }]);
  });
  it("未閉合 `<!--` 貼在沒改的段上方 → 那段併入（交給 T6 判 400）", async () => {
    const b = await base([P("A"), P("B")]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n<!--\nB")).regions)).toEqual([{ kind: "rewrite", idx: [1], text: "<!--\nB" }]);
  });
  it("stripClosedComments", () => {
    expect(stripClosedComments("a<!--x-->b<!--y")).toBe("ab<!--y");
    expect(stripClosedComments("<!-- a\nb -->c")).toBe("c");
  });
});

describe("R7 三種區與文字", () => {
  const B3 = [P("a"), P("b"), P("c")];
  it.each([
    ["改一段", "a\n\nB\n\nc", [{ kind: "rewrite", idx: [1], text: "B" }]],
    ["相鄰兩段", "A\n\nB\n\nc", [{ kind: "rewrite", idx: [0, 1], text: "A\n\nB" }]],
    ["段間插入", "a\n\nb\n\nX\n\nc", [{ kind: "insert", idx: [], text: "X" }]],
    ["刪段", "a\n\nc", [{ kind: "delete", idx: [1], text: "" }]],
    ["全文重寫（一區）", "x\n\ny", [{ kind: "rewrite", idx: [0, 1, 2], text: "x\n\ny" }]],
    ["只插空行（零區）", "a\n\n\n\nb\n\n\nc", []],
  ])("%s", async (_n, agentBody, want) => {
    const b = await base(B3);
    expect(summary(b, ok(await regionsOf(rt, b, agentBody as string)).regions)).toEqual(want);
  });
  it("R7-正例 a、b、a 刪第一個 a → 剝共同後綴、被移除的是 A1（id 正確）", async () => {
    const b = await base([P("a"), P("b"), P("a")]);
    expect(b.lines).toEqual(["a", "", "b", "", "a"]);
    expect(summary(b, ok(await regionsOf(rt, b, "b\n\na")).regions)).toEqual([{ kind: "delete", idx: [0], text: "" }]);
  });
  it("R7-歧義形（⑫）a、x、a 只留 a → 剝前綴：留下 A1、移除 X 與 A2（agent 若意在刪第一個 a：內容相同、id 不同）", async () => {
    const b = await base([P("a"), P("x"), P("a")]);
    expect(summary(b, ok(await regionsOf(rt, b, "a")).regions)).toEqual([{ kind: "delete", idx: [1, 2], text: "" }]);
  });
});

describe("R8 numbered", () => {
  it("中間插一項並重編號 → 只有一個插入區", async () => {
    const b = await base([NL("a"), NL("b"), NL("c")]);
    expect(b.lines).toEqual(["1. a", "2. b", "3. c"]);
    expect(summary(b, ok(await regionsOf(rt, b, "1. a\n2. new\n3. b\n4. c")).regions)).toEqual([{ kind: "insert", idx: [], text: "2. new" }]);
  });
  it("code block 裡 `1.` → `2.` 算改", async () => {
    const b = await base([{ type: "codeBlock", props: { language: "" }, content: "1. x" }]);
    const body = normalizeBody(b.body);
    expect(ok(await regionsOf(rt, b, body.replace("1. x", "2. x"))).regions.map(r => r.kind)).toEqual(["rewrite"]);
  });
  it("改起號兩個方向 → 零區（㉔）", async () => {
    const b5 = await base([NL("a", { start: 5 }), NL("b")]);
    expect(b5.lines).toEqual(["5. a", "6. b"]);
    expect(ok(await regionsOf(rt, b5, "1. a\n2. b")).regions).toEqual([]);
    const b1 = await base([NL("a"), NL("b")]);
    expect(ok(await regionsOf(rt, b1, "5. a\n6. b")).regions).toEqual([]);
  });
});

describe("R9 溢位（gate r1 I6）", () => {
  const blocks = [P("X0"), P("S"), P("S"), P("X1"), ...Array.from({ length: 6 }, (_, i) => P(`U${i}`))];
  const agentBody = ["Y0", "S", "S", "Y1", ...Array.from({ length: 6 }, (_, i) => `U${i}`)].join("\n\n");
  it("沒溢位：只有改了的段成區（兩區）", async () => {
    const b = await base(blocks);
    const r = ok(await regionsOf(rt, b, agentBody));
    expect(r.diff.overflow).toBe(false);
    expect(summary(b, r.regions)).toEqual([
      { kind: "rewrite", idx: [0], text: "Y0" },
      { kind: "rewrite", idx: [3], text: "Y1" },
    ]);
  });
  it("溢位且有退化子區段：只有退化子區段裡的段併成改寫區（含沒改、由重複行組成的 S、S）", async () => {
    const b = await base(blocks);
    const r = ok(await regionsOf(rt, b, agentBody, { maxD: 2 }));
    expect(r.diff.overflow).toBe(true);
    expect(r.diff.degradedLines).toBe(7);
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0, 1, 2, 3], text: "Y0\n\nS\n\nS\n\nY1" }]);
  });
  it("溢位但有錨點：被錨定的段照常判沒改", async () => {
    const many = Array.from({ length: 30 }, (_, i) => P(`L${i}`));
    const b = await base(many);
    const body = Array.from({ length: 30 }, (_, i) => (i === 3 || i === 20 ? `L${i} changed` : `L${i}`)).join("\n\n");
    const r = ok(await regionsOf(rt, b, body, { maxD: 2 }));
    expect(r.diff.overflow).toBe(true);
    expect(r.diff.anchored).toBeGreaterThan(0);
    expect(summary(b, r.regions)).toEqual([
      { kind: "rewrite", idx: [3], text: "L3 changed" },
      { kind: "rewrite", idx: [20], text: "L20 changed" },
    ]);
  });
});

describe("R10 只匯出空行的型別（gate r1 m22）", () => {
  it("129 形：逐段匯出為 [] 或全是空行的段，block 型別全是 paragraph", async () => {
    let seen = 0;
    for (const shape of TRANSFER_SHAPES) {
      const b = await base(shape.blocks);
      for (const s of b.base.segments ?? []) {
        const lines = b.lines.slice(s.start, s.start + s.count);
        if (!lines.every(l => l.trimEnd() === "")) continue;
        seen++;
        for (const id of s.ids) expect(b.types[b.ids.indexOf(id)], `${shape.name}`).toBe("paragraph");
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 120_000);
});

describe("#398 審查 C2／I1：邊界檢查的上限、註解剝除線性", () => {
  it("相接那串超過 4 096 字（BOUNDARY_ADJ_MAX_CHARS）→ 不解析、那段當改過；剛好 4 096 字 → 照常解析", async () => {
    expect(BOUNDARY_ADJ_MAX_CHARS).toBe(4 * 1024);
    const b = await base([P("A"), P("B")]);
    const calls: string[] = [];
    const spy = async (k: string, adj: string, side: "before" | "after") => {
      calls.push(adj);
      return check(k, adj, side);
    };
    const long = "y".repeat(4 * 1024 + 1);
    const r1 = ok(await regionsOf(rt, b, `A\n\n${long}\nB`, { check: spy }));
    expect(calls).toHaveLength(0);
    expect(summary(b, r1.regions)).toEqual([{ kind: "rewrite", idx: [1], text: `${long}\nB` }]);
    const fit = "y".repeat(4 * 1024);
    await regionsOf(rt, b, `A\n\n${fit}\nB`, { check: spy });
    expect(calls).toEqual([fit]);
  });
  it("stripClosedComments 與原本的 regex 結果相同（含沒收尾、重疊、相鄰），且 `<!--`×6.5 萬是線性的", async () => {
    const ref = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
    for (const s of ["", "a", "<!---->", "<!-->x-->y", "a<!--b-->c<!--d", "<!--<!--x-->-->", "x<!--a-->-->y<!--", "<!--a--><!--b-->c", "<!-- a --\n> b -->c"]) {
      expect(stripClosedComments(s), JSON.stringify(s)).toBe(ref(s));
    }
    await expectLinear("stripClosedComments", n => {
      const t = performance.now();
      expect(stripClosedComments("<!--".repeat(n))).toBe("<!--".repeat(n));
      return performance.now() - t;
    }, 64_000);
  });
});
