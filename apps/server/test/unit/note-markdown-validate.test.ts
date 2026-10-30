// 並排 PR-2（spec 2026-10-21 columns-layout §11.3）：寫入的語法檢查 S1–S10（`checkNoteMarkdownSyntax`，在
// `markdownToHTML` 的 DOM 上做）與結構檢查（`findStructureError`，在 blocks 上做）。需要 DOM：沿用 `rt.installGlobals()`。
import { readFileSync } from "node:fs";
import { markdownToHTML } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLUMNS_OPEN_TAG, checkNoteMarkdownSyntax, findStructureError, syntaxCheckRoot } from "@knotebook/shared";
import type { MarkdownPlacement } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();

const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; roundTrip: string; markdown: string }> };
const ROW2 = goldens.cases.find(c => c.id === "G1-cols-spec")!.markdown;
const OUTER_LINE = COLUMNS_OPEN_TAG;
const FIRST_COL_LINE = '<div data-kb-column style="flex:1">';

const chk = (md: string, placement: MarkdownPlacement = "top") => checkNoteMarkdownSyntax(md, placement);
const col = (w: string, body: string) => (body === "" ? `<div data-kb-column style="flex:${w}">\n\n</div>` : `<div data-kb-column style="flex:${w}">\n\n${body}\n\n</div>`);
const row = (...cols: string[]) => [OUTER_LINE, ...cols, "</div>"].join("\n") + "\n";
/** 把 ROW2 的某一行逐字換掉（斷言原行恰出現一次）。 */
const swapLine = (from: string, to: string): string => {
  const lines = ROW2.split("\n");
  expect(lines.filter(l => l === from)).toHaveLength(1);
  return lines.map(l => (l === from ? to : l)).join("\n");
};
const COLS = { ok: false, error: "unsupported_columns" } as const;
const SIZE = { ok: false, error: "unsupported_size" } as const;
const tableMd = (row1: string, row2: string) => `<table><tr>${row1}</tr><tr>${row2}</tr></table>\n`;

describe("接受", () => {
  it("V-OK1：Task 2 讀出的列 → ok，html 是未標記原文的 markdownToHTML", () => {
    expect(ROW2.startsWith(`${OUTER_LINE}\n${FIRST_COL_LINE}\n`)).toBe(true);
    expect(chk(ROW2)).toEqual({ ok: true, html: markdownToHTML(ROW2) });
  });

  it("V-OK2：3 欄、4 欄（寬 0.1／10／2.25）", () => {
    expect(chk(row(col("0.75", "a"), col("1", "b"), col("1.25", "c"))).ok).toBe(true);
    expect(chk(row(col("0.1", "a"), col("10", "b"), col("2.25", "c"), col("1", "d"))).ok).toBe(true);
  });

  it("V-OK3：空欄", () => {
    expect(chk(row(col("1", "a"), col("1", ""))).ok).toBe(true);
  });

  it("V-OK4：欄內最後一段後面直接接 </div>（少結尾空行）", () => {
    const md = ROW2.replace("型號：x\n\n</div>", "型號：x\n</div>");
    expect(md).not.toBe(ROW2);
    expect(chk(md).ok).toBe(true);
  });

  it("V-OK5：CRLF 換行（Review Focus 1）", () => {
    const md = ROW2.replace(/\n/g, "\r\n");
    expect(md).toContain(`${OUTER_LINE}\r\n`);
    expect(chk(md).ok).toBe(true);
  });

  it("V-OK6：程式碼區塊與行內 code 裡的非正規標記不算", () => {
    const md = [
      "```html",
      "<div data-kb-columns>",
      '<div style="display:flex">',
      '<img src="/x" width="7">',
      '<p data-node-type="x">',
      "```",
      "",
      "行內 `<div data-kb-column>` 也是",
      "",
    ].join("\n");
    expect(chk(md).ok).toBe(true);
  });

  it.each([
    '<figure><img alt="a" src="/x" width="300"></figure>',
    '<figure><img src="/x" width="32"><figcaption>c</figcaption></figure>',
    '<figure data-background-color="red"><img src="/x" width="4000"></figure>',
  ])("V-OK7：%s", md => {
    expect(chk(`${md}\n`).ok).toBe(true);
  });

  it("V-OK7b：屬性值含 \"、&、< 的圖片（G2-img-escape 的讀出；屬性值內 < 跳脫與否兩種序列化都收）", () => {
    const md = goldens.cases.find(c => c.id === "G2-img-escape")!.markdown;
    expect(md).toContain("<c>");
    expect(chk(md).ok).toBe(true);
    expect(chk(md.replace("<c>", "&lt;c&gt;")).ok).toBe(true);
  });

  it.each([
    tableMd('<th colwidth="120">a</th><th>b</th>', "<td>c</td><td>d</td>"),
    tableMd('<th colspan="2" colwidth="120,200">a</th>', "<td>c</td><td>d</td>"),
    tableMd('<th colspan="2" colwidth="120,">a</th>', "<td>c</td><td>d</td>"),
    tableMd('<th colspan="2" colwidth=",">a</th>', "<td>c</td><td>d</td>"),
    tableMd("<th>a</th><th>b</th>", '<td colspan="2" colwidth=",">c</td>'),
  ])("V-OK8：%s", md => {
    expect(chk(md).ok).toBe(true);
  });

  it("V-OK9：display:block 的 div", () => {
    expect(chk('<div style="display:block">x</div>\n').ok).toBe(true);
  });

  it.each(goldens.cases.filter(c => c.roundTrip !== "skip").map(c => [c.id, c] as const))("V-GOLD：讀出 golden %s 原樣過語法檢查（reject 案照標的碼）", (_id, c) => {
    if (c.roundTrip.startsWith("reject:")) expect(chk(c.markdown)).toEqual({ ok: false, error: c.roundTrip.slice("reject:".length) });
    else expect(chk(c.markdown)).toMatchObject({ ok: true });
  });
});

