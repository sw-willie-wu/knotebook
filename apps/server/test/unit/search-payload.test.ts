/**
 * #93 §8.4：回應層 wire 預算——依「筆記順序 → 每篇 ord 順序」逐個加入 match，下一個會超過就**停止加入任何 match**（不跳過再試）。
 * 另：§8.6 的「search 桶在查詢之前扣」（耗盡者不碰 DB）——不連 DB 的純單元案。
 */
import { describe, expect, it } from "vitest";
import type { McpToolCtx } from "../../src/mcp/context.js";
import { assembleSearchPayload, searchNotes, type SearchMatchForModel } from "../../src/mcp/tools/search-notes.js";

const note = (id: string) => ({
  id, title: id, owner: { kind: "user" as const, handle: "h" }, slug: id, url: `/n/h/${id}`, role: "owner",
  updatedAt: "2026-01-01T00:00:00.000Z", lastEdited: null, matchedOn: "body" as const, matches: [] as SearchMatchForModel[],
});
const m = (n: number): SearchMatchForModel => ({ sectionId: "s", heading: "", snippet: "x".repeat(n) });

describe("assembleSearchPayload", () => {
  it("預算夠 → 全部加入、沒有 matchesTruncated", () => {
    const out = assembleSearchPayload([note("a"), note("b")], [[m(10), m(10)], [m(10)]], false);
    expect(out.notes.map(n => n.matches.length)).toEqual([2, 1]);
    expect("matchesTruncated" in out).toBe(false);
  });
  it("預算不夠 → 在第一個放不下的地方停止、之後即使放得下也不加、帶 matchesTruncated: true", () => {
    const notes = [note("a"), note("b")];
    const p0 = JSON.stringify({ notes, truncated: false });
    const base = p0.length + JSON.stringify(p0).length + 64;
    // 預算＝恰好放得下 m(10) 與 m(1)：「跳過 m(5000) 再試下一個」的寫法會把 b 的 m(1) 放進去（[1, 1]）。
    // ⚠ 原本的 base + 200 放不下 m(10)＋m(1)（122＋104），那個寫法下照樣是 [1, 0]——零鑑別力（突變 M2 實跑）。
    const cost = (x: SearchMatchForModel) => { const j = JSON.stringify(x); return j.length + JSON.stringify(j).length + 2; };
    const out = assembleSearchPayload(notes, [[m(10), m(5000)], [m(1)]], false, base + cost(m(10)) + cost(m(1)));
    expect(out.notes.map(n => n.matches.length)).toEqual([1, 0]);
    expect(out).toMatchObject({ matchesTruncated: true, truncated: false });
  });
});

describe("#93 §8.6 扣桶時點", () => {
  it("search 桶耗盡 → too_many_requests，且在查詢之前（不碰 db）", async () => {
    let touched = 0;
    // 對 db 的任何存取都計數並丟例外：扣桶若搬到查詢之後，查詢會先碰到它。
    const db = new Proxy({}, { get() { touched += 1; throw new Error("db touched"); } });
    const ctx = { db, userId: "u", limiters: { search: { consume: () => false } } } as unknown as McpToolCtx;
    const r = await searchNotes({ query: "x" }, ctx);
    expect(touched).toBe(0);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("too_many_requests");
  });
});
