/**
 * #108 §8.1 回應大小上限表的截斷函式（M16）。
 *
 * 這一族守的是 `truncateText` 的邊界，不是「哪些欄位有被截」——後者由
 * `test/mcp-notes.test.ts` 的 key 集合／長度斷言守。
 */
import { describe, expect, it } from "vitest";
import { MCP_TEXT_MAX, truncateText } from "../../src/mcp/limits.js";

/** 沒有配對的高位／低位代理。`String.prototype.isWellFormed` 要 ES2024 lib，本 repo 是 ES2023。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("#108 truncateText", () => {
  it("恰好 200 code unit 不截斷", () => {
    const s = "a".repeat(MCP_TEXT_MAX);
    expect(truncateText(s)).toEqual({ text: s, truncated: false });
  });

  it("201 code unit 截到 200 並標記 truncated", () => {
    const s = "a".repeat(MCP_TEXT_MAX + 1);
    const out = truncateText(s);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MCP_TEXT_MAX);
    expect(out.text).toBe("a".repeat(MCP_TEXT_MAX));
  });

  // 代理對（一個 emoji ＝兩個 code unit）**不切半**：切點恰落在代理對中間時退一格，
  // 回傳 199 個 code unit。切半的後果是回給模型一個孤立代理（lone surrogate）——
  // JSON 序列化不會報錯，只會安靜地送出一個壞字元。
  it("切點落在代理對中間時退一格，不產生孤立代理", () => {
    const s = "a".repeat(MCP_TEXT_MAX - 1) + "\u{1F600}" + "tail";
    const out = truncateText(s);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MCP_TEXT_MAX - 1);
    expect(out.text).toBe("a".repeat(MCP_TEXT_MAX - 1));
    expect(LONE_SURROGATE.test(out.text)).toBe(false);
    // 對照面：天真的 `slice(0, 200)` 在同一份輸入上會切出孤立代理——沒有這一行，
    // 上面那條「長度 199」的斷言看不出它為什麼是 199。
    expect(LONE_SURROGATE.test(s.slice(0, MCP_TEXT_MAX))).toBe(true);
  });
});