describe("拒絕：S1 並排標記須獨佔一行且逐字正規", () => {
  it.each<[string, string]>([
    ["S1a 外層屬性順序對調", swapLine(OUTER_LINE, '<div style="display:flex;gap:16px" data-kb-columns>')],
    ["S1b 單引號", swapLine(OUTER_LINE, "<div data-kb-columns style='display:flex;gap:16px'>")],
    ["S1c 多一個 class", swapLine(OUTER_LINE, '<div data-kb-columns class="x" style="display:flex;gap:16px">')],
    ["S1d 大寫", swapLine(OUTER_LINE, '<DIV DATA-KB-COLUMNS STYLE="display:flex;gap:16px">')],
    ["S1e gap:8px", swapLine(OUTER_LINE, '<div data-kb-columns style="display:flex;gap:8px">')],
    ["S1f 欄寬 flex:10.5", swapLine(FIRST_COL_LINE, '<div data-kb-column style="flex:10.5">')],
    ["S1g 外層行前一個空白", swapLine(OUTER_LINE, ` ${OUTER_LINE}`)],
    ["S1h 外層標籤後同一行接 x", swapLine(OUTER_LINE, `${OUTER_LINE}x`)],
    ["S1i 外層與第一欄開標籤同一行", ROW2.replace(`${OUTER_LINE}\n${FIRST_COL_LINE}\n`, `${OUTER_LINE}${FIRST_COL_LINE}\n`)],
    ["S1j span 帶 data-kb-column", "a <span data-kb-column>b</span> c\n"],
    ["S1k 偽造標記", swapLine(OUTER_LINE, '<div data-kb-columns data-kb-line style="display:flex;gap:16px">')],
    ["S1k 偽造標記（大寫）", swapLine(OUTER_LINE, '<div data-kb-columns DATA-KB-LINE style="display:flex;gap:16px">')],
    // 前一行沒關上的開標籤與正規行併成同一個標籤（標記被「借用」）
    ["S1l 前一行 <div class=\"x\" 併進外層行", swapLine(OUTER_LINE, `<div class="x" data-x\n${OUTER_LINE}`)],
    ["S1l 前一行 <div style=\"display:grid\" 併進外層行", swapLine(OUTER_LINE, `<div style="display:grid"\n${OUTER_LINE}`)],
    ["S1l 前一行 <div data-nesting-level=\"1\" 併進外層行", swapLine(OUTER_LINE, `<div data-nesting-level="1"\n${OUTER_LINE}`)],
    ["S1m 前一行 <div style=\"flex:5.555\" 併進欄行", swapLine(FIRST_COL_LINE, `<div style="flex:5.555"\n${FIRST_COL_LINE}`)],
    ["S1m 前一行 <div data-content-type=\"paragraph\" 併進欄行", swapLine(FIRST_COL_LINE, `<div data-content-type="paragraph"\n${FIRST_COL_LINE}`)],
    // 前一行的無引號屬性值把正規行開頭的 `<div` 吞掉（屬性清單仍是三項）
    ["S1n 前一行 <div data-kb-columns= 併進外層行", swapLine(OUTER_LINE, `<div data-kb-columns=\n${OUTER_LINE}`)],
    ["S1o 前一行 <div data-kb-column= 併進欄行", swapLine(FIRST_COL_LINE, `<div data-kb-column=\n${FIRST_COL_LINE}`)],
    ["S1p 前一行 <section data-kb-columns= 併進外層行", swapLine(OUTER_LINE, `<section data-kb-columns=\n${OUTER_LINE}`)],
  ])("%s → unsupported_columns", (_name, md) => {
    expect(md).not.toBe(ROW2);
    expect(chk(md)).toEqual(COLS);
  });
});

