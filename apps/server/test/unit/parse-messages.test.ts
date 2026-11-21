import { describe, expect, it } from "vitest";
import { parseErrorMessage, PARSER_BUSY_MESSAGE, TOO_COMPLEX_MESSAGE } from "../../src/http/parse-errors.js";
import { PARSER_BUSY_TOOL_MESSAGE, writeFailureMessage } from "../../src/mcp/write-messages.js";
import { transferParseMessage } from "../../src/routes/transfer.js";

describe("too_complex and parser-busy messages", () => {
  it("REST: unsupported_block + too_complex -> too-complex message; other causes still return the fallback", () => {
    expect(TOO_COMPLEX_MESSAGE).toBe("The content is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller parts or simplify its formatting.");
    expect(parseErrorMessage("unsupported_block", "fb", "too_complex")).toBe(TOO_COMPLEX_MESSAGE);
    expect(parseErrorMessage("unsupported_block", "fb", "too_deep")).toBe("fb");
    expect(parseErrorMessage("unsupported_block", "fb")).toBe("fb");
    expect(PARSER_BUSY_MESSAGE).toBe("The server is busy processing other writes. Try again in a moment.");
  });
  it("batch write-back: file-flavoured too-complex message", () => {
    expect(transferParseMessage("unsupported_block", "too_complex")).toBe("The file is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller files or simplify its formatting.");
  });
  it("MCP: writeFailureMessage reads detail; without detail it falls back to the generic unsupported_block message", () => {
    expect(writeFailureMessage("unsupported_block", "too_complex")).toBe("That markdown is too complex to process within the server's time and memory limits, so nothing was written. Split it into smaller writes or simplify its formatting.");
    expect(writeFailureMessage("unsupported_block")).toBe(writeFailureMessage("unsupported_block", "nested_paragraph"));
    expect(writeFailureMessage("unsupported_block")).not.toContain("too complex");
    expect(PARSER_BUSY_TOOL_MESSAGE).toBe("The server is busy processing other writes, so nothing was written. Try again in a moment.");
  });
});

describe("knowledge messages", () => {
  const problem = { problem: "bad_date", key: "verified", heading: "D1" } as const;
  const expected = 'The knowledge comment under the heading "D1" has a `verified` that isn\'t a date written YYYY-MM-DD. Nothing was written.';
  it("invalid_knowledge names the heading and the reason on REST, in a file write-back and over MCP", () => {
    expect(parseErrorMessage("invalid_knowledge", "fb", undefined, problem)).toBe(expected);
    expect(transferParseMessage("invalid_knowledge", undefined, undefined, problem)).toBe(expected);
    expect(writeFailureMessage("invalid_knowledge", undefined, problem)).toBe(expected);
  });
  it("without the problem they fall back to a plain sentence that still says nothing was written", () => {
    for (const m of [parseErrorMessage("invalid_knowledge", "fb"), transferParseMessage("invalid_knowledge"), writeFailureMessage("invalid_knowledge")]) expect(m).toMatch(/knowledge comment.*nothing was written/);
  });
  it("unsupported_block with knowledge_attr has its own message on all three paths, and it does not offer data-knowledge attributes", () => {
    for (const m of [parseErrorMessage("unsupported_block", "fb", "knowledge_attr"), transferParseMessage("unsupported_block", "knowledge_attr"), writeFailureMessage("unsupported_block", "knowledge_attr")]) {
      expect(m).toContain("knowledge info this editor cannot store");
      expect(m).toContain("<!-- knotebook:knowledge … --> comment");
      expect(m).not.toContain("data-knowledge");
    }
  });
});
