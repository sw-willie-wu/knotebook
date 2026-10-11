/**
 * #108 PR2：寫入工具的 schema 與 REST 的**同一份** schema 對得起來（M14／D-N／D-K）。
 *
 * 本檔放寫入工具 schema 的同源斷言：op 集合的兩邊、M14 的 identity 斷言（21b(i)）與行為探針
 * （21b(ii)），以及 #180 起各新工具輸入欄位的 identity（U1／U2-x）。
 *
 * ⚠ **`op` 是唯一沒有共用物件的欄位**：REST 那邊是五個 `z.literal`（`discriminatedUnion` 的
 * 判別鍵），MCP 這邊要的是一個帶 `.describe()` 的 `z.enum`（raw shape 表達不了 union）。
 * #180 起 MCP 的 op 集合＝REST 五個 ∪ {rename}（`rename` 是 MCP 獨有，REST 刻意不加；以下 `MCP_OPS` 斷言）。
 * 兩份字串集合因此只能靠下面這一案對起來——**沒有它，日後 REST 多一個 op 只有一邊會知道，
 * 而且不會有任何測試變紅**（`editBodySchema` 多一個分支＝MCP 收不到那個 op、raw shape 多一個
 * 成員＝REST 的 `safeParse` 直接 `invalid_union_discriminator`，兩種漂移都只是「功能沒接上」）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBodySchema, editBodySchema, FP, GROUP_ID, MD, NOTE_ID, NUL, SEC, TITLE, updateBodyObject } from "../../src/notes/schemas.js";
import { editNoteInput, mcpEditBodySchema } from "../../src/mcp/tools/edit-note.js";
import { createNoteInput } from "../../src/mcp/tools/create-note.js";
import { COPY_GROUP_ID_DESCRIBE_NO_MOVE, copyNoteInput, copyNoteInputNoMove } from "../../src/mcp/tools/copy-note.js";
import { moveNoteToGroupInput } from "../../src/mcp/tools/move-note-to-group.js";
import { readNoteSectionOutput } from "../../src/mcp/tools/read-note-section.js";

/** 寫死一份（不是從實作導出來的）——否則兩邊一起改就一起綠。 */
const OPS = ["replace_all", "replace_section", "insert_after", "append", "delete_section"];
/** #180 W8：MCP 多一個 op（REST 五 ∪ {rename}）。**刻意不相等**——REST `/edits` 不加 rename 是對 D18 的刻意偏離（spec §4.6：rename 不進 `note_ai_edits`、REST 已有 PATCH、MCP 加 op 比另開工具便宜）。日後別「修正」成兩邊相等。 */
const MCP_OPS = [...OPS, "rename"];

describe("#108 寫入 schema 的兩邊", () => {
  it("editBodySchema 的五個分支 op literal 逐字等於寫死的五元陣列（含順序）", () => {
    expect(editBodySchema.options).toHaveLength(5);
    expect(editBodySchema.options.map(o => o.shape.op.value)).toEqual(OPS);
  });

  it("edit_note 的 op enum ＝ REST 五 ∪ {rename}（W8）；mcpEditBodySchema 的 literal ＝ MCP_OPS 且前五支就是 editBodySchema 的同一批物件", () => {
    expect(editNoteInput.op.options).toEqual(MCP_OPS);
    expect(mcpEditBodySchema.options.map(o => o.shape.op.value)).toEqual(MCP_OPS);
    for (let i = 0; i < OPS.length; i += 1) expect(mcpEditBodySchema.options[i]).toBe(editBodySchema.options[i]);
  });
});

/**
 * 21b(i)（M14 的**來源**那一半）：raw shape 的六個欄位各自與 `notes/schemas.ts` 的 base
 * **同一份物件參考**，不是「兩邊碰巧寫出同樣的規則」。
 *
 * zod 3.25.76 的 `.describe()` 對任何型別都是 `new This({ ...this._def, description })`——
 * description 以外的 `_def` 屬性與被呼叫端同一份參考（P7 的機制）：
 * - 選配欄位（`markdown`／`if_match`／`section_id`／`title`／`content`）建法固定成
 *   `BASE.optional().describe(...)`：`.optional()` 包一層 `ZodOptional`，`_def.innerType`
 *   就是 `BASE` 本身，`.describe()` 之後這個參考不變（P7）——直接 `toBe` 最乾淨。
 * - 必填欄位（`note_id`）沒有 `.optional()`，直接 `NOTE_ID.describe(...)`：沒有
 *   `innerType` 可比，但剝掉 `description` 之後剩下的 `_def`（`schema`／`effect` 等）
 *   與 `NOTE_ID._def`（同樣剝掉 description）逐一都是同一份參考，`toEqual` 遞迴比對時
 *   碰到的都是同一個物件，等同於一份更囉唆的 `toBe`。
 */