describe("拒絕：S2–S7", () => {
  it.each<[string, string]>([
    ["S2 欄開標籤下一行直接接 ## H", row(`<div data-kb-column style="flex:1">\n## H\n\n</div>`, col("1", "b"))],
    ["S3a 只有欄行、沒有外層", `${col("1", "a")}\n${col("1", "b")}\n`],
    ["S3b 兩欄之間多一段 stray", [OUTER_LINE, col("1", "a"), "", "stray", "", col("1", "b"), "</div>"].join("\n") + "\n"],
    ["S3c 外層行與欄行之間一行 &nbsp;（NBSP 不是空白）", swapLine(OUTER_LINE, `${OUTER_LINE}\n&nbsp;`)],
    ["S4a 一欄", row(col("1", "a"))],
    ["S4b 五欄", row(col("1", "a"), col("1", "b"), col("1", "c"), col("1", "d"), col("1", "e"))],
    ["S5 第 2 欄內再放一列", row(col("1", "a"), col("1", ROW2.trimEnd()))],
    ["S6a 引言包住列", ROW2.trimEnd().split("\n").map(l => (l === "" ? ">" : `> ${l}`)).join("\n") + "\n"],
    ["S6b <details> 包住列", `<details>\n<summary>s</summary>\n\n${ROW2}\n</details>\n`],
    ["S7a display:flex 的 div", '<div style="display:flex">\n\nx\n\n</div>\n'],
    ["S7b DISPLAY: Grid", '<div style="DISPLAY: Grid">\n\nx\n\n</div>\n'],
  ])("%s → unsupported_columns", (_name, md) => {
    expect(chk(md)).toEqual(COLS);
  });
});

describe("拒絕：S8 圖片寬度", () => {
  it.each<[string, string]>([
    ["S8a 段落裡裸 img", 'x <img src="/x" width="300"> y\n'],
    ["S8b width=300.5", '<figure><img src="/x" width="300.5"></figure>\n'],
    ["S8b width=31", '<figure><img src="/x" width="31"></figure>\n'],
    ["S8b width=4001", '<figure><img src="/x" width="4001"></figure>\n'],
    ["S8b width=0300", '<figure><img src="/x" width="0300"></figure>\n'],
    ['S8b width=""', '<figure><img src="/x" width=""></figure>\n'],
    ["S8c src 在 alt 前", '<figure><img src="/x" alt="a" width="300"></figure>\n'],
    ["S8d img 多 data-name", '<figure><img alt="a" src="/x" width="300" data-name="n"></figure>\n'],
    ["S8e figure 多 class", '<figure class="c"><img src="/x" width="300"></figure>\n'],
    ["S8f 表格格子內帶 width 的 img（Q3）", tableMd('<th><img src="/x" width="160"></th><th>b</th>', "<td>c</td><td>d</td>")],
    ["S8g figure 內兩個 img", '<figure><img src="/x" width="300"><img src="/y" width="300"></figure>\n'],
  ])("%s → unsupported_size", (_name, md) => {
    expect(chk(md)).toEqual(SIZE);
  });
});

