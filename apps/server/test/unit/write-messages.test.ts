// 並排 PR-2（spec §11.3 錯誤訊息）：兩個新碼的 MCP 訊息逐字釘住。REST 那兩句由整合測試 mcp-write-guards GW2、GW3 逐字比對。
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@knotebook/shared";
import { writeFailureMessage } from "../../src/mcp/write-messages.js";

describe("writeFailureMessage：並排與尺寸", () => {
  it("WM1：unsupported_columns、unsupported_size 各自逐字", () => {
    expect(writeFailureMessage("unsupported_columns")).toBe(
      "That markdown has layout or editor-internal HTML this editor cannot store, so nothing was written. Write side-by-side columns exactly as read_note_section returns them: <div data-kb-columns style=\"display:flex;gap:16px\"> holding 2 to 4 <div data-kb-column style=\"flex:N\"> columns, N from 0.1 to 10 with at most two decimal places, with a blank line after each column's opening tag and another before its </div>, at the top level of the markdown, not nested inside a list, a quote or anything else. Other <div> elements cannot use display:flex or display:grid, and no element can carry data-node-type."
    );
    expect(writeFailureMessage("unsupported_size")).toBe(
      "An image width or table column width in that markdown is not in a form this editor can store, so nothing was written. Write sizes exactly as read_note_section returns them, as whole numbers of pixels from 32 to 4000: an image's width on the <img> inside a <figure> that is outside any table, the <img> carrying only alt (optional), src and width, in that order, and a table's column widths as colwidth on its first row's cells, one comma-separated value for each column a cell spans, left empty for a column with no width."
    );
  });

  it("WM2：unsupported_size 不提表格格子裡的圖片（格子圖片 PR-4 才收，免得模型被引去寫）", () => {
    expect(writeFailureMessage("unsupported_size")).not.toContain("table cell");
  });

  // T4 審查 Minor-1：舊句在可到達的情形下是假的——帶 data-node-type 的非並排元素（S10）也回 unsupported_columns，
  // 表格格子裡帶寬的圖片照「figure 內的 img」改寫仍被拒（S8 格子分支），模型會原地打轉。
  it("WM4：舊句的兩個假敘述不在", () => {
    expect(writeFailureMessage("unsupported_columns")).not.toContain("has side-by-side columns");
    expect(writeFailureMessage("unsupported_size")).not.toContain("on the <img> inside <figure>,");
  });

  it("WM3：兩碼都在 ERROR_CODES（web 的 errors.<code> 與 REST 的 sendError 靠它）", () => {
    expect(ERROR_CODES).toEqual(expect.arrayContaining(["unsupported_columns", "unsupported_size"]));
  });
});
