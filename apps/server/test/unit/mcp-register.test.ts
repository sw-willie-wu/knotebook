/**
 * #240/#241: look at what is **actually registered**, not at exports.
 * Calls the real `registerMcpTools` with a fake `registerTool` that only collects `(name, config)`, over twelve ctx shapes
 * (all combinations of authKind x scope x canRead: read-write-move-delete, read-write-delete, read-write-move, read-write, read-only token, session, each with and without collab+editing;
 * #239 added read-write-move, #181 added the two shapes containing notes:delete):
 * (1) every inputSchema is a strict ZodObject (and `catchall` must be ZodNever, otherwise `unknownKeys` has no effect);
 * (2) fields carrying `note_id` come from the same source as `NOTE_ID` (the convergence point);
 * (3) the name array verbatim (including order): adding a tool turns this red, forcing the name constants to be updated; (1) and (2) apply automatically to every registered tool.
 * (1) checks `_def.typeName` rather than `instanceof z.ZodObject`: with two zod instances `instanceof` would be false for everything.
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
 * Same judgement as `mcp-write-schemas.test.ts` (strip description, then `toEqual` on `_def`); note_id is always required, so there is no ZodOptional branch.
 * The "same source" check works because the refine/transform of `NOTE_ID` are functions: `toEqual` compares functions by reference, so a different copy with the same structure fails.
 */
function expectSameSchema(field: z.ZodTypeAny, base: z.ZodTypeAny): void {
  const { description: _f, ...fieldRest } = field._def as Record<string, unknown>;
  const { description: _b, ...baseRest } = base._def as Record<string, unknown>;
  expect(fieldRest).toEqual(baseRest);
}

const LIVE = { collab: {} as never, editing: {} as never };
// #239: read-write tokens no longer register move_note_to_group (needs notes:move); read-write-move tokens and sessions do.
export const RWM_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "open_notes_as_files", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image", "read_comments", "post_comment", "list_notifications"];
export const RW_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "copy_note", "create_transfer_token", "open_notes_as_files", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image", "read_comments", "post_comment", "list_notifications"];
export const RO_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "create_transfer_token", "open_notes_as_files", "list_trash", "list_folders", "read_note_image", "read_comments", "list_notifications"];
export const SESSION = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image", "read_comments", "post_comment", "list_notifications"];
export const RO_NO_COLLAB = ["list_notes", "search_notes", "create_transfer_token", "list_trash", "list_folders", "read_note_image", "list_notifications"];
export const SESSION_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image", "list_notifications"];
export const RWM_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image", "list_notifications"];
export const RW_NO_COLLAB = ["list_notes", "search_notes", "create_note", "copy_note", "create_transfer_token", "list_trash", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "read_note_image", "list_notifications"];
// bulk transfer: open_notes_as_files is registered only on the token path with collab + editing (inside the gate), right after create_transfer_token.
// #181: delete_note/restore_note are registered only with notes:delete (and write), right after list_trash and before read_note_image; independent of move.
// Folders: list_folders is registered for any credential and deployment shape, after restore_note and before read_note_image.
// Folders: create_folder/rename_folder/move_folder are registered only with notes:write (outside the collab gate), right after list_folders.
// Folders: move_note_to_folder is in the same notes:write block, right after move_folder.
// Folders: delete_folder is registered only with notes:delete (and write), right after move_note_to_folder and before read_note_image.
// Comments: read_comments (inside the gate), post_comment (inside the gate, notes:write) and list_notifications (any credential and deployment shape) come last, in that order.
export const RWD_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "copy_note", "create_transfer_token", "open_notes_as_files", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image", "read_comments", "post_comment", "list_notifications"];
export const RWMD_TOKEN = ["list_notes", "search_notes", "read_note_outline", "read_note_section", "edit_note", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "open_notes_as_files", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image", "read_comments", "post_comment", "list_notifications"];
export const RWD_NO_COLLAB = ["list_notes", "search_notes", "create_note", "copy_note", "create_transfer_token", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image", "list_notifications"];
export const RWMD_NO_COLLAB = ["list_notes", "search_notes", "create_note", "move_note_to_group", "copy_note", "create_transfer_token", "list_trash", "delete_note", "restore_note", "list_folders", "create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder", "read_note_image", "list_notifications"];

const CASES: Array<[string, Partial<McpToolCtx>, string[]]> = [
  ["read-write-move-delete token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write notes:move notes:delete" as never }, RWMD_TOKEN],
  ["read-write-delete token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write notes:delete" as never }, RWD_TOKEN],
  ["read-write-move-delete token, no collab", { authKind: "token", tokenScope: "notes:read notes:write notes:move notes:delete" as never }, RWMD_NO_COLLAB],
  ["read-write-delete token, no collab", { authKind: "token", tokenScope: "notes:read notes:write notes:delete" as never }, RWD_NO_COLLAB],
  ["read-write-move token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write notes:move" as never }, RWM_TOKEN],
  ["read-write token", { ...LIVE, authKind: "token", tokenScope: "notes:read notes:write" as never }, RW_TOKEN],
  ["read-only token", { ...LIVE, authKind: "token", tokenScope: "notes:read" as never }, RO_TOKEN],
  ["session", { ...LIVE, authKind: "session", tokenScope: null }, SESSION],
  ["read-write-move token, no collab", { authKind: "token", tokenScope: "notes:read notes:write notes:move" as never }, RWM_NO_COLLAB],
  ["read-write token, no collab", { authKind: "token", tokenScope: "notes:read notes:write" as never }, RW_NO_COLLAB],
  ["read-only token, no collab", { authKind: "token", tokenScope: "notes:read" as never }, RO_NO_COLLAB],
  ["session, no collab", { authKind: "session", tokenScope: null }, SESSION_NO_COLLAB],
];

describe("#240/#241: inputSchema as actually registered", () => {
  for (const [label, ctx, names] of CASES) {
    it(`${label}: every one is a strict ZodObject, note_id comes from the same source as NOTE_ID, names verbatim`, () => {
      const got = collect(ctx);
      for (const g of got) {
        const def = (g.inputSchema as { _def?: { typeName?: string; unknownKeys?: string; catchall?: { _def?: { typeName?: string } } } } | undefined)?._def;
        // Checked first: it is the main thing this test guards.
        // When catchall isn't ZodNever zod 3 doesn't apply unknownKeys (`.strict().catchall(z.unknown())` still accepts unknown keys), so assert both together.
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
