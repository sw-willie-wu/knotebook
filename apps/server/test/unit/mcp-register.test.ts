/**
 * #240／#241 U-F1：看**實際註冊**的東西，不看 export。
 * 用只收集 `(name, config)` 的假 `registerTool` 呼叫真的 `registerMcpTools`，十二種 ctx
 * （＝authKind × scope × canRead 的全組合：讀寫搬移刪除、讀寫刪除、讀寫搬移、讀寫、唯讀 token，session，各有／無 collab+editing；
 * #239 加讀寫搬移，#181 加兩個含 notes:delete 的形）：
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
// #239：讀寫 token 不再註冊 move_note_to_group（要 notes:move）；讀寫搬移 token 與 session 才有。
export const RWM_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image"];
export const RW_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "copy_note", "create_transfer_token", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image"];
export const RO_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "create_transfer_token", "list_trash", "list_folders", "read_note_image"];
export const SESSION = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image"];
export const RO_NO_COLLAB = ["list_notes", "search_notes", "create_transfer_token", "list_trash", "list_folders", "read_note_image"];
export const SESSION_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image"];
export const RWM_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image"];
export const RW_NO_COLLAB = ["list_notes", "search_notes", "create_note", "copy_note", "create_transfer_token", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image"];
// #181：delete_note／restore_note 只在 notes:delete（且有 write）時註冊，緊接 list_trash 之後、read_note_image 之前；與 move 互相獨立。
// 資料夾 PR-3d：list_folders 任何憑證、任何部署形態都註冊，在 restore_note 之後、read_note_image 之前。
// 資料夾 PR-3d：create_folder／rename_folder／move_folder 只在 notes:write 時註冊（collab 閘門外），緊接 list_folders 之後。
// 資料夾 PR-3d T7：move_note_to_folder 同一個 notes:write 區塊，緊接 move_folder 之後。
// 資料夾 PR-3d T8：delete_folder 只在 notes:delete（且有 write）時註冊，緊接 move_note_to_folder 之後、read_note_image 之前。
export const RWD_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "copy_note", "create_transfer_token", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image"];
export const RWMD_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image"];
export const RWD_NO_COLLAB = ["list_notes", "search_notes", "create_note", "copy_note", "create_transfer_token", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image"];
export const RWMD_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image"];

const CASES: Array<[string, Partial<McpToolCtx>, string[]]> = [
  ["讀寫搬移刪除 token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write notes:move notes:delete" as never }, RWMD_TOKEN],
  ["讀寫刪除 token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write notes:delete" as never }, RWD_TOKEN],
  ["讀寫搬移刪除 token、無 collab", { authKind: "token", tokenScope: "notes:read notes:write notes:move notes:delete" as never }, RWMD_NO_COLLAB],
  ["讀寫刪除 token、無 collab", { authKind: "token", tokenScope: "notes:read notes:write notes:delete" as never }, RWD_NO_COLLAB],
  ["讀寫搬移 token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write notes:move" as never }, RWM_TOKEN],
  ["讀寫 token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write" as never }, RW_TOKEN],
  ["唯讀 token", { ...LIVE, authKind: "token", tokenScope: "notes:read" as never }, RO_TOKEN],
  ["session", { ...LIVE, authKind: "session", tokenScope: null }, SESSION],
  ["讀寫搬移 token、無 collab", { authKind: "token", tokenScope: "notes:read notes:write notes:move" as never }, RWM_NO_COLLAB],
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
