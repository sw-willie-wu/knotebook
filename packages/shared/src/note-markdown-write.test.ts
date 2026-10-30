import { describe, expect, it } from "vitest";
import { canonicalColumnsLine, normalizeTableWidths, relativizeSiteUploads } from "./note-markdown-write.js";

// spec 2026-10-21 columns-layout §11.3（寫入）。node 環境：只測不需要 DOM 的三支；語法檢查（需要 DOM）在 server
// `test/unit/note-markdown-validate.test.ts`。

describe("CL1 canonicalColumnsLine：逐字等於正規行才算", () => {
  it("外層行 → list；欄行 → { width }", () => {
    expect(canonicalColumnsLine('<div data-kb-columns style="display:flex;gap:16px">')).toBe("list");
    expect(canonicalColumnsLine('<div data-kb-column style="flex:1.5">')).toEqual({ width: 1.5 });
  });

  it("行尾一個 \\r 照收（Q10）", () => {
    expect(canonicalColumnsLine('<div data-kb-columns style="display:flex;gap:16px">\r')).toBe("list");
    expect(canonicalColumnsLine('<div data-kb-column style="flex:1.5">\r')).toEqual({ width: 1.5 });
  });

  it.each([["0.1", 0.1], ["10", 10], ["2.25", 2.25], ["1", 1]])("flex:%s 收", (s, w) => {
    expect(canonicalColumnsLine(`<div data-kb-column style="flex:${s}">`)).toEqual({ width: w });
  });

  it.each([
    '<div data-kb-column style="flex:0.05">',
    '<div data-kb-column style="flex:10.5">',
    '<div data-kb-column style="flex:01">',
    '<div data-kb-column style="flex:1.555">',
    '<div data-kb-column style="flex:1.">',
    '<div data-kb-column style="flex:-1">',
    '<div data-kb-column style="flex:1e1">',
    ' <div data-kb-column style="flex:1">',
    '<div data-kb-column style="flex:1"> ',
    " <div data-kb-columns style=\"display:flex;gap:16px\">",
    "<div data-kb-columns style=\"display:flex;gap:16px\"> ",
    "<div data-kb-column style='flex:1'>",
    "<div data-kb-columns style='display:flex;gap:16px'>",
    '<div style="flex:1" data-kb-column>',
    '<div style="display:flex;gap:16px" data-kb-columns>',
    '<DIV DATA-KB-COLUMN STYLE="flex:1">',
    '<DIV DATA-KB-COLUMNS STYLE="display:flex;gap:16px">',
    '<div data-kb-column style="flex:1">\r\r',
  ])("%j → null", line => {
    expect(canonicalColumnsLine(line)).toBeNull();
  });
});

const table = (columnWidths: unknown[]) => ({ type: "table", props: {}, content: { type: "tableContent", columnWidths, rows: [] }, children: [] });
const para = (children: unknown[] = []) => ({ type: "paragraph", props: {}, content: [], children });
const widthsOf = (b: unknown): unknown[] => (b as { content: { columnWidths: unknown[] } }).content.columnWidths;