function expectSameSchema(field: z.ZodTypeAny, base: z.ZodTypeAny): void {
  if (field instanceof z.ZodOptional) {
    expect(field._def.innerType).toBe(base);
    return;
  }
  const { description: _fieldDescription, ...fieldRest } = field._def as Record<string, unknown>;
  const { description: _baseDescription, ...baseRest } = base._def as Record<string, unknown>;
  expect(fieldRest).toEqual(baseRest);
}

describe("#108 M14：raw shape 六個欄位與 notes/schemas.ts 的 base 同源（案 21b(i)）", () => {
  it("editNoteInput 的 markdown／if_match／section_id／note_id 各自與 MD／FP／SEC／NOTE_ID 同源", () => {
    expectSameSchema(editNoteInput.markdown, MD);
    expectSameSchema(editNoteInput.if_match, FP);
    expectSameSchema(editNoteInput.section_id, SEC);
    expectSameSchema(editNoteInput.note_id, NOTE_ID);
  });

  it("#180：editNoteInput.title 與 TITLE 同源；PATCH 的 updateBodyObject.title 與 TITLE 同源（W16）", () => {
    expectSameSchema(editNoteInput.title, TITLE);
    expectSameSchema(updateBodyObject.shape.title, TITLE);
  });

  it("createNoteInput 的 title／content／group_id 各自與 TITLE／MD／GROUP_ID 同源", () => {
    expectSameSchema(createNoteInput.title, TITLE);
    expectSameSchema(createNoteInput.content, MD);
    expectSameSchema(createNoteInput.group_id, GROUP_ID);
  });

  it("#175 PR5：REST createBodySchema 的 groupId 與 GROUP_ID 同源（D18：寫入側不發明第二套契約）", () => {
    expectSameSchema(createBodySchema.shape.groupId, GROUP_ID);
    expectSameSchema(createBodySchema.shape.title, TITLE);
    expectSameSchema(createBodySchema.shape.content, MD);
  });

  it("#175 PR5：GROUP_ID 收大小寫 uuid、拒非 uuid 與空字串", () => {
    expect(GROUP_ID.safeParse(randomUUID()).success).toBe(true);
    expect(GROUP_ID.safeParse(randomUUID().toUpperCase()).success).toBe(true);
    for (const bad of ["", "not-a-uuid", `${randomUUID()}x`, randomUUID().replace(/-/g, "")]) expect(GROUP_ID.safeParse(bad).success).toBe(false);
  });

  it("#240 U-240a：NOTE_ID 把大寫／大小寫混雜的 uuid 轉成小寫；NUL、非 uuid 仍拒", () => {
    const lower = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const mixed = "0F8fAd5B-d9Cb-469F-a165-70867728950E";
    expect(NOTE_ID.parse(lower.toUpperCase())).toBe(lower);
    expect(NOTE_ID.parse(mixed)).toBe(lower);
    expect(NOTE_ID.parse(lower)).toBe(lower);
    for (const bad of ["", "not-a-uuid", `${lower}${NUL}`, `${lower}x`]) expect(NOTE_ID.safeParse(bad).success).toBe(false);
  });
});

/**
 * 21b(ii)（M14 的**行為**那一半）：三發直接打 schema 物件（不經 HTTP），驗證執行期真的擋得住。
 *
 * ⚠ **262 145 code unit 的那一發不可以經 HTTP**（規格逐字：一份那麼長的 markdown 會先撞
 * `bodyLimit` 的 413，那個形恆綠，測不到 `MD` 的 `.max`）——只在 schema 層驗。
 * ⚠ **handler 本身不跑 raw shape 的驗證**（那是 SDK 做的）：這裡打的是 `z.object(editNoteInput)`／
 * `z.object(createNoteInput)` 這兩個物件本身，不是呼叫 `editNote()`／`createNote()`。
 *
 * ⚠ **NUL 與空 title 兩發的「同一份 payload 經 tools/call 打進去」後半，移到
 * `test/mcp-write-guards.test.ts`**（本檔實作時的自我修正，不是 brief 原樣）：brief 原文把
 * 這半段也放在本檔，但那半需要 `buildCollabTestApp()`（真 DB），而 `vitest.unit.config.ts`
 * 刻意不帶 `globalSetup`——那份 config 的檔頭逐字「確保 unit 測試絕不啟動 testcontainers」，
 * 是這個 repo 對「跑 `test:unit` 永遠不用 docker」的既有承諾（`package.json` 的
 * `test:unit` 腳本、以及本機測試慣例都靠它）。實測過：不手動設 `TEST_DATABASE_URL` 直接
 * `pnpm --filter @knotebook/server test:unit` 時，那半段會炸
 * 「TEST_DATABASE_URL 未設定」，把這份「本檔＝快、免 docker」的承諾打破。schema 層
 * safeParse 那一半（不需要 DB）留在這裡；HTTP 那一半搬進 `mcp-write-guards.test.ts`
 * （已經是本棒的整合測試檔），案號與斷言內容一字不改。
 */
