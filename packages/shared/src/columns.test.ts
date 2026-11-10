import { describe, expect, it } from "vitest";
import {
  COLUMN_BLOCK_TYPES, COLUMNS_OPEN_TAG, ColumnListNode, ColumnNode, columnBlockSpec, columnListBlockSpec, columnOpenTag,
  formatColumnWidth, parseColumnFlex,
} from "./columns.js";

// node 環境，不掛編輯器（掛編輯器的案在 web collab/schema.test.ts）。

describe("C1 formatColumnWidth：夾 [0.1, 10]、兩位小數、去尾端 0", () => {
  it.each([
    [1, "1"], [1.5, "1.5"], [0.75, "0.75"], [0.756, "0.76"], [2.0, "2"], [0.05, "0.1"], [0, "0.1"], [11, "10"],
    [NaN, "1"], [Infinity, "1"], [-3, "0.1"],
  ])("%s → %s", (n, expected) => {
    expect(formatColumnWidth(n)).toBe(expected);
  });
});

describe("C2 parseColumnFlex：只認 flex 屬性的第一個數字", () => {
  it.each<[string | null, number]>([
    ["flex:1.5", 1.5], ["flex: 2 1 0", 2], ["display:flex", 1], ["display:flex;gap:16px", 1], [null, 1], ["", 1],
    ["flex:20", 10], ["flex:0.01", 0.1], ["color:red;flex:3", 3], ["-webkit-flex:5", 1],
  ])("%j → %s", (style, expected) => {
    expect(parseColumnFlex(style)).toBe(expected);
  });
});

describe("C3 外部 HTML 開頭標籤（規則 1）", () => {
  it("columnOpenTag 與 COLUMNS_OPEN_TAG 逐字", () => {
    expect(columnOpenTag(1.5)).toBe('<div data-kb-column style="flex:1.5">');
    expect(COLUMNS_OPEN_TAG).toBe('<div data-kb-columns style="display:flex;gap:16px">');
  });
});

describe("C4 節點字串守衛", () => {
  it("型別集合、name、group、content、propSchema", () => {
    expect([...COLUMN_BLOCK_TYPES].sort()).toEqual(["column", "columnList"]);
    expect(ColumnListNode.name).toBe("columnList");
    expect(ColumnListNode.config.group).toBe("childContainer bnBlock blockGroupChild");
    expect(ColumnListNode.config.content).toBe("column column+");
    expect(ColumnNode.name).toBe("column");
    expect(ColumnNode.config.group).toBe("bnBlock childContainer");
    expect(ColumnNode.config.content).toBe("blockContainer+");
    expect(columnBlockSpec.config.propSchema).toEqual({ width: { default: 1 } });
    expect(columnListBlockSpec.config.propSchema).toEqual({});
    expect(columnBlockSpec.config.content).toBe("none");
    expect(columnListBlockSpec.config.content).toBe("none");
  });
});
