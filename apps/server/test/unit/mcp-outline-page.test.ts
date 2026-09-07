/**
 * #108 §8.1／§8.3：outline 分頁（一次最多 100 筆）的邊界。
 *
 * 這一族守的是 `buildOutlinePage` 本身；「哪些欄位被丟掉／被截斷」的結果面由
 * `test/mcp-content.test.ts` 的 key 集合與長度斷言守。
 */
import { describe, expect, it } from "vitest";
import type { OutlineEntry } from "../../src/notes/editing/fingerprint.js";
import { buildOutlinePage } from "../../src/mcp/outline-page.js";
import { MCP_PAGE_MAX, MCP_TEXT_MAX } from "../../src/mcp/limits.js";

/** 逐字帶著 `fingerprint`／`blockIds` ——這兩欄**不得**出現在回傳值裡（M12(1)）。 */
function entries(n: number, heading = (i: number) => `S${i}`): OutlineEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    sectionId: i === 0 ? "_top" : `sec-${i}`,
    level: i === 0 ? 0 : 1,
    heading: heading(i),
    chars: i,
    blockIds: [`b-${i}`],
    fingerprint: "deadbeefdeadbeef",
  }));
}

describe("#108 buildOutlinePage", () => {
  it("不足 100 筆：全數回傳、truncated false、nextSectionOffset null", () => {
    const page = buildOutlinePage(entries(7), 0);
    expect(page.sections).toHaveLength(7);
    expect(page.truncated).toBe(false);
    expect(page.nextSectionOffset).toBeNull();
  });

  it("恰好 100 筆不算截斷（邊界：> 才是 truncated，>= 會多發一次空的第二頁）", () => {
    const page = buildOutlinePage(entries(MCP_PAGE_MAX), 0);
    expect(page.sections).toHaveLength(MCP_PAGE_MAX);
    expect(page.truncated).toBe(false);
    expect(page.nextSectionOffset).toBeNull();
  });

  it("101 筆：第一頁 100 ＋ truncated ＋ nextSectionOffset 100；第二頁 1 筆收尾", () => {
    const all = entries(MCP_PAGE_MAX + 1);
    const p1 = buildOutlinePage(all, 0);
    expect(p1.sections).toHaveLength(MCP_PAGE_MAX);
    expect(p1.truncated).toBe(true);
    expect(p1.nextSectionOffset).toBe(MCP_PAGE_MAX);
    const p2 = buildOutlinePage(all, p1.nextSectionOffset!);
    expect(p2.sections).toHaveLength(1);
    expect(p2.truncated).toBe(false);
    expect(p2.nextSectionOffset).toBeNull();
    // 兩頁湊回全集、順序不變、無重複無遺漏。
    expect([...p1.sections, ...p2.sections].map(s => s.sectionId)).toEqual(all.map(s => s.sectionId));
  });

  it("sectionOffset 等於或大於總段數 → 空陣列 ＋ truncated false ＋ nextSectionOffset null（不是錯誤）", () => {
    for (const offset of [7, 8, 10_000]) {
      const page = buildOutlinePage(entries(7), offset);
      expect(page.sections).toEqual([]);
      expect(page.truncated).toBe(false);
      expect(page.nextSectionOffset).toBeNull();
    }
  });

  it("每個 entry 的 key 集合逐字＝{sectionId, level, heading, chars}，指紋與 blockIds 都被丟掉", () => {
    const page = buildOutlinePage(entries(3), 0);
    for (const s of page.sections) {
      expect(Object.keys(s).sort()).toEqual(["chars", "heading", "level", "sectionId"].sort());
    }
    expect(JSON.stringify(page)).not.toContain("deadbeefdeadbeef");
    expect(JSON.stringify(page)).not.toContain("b-0");
  });

  it("heading 截到 200 並附 headingTruncated；未截斷時沒有那把 key", () => {
    const page = buildOutlinePage(entries(2, i => (i === 1 ? "H".repeat(500) : "short")), 0);
    expect(page.sections[0]!.heading).toBe("short");
    expect("headingTruncated" in page.sections[0]!).toBe(false);
    expect(page.sections[1]!.heading).toBe("H".repeat(MCP_TEXT_MAX));
    expect(page.sections[1]!.headingTruncated).toBe(true);
  });
});
