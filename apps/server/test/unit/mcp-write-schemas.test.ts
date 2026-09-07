/**
 * #108 PR2：寫入工具的 schema 與 REST 的**同一份** schema 對得起來（M14／D-N／D-K）。
 *
 * 本檔在 Task 2 只放兩案（op 集合的兩邊）；M14 的 identity 斷言與行為探針在 Task 4 續寫。
 *
 * ⚠ **`op` 是唯一沒有共用物件的欄位**：REST 那邊是五個 `z.literal`（`discriminatedUnion` 的
 * 判別鍵），MCP 這邊要的是一個帶 `.describe()` 的 `z.enum`（raw shape 表達不了 union）。
 * 兩份字串集合因此只能靠下面這一案對起來——**沒有它，日後加第六個 op 只有一邊會知道，
 * 而且不會有任何測試變紅**（`editBodySchema` 多一個分支＝MCP 收不到那個 op、raw shape 多一個
 * 成員＝REST 的 `safeParse` 直接 `invalid_union_discriminator`，兩種漂移都只是「功能沒接上」）。
 */
import { describe, expect, it } from "vitest";
import { editBodySchema } from "../../src/notes/schemas.js";
import { editNoteInput } from "../../src/mcp/tools/edit-note.js";

/** 寫死一份（不是從實作導出來的）——否則兩邊一起改就一起綠。 */
const OPS = ["replace_all", "replace_section", "insert_after", "append", "delete_section"];

describe("#108 寫入 schema 的兩邊", () => {
  it("editBodySchema 的五個分支 op literal 逐字等於寫死的五元陣列（含順序）", () => {
    expect(editBodySchema.options).toHaveLength(5);
    expect(editBodySchema.options.map(o => o.shape.op.value)).toEqual(OPS);
  });

  it("edit_note 的 op enum 成員逐字等於 editBodySchema 的五個 literal（D-N）", () => {
    // 兩邊各自與寫死的那份對，而不是互相對——互相對的話兩邊一起漏一個 op 仍然綠。
    expect(editNoteInput.op.options).toEqual(OPS);
    expect(editNoteInput.op.options).toEqual(editBodySchema.options.map(o => o.shape.op.value));
  });
});
