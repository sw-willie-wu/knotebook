/**
 * #93 §8.3：摘錄演算法（M5 單元、RF2）。cost＝MCP 的 JSON 逃脫後成本（`escapedLength`）。
 * 保證：libc locale 下恆含命中起點；命中逃脫後成本 ≤ 158 時含整段命中；結果逃脫後 ≤ 160。
 */
import { describe, expect, it } from "vitest";
import { MCP_SNIPPET_MAX, escapedLength } from "../../src/mcp/limits.js";
import { buildSnippet } from "../../src/notes/search-snippet.js";

/** 模擬 SQL 的窗口（search-sql.ts：前 40、命中、後 160 code point；win_start 1-based）。 */
function windowOf(body: string, query: string) {
  const cps = Array.from(body);
  const lower = Array.from(body.toLowerCase());
  const q = Array.from(query.toLowerCase());
  let p0 = -1;
  for (let i = 0; i + q.length <= lower.length; i += 1) if (q.every((c, k) => lower[i + k] === c)) { p0 = i; break; }
  if (p0 < 0) throw new Error("no hit");
  const p = p0 + 1;
  const winStart = Math.max(p - 40, 1);
  const win = cps.slice(winStart - 1, winStart - 1 + 40 + q.length + 160).join("");
  return { win, lead: p - winStart, qlen: q.length, winStart, bodyLen: cps.length };
}
const snip = (body: string, q: string) => buildSnippet(windowOf(body, q), MCP_SNIPPET_MAX, escapedLength);
const esc = (s: string) => JSON.stringify(s).length - 2;

describe("M5 摘錄", () => {
  it("命中在段首：沒有前綴 …；段尾：沒有後綴 …；段中：兩邊都有", () => {
    expect(snip("zeta and more", "zeta")).toBe("zeta and more");
    expect(snip("some words zeta", "zeta")).toBe("some words zeta");
    const mid = snip(`${"a ".repeat(100)}zeta${" b".repeat(200)}`, "zeta");
    expect(mid.startsWith("…")).toBe(true);
    expect(mid.endsWith("…")).toBe(true);
    expect(mid).toContain("zeta");
  });
  it("… 的差一邊界：摘錄外恰好剩 0 個字 → 沒有 …；恰好剩 1 個字 → 有 …（前後各一組）", () => {
    // 後文：命中在段首、成本 4，後文預算 158 − 4 ＝ 154 個 `x`。
    expect(snip(`zeta${"x".repeat(154)}`, "zeta")).toBe(`zeta${"x".repeat(154)}`);
    expect(snip(`zeta${"x".repeat(155)}`, "zeta")).toBe(`zeta${"x".repeat(154)}…`);
    // 前文：窗口只帶命中前 40 個字（前文預算 51 用不完），所以前文恰為窗口；body 多 1 個字就在窗口外。
    expect(snip(`${"y".repeat(40)}zeta`, "zeta")).toBe(`${"y".repeat(40)}zeta`);
    expect(snip(`${"y".repeat(41)}zeta`, "zeta")).toBe(`…${"y".repeat(40)}zeta`);
  });
  it("前後文的連續空白（含換行）壓成一個空格；命中段本身不壓、保持 body 原文的大小寫", () => {
    expect(snip("pre \n\n  ZeTa   x  y", "zeta")).toBe("pre ZeTa x y");
    expect(snip("pre x  y post", "x  y")).toBe("pre x  y post");
  });
  it("40 個 U+0001 前文＋命中 → 命中整段在摘錄裡（窗口先截再算預算的舊演算法會把它丟掉）", () => {
    const s = snip(`${"\u0001".repeat(40)}zeta tail`, "zeta");
    expect(s).toContain("zeta tail");
    expect(esc(s)).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
  it("查詢為 200 個 \"（逃脫後 400）→ 摘錄以命中起點開頭、逃脫後 ≤ 160", () => {
    const q = '"'.repeat(200);
    const s = snip(`pre ${q} post`, q);
    expect(s.startsWith('…"')).toBe(true);
    expect(esc(s)).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
  it("任何輸入的逃脫後長度 ≤ 160（混合 \\\"、C0、CJK、emoji）", () => {
    const body = `${"\\\"\u0001中😀".repeat(60)}zeta${"\\\"\u0002文😀".repeat(80)}`;
    expect(esc(snip(body, "zeta"))).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
  it("RF2：命中前後都是 emoji、命中本身含 emoji → 含命中、沒有孤立代理、≤ 160", () => {
    const s = snip(`${"😀".repeat(50)}ze😀ta${"😀".repeat(80)}`, "ze😀ta");
    expect(s).toContain("ze😀ta");
    expect(JSON.stringify(s)).not.toMatch(/\\ud[89a-f]/i);
    expect(esc(s)).toBeLessThanOrEqual(MCP_SNIPPET_MAX);
  });
});