describe("拒絕：S9 表格欄寬", () => {
  it.each<[string, string]>([
    ["S9a 第二列格子帶 colwidth", tableMd('<th colwidth="120">a</th><th>b</th>', '<td colwidth="120">c</td><td>d</td>')],
    ["S9a2 第二列合併格帶有非空段的 colwidth", tableMd("<th>a</th><th>b</th>", '<td colspan="2" colwidth="120,">c</td>')],
    ["S9b 120,abc", tableMd('<th colspan="2" colwidth="120,abc">a</th>', "<td>c</td><td>d</td>")],
    ["S9c 20", tableMd('<th colwidth="20">a</th><th>b</th>', "<td>c</td><td>d</td>")],
    ["S9d colspan=2 配單段", tableMd('<th colspan="2" colwidth="120">a</th>', "<td>c</td><td>d</td>")],
    ["S9d2 colspan=1 配兩段", tableMd('<th colspan="1" colwidth=",">a</th><th>b</th>', "<td>c</td><td>d</td>")],
    ["S9e 尾空白", tableMd('<th colwidth="120 ">a</th><th>b</th>', "<td>c</td><td>d</td>")],
  ])("%s → unsupported_size", (_name, md) => {
    expect(chk(md)).toEqual(SIZE);
  });
});

// 審查 r3：檢查與 BlockNote 剖析要在同一片段情境下建樹。`<template>` 情境下開頭一個 `<col>` 會丟掉其後所有 token、
// `<caption>`／`<td>`／`<th>` 開頭會把列收進格子；BlockNote（createHTMLDocument 的 div）都照常剖析其餘內容。
// `<frameset>` 開頭：整份文件剖析（`DOMParser` 的 body）時 frameset 取代 body、看不到列，div 片段情境照常（T3 審查 r4 Minor-1）。
const FLEX_DIV = '<div style="display:flex">\n\nx\n\n</div>\n';
const ROW3_FIG = row(col("1", "a"), col("2.5", "b"), col("1", "c")) + '\n<figure><img src="/x" width="300"></figure>\n';
const LEADS = ["col", "caption", "td", "th", "frameset"] as const;

