/**
 * #240／#241 U-F1：看**實際註冊**的東西，不看 export。
 * 用只收集 `(name, config)` 的假 `registerTool` 呼叫真的 `registerMcpTools`，六種 ctx
 * （＝authKind × scope × canRead 的全組合：讀寫 token、唯讀 token、session，各有／無 collab+editing）：
 * ① 每個 inputSchema 都是 strict 的 ZodObject（W2，含 `catchall` 必須是 ZodNever——否則 `unknownKeys` 不生效）；
 * ② 帶 `note_id` 的欄位與 `NOTE_ID` 同源（W3 收斂點）；
 * ③ 名字陣列逐字（含順序）——新增工具時這裡會紅，逼人補名字常數；①② 對每支註冊物自動生效。
 * ⚠ ① 判 `_def.typeName` 而不是 `instanceof z.ZodObject`：兩份 zod 實例會讓 instanceof 全判 false（spec gate r2 N4）。
 */
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { registerMcpTools } from "../../src/mcp/register.js";
import type { McpToolCtx } from "../../src/mcp/context.js";
import { NOTE_ID } from "../../src/notes/schemas.js";

interface Collected { name: string; inputSchema: unknown }

function collect(ctx: Partial<McpToolCtx>): Collected[] {
  const out: Collected[] = [];
  const fake = {
    registerTool: (name: string, config: { inputSchema?: unknown }) => {
      out.push({ name, inputSchema: config.inputSchema });
    },
  };
  registerMcpTools(fake as unknown as McpServer, ctx as McpToolCtx);
  return out;
}

/**
 * 同 `mcp-write-schemas.test.ts` 的判法（剝掉 description 後 `_def` 逐一 `toEqual`）；note_id 恆為必填，無 ZodOptional 分支。
 * 「同源」的鑑別力來自 `NOTE_ID` 的 refine／transform 是函式——`toEqual` 對函式比參考，同結構、不同源的另一份會紅。
 */
function expectSameSchema(field: z.ZodTypeAny, base: z.ZodTypeAny): void {
  const { description: _f, ...fieldRest } = field._def as Record<string, unknown>;
  const { description: _b, ...baseRest } = base._def as Record<string, unknown>;
  expect(fieldRest).toEqual(baseRest);
}

const LIVE = { collab: {} as never, editing: {} as never };
export const RW_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "read_note_image"];
export const RO_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "create_transfer_token", "read_note_image"];
export const SESSION = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "read_note_image"];
export const RO_NO_COLLAB = ["list_notes", "search_notes", "create_transfer_token", "read_note_image"];
export const SESSION_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "read_note_image"];
export const RW_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "read_note_image"];

const CASES: Array<[string, Partial<McpToolCtx>, string[]]> = [
  ["讀寫 token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write" as never }, RW_TOKEN],
  ["唯讀 token", { ...LIVE, authKind: "token", tokenScope: "notes:read" as never }, RO_TOKEN],
  ["session", { ...LIVE, authKind: "session", tokenScope: null }, SESSION],
  ["讀寫 token、無 collab", { authKind: "token", tokenScope: "notes:read notes:write" as never }, RW_NO_COLLAB],
  ["唯讀 token、無 collab", { authKind: "token", tokenScope: "notes:read" as never }, RO_NO_COLLAB],
  ["session、無 collab", { authKind: "session", tokenScope: null }, SESSION_NO_COLLAB],
];

describe("#240／#241 U-F1：實際註冊的 inputSchema", () => {
  for (const [label, ctx, names] of CASES) {
    it(`${label}：每支 strict ZodObject、note_id 與 NOTE_ID 同源、名字逐字`, () => {
      const got = collect(ctx);
      for (const g of got) {
        const def = (g.inputSchema as { _def?: { typeName?: string; unknownKeys?: string; catchall?: { _def?: { typeName?: string } } } } | undefined)?._def;
        // ① 排最前：W2 是這支測試首要守的東西。
        // catchall 不是 ZodNever 時 zod 3 不套 unknownKeys（`.strict().catchall(z.unknown())` 照收未知鍵），所以一起斷。
        expect({ name: g.name, typeName: def?.typeName, unknownKeys: def?.unknownKeys, catchall: def?.catchall?._def?.typeName }).toEqual({
          name: g.name,
          typeName: "ZodObject",
          unknownKeys: "strict",
          catchall: "ZodNever",
        });
        const shape = (g.inputSchema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
        if ("note_id" in shape) expectSameSchema(shape.note_id!, NOTE_ID);
      }
      expect(got.map(g => g.name)).toEqual(names);
    });
  }
});
