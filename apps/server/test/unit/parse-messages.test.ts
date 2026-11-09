/** #398：解析太複雜（`too_complex`）與解析排隊逾時的訊息——REST、批次寫回、MCP 三處的字面。 */
import { describe, expect, it } from "vitest";
import { PARSER_BUSY_MESSAGE, TOO_COMPLEX_MESSAGE } from "../../src/http/parse-errors.js";
import { PARSER_BUSY_TOOL_MESSAGE, writeFailureMessage } from "../../src/mcp/write-messages.js";
import { parseErrorMessage } from "../../src/routes/notes.js";
import { transferParseMessage } from "../../src/routes/transfer.js";

describe("too_complex／parser busy 訊息", () => {
  it("REST：unsupported_block＋too_complex → 太複雜；其他成因照舊回 fallback", () => {
    expect(TOO_COMPLEX_MESSAGE).toBe("The content is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller parts or simplify its formatting.");
    expect(parseErrorMessage("unsupported_block", "fb", "too_complex")).toBe(TOO_COMPLEX_MESSAGE);
    expect(parseErrorMessage("unsupported_block", "fb", "too_deep")).toBe("fb");
    expect(parseErrorMessage("unsupported_block", "fb")).toBe("fb");
    expect(PARSER_BUSY_MESSAGE).toBe("The server is busy processing other writes. Try again in a moment.");
  });
  it("批次寫回：檔案版的太複雜", () => {
    expect(transferParseMessage("unsupported_block", "too_complex")).toBe("The file is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller files or simplify its formatting.");
  });
  it("MCP：writeFailureMessage 看 detail；沒有 detail 照舊", () => {
    expect(writeFailureMessage("unsupported_block", "too_complex")).toBe("That markdown is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller writes or simplify its formatting.");
    expect(writeFailureMessage("unsupported_block")).toBe(writeFailureMessage("unsupported_block", "nested_paragraph"));
    expect(writeFailureMessage("unsupported_block")).not.toContain("too complex");
    expect(PARSER_BUSY_TOOL_MESSAGE).toBe("The server is busy processing other writes, so nothing was written. Try again in a moment.");
  });
});