describe("NT1 normalizeTableWidths：非正有限數 → undefined", () => {
  it("[120, NaN, 80] → [120, undefined, 80]", () => {
    const out = normalizeTableWidths([table([120, NaN, 80])]);
    expect(widthsOf(out[0])).toEqual([120, undefined, 80]);
    expect(widthsOf(out[0])[1]).toBeUndefined();
  });

  it.each<[string, number[]]>([["[NaN, NaN]", [NaN, NaN]], ["[0, -5]", [0, -5]]])("%s → 全 undefined", (_name, ws) => {
    const out = normalizeTableWidths([table(ws)]);
    expect(widthsOf(out[0])).toEqual([undefined, undefined]);
    expect(widthsOf(out[0]).every(v => v === undefined)).toBe(true);
  });

  it("columnList → column → table 裡的同樣處理", () => {
    const blocks = [{ type: "columnList", props: {}, children: [{ type: "column", props: { width: 1 }, children: [table([NaN, 120])] }, { type: "column", props: { width: 1 }, children: [para()] }] }];
    const out = normalizeTableWidths(blocks) as unknown as Array<{ children: Array<{ children: unknown[] }> }>;
    expect(widthsOf(out[0]!.children[0]!.children[0])).toEqual([undefined, 120]);
    expect(widthsOf(out[0]!.children[0]!.children[0])[0]).toBeUndefined();
    expect(out[0]!.children[1]).toBe(blocks[0]!.children[1]); // 沒改到的分支沿用原物件
  });

  it("沒有可改的值 → 回同一個陣列", () => {
    const blocks = [table([120, undefined, 80]), para([table([300])])];
    expect(normalizeTableWidths(blocks)).toBe(blocks);
  });

  it("輸入物件沒被改", () => {
    const t = table([120, NaN, 80]);
    const blocks = [para([t])];
    const out = normalizeTableWidths(blocks);
    expect(out).not.toBe(blocks);
    expect(Number.isNaN(widthsOf(t)[1])).toBe(true);
    expect(blocks[0]!.children[0]).toBe(t);
  });
});

const U = "00000000-0000-4000-8000-000000000001";
const media = (type: string, url: string, children: unknown[] = []) => ({ type, props: { url, name: "n" }, children });
const urlOf = (b: unknown): unknown => (b as { props: { url: unknown } }).props.url;

describe("RS1 relativizeSiteUploads：同 origin 的 /api/uploads/<uuid> 還原成相對形", () => {
  const BASE = "http://localhost";

  it("頂層 image", () => {
    const out = relativizeSiteUploads([media("image", `http://localhost/api/uploads/${U}`)], BASE);
    expect(urlOf(out[0])).toBe(`/api/uploads/${U}`);
  });

  it("欄內（columnList → column → image）與段落 children 裡的 image、video、file 同樣還原", () => {
    const abs = `http://localhost/api/uploads/${U}`;
    const blocks = [
      { type: "columnList", props: {}, children: [{ type: "column", props: { width: 1 }, children: [media("image", abs)] }, { type: "column", props: { width: 1 }, children: [para()] }] },
      para([media("image", abs), media("video", abs), media("file", abs)]),
    ];
    const out = relativizeSiteUploads(blocks, BASE) as unknown as Array<{ children: Array<{ children?: unknown[] }> }>;
    expect(urlOf(out[0]!.children[0]!.children![0])).toBe(`/api/uploads/${U}`);
    expect(out[1]!.children.map(urlOf)).toEqual([`/api/uploads/${U}`, `/api/uploads/${U}`, `/api/uploads/${U}`]);
  });

  it.each([
    `https://evil.example/api/uploads/${U}`,
    `http://localhost:8080/api/uploads/${U}`,
    `https://localhost/api/uploads/${U}`,
    "http://localhost/api/uploads/not-a-uuid",
    `http://localhost/api/uploads/${U}/x`,
    `http://localhost/api/uploads/${U}?x=1`,
    `http://localhost/api/uploads/${U}#a`,
    `http://u:p@localhost/api/uploads/${U}`,
    `http://localhost/other/${U}`,
    `/api/uploads/${U}`,
    "",
  ])("不動：%j", url => {
    const blocks = [media("image", url)];
    const out = relativizeSiteUploads(blocks, BASE);
    expect(urlOf(out[0])).toBe(url);
    expect(out).toBe(blocks);
  });

  it("沒有可改的輸入 → 回同一個陣列", () => {
    const blocks = [para([media("image", `/api/uploads/${U}`)]), media("file", "https://evil.example/a.pdf")];
    expect(relativizeSiteUploads(blocks, BASE)).toBe(blocks);
  });

  it("輸入物件沒被改", () => {
    const abs = `http://localhost/api/uploads/${U}`;
    const img = media("image", abs);
    const blocks = [para([img])];
    const out = relativizeSiteUploads(blocks, BASE);
    expect(out).not.toBe(blocks);
    expect(urlOf(img)).toBe(abs);
    expect(blocks[0]!.children[0]).toBe(img);
  });
});
