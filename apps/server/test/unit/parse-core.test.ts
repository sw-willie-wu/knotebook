/** #398：worker 與同執行緒共用的解析核心——`RangeError`（堆疊溢位等）＝內容太複雜（400），其他例外照舊丟（500）。 */
import { describe, expect, it, vi } from "vitest";

const parseMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/notes/editing/markdown.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/notes/editing/markdown.js")>()),
  parseMarkdownForNote: parseMock,
}));
const { runParse, TOO_COMPLEX } = await import("../../src/notes/editing/parse-core.js");

const req = { markdown: "x", candidates: [], siteOrigin: "http://localhost" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 假編輯器：runParse 只把它原樣交給 parseMarkdownForNote（已 mock）
const ed = {} as any;

describe("runParse", () => {
  it("RangeError（Maximum call stack size exceeded）→ too_complex", () => {
    parseMock.mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    expect(runParse(ed, req)).toEqual(TOO_COMPLEX);
  });
  it("其他例外原樣丟出（程式錯 → 500，不偽裝成內容問題）", () => {
    parseMock.mockImplementationOnce(() => {
      throw new TypeError("boom");
    });
    expect(() => runParse(ed, req)).toThrow(TypeError);
  });
  it("正常結果原樣回", () => {
    parseMock.mockReturnValueOnce({ blocks: [], unbound: 0 });
    expect(runParse(ed, req)).toEqual({ blocks: [], unbound: 0 });
  });
});
