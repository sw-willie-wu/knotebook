/**
 * #108 §8.1 D31／M15 的單元那一半：`toolError()` 是**我們自己產生的**工具錯誤（D12 的 (4b)）
 * 唯一的建構點，`content[0].text` 必須逐字是 `structuredContent` 的鏡像。
 *
 * ⚠ SDK 自產的四條路徑（未知工具名／輸入 schema 不符／輸出驗證失敗／未捕捉例外）不在這裡，
 * 也攔不到——它們沒有 `code`、沒有 `structuredContent`（D12 的 (4a)）。
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@knotebook/shared";
import { toolError } from "../../src/mcp/tool-result.js";

describe("#108 toolError", () => {
  it("回 isError ＋ structuredContent，且 content[0].text 逐字等於 structuredContent 的 JSON", () => {
    const result = toolError("not_found", "That note does not exist.");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "not_found", message: "That note does not exist." });
    expect(result.structuredContent!.message).toBeTruthy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(result.structuredContent),
    });
  });

  it("extra 進 structuredContent，鏡像等式仍然成立", () => {
    const result = toolError("section_not_found", "No such section.", { outline: { sections: [], truncated: false } });
    expect(result.structuredContent).toEqual({
      code: "section_not_found",
      message: "No such section.",
      outline: { sections: [], truncated: false },
    });
    expect(result.content[0]!.text).toBe(JSON.stringify(result.structuredContent));
  });

  it("code 逐字沿用 ERROR_CODES（M4：錯誤碼單一真相）", () => {
    for (const code of ["not_found", "forbidden", "section_not_found", "too_many_requests", "invalid_body", "internal"] as const) {
      const result = toolError(code, "x");
      expect(ERROR_CODES).toContain(result.structuredContent!.code);
    }
  });

  it("鏡像是逐字的字串比對，不是「兩邊都 parse 得出來」", () => {
    // 殺掉「content 用 JSON.stringify(…, null, 2) 或另組一份文字」的寫法。
    const result = toolError("internal", `a"b\\c`);
    expect(result.content[0]!.text).toBe(JSON.stringify(result.structuredContent));
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
});
