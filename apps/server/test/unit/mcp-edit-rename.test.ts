/**
 * #180 spec §4.1／§4.3：MCP 側必填矩陣 `mcpEditBodySchema`（REST 五支＋`RENAME_BRANCH`）與 `invalidBodyMessage` 全文。
 * 字串寫字面值（不 import 實作常數以外的字串）——字面值才釘得住 spec。
 */
import { describe, expect, it } from "vitest";
import { mcpEditBodySchema, invalidBodyMessage } from "../../src/mcp/tools/edit-note.js";

const FP = "0123456789abcdef";
const SEC = "a".repeat(8);

describe("U3 mcpEditBodySchema 矩陣", () => {
  it("{op:rename, title} 過；append 無 if_match 過（不變）", () => {
    expect(mcpEditBodySchema.safeParse({ op: "rename", title: "x" }).success).toBe(true);
    expect(mcpEditBodySchema.safeParse({ op: "append", markdown: "m" }).success).toBe(true);
  });

  it.each([
    ["if_match", { if_match: FP }],
    ["markdown", { markdown: "m" }],
    ["section_id", { section_id: SEC }],
  ])("rename ＋ %s → unrecognized_keys", (_k, extra) => {
    const r = mcpEditBodySchema.safeParse({ op: "rename", title: "x", ...extra });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.code)).toContain("unrecognized_keys");
  });

  it("rename 無 title → 拒、path title；title 空字串 → 拒", () => {
    const r = mcpEditBodySchema.safeParse({ op: "rename" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(["title"]);
    expect(mcpEditBodySchema.safeParse({ op: "rename", title: "" }).success).toBe(false);
  });

  it.each([
    ["replace_all", { markdown: "m", if_match: FP }],
    ["replace_section", { section_id: SEC, markdown: "m", if_match: FP }],
    ["insert_after", { section_id: SEC, markdown: "m", if_match: FP }],
    ["append", { markdown: "m" }],
    ["delete_section", { section_id: SEC, if_match: FP }],
  ])("%s ＋ title → unrecognized_keys（只有 rename 收 title）", (op, rest) => {
    const r = mcpEditBodySchema.safeParse({ op, ...rest, title: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.code)).toContain("unrecognized_keys");
  });
});

describe("U4 invalidBodyMessage 全文（spec §4.3）", () => {
  it("rename 缺 title：Check: title. ＋ 全文尾段逐字", () => {
    expect(invalidBodyMessage("rename", [{ path: ["title"] }])).toBe(
      "This `rename` call does not match what that operation needs. Check: title. replace_section, insert_after and " +
        "delete_section need `section_id`; every operation except delete_section and rename needs `markdown`; every " +
        "operation except append and rename needs `if_match`; rename needs `title`, and no other operation takes it. " +
        "Fields that do not belong to the operation are rejected."
    );
  });
});