describe("#108 M14：21b(ii) 的行為探針", () => {
  it("markdown 262 145 code unit：z.object(editNoteInput) 直接 safeParse 拒絕，issue 指到 markdown", () => {
    const tooLong = "x".repeat(262_145);
    const parsed = z.object(editNoteInput).safeParse({ note_id: randomUUID(), op: "append", markdown: tooLong });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toContain("markdown");
  });

  it("markdown 含 NUL：z.object(editNoteInput) 直接 safeParse 拒絕，issue 指到 markdown（HTTP 那一半在 mcp-write-guards.test.ts）", () => {
    const parsed = z.object(editNoteInput).safeParse({ note_id: randomUUID(), op: "append", markdown: "x" + NUL });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toContain("markdown");
  });

  it("create_note 空字串 title：z.object(createNoteInput) 直接 safeParse 拒絕，issue 指到 title（HTTP 那一半在 mcp-write-guards.test.ts）", () => {
    const parsed = z.object(createNoteInput).safeParse({ title: "" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toContain("title");
  });
});

// #222：模型面字串要講到顏色怎麼寫、只收哪些名字、讀回來是同一個形——不講的話模型只會靠
// read_note_section 偶然看到 HTML 去猜，而 `#ff6600` 這種值會整筆被拒。
// 色名清單寫死一份（不從 PALETTE_COLORS 導出）——否則兩邊一起改就一起綠。
describe("#222 顏色在工具說明裡", () => {
  const NAMES = "default, gray, brown, red, orange, yellow, green, blue, purple, pink";
  it("edit_note 的 markdown 說明：HTML 形的例子、10 個色名逐字、讀回同形", () => {
    const d = editNoteInput.markdown.description ?? "";
    expect(d).toContain(NAMES);
    expect(d).toContain('<span style="color:red">');
    expect(d).toContain("read_note_section");
  });
  it("create_note 的 content 說明指回 edit_note；read_note_section 的 markdown 說明講到顏色是 HTML、原樣寫回會保留", () => {
    expect(createNoteInput.content.description).toContain("Colors work as in edit_note");
    const d = readNoteSectionOutput.section.shape.markdown.description ?? "";
    expect(d).toContain("Colored text and blocks come back as HTML");
    expect(d).toContain("unchanged");
  });
});

describe("#180 U2-c：copy_note 的輸入與 notes/schemas.ts 同源", () => {
  it("copyNoteInput.note_id ↔ NOTE_ID；copyNoteInput.group_id（optional）↔ GROUP_ID", () => {
    expectSameSchema(copyNoteInput.note_id, NOTE_ID);
    expectSameSchema(copyNoteInput.group_id, GROUP_ID);
    expect(copyNoteInput.group_id).toBeInstanceOf(z.ZodOptional);
  });

  it("#239：copyNoteInputNoMove.note_id ↔ NOTE_ID；.group_id（optional）↔ GROUP_ID，說明是無搬移版", () => {
    expectSameSchema(copyNoteInputNoMove.note_id, NOTE_ID);
    expectSameSchema(copyNoteInputNoMove.group_id, GROUP_ID);
    expect(copyNoteInputNoMove.group_id).toBeInstanceOf(z.ZodOptional);
    expect(copyNoteInputNoMove.group_id.description).toBe(COPY_GROUP_ID_DESCRIBE_NO_MOVE);
  });
});

describe("#180 U2-d：move_note_to_group 的輸入與 notes/schemas.ts 同源", () => {
  it("moveNoteToGroupInput.note_id ↔ NOTE_ID；.group_id（必填，無 optional）↔ GROUP_ID", () => {
    expectSameSchema(moveNoteToGroupInput.note_id, NOTE_ID);
    expectSameSchema(moveNoteToGroupInput.group_id, GROUP_ID);
    expect(moveNoteToGroupInput.group_id).not.toBeInstanceOf(z.ZodOptional);
  });
});