describe("片段情境：檢查看到的 DOM 與剖析一致", () => {
  it("CTX1：開頭 <col> 接 display:flex 的 div → unsupported_columns", () => {
    expect(chk(`<col>\n\n${FLEX_DIV}`)).toEqual(COLS);
  });

  it("CTX2：開頭 <col> 接外層 style 非正規的列 → unsupported_columns", () => {
    expect(chk(`<col>\n\n${swapLine(OUTER_LINE, '<div data-kb-columns style="display:grid">')}`)).toEqual(COLS);
  });

  it("CTX3：開頭 <col> 接段落裡的裸 img 帶寬 → unsupported_size", () => {
    expect(chk('<col>\n\nx <img src="/x" width="300"> y\n')).toEqual(SIZE);
  });

  it.each(["caption", "td", "th"])("CTX4：開頭 <%s> 再接正規列 → 照收（不誤拒）", t => {
    expect(chk(`<${t}>\n\n${ROW2}`)).toMatchObject({ ok: true });
  });

  // 對照（Willie 指定）：檢查的 root 裡看到的頂層列（各列欄數）與帶寬圖片數，必須等於 BlockNote 實際剖析出的
  // 頂層 columnList（各列欄數）與帶 previewWidth 的 image 數。BlockNote 日後改了建樹情境，這裡會先紅。
  it.each(LEADS.flatMap(t => [[t, "ROW2", ROW2], [t, "ROW3_FIG", ROW3_FIG]] as const))("CTX-CMP：開頭 <%s> 接 %s → 檢查看到的＝剖析出的", async (t, _name, body) => {
    const html = markdownToHTML(`<${t}>\n\n${body}`);
    const root = syntaxCheckRoot(html);
    const seen = {
      rows: Array.from(root.children).filter(el => el.tagName === "DIV" && el.hasAttribute("data-kb-columns")).map(r => Array.from(r.children).filter(c => c.hasAttribute("data-kb-column")).length),
      sized: root.querySelectorAll("img[width]").length,
    };
    const s = await EditorSession.open(rt, new Y.Doc());
    try {
      const blocks = s.editor.tryParseHTMLToBlocks(html) as B[];
      const sizedImages = (bs: B[]): number => bs.reduce((n, b) => n + (b.type === "image" && b.props?.previewWidth !== undefined ? 1 : 0) + sizedImages(b.children ?? []), 0);
      const parsed = {
        rows: blocks.filter(b => b.type === "columnList").map(b => b.children.length),
        sized: sizedImages(blocks),
      };
      expect(seen).toEqual(parsed);
      expect(parsed.rows.length).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("拒絕：S10、placement、順序", () => {
  it("S10a：帶 data-node-type 的段落", () => {
    expect(chk('<p data-node-type="x">y</p>\n')).toEqual(COLS);
  });

  it("S10b：站內形的 columnList", () => {
    const md =
      '<div data-node-type="columnList"><div data-node-type="column" data-width="1"><p>a</p></div><div data-node-type="column" data-width="1"><p>b</p></div></div>\n';
    expect(chk(md)).toEqual(COLS);
  });

  it("P1：nested 位置的列 → unsupported_columns", () => {
    expect(chk(ROW2)).toMatchObject({ ok: true });
    expect(chk(ROW2, "nested")).toEqual(COLS);
  });

  it("P2：nested 位置的 figure 圖片照收", () => {
    expect(chk('<figure><img src="/x" width="300"></figure>', "nested").ok).toBe(true);
  });

  it("PREC：同一筆有 S7 的 div 與 S8b 的壞寬度 → unsupported_columns", () => {
    const md = '<figure><img src="/x" width="31"></figure>\n\n<div style="display:flex">\n\nx\n\n</div>\n';
    expect(chk(md)).toEqual(COLS);
  });
});

// final review Nit 1（總管裁定）：HTML 帶事件處理屬性（`onerror` 等）→ `unsupported_block`，在並排與尺寸檢查之前。
// 碼用 unsupported_block：unsupported_columns 的訊息是「layout or editor-internal HTML」，事件處理屬性兩者都不是。
describe("事件處理屬性", () => {
  const BLOCK = { ok: false, error: "unsupported_block" } as const;
  it.each([
    ["EH1 段落裡的 img onerror", '<img src="x" onerror="alert(1)">\n'],
    ["EH2 <details> 裡的 img onerror", '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>\n'],
    ["EH3 figure 裡的 img onerror（其餘照正規形）", '<figure><img alt="a" src="/x" width="300" onerror="alert(1)"></figure>\n'],
    ["EH4 p onclick", '<p onclick="x()">t</p>\n'],
    ["EH5 svg onload", '<svg onload="x()"></svg>\n'],
    ["EH6 大寫 ONERROR", '<IMG SRC="x" ONERROR="x()">\n'],
    ["EH7 欄內的 onmouseover", row(col("1", '<p onmouseover="x()">a</p>'), col("1", "b"))],
    ["EH8 同一筆另有 S7 的 div（事件處理屬性先判）", '<div style="display:flex"><img src="x" onerror="x()"></div>\n'],
    // cleanup r2 Minor 1：只看名字——自造的 on 開頭屬性也拒（讀出形不產生它們），server 與瀏覽器拒同一組
    ["EH9 自造的 on 開頭屬性名（only、one）", '<span only="1" one="2">x</span>\n'],
    // 以下三形 jsdom 沒有對應的 IDL 成員（舊的 `n in el` 在 server 上照收）
    ["EH10 p onanimationstart", '<p onanimationstart="x()">t</p>\n'],
    ["EH11 math onclick", '<math onclick="x()"><mi>x</mi></math>\n'],
    ["EH12 svg animate onbegin", '<svg><animate onbegin="x()"></animate></svg>\n'],
  ])("%s → unsupported_block", (_name, md) => {
    expect(chk(md)).toEqual(BLOCK);
    expect(chk(md, "nested")).toEqual(BLOCK);
  });
  it.each([
    ["EH-OK1 <details open>", "<details open><summary>s</summary><p>x</p></details>\n"],
    ["EH-OK3 文字裡的 only= 與 onerror=", "only=1 and onerror=alert(1) as text\n"],
    ["EH-OK4 程式碼區塊與行內 code 裡的 img onerror", '```\n<img src="x" onerror="x()">\n```\n\n`<img onerror="x()">`\n'],
    ["EH-OK5 網址裡的 ?onload=（屬性值，不是屬性名）", '![x](/a.png?onload=1)\n\n[l](/x?onload=1)\n\n<a href="/x?onload=1">l</a>\n\n<figure><img alt="a" src="/x?onload=1" width="300"></figure>\n'],
    ["EH-OK6 屬性值裡的 only= 與 onerror=", '<span title="only=1 onerror=x">t</span>\n'],
  ])("%s → ok", (_name, md) => {
    expect(chk(md).ok).toBe(true);
  });
  it("EH-GOLD：沒有任何 golden 的 markdown 被這道檢查擋下", () => {
    const hits = goldens.cases.filter(c => {
      const r = chk(c.markdown);
      return !r.ok && r.error === "unsupported_block";
    });
    expect(hits.map(c => c.id)).toEqual([]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 手造 Block JSON
type B = any;
const P = (text = "p", children: B[] = []): B => ({ type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children });
const C = (width: number, children: B[] = [P()]): B => ({ type: "column", props: { width }, content: undefined, children });
const L = (...cols: B[]): B => ({ type: "columnList", props: {}, content: undefined, children: cols });
const IMG = (previewWidth: number | undefined): B => ({ type: "image", props: { url: "/x", name: "", previewWidth }, children: [] });
const T = (columnWidths: Array<number | undefined | null>): B => ({ type: "table", props: {}, content: { type: "tableContent", columnWidths, rows: [] }, children: [] });

describe("結構檢查 findStructureError", () => {
  it("ST1：段落 children 裡的 columnList → columns", () => {
    expect(findStructureError([P("p", [L(C(1), C(1))])], "top")).toBe("unsupported_columns");
  });

  it("ST2：一欄、五欄的 columnList → columns", () => {
    expect(findStructureError([L(C(1))], "top")).toBe("unsupported_columns");
    expect(findStructureError([L(C(1), C(1), C(1), C(1), C(1))], "top")).toBe("unsupported_columns");
  });

  it("ST2b：columnList 的 children 有非 column → columns", () => {
    expect(findStructureError([L(C(1), P())], "top")).toBe("unsupported_columns");
  });

  it("ST3：頂層孤立 column → columns", () => {
    expect(findStructureError([C(1)], "top")).toBe("unsupported_columns");
  });

  it.each([0.05, 11])("ST4：column width %s → columns", w => {
    expect(findStructureError([L(C(1), C(w))], "top")).toBe("unsupported_columns");
  });

  it("ST5：column 內 columnList → columns", () => {
    expect(findStructureError([L(C(1, [L(C(1), C(1))]), C(1))], "top")).toBe("unsupported_columns");
  });

  it("ST6：placement nested 的頂層 columnList → columns", () => {
    expect(findStructureError([L(C(1), C(1))], "top")).toBeNull();
    expect(findStructureError([L(C(1), C(1))], "nested")).toBe("unsupported_columns");
  });

  it.each([31, 4001, 300.5])("ST7：image previewWidth %s → size", w => {
    expect(findStructureError([IMG(w)], "top")).toBe("unsupported_size");
  });

  it("ST8：table columnWidths [10] → size", () => {
    expect(findStructureError([T([10])], "top")).toBe("unsupported_size");
  });

  it("ST8b：table columnWidths [NaN]（沒先正規化）→ size", () => {
    expect(findStructureError([T([NaN])], "top")).toBe("unsupported_size");
  });

  it("ST-PREC：並排與尺寸都違反 → columns（尺寸先被走到也一樣）", () => {
    expect(findStructureError([L(C(1)), IMG(31)], "top")).toBe("unsupported_columns");
  });

  it("ST9：合法——兩欄列、image 300、table [120, undefined] → null", () => {
    expect(findStructureError([L(C(1, [IMG(300)]), C(1.5, [T([120, undefined])])), IMG(undefined), T([null, 4000])], "top")).toBeNull();
  });

  it("ST10：十萬層 children 鏈 → null、不丟例外", () => {
    const root = P();
    let cur = root;
    for (let i = 0; i < 100_000; i++) {
      const next = P();
      cur.children.push(next);
      cur = next;
    }
    expect(findStructureError([root], "top")).toBeNull();
  });
});
